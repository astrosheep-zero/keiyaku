import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import {
  projectDebtDetail,
  relationProblem,
  projectBlocked,
  projectRows,
  type BlockedDebtRow,
  type DebtBoard,
  type DebtDetail,
  type DebtSummary,
  type ReadyDebtRow,
} from "./board.js";
import {
  parseDebtCreationDocument,
  serializeDebtDocument,
  type DebtCreationDocument,
  type DebtDocument,
} from "./document.js";
import { allocateLocalId, deriveLocalStem, type DebtId } from "./identity.js";
import { nukeDebtAuthority, readBoard, readDebtDocument, replaceAuthority, withDebtLocks } from "./store.js";
import type { WorldRoot } from "../world.js";
import { boundedListLimit, projectBoundedList } from "../bounded-list.js";
import { advanceDebtTimestamp } from "./view.js";
export type {
  AddDebtDocumentInput,
  AddDebtInput,
  DebtMutationResult,
  DebtReadPage,
  DebtRefusal,
  DebtRetry,
  DebtUpdateResult,
  SettledDebtResult,
  UpdateDebtInput,
} from "./operation-types.js";
import { nonEmptyDebtValues } from "./operation-types.js";
import type {
  AddDebtDocumentInput,
  AddDebtInput,
  DebtChange,
  DebtMutationResult,
  DebtReadPage,
  DebtRetry,
  DebtUpdateResult,
  UpdateDebtInput,
} from "./operation-types.js";

export async function nukeDebt(
  world: WorldRoot,
  options?: Readonly<{ timeoutMs?: number; onRemoved?(count: number): void }>,
): Promise<number> {
  const result = await nukeDebtAuthority(world, options);
  if (result === "busy") throw new SqliteTransactionLockError("Debt reset lock contention", "timeout");
  return result;
}

function retry(reason: DebtRetry) {
  return { kind: "retry" as const, reason };
}
function currentTimestamp(): string {
  return new Date().toISOString();
}

function addDocument(base: DebtCreationDocument, board: DebtBoard, at: string): DebtDocument {
  const localId = allocateLocalId(
    deriveLocalStem(base.title),
    new Set([...board.debts.keys()].map((id) => id.slice(5))),
  );
  return {
    ...base,
    id: `debt/${localId}`,
    createdAt: at,
    updatedAt: at,
  };
}
function boardWith(board: DebtBoard, document: DebtDocument): DebtBoard {
  const debts = new Map(board.debts);
  debts.set(document.id, document);
  return { debts };
}
async function create(world: WorldRoot, base: DebtCreationDocument, signal?: AbortSignal): Promise<DebtMutationResult> {
  const result = await withDebtLocks(
    { world, allocation: true, ids: [], ...(signal === undefined ? {} : { signal }) },
    async () => {
      const snapshot = await readBoard(world),
        next = addDocument(base, snapshot.board, currentTimestamp());
      const problem = relationProblem(boardWith(snapshot.board, next), null, next);
      if (problem !== null) return { kind: "refused", reason: "invalid-graph", diagnostic: problem } as const;
      const replaced = await replaceAuthority({
        world,
        id: next.id,
        expected: null,
        next: serializeDebtDocument(next),
      });
      return replaced === "replaced" ? ({ kind: "accepted", id: next.id } as const) : retry("concurrent-modification");
    },
  );
  return result === "busy" ? retry("busy") : result;
}

export async function addDebt(world: WorldRoot, input: AddDebtInput): Promise<DebtMutationResult> {
  return create(
    world,
    {
      title: input.title,
      body: input.body ?? "",
      note: "",
      state: "open",
      priority: input.priority ?? 2,
      needs: input.needs ?? [],
    },
    input.signal,
  );
}
export async function addDebtDocument(world: WorldRoot, input: AddDebtDocumentInput): Promise<DebtMutationResult> {
  return create(world, parseDebtCreationDocument(input.markdown), input.signal);
}

function updateDocument(current: DebtDocument, input: UpdateDebtInput): DebtDocument {
  return {
    ...current,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.needs === undefined ? {} : { needs: input.needs }),
  };
}

