import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import { documentDiff } from "../markdown/diff.js";
import {
  createDebtRelations,
  projectOwnedDetailFacts,
  projectDebtBoardObservation,
  relationProblem,
  projectBlocked,
  projectRows,
  type BlockedDebtRow,
  occupiedLocalIds,
  type DebtBoard,
  type DebtBoardObservation,
  type DebtDetailFacts,
  type DebtRow,
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
  type DebtPage,
  type DebtQueryExpression,
  type DebtQueryRow,
  type DebtQuerySort,
  underExpression,
} from "./query.js";
import { advanceDebtTimestamp, debtView } from "./view.js";
export { debtView } from "./view.js";
export type {
  AddDebtDocumentInput,
  AddDebtInput,
  DebtCleanupFailure,
  SettledDebtResult,
  DebtBatchResult,
  DebtMutationResult,
  DebtOutcome,
  DebtRefusal,
  DebtRetry,
  DebtUpdateResult,
  DebtView,
  UpdateDebtInput,
} from "./operation-types.js";
import type {
  AddDebtDocumentInput,
  AddDebtInput,
  DebtMutationResult,
  DebtOutcome,
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

function refused(refusal: DebtRefusal): DebtMutationResult {
  return { kind: "refused", refusal };
}
function retry(reason: DebtRetry): DebtMutationResult {
  return { kind: "retry", reason };
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
        if (problem !== null) return refused({ kind: "invalid-graph", diagnostic: problem });
        const replaced = await replaceAuthority({
          world,
          id: next.id,
          expected: null,
          next: serializeDebtDocument(next),
        });
        return replaced === "replaced"
          ? ({ kind: "accepted", value: debtView(next) } as const)
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
      return refused({ kind: "invalid-namespace-context", path: namespace.join("/") });
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
function updateDocument(board: DebtBoard, current: DebtDocument, input: UpdateDebtInput): DebtDocument | DebtRefusal {
  for (const related of input.dropRelates ?? [])
    if (!current.relates.includes(related)) {
      const owner = relatedOwner(board, current.id, related);
      if (owner !== null) return { kind: "relation-owned-by-other", debtId: current.id, related, declaringDebt: owner };
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

function updateFieldChanges(
  current: DebtDocument,
  next: DebtDocument,
  input: UpdateDebtInput,
): Extract<DebtUpdateResult, { kind: "accepted" }>["value"]["changedFields"] {
  const changes: Array<{ field: string; action: "added" | "replaced" | "cleared" | "changed" | "appended" }> = [];
  for (const field of ["title", "body", "note", "priority", "needs", "parent", "supersedes", "relates"] as const) {
    const before = current[field];
    const after = next[field];
    if (Array.isArray(before) && Array.isArray(after) ? before.join("\0") === after.join("\0") : before === after)
      continue;
    const action =
      field === "body" && input.appendBody !== undefined && input.body === undefined
        ? "appended"
        : typeof before === "string" && typeof after === "string"
          ? after.length === 0
            ? "cleared"
            : before.length === 0
              ? "added"
              : "replaced"
          : field === "parent" && after === null
            ? "cleared"
            : "changed";
    changes.push({ field, action });
  }
  return changes;
}

export async function updateDebt(world: WorldRoot, id: DebtId, input: UpdateDebtInput): Promise<DebtUpdateResult> {
  const result = await withDebtLocks(
    { world, allocation: false, ids: [id], ...(input.signal === undefined ? {} : { signal: input.signal }) },
    async (): Promise<DebtUpdateResult> => {
      const snapshot = await readBoard(world),
        current = snapshot.board.debts.get(id);
      if (current === undefined) return { kind: "refused", refusal: { kind: "debt-missing", debtId: id } };
      const candidate = updateDocument(snapshot.board, current, input);
      if ("kind" in candidate) return { kind: "refused", refusal: candidate };
      const problem = relationProblem(boardWith(snapshot.board, candidate), current, candidate);
      if (problem !== null) return { kind: "refused", refusal: { kind: "invalid-graph", diagnostic: problem } };
      const predecessor = snapshot.bytes.get(id)!;
      const before = Buffer.from(predecessor).toString("utf8");
      const changed = !Buffer.from(serializeDebtDocument(candidate)).equals(Buffer.from(predecessor));
      let next = candidate;
      if (changed) {
        const at = currentTimestamp();
        next = { ...candidate, updatedAt: advanceDebtTimestamp(current.updatedAt, at) };
      }
      const afterBytes = serializeDebtDocument(next);
      const after = Buffer.from(afterBytes).toString("utf8");
      if (
        before !== after &&
        (await replaceAuthority({ world, id, expected: predecessor, next: afterBytes })) !== "replaced"
      ) {
        return { kind: "retry", reason: "concurrent-modification" };
      }
      const label = `${id}.md`;
      return {
        kind: "accepted",
        value: {
          debt: debtView(next),
          documentDiff: documentDiff(label, label, before, after),
          changedFields: updateFieldChanges(current, next, input),
        },
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
export async function listDebts(
  world: WorldRoot,
  namespace: readonly string[] | undefined,
  selection: "active" | "closed" | "all",
  scope?: "namespace" | "world",
  limit?: number,
): Promise<DebtOutcome<DebtPage<DebtRow>>> {
  const selectedLimit = boundedListLimit(limit);
  const selected = readScope(namespace, scope);
  const board = (await readBoard(world)).board;
  return {
    kind: "accepted",
    value: projectBoundedList(projectRows(board, createDebtRelations(board), selected, selection), selectedLimit),
  };
}
export async function readDebtDetail(world: WorldRoot, id: DebtId): Promise<DebtDetailFacts | null> {
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
  return projectOwnedDetailFacts({ debts: selected }, id);
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
    return { kind: "refused", refusal: { kind: "debt-missing", debtId: input.parent } } as const;
  const relations = createDebtRelations(board);
  const scope = readScope(input.namespace, input.scope);
  const predicate: DebtQueryExpression = {
    kind: "predicate",
    predicate: { field: input.field, operator: "=", value: true },
  };
  return {
    kind: "accepted",
    value: {
      limit: boundedListLimit(input.limit),
      board,
      scope,
      relations,
      rows: projectQueryRows(board, relations, {
        scope,
        expression:
          input.parent === undefined ? predicate : { kind: "and", terms: [predicate, underExpression(input.parent)] },
      }),
    },
  } as const;
}
export async function readyDebts(
  world: WorldRoot,
  namespace: readonly string[] | undefined,
  scope?: "namespace" | "world",
  parent?: DebtId,
  limit?: number,
): Promise<DebtOutcome<DebtPage<DebtRow>>> {
  const queried = await readDebtQueryContext({ world, field: "ready", namespace, scope, parent, limit });
  if (queried.kind !== "accepted") return queried;
  const rows = queried.value.rows.map(
    ({ parent: _parent, needs: _needs, blocks: _blocks, createdAt: _createdAt, ...row }) => row,
  );
  return { kind: "accepted", value: projectBoundedList(rows, queried.value.limit) };
}
export async function blockedDebts(
  world: WorldRoot,
  namespace: readonly string[] | undefined,
  scope?: "namespace" | "world",
  parent?: DebtId,
  limit?: number,
): Promise<DebtOutcome<DebtPage<BlockedDebtRow>>> {
  const queried = await readDebtQueryContext({ world, field: "blocked", namespace, scope, parent, limit });
  if (queried.kind !== "accepted") return queried;
  const { board, scope: selected, relations, limit: selectedLimit, rows } = queried.value;
  const ids = new Set(rows.map((row) => row.id));
  return {
    kind: "accepted",
    value: projectBoundedList(
      projectBlocked(board, selected, relations).filter((row) => ids.has(row.id)),
      selectedLimit,
    ),
  };
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
): Promise<DebtOutcome<DebtPage<DebtQueryRow>>> {
  const selectedLimit = boundedListLimit(input.limit);
  const selected = readScope(input.namespace, input.scope);
  const board = (await readBoard(input.world)).board;
  const relations = createDebtRelations(board);
  for (const target of queryUnderTargets(input.expression))
    if (!board.debts.has(target)) {
      return { kind: "refused", refusal: { kind: "debt-missing", debtId: target } };
    }
  return {
    kind: "accepted",
    value: projectQuery(board, relations, {
      scope: selected as readonly string[] | null,
      expression: input.expression,
      sort: input.sort ?? "priority",
      limit: selectedLimit,
    }),
  };
}
export async function observeDebtBoard(world: WorldRoot): Promise<DebtBoardObservation> {
  return projectDebtBoardObservation((await readBoard(world)).board);
}
