import type { DebtBoard } from "./board.js";
import { serializeDebtDocument, type DebtDocument } from "./document.js";
import {
  type SettledDebtResult,
  type DebtBatchItem,
  type DebtBatchResult,
  type DebtLifecycleVerb,
  type DebtLifecycleResult,
  type DebtRetry,
} from "./operation-types.js";
import type { DebtId } from "./identity.js";
import { authorityBytesMatch, readBoard, replaceAuthority, withDebtLocks } from "./store.js";
import type { WorldRoot } from "../world.js";
import { advanceDebtTimestamp } from "./view.js";

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
function retry(reason: DebtRetry): DebtLifecycleResult {
  return { kind: "retry", reason };
}

async function transitionLifecycle(
  world: WorldRoot,
  id: DebtId,
  verb: DebtLifecycleVerb,
  currentBoard: CurrentDebtBoard,
  options: LifecycleOptions = {},
): Promise<DebtLifecycleResult> {
  const { note, freshness = "none" } = options;
  const current = currentBoard.board.debts.get(id);
  if (current === undefined) {
    return freshness === "batch" && !(await authorityBytesMatch(world, id, null))
      ? retry("concurrent-modification")
      : { kind: "refused", reason: "debt-missing" };
  }
  if (current.state !== "open") {
    return freshness === "batch" && !(await authorityBytesMatch(world, id, currentBoard.bytes.get(id)!))
      ? retry("concurrent-modification")
      : { kind: "refused", reason: "invalid-lifecycle-transition", state: current.state };
  }
  const at = new Date().toISOString();
  const next = {
    ...current,
    state: verb,
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
  return { kind: "accepted" };
}

async function lifecycleFromCurrentBoard(
  world: WorldRoot,
  id: DebtId,
  verb: DebtLifecycleVerb,
  currentBoard: CurrentDebtBoard,
  options: BatchLifecycleOptions = {},
): Promise<DebtLifecycleResult> {
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
): Promise<DebtLifecycleResult> {
  const result = await withDebtLocks(
    { world, allocation: false, ids: [id], ...(signal === undefined ? {} : { signal }) },
    async (): Promise<DebtLifecycleResult> => {
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
  const items: DebtBatchItem[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    const result = await lifecycleFromCurrentBoard(world, id, verb, currentBoard, {
      ...(signal === undefined ? {} : { signal }),
      ...(note === undefined ? {} : { note }),
    });
    items.push(result);
  }
  return { items };
}

export async function settleDebt(world: WorldRoot, id: DebtId): Promise<SettledDebtResult> {
  const result = await withDebtLocks({ world, allocation: false, ids: [id] }, async (): Promise<SettledDebtResult> => {
    const snapshot = await readBoard(world),
      current = snapshot.board.debts.get(id);
    if (current === undefined) return { kind: "refused", reason: "debt-missing" };
    if (current.state === "done") return { kind: "unchanged" };
    if (current.state === "drop") {
      return {
        kind: "refused",
        reason: "invalid-lifecycle-transition",
        state: current.state,
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
    return replaced === "replaced" ? { kind: "changed" } : { kind: "retry", reason: "concurrent-modification" };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}
