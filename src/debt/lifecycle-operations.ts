import type { DebtBoard } from "./board.js";
import { serializeDebtDocument, type DebtDocument } from "./document.js";
import {
  type SettledDebtResult,
  type DebtBatchResult,
  type DebtLifecycleVerb,
  type DebtMutationResult,
  type DebtRetry,
} from "./operation-types.js";
import type { DebtId } from "./identity.js";
import { authorityBytesMatch, readBoard, replaceAuthority, withDebtLocks } from "./store.js";
import type { WorldRoot } from "../world.js";
import { advanceDebtTimestamp, debtView } from "./view.js";

const TRANSITIONS: Readonly<
  Record<DebtLifecycleVerb, Readonly<Partial<Record<DebtDocument["state"], DebtDocument["state"]>>>>
> = {
  done: { open: "done" },
  drop: { open: "drop" },
};

type CurrentDebtBoard = {
  board: DebtBoard;
  bytes: Map<DebtId, Uint8Array>;
};
type LifecycleFreshness = "batch" | "none";
type LifecycleOptions = Readonly<{ note?: string; freshness?: LifecycleFreshness }>;
type BatchLifecycleOptions = Readonly<{ signal?: AbortSignal; note?: string }>;

function currentDebtBoard(board: DebtBoard, bytes: ReadonlyMap<DebtId, Uint8Array>): CurrentDebtBoard {
  return { board, bytes: new Map(bytes) };
}
function retry(reason: DebtRetry): DebtMutationResult {
  return { kind: "retry", reason };
}

async function transitionLifecycle(
  world: WorldRoot,
  id: DebtId,
  verb: DebtLifecycleVerb,
  currentBoard: CurrentDebtBoard,
  options: LifecycleOptions = {},
): Promise<DebtMutationResult> {
  const { note, freshness = "none" } = options;
  const current = currentBoard.board.debts.get(id);
  if (current === undefined) {
    return freshness === "batch" && !(await authorityBytesMatch(world, id, null))
      ? retry("concurrent-modification")
      : { kind: "refused", refusal: { kind: "debt-missing", debtId: id } };
  }
  const state = TRANSITIONS[verb][current.state];
  if (state === undefined) {
    return freshness === "batch" && !(await authorityBytesMatch(world, id, currentBoard.bytes.get(id)!))
      ? retry("concurrent-modification")
      : { kind: "refused", refusal: { kind: "invalid-lifecycle-transition", debtId: id, state: current.state, verb } };
  }
  const at = new Date().toISOString();
  const next = {
    ...current,
    state,
    ...(note === undefined ? {} : { note }),
    updatedAt: advanceDebtTimestamp(current.updatedAt, at),
  };
  const bytes = serializeDebtDocument(next);
  if (
    (await replaceAuthority({
      world,
      id,
      expected: currentBoard.bytes.get(id)!,
      next: bytes,
    })) !== "replaced"
  ) {
    return retry("concurrent-modification");
  }
  currentBoard.board = {
    debts: new Map(currentBoard.board.debts).set(id, next),
  };
  currentBoard.bytes.set(id, bytes);
  return { kind: "accepted", value: debtView(next) };
}

async function lifecycleFromCurrentBoard(
  world: WorldRoot,
  id: DebtId,
  verb: DebtLifecycleVerb,
  currentBoard: CurrentDebtBoard,
  options: BatchLifecycleOptions = {},
): Promise<DebtMutationResult> {
  const { signal, note } = options;
  const result = await withDebtLocks(
    { world, allocation: false, ids: [id], ...(signal === undefined ? {} : { signal }) },
    async () =>
      transitionLifecycle(world, id, verb, currentBoard, {
        freshness: "batch",
        ...(note === undefined ? {} : { note }),
      }),
  );
  return result === "busy" ? retry("busy") : result;
}

export async function lifecycleDebt(
  world: WorldRoot,
  id: DebtId,
  verb: DebtLifecycleVerb,
  signal?: AbortSignal,
  note?: string,
): Promise<DebtMutationResult> {
  const result = await withDebtLocks(
    { world, allocation: false, ids: [id], ...(signal === undefined ? {} : { signal }) },
    async (): Promise<DebtMutationResult> => {
      const snapshot = await readBoard(world);
      const options = note === undefined ? {} : { note };
      return transitionLifecycle(world, id, verb, currentDebtBoard(snapshot.board, snapshot.bytes), options);
    },
  );
  return result === "busy" ? retry("busy") : result;
}

export async function batchDebts(
  world: WorldRoot,
  verb: DebtLifecycleVerb,
  ids: readonly DebtId[],
  signal?: AbortSignal,
  note?: string,
): Promise<DebtBatchResult> {
  signal?.throwIfAborted();
  const snapshot = await readBoard(world);
  const currentBoard = currentDebtBoard(snapshot.board, snapshot.bytes);
  const items = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    items.push({
      id,
      outcome: await lifecycleFromCurrentBoard(world, id, verb, currentBoard, {
        ...(signal === undefined ? {} : { signal }),
        ...(note === undefined ? {} : { note }),
      }),
    });
  }
  return { items };
}

export async function settleDebt(world: WorldRoot, id: DebtId): Promise<SettledDebtResult> {
  const result = await withDebtLocks({ world, allocation: false, ids: [id] }, async (): Promise<SettledDebtResult> => {
    const snapshot = await readBoard(world),
      current = snapshot.board.debts.get(id);
    if (current === undefined) return { kind: "refused", refusal: { kind: "debt-missing", debtId: id } };
    if (current.state === "done") return { kind: "unchanged" };
    if (current.state === "drop") {
      return {
        kind: "refused",
        refusal: { kind: "invalid-lifecycle-transition", debtId: id, state: current.state, verb: "done" },
      };
    }
    const next: DebtDocument = {
      ...current,
      state: "done",
      updatedAt: advanceDebtTimestamp(current.updatedAt, new Date().toISOString()),
    };
    const replaced = await replaceAuthority({
      world,
      id,
      expected: snapshot.bytes.get(id)!,
      next: serializeDebtDocument(next),
    });
    return replaced === "replaced"
      ? { kind: "changed", debt: debtView(next), action: "done" }
      : { kind: "retry", reason: "concurrent-modification" };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}