function updateFieldChanges(current: DebtDocument, next: DebtDocument): readonly DebtChange[] {
  const changes: DebtChange[] = [];
  for (const field of ["title", "body", "note", "state", "priority", "needs"] as const) {
    const before = current[field];
    const after = next[field];
    if (Array.isArray(before) && Array.isArray(after) ? before.join("\0") === after.join("\0") : before === after)
      continue;
    changes.push(field);
  }
  return changes;
}

export async function updateDebt(world: WorldRoot, id: DebtId, input: UpdateDebtInput): Promise<DebtUpdateResult> {
  const result = await withDebtLocks(
    { world, allocation: false, ids: [id], ...(input.signal === undefined ? {} : { signal: input.signal }) },
    async (): Promise<DebtUpdateResult> => {
      const snapshot = await readBoard(world),
        current = snapshot.board.debts.get(id);
      if (current === undefined) return { kind: "refused", reason: "debt-missing" };
      const candidate = updateDocument(current, input);
      const problem = relationProblem(boardWith(snapshot.board, candidate), current, candidate);
      if (problem !== null) return { kind: "refused", reason: "invalid-graph", diagnostic: problem } as const;
      const changes = nonEmptyDebtValues(updateFieldChanges(current, candidate));
      if (changes === undefined) return { kind: "accepted" };
      const next = { ...candidate, updatedAt: advanceDebtTimestamp(current.updatedAt, currentTimestamp()) };
      if (
        (await replaceAuthority({
          world,
          id,
          expected: snapshot.bytes.get(id)!,
          next: serializeDebtDocument(next),
        })) !== "replaced"
      ) {
        return { kind: "retry", reason: "concurrent-modification" };
      }
      return { kind: "accepted", changes };
    },
  );
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}

export { settleDebt } from "./lifecycle-operations.js";

function readPage<T>(
  bounded: Readonly<{ rows: readonly T[]; hasMore: boolean }>,
): Extract<DebtReadPage<T>, { kind: "present" }> {
  const rows = nonEmptyDebtValues(bounded.rows);
  return {
    kind: "present",
    ...(rows === undefined ? {} : { rows }),
    ...(bounded.hasMore ? { more: true as const } : {}),
  };
}
export async function listDebts(
  world: WorldRoot,
  selection: "active" | "closed" | "all",
  limit?: number,
): Promise<Extract<DebtReadPage<DebtSummary>, { kind: "present" }>> {
  const selectedLimit = boundedListLimit(limit);
  const board = (await readBoard(world)).board;
  return readPage(projectBoundedList(projectRows(board, selection), selectedLimit));
}
export async function readDebtDetail(world: WorldRoot, id: DebtId): Promise<DebtDetail | null> {
  const debt = await readDebtDocument(world, id);
  if (debt === undefined) return null;
  const selected = new Map<DebtId, DebtDocument>([[id, debt]]);
  for (const reference of debt.needs) {
    if (selected.has(reference)) continue;
    const document = await readDebtDocument(world, reference);
    if (document !== undefined) selected.set(reference, document);
  }
  return projectDebtDetail({ debts: selected }, id);
}
/** Read the complete prerequisite graph before bounding either native view. */
async function readDebtGraphContext(world: WorldRoot, limit: number | undefined) {
  return { limit: boundedListLimit(limit), board: (await readBoard(world)).board };
}
export async function readyDebts(world: WorldRoot, limit?: number): Promise<DebtReadPage<ReadyDebtRow>> {
  const context = await readDebtGraphContext(world, limit);
  const rows = projectRows(context.board, "active")
    .filter((row) => row.disposition === "ready")
    .map(({ id, title, priority }) => ({ id, title, priority }));
  return readPage(projectBoundedList(rows, context.limit));
}
export async function blockedDebts(world: WorldRoot, limit?: number): Promise<DebtReadPage<BlockedDebtRow>> {
  const context = await readDebtGraphContext(world, limit);
  return readPage(projectBoundedList(projectBlocked(context.board), context.limit));
}
export async function observeDebtBoard(world: WorldRoot): Promise<readonly DebtSummary[]> {
  return projectRows((await readBoard(world)).board, "all");
}
