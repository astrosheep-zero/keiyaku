import {
  debtNonblankTextSchema,
  debtStateSchema,
  debtPrioritySchema,
  type DebtDocument,
  type DebtPriority,
  type DebtState,
} from "./document.js";
import { debtIdSchema, parseDebtId, sameNamespace, type DebtId } from "./identity.js";
import { z } from "zod";
import { boundedListLimit, projectBoundedList, type BoundedList } from "../bounded-list.js";

export type DebtRef = Readonly<{ id: DebtId; title: string | null; state: DebtState | "missing" }>;
const debtRowTimestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "expected timestamp");
export const debtRowSchema = z
  .object({
    id: debtIdSchema,
    title: debtNonblankTextSchema,
    state: debtStateSchema,
    priority: debtPrioritySchema,
    disposition: z.enum(["ready", "blocked", "done", "drop"]),
    updatedAt: debtRowTimestampSchema,
    bodyPresent: z.boolean(),
    children: z
      .object({ live: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export const debtRowsSchema = z.array(debtRowSchema).readonly();
export type DebtDisposition = z.infer<typeof debtRowSchema>["disposition"];
export type DebtRow = z.infer<typeof debtRowSchema>;
export type BlockedDebtRow = DebtRow & Readonly<{ blockers: readonly DebtRef[] }>;
export type DebtDetailFacts = Readonly<{
  debt: DebtDocument;
  needs: readonly (DebtRef & Readonly<{ released: boolean }>)[];
  blockers: readonly DebtRef[];
  blocks: readonly DebtRef[];
  parent: DebtRef | null;
  children: readonly DebtRef[];
  supersedes: readonly DebtRef[];
  supersededBy: readonly DebtRef[];
  related: readonly DebtRef[];
}>;
export type DebtTreeNode = Readonly<{
  debt: DebtRef & Readonly<{ priority: DebtPriority | null }>;
  cycle?: true;
  children: readonly DebtTreeNode[];
}>;
export type DebtBoard = Readonly<{ debts: ReadonlyMap<DebtId, DebtDocument> }>;

/** The local ids occupied across one namespace of the current board. */
export function occupiedLocalIds(board: DebtBoard, namespace: readonly string[]): Set<string> {
  return new Set(
    [...board.debts.values()].flatMap((debt) => {
      const coordinate = parseDebtId(debt.id);
      return sameNamespace(coordinate.namespace, namespace) ? [coordinate.localId] : [];
    }),
  );
}

type DebtRelation = "needs" | "parent" | "supersedes" | "relates";
export type DebtDoctorIssue =
  | Readonly<{ kind: "missing-target"; debtId: DebtId; relation: DebtRelation; target: DebtId }>
  | Readonly<{ kind: "self-relation"; debtId: DebtId; relation: DebtRelation }>
  | Readonly<{ kind: "cycle"; relation: "needs" | "parent" | "supersedes"; debts: readonly DebtId[] }>;

const terminal = (state: DebtState): boolean => state === "done" || state === "drop";
const none: readonly DebtRef[] = Object.freeze([]);
const sorted = <T extends { id: string }>(values: Iterable<T>): readonly T[] =>
  [...values].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
export function debtRef(board: DebtBoard, id: DebtId): DebtRef {
  const debt = board.debts.get(id);
  return debt === undefined ? { id, title: null, state: "missing" } : { id, title: debt.title, state: debt.state };
}
function append(index: Map<DebtId, DebtId[]>, key: DebtId, value: DebtId): void {
  const values = index.get(key);
  if (values === undefined) index.set(key, [value]);
  else values.push(value);
}
function freezeRefs(
  board: DebtBoard,
  index: ReadonlyMap<DebtId, readonly DebtId[]>,
): ReadonlyMap<DebtId, readonly DebtRef[]> {
  return new Map([...index].map(([id, targets]) => [id, sorted(targets.map((target) => debtRef(board, target)))]));
}
export type DebtRelationProjection = Readonly<{
  children(id: DebtId): readonly DebtRef[];
  blocks(id: DebtId): readonly DebtRef[];
  supersededBy(id: DebtId): readonly DebtRef[];
  related(id: DebtId): readonly DebtRef[];
}>;
export function createDebtRelations(board: DebtBoard): DebtRelationProjection {
  const children = new Map<DebtId, DebtId[]>();
  const blocks = new Map<DebtId, DebtId[]>();
  const supersededBy = new Map<DebtId, DebtId[]>();
  const incoming = new Map<DebtId, DebtId[]>();
  for (const debt of board.debts.values()) {
    if (debt.parent !== null) append(children, debt.parent, debt.id);
    for (const need of debt.needs) append(blocks, need, debt.id);
    for (const target of debt.supersedes) append(supersededBy, target, debt.id);
    for (const target of debt.relates) append(incoming, target, debt.id);
  }
  const childRefs = freezeRefs(board, children);
  const blockRefs = freezeRefs(board, blocks);
  const successorRefs = freezeRefs(board, supersededBy);
  const incomingRefs = freezeRefs(board, incoming);
  return {
    children: (id) => childRefs.get(id) ?? none,
    blocks: (id) => blockRefs.get(id) ?? none,
    supersededBy: (id) => successorRefs.get(id) ?? none,
    related: (id) => {
      const debt = board.debts.get(id);
      const ids = new Set<DebtId>(debt?.relates ?? []);
      for (const ref of incomingRefs.get(id) ?? none) ids.add(ref.id);
      return ids.size === 0 ? none : sorted([...ids].map((related) => debtRef(board, related)));
    },
  };
}
function needReleased(board: DebtBoard, id: DebtId): boolean {
  const target = board.debts.get(id);
  return target !== undefined && terminal(target.state);
}
function hasUnresolvedNeeds(board: DebtBoard, debt: DebtDocument): boolean {
  return debt.needs.some((id) => !needReleased(board, id));
}
export function debtDisposition(board: DebtBoard, debt: DebtDocument): DebtDisposition {
  if (debt.state !== "open") return debt.state;
  return hasUnresolvedNeeds(board, debt) ? "blocked" : "ready";
}
export function debtBlocked(board: DebtBoard, debt: DebtDocument): boolean {
  return debt.state === "open" && hasUnresolvedNeeds(board, debt);
}
export function projectOwnedDetailFacts(board: DebtBoard, id: DebtId): DebtDetailFacts | null {
  const debt = board.debts.get(id);
  if (debt === undefined) return null;
  const needs = debt.needs.map((need) => ({ ...debtRef(board, need), released: needReleased(board, need) }));
  return {
    debt,
    needs,
    blockers: needs.filter((need) => !need.released).map(({ released: _released, ...ref }) => ref),
    blocks: none,
    parent: debt.parent === null ? null : debtRef(board, debt.parent),
    children: none,
    supersedes: debt.supersedes.map((target) => debtRef(board, target)),
    supersededBy: none,
    related: debt.relates.length === 0 ? none : sorted(debt.relates.map((target) => debtRef(board, target))),
  };
}

export function projectDetailFacts(
  board: DebtBoard,
  id: DebtId,
  relations: DebtRelationProjection,
): DebtDetailFacts | null {
  const owned = projectOwnedDetailFacts(board, id);
  if (owned === null) return null;
  return {
    ...owned,
    blocks: relations.blocks(id),
    children: relations.children(id),
    supersededBy: relations.supersededBy(id),
    related: relations.related(id),
  };
}
function inScope(debt: DebtDocument, scope: readonly string[] | null): boolean {
  return scope === null || sameNamespace(parseDebtId(debt.id).namespace, scope);
}
export function projectDebtRow(board: DebtBoard, relations: DebtRelationProjection, debt: DebtDocument): DebtRow {
  const children = relations.children(debt.id);
  const total = children.length;
  const live = children.filter((child) => child.state !== "done" && child.state !== "drop").length;
  return {
    id: debt.id,
    title: debt.title,
    state: debt.state,
    priority: debt.priority,
    disposition: debtDisposition(board, debt),
    updatedAt: debt.updatedAt,
    bodyPresent: debt.body.length > 0,
    ...(total === 0 ? {} : { children: { live, total } }),
  };
}
export function projectRows(
  board: DebtBoard,
  relations: DebtRelationProjection,
  scope: readonly string[] | null,
  selection: "active" | "closed" | "all",
): readonly DebtRow[] {
  return [...board.debts.values()]
    .filter((debt) => inScope(debt, scope))
    .filter((debt) => selection === "all" || (selection === "closed") === terminal(debt.state))
    .map((debt) => projectDebtRow(board, relations, debt))
    .sort(compareDebtRows);
}

/** The established Debt row order: priority first, then canonical identity bytes. */
function compareDebtRows(left: DebtRow, right: DebtRow): number {
  return left.priority - right.priority || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
}

/**
 * Rows for the identities that created work, grouped by creator. Only documents a
 * requested identity created reach row projection, and each group keeps the
 * established row order.
 */
export function projectCreatedByRows(
  board: DebtBoard,
  relations: DebtRelationProjection,
  createdByIds: readonly string[],
): ReadonlyMap<string, readonly DebtRow[]> {
  const requested = new Set(createdByIds);
  const attributed: { createdBy: string; row: DebtRow }[] = [];
  for (const debt of board.debts.values()) {
    const createdBy = debt.createdBy;
    if (createdBy === undefined || !requested.has(createdBy)) continue;
    attributed.push({ createdBy, row: projectDebtRow(board, relations, debt) });
  }
  attributed.sort((left, right) => compareDebtRows(left.row, right.row));
  const grouped = new Map<string, DebtRow[]>();
  for (const { createdBy, row } of attributed) {
    const rows = grouped.get(createdBy);
    if (rows === undefined) grouped.set(createdBy, [row]);
    else rows.push(row);
  }
  return grouped;
}
export function projectBlocked(
  board: DebtBoard,
  scope: readonly string[] | null,
  relations: DebtRelationProjection,
): readonly BlockedDebtRow[] {
  return projectRows(board, relations, scope, "active").flatMap((row) => {
    if (!debtBlocked(board, board.debts.get(row.id)!)) return [];
    return [{ ...row, blockers: projectDetailFacts(board, row.id, relations)!.blockers }];
  });
}

export function projectStatusRows(
  board: DebtBoard,
  relations: DebtRelationProjection,
  scope: readonly string[] | null,
) {
  const blockers = new Map(projectBlocked(board, scope, relations).map((row) => [row.id, row.blockers]));
  return projectRows(board, relations, scope, "all").map((row) => {
    const unresolved = blockers.get(row.id);
    return unresolved === undefined ? row : { ...row, blockers: unresolved };
  });
}

export type DebtBoardObservation = Readonly<{
  statusRows: ReturnType<typeof projectStatusRows>;
  selectRecentStatus(limit?: number): BoundedList<ReturnType<typeof projectStatusRows>[number]>;
  selectNamespace(namespace: readonly string[]): readonly DebtRow[];
  selectCreatedBy(createdBy: string): readonly DebtRow[];
}>;

export function projectDebtBoardObservation(board: DebtBoard): DebtBoardObservation {
  const relations = createDebtRelations(board);
  const rows = projectRows(board, relations, null, "all");
  const statusRows = projectStatusRows(board, relations, null);
  return {
    statusRows,
    selectRecentStatus: (limit) =>
      projectBoundedList(
        statusRows
          .filter((row) => row.state !== "done" && row.state !== "drop")
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
          ),
        boundedListLimit(limit),
      ),
    selectNamespace: (namespace) => projectRows(board, relations, namespace, "all"),
    selectCreatedBy: (createdBy) => rows.filter((row) => board.debts.get(row.id)?.createdBy === createdBy),
  };
}

function relationIds(debt: DebtDocument, relation: DebtRelation): readonly DebtId[] {
  return relation === "parent" ? (debt.parent === null ? [] : [debt.parent]) : debt[relation];
}
export function relationProblem(board: DebtBoard, before: DebtDocument | null, after: DebtDocument): string | null {
  for (const relation of ["needs", "parent", "supersedes", "relates"] as const) {
    const previous = new Set(before === null ? [] : relationIds(before, relation));
    for (const target of relationIds(after, relation)) {
      if (previous.has(target)) continue;
      if (target === after.id) return `${after.id} has a self ${relation} relation`;
      if (!board.debts.has(target)) return `${after.id} ${relation} target does not exist: ${target}`;
    }
  }
  return null;
}

function cycleComponents(
  board: DebtBoard,
  relation: "needs" | "parent" | "supersedes",
): readonly (readonly DebtId[])[] {
  const ids = sorted([...board.debts.keys()].map((id) => ({ id }))).map(({ id }) => id as DebtId);
  const edges = new Map(
    ids.map((id) => [id, relationIds(board.debts.get(id)!, relation).filter((target) => board.debts.has(target))]),
  );
  const reverse = new Map(ids.map((id) => [id, [] as DebtId[]]));
  for (const [id, targets] of edges) for (const target of targets) reverse.get(target)!.push(id);

  const visited = new Set<DebtId>(),
    finished: DebtId[] = [];
  for (const root of ids) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack: { id: DebtId; index: number }[] = [{ id: root, index: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!,
        targets = edges.get(frame.id)!;
      if (frame.index < targets.length) {
        const target = targets[frame.index++]!;
        if (!visited.has(target)) {
          visited.add(target);
          stack.push({ id: target, index: 0 });
        }
      } else {
        finished.push(frame.id);
        stack.pop();
      }
    }
  }

  const assigned = new Set<DebtId>(),
    components: DebtId[][] = [];
  for (const root of finished.reverse()) {
    if (assigned.has(root)) continue;
    const component: DebtId[] = [],
      stack = [root];
    assigned.add(root);
    while (stack.length > 0) {
      const id = stack.pop()!;
      component.push(id);
      for (const target of reverse.get(id)!)
        if (!assigned.has(target)) {
          assigned.add(target);
          stack.push(target);
        }
    }
    if (component.length > 1) components.push(sorted(component.map((id) => ({ id }))).map(({ id }) => id as DebtId));
  }
  return components.sort((left, right) => Buffer.compare(Buffer.from(left.join("\0")), Buffer.from(right.join("\0"))));
}

export function diagnoseBoard(board: DebtBoard): readonly DebtDoctorIssue[] {
  const issues: DebtDoctorIssue[] = [];
  for (const debt of sorted(board.debts.values()))
    for (const relation of ["needs", "parent", "supersedes", "relates"] as const) {
      for (const target of relationIds(debt, relation)) {
        if (target === debt.id) issues.push({ kind: "self-relation", debtId: debt.id, relation });
        else if (!board.debts.has(target)) issues.push({ kind: "missing-target", debtId: debt.id, relation, target });
      }
    }
  for (const relation of ["needs", "parent", "supersedes"] as const) {
    for (const debts of cycleComponents(board, relation)) issues.push({ kind: "cycle", relation, debts });
  }
  return issues;
}

export function buildTree(board: DebtBoard, root: DebtId, relations: DebtRelationProjection): DebtTreeNode | null {
  if (!board.debts.has(root)) return null;
  const walk = (id: DebtId, path: readonly DebtId[]): DebtTreeNode => {
    const ref = debtRef(board, id);
    const debt = board.debts.get(id);
    const node = { debt: { ...ref, priority: debt?.priority ?? null } };
    if (path.includes(id)) return { ...node, cycle: true, children: [] };
    return { ...node, children: relations.children(id).map((child) => walk(child.id, [...path, id])) };
  };
  return walk(root, []);
}
