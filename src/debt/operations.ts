import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import {
  createDebtRelations,
  projectDebtBoardObservation,
  projectDebtDetail,
  relationProblem,
  projectBlocked,
  projectRows,
  type BlockedDebtRow,
  occupiedLocalIds,
  type DebtBoard,
  type DebtBoardObservation,
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
import { allocateLocalId, deriveLocalStem, formatDebtId, type DebtId } from "./identity.js";
import { nukeDebtAuthority, readBoard, readDebtDocument, replaceAuthority, withDebtLocks } from "./store.js";
import type { WorldRoot } from "../world.js";
import { boundedListLimit, projectBoundedList } from "../bounded-list.js";
import {
  projectQuery,
  projectQueryRows,
  queryUnderTargets,
  type DebtQueryExpression,
  type DebtQueryRow,
  type DebtQuerySort,
  underExpression,
} from "./query.js";
import { advanceDebtTimestamp } from "./view.js";
export type {
  AddDebtDocumentInput,
  AddDebtInput,
  DebtBatchResult,
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
  DebtParentReadRefusal,
  DebtMutationResult,
  DebtReadPage,
  DebtRefusal,
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

function addDocument(
  base: DebtCreationDocument,
  namespace: readonly string[],
  board: DebtBoard,
  at: string,
  actor?: string,
): DebtDocument {
  const localId = allocateLocalId(deriveLocalStem(base.title), occupiedLocalIds(board, namespace));
  return {
    ...base,
    id: formatDebtId({ namespace, localId }),
    ...(actor === undefined ? {} : { createdBy: actor }),
    createdAt: at,
    updatedAt: at,
  };
}
function boardWith(board: DebtBoard, document: DebtDocument): DebtBoard {
  const debts = new Map(board.debts);
  debts.set(document.id, document);
  return { debts };
}
async function create(
  world: WorldRoot,
  base: DebtCreationDocument,
  namespace: readonly string[],
  signal?: AbortSignal,
  actor?: string,
): Promise<DebtMutationResult> {
  let result: DebtMutationResult | "busy";
  try {
    result = await withDebtLocks(
      { world, allocation: true, ids: [], ...(signal === undefined ? {} : { signal }) },
      async () => {
        const snapshot = await readBoard(world),
          next = addDocument(base, namespace, snapshot.board, currentTimestamp(), actor);
        const problem = relationProblem(boardWith(snapshot.board, next), null, next);
        if (problem !== null) return { kind: "refused", reason: "invalid-graph", diagnostic: problem } as const;
        const replaced = await replaceAuthority({
          world,
          id: next.id,
          expected: null,
          next: serializeDebtDocument(next),
        });
        return replaced === "replaced"
          ? ({ kind: "accepted", id: next.id } as const)
          : retry("concurrent-modification");
      },
    );
  } catch (error) {
    if (
      error instanceof TypeError &&
      /debt identity (?:cannot fit the physical filename budget|contains a Windows-reserved physical segment)/u.test(
        error.message,
      )
    )
      return { kind: "refused", reason: "invalid-namespace-context" };
    throw error;
  }
  return result === "busy" ? retry("busy") : result;
}

export async function addDebt(world: WorldRoot, input: AddDebtInput): Promise<DebtMutationResult> {
  const namespace = input.namespace ?? [];
  return create(
    world,
    {
      title: input.title,
      body: input.body ?? "",
      note: input.note ?? "",
      state: input.state ?? "open",
      priority: input.priority ?? 2,
      needs: input.needs ?? [],
      parent: input.parent ?? null,
      supersedes: input.supersedes ?? [],
      relates: input.relates ?? [],
    },
    namespace,
    input.signal,
    input.actor,
  );
}
export async function addDebtDocument(world: WorldRoot, input: AddDebtDocumentInput): Promise<DebtMutationResult> {
  const namespace = input.namespace ?? [];
  return create(world, parseDebtCreationDocument(input.markdown), namespace, input.signal, input.actor);
}

function listChange(
  current: readonly DebtId[],
  replacement: readonly DebtId[] | undefined,
  additions: readonly DebtId[] | undefined,
  removals: readonly DebtId[] | undefined,
): readonly DebtId[] {
  const next = [...(replacement ?? current)];
  for (const id of additions ?? []) if (!next.includes(id)) next.push(id);
  return next.filter((id) => !(removals ?? []).includes(id));
}
function relatedOwner(board: DebtBoard, id: DebtId, target: DebtId): DebtId | null {
  return board.debts.get(target)?.relates.includes(id) ? target : null;
}
function appendDebtBody(current: string, addition: string): string {
  if (current.length === 0 || addition.length === 0 || current.endsWith("\n") || addition.startsWith("\n")) {
    return current + addition;
  }
  return `${current}\n${addition}`;
}
function updateDocument(
  board: DebtBoard,
  current: DebtDocument,
  input: UpdateDebtInput,
): DebtDocument | Extract<DebtRefusal, { reason: "relation-owned-by-other" }> {
  for (const related of input.dropRelates ?? [])
    if (!current.relates.includes(related)) {
      const owner = relatedOwner(board, current.id, related);
      if (owner !== null) return { kind: "refused", reason: "relation-owned-by-other", related };
    }
  return {
    ...current,
    ...(input.title === undefined ? {} : { title: input.title }),
    body:
      input.body ?? (input.appendBody === undefined ? current.body : appendDebtBody(current.body, input.appendBody)),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    needs: listChange(current.needs, input.needs, input.addNeeds, input.dropNeeds),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    supersedes: listChange(current.supersedes, input.supersedes, input.addSupersedes, input.dropSupersedes),
    relates: listChange(current.relates, input.relates, input.addRelates, input.dropRelates),
  };
}

function updateFieldChanges(current: DebtDocument, next: DebtDocument): readonly DebtChange[] {
  const changes: DebtChange[] = [];
  for (const field of ["title", "body", "note", "priority", "needs", "parent", "supersedes", "relates"] as const) {
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
      const candidate = updateDocument(snapshot.board, current, input);
      if ("kind" in candidate) return candidate;
      const problem = relationProblem(boardWith(snapshot.board, candidate), current, candidate);
      if (problem !== null) return { kind: "refused", reason: "invalid-graph", diagnostic: problem } as const;
      const predecessor = snapshot.bytes.get(id)!;
      const changed = !Buffer.from(serializeDebtDocument(candidate)).equals(Buffer.from(predecessor));
      let next = candidate;
      if (changed) {
        const at = currentTimestamp();
        next = { ...candidate, updatedAt: advanceDebtTimestamp(current.updatedAt, at) };
      }
      const afterBytes = serializeDebtDocument(next);
      if (
        !Buffer.from(predecessor).equals(Buffer.from(afterBytes)) &&
        (await replaceAuthority({ world, id, expected: predecessor, next: afterBytes })) !== "replaced"
      ) {
        return { kind: "retry", reason: "concurrent-modification" };
      }
      const changes = nonEmptyDebtValues(updateFieldChanges(current, next));
      return {
        kind: "accepted",
        ...(changes === undefined ? {} : { changes }),
      };
    },
  );
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}

export { batchDebts, lifecycleDebt, settleDebt } from "./lifecycle-operations.js";

function readScope(
  namespace: readonly string[] | undefined,
  scope: "namespace" | "world" | undefined,
): readonly string[] | null {
  return scope === "world" ? null : (namespace ?? []);
}
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
  namespace: readonly string[] | undefined,
  selection: "active" | "closed" | "all",
  scope?: "namespace" | "world",
  limit?: number,
): Promise<Extract<DebtReadPage<DebtSummary>, { kind: "present" }>> {
  const selectedLimit = boundedListLimit(limit);
  const selected = readScope(namespace, scope);
  const board = (await readBoard(world)).board;
  return readPage(projectBoundedList(projectRows(board, selected, selection), selectedLimit));
}
export async function readDebtDetail(world: WorldRoot, id: DebtId): Promise<DebtDetail | null> {
  const debt = await readDebtDocument(world, id);
  if (debt === undefined) return null;
  const selected = new Map<DebtId, DebtDocument>([[id, debt]]);
  const references = [
    ...debt.needs,
    ...(debt.parent === null ? [] : [debt.parent]),
    ...debt.supersedes,
    ...debt.relates,
  ];
  for (const reference of references) {
    if (selected.has(reference)) continue;
    const document = await readDebtDocument(world, reference);
    if (document !== undefined) selected.set(reference, document);
  }
  return projectDebtDetail({ debts: selected }, id);
}
/** One board observation and predicate projection shared by the ready and blocked views. */
async function readDebtQueryContext(
  input: Readonly<{
    world: WorldRoot;
    field: "ready" | "blocked";
    namespace?: readonly string[] | undefined;
    scope?: "namespace" | "world" | undefined;
    parent?: DebtId | undefined;
    limit?: number | undefined;
  }>,
) {
  const board = (await readBoard(input.world)).board;
  if (input.parent !== undefined && !board.debts.has(input.parent))
    return { kind: "refused", reason: "debt-missing" } as const;
  const relations = createDebtRelations(board);
  const scope = readScope(input.namespace, input.scope);
  const predicate: DebtQueryExpression = {
    kind: "predicate",
    predicate: { field: input.field, operator: "=", value: true },
  };
  return {
    kind: "ready",
    limit: boundedListLimit(input.limit),
    board,
    scope,
    relations,
    rows: projectQueryRows(board, relations, {
      scope,
      expression:
        input.parent === undefined ? predicate : { kind: "and", terms: [predicate, underExpression(input.parent)] },
    }),
  } as const;
}
export async function readyDebts(
  world: WorldRoot,
  namespace: readonly string[] | undefined,
  scope?: "namespace" | "world",
  parent?: DebtId,
  limit?: number,
): Promise<DebtReadPage<ReadyDebtRow, DebtParentReadRefusal>> {
  const queried = await readDebtQueryContext({ world, field: "ready", namespace, scope, parent, limit });
  if (queried.kind === "refused") return queried;
  return readPage(
    projectBoundedList(
      queried.rows.map(({ id, title, priority }) => ({ id, title, priority })),
      queried.limit,
    ),
  );
}
export async function blockedDebts(
  world: WorldRoot,
  namespace: readonly string[] | undefined,
  scope?: "namespace" | "world",
  parent?: DebtId,
  limit?: number,
): Promise<DebtReadPage<BlockedDebtRow, DebtParentReadRefusal>> {
  const queried = await readDebtQueryContext({ world, field: "blocked", namespace, scope, parent, limit });
  if (queried.kind === "refused") return queried;
  const { board, scope: selected, limit: selectedLimit, rows } = queried;
  const ids = new Set(rows.map((row) => row.id));
  return readPage(
    projectBoundedList(
      projectBlocked(board, selected).filter((row) => ids.has(row.id)),
      selectedLimit,
    ),
  );
}
export async function queryDebts(
  input: Readonly<{
    world: WorldRoot;
    namespace?: readonly string[];
    expression: DebtQueryExpression;
    scope?: "namespace" | "world";
    sort?: DebtQuerySort;
    limit?: number;
  }>,
): Promise<DebtReadPage<DebtQueryRow>> {
  const selectedLimit = boundedListLimit(input.limit);
  const selected = readScope(input.namespace, input.scope);
  const board = (await readBoard(input.world)).board;
  const relations = createDebtRelations(board);
  for (const target of queryUnderTargets(input.expression))
    if (!board.debts.has(target)) {
      return { kind: "refused", reason: "debt-missing", debtId: target };
    }
  return readPage(
    projectQuery(board, relations, {
      scope: selected as readonly string[] | null,
      expression: input.expression,
      sort: input.sort ?? "priority",
      limit: selectedLimit,
    }),
  );
}
export async function observeDebtBoard(world: WorldRoot): Promise<DebtBoardObservation> {
  return projectDebtBoardObservation((await readBoard(world)).board);
}
