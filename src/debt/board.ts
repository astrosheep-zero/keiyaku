import {
  debtNonblankTextSchema,
  debtStateSchema,
  debtPrioritySchema,
  type DebtDocument,
  type DebtState,
} from "./document.js";
import { debtIdSchema, parseDebtId, sameNamespace, type DebtId } from "./identity.js";
import { nonEmptyDebtValues, nonEmptyDebtArraySchema } from "./operation-types.js";
import { z } from "zod";

export const debtRefSchema = z
  .strictObject({
    id: debtIdSchema,
    state: z.union([debtStateSchema, z.literal("missing")]),
  })
  .readonly();
export type DebtRef = z.output<typeof debtRefSchema>;
const debtRowTimestampSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}, "expected canonical UTC ISO timestamp");
export const debtDispositionSchema = z.enum(["ready", "blocked", "done", "drop"]);
export type DebtDisposition = z.output<typeof debtDispositionSchema>;
export const readyDebtRowSchema = z
  .strictObject({
    id: debtIdSchema,
    title: debtNonblankTextSchema,
    priority: debtPrioritySchema,
  })
  .readonly();
export type ReadyDebtRow = z.output<typeof readyDebtRowSchema>;
export const debtSummarySchema = readyDebtRowSchema.unwrap().extend({ disposition: debtDispositionSchema }).readonly();
export type DebtSummary = z.output<typeof debtSummarySchema>;
const debtBlockerSchema = z.strictObject({ id: debtIdSchema, missing: z.literal(true).exactOptional() }).readonly();
export const blockedDebtRowSchema = readyDebtRowSchema
  .unwrap()
  .extend({
    blockers: nonEmptyDebtArraySchema(debtBlockerSchema),
  })
  .readonly();
export type BlockedDebtRow = z.output<typeof blockedDebtRowSchema>;
export const debtDetailSchema = z
  .strictObject({
    title: debtNonblankTextSchema,
    state: debtStateSchema,
    priority: debtPrioritySchema,
    createdAt: debtRowTimestampSchema,
    updatedAt: debtRowTimestampSchema,
    body: z.string().min(1).exactOptional(),
    note: z.string().min(1).exactOptional(),
    createdBy: z.string().exactOptional(),
    needs: nonEmptyDebtArraySchema(debtRefSchema).exactOptional(),
    parent: debtRefSchema.exactOptional(),
    supersedes: nonEmptyDebtArraySchema(debtRefSchema).exactOptional(),
    relates: nonEmptyDebtArraySchema(debtRefSchema).exactOptional(),
  })
  .readonly();
export type DebtDetail = z.output<typeof debtDetailSchema>;
const debtTreeFields = {
  title: debtNonblankTextSchema,
  state: debtStateSchema,
  priority: debtPrioritySchema,
};
export type DebtTreeNode =
  | Readonly<{
      kind: "node";
      id: DebtId;
      title: string;
      state: DebtState;
      priority: z.output<typeof debtPrioritySchema>;
      children?: readonly DebtTreeNode[];
    }>
  | Readonly<{ kind: "cycle"; id: DebtId }>;
export const debtTreeNodeSchema: z.ZodType<DebtTreeNode> = z.lazy(() =>
  z.union([
    z
      .strictObject({
        kind: z.literal("node"),
        id: debtIdSchema,
        ...debtTreeFields,
        children: nonEmptyDebtArraySchema(debtTreeNodeSchema).exactOptional(),
      })
      .readonly(),
    z.strictObject({ kind: z.literal("cycle"), id: debtIdSchema }).readonly(),
  ]),
);
export const debtTreeRootSchema = z
  .strictObject({
    ...debtTreeFields,
    children: nonEmptyDebtArraySchema(debtTreeNodeSchema).exactOptional(),
  })
  .readonly();
export type DebtTreeRoot = z.output<typeof debtTreeRootSchema>;
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
export const debtDoctorIssueSchema = z.union([
  z
    .strictObject({
      kind: z.literal("missing-target"),
      debtId: debtIdSchema,
      relation: z.enum(["needs", "parent", "supersedes", "relates"]),
      target: debtIdSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("self-relation"),
      debtId: debtIdSchema,
      relation: z.enum(["needs", "parent", "supersedes", "relates"]),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("cycle"),
      relation: z.enum(["needs", "parent", "supersedes"]),
      debts: z.array(debtIdSchema).min(2).readonly(),
    })
    .readonly(),
]);
export type DebtDoctorIssue = z.output<typeof debtDoctorIssueSchema>;

const terminal = (state: DebtState): boolean => state === "done" || state === "drop";
const none: readonly DebtRef[] = Object.freeze([]);
const sorted = <T extends { id: string }>(values: Iterable<T>): readonly T[] =>
  [...values].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
export function debtRef(board: DebtBoard, id: DebtId): DebtRef {
  const debt = board.debts.get(id);
  return debt === undefined ? { id, state: "missing" } : { id, state: debt.state };
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
}>;
export function createDebtRelations(board: DebtBoard): DebtRelationProjection {
  const children = new Map<DebtId, DebtId[]>();
  for (const debt of board.debts.values()) {
    if (debt.parent !== null) append(children, debt.parent, debt.id);
  }
  const childRefs = freezeRefs(board, children);
  return {
    children: (id) => childRefs.get(id) ?? none,
  };
}
export function debtDescendants(relations: DebtRelationProjection, parent: DebtId): ReadonlySet<DebtId> {
  const result = new Set<DebtId>();
  const pending = [parent];
  for (let index = 0; index < pending.length; index += 1) {
    for (const child of relations.children(pending[index]!)) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      pending.push(child.id);
    }
  }
  return result;
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
export function projectDebtDetail(board: DebtBoard, id: DebtId): DebtDetail | null {
  const debt = board.debts.get(id);
  if (debt === undefined) return null;
  const refs = (targets: readonly DebtId[]): readonly DebtRef[] => targets.map((target) => debtRef(board, target));
  return {
    title: debt.title,
    state: debt.state,
    priority: debt.priority,
    createdAt: debt.createdAt,
    updatedAt: debt.updatedAt,
    ...(debt.body.length === 0 ? {} : { body: debt.body }),
    ...(debt.note.length === 0 ? {} : { note: debt.note }),
    ...(debt.createdBy === undefined ? {} : { createdBy: debt.createdBy }),
    ...(debt.needs.length === 0 ? {} : { needs: refs(debt.needs) }),
    ...(debt.parent === null ? {} : { parent: debtRef(board, debt.parent) }),
    ...(debt.supersedes.length === 0 ? {} : { supersedes: refs(debt.supersedes) }),
    ...(debt.relates.length === 0 ? {} : { relates: refs(debt.relates) }),
  };
}
function inScope(debt: DebtDocument, scope: readonly string[] | null): boolean {
  return scope === null || sameNamespace(parseDebtId(debt.id).namespace, scope);
}
export function projectDebtSummary(board: DebtBoard, debt: DebtDocument): DebtSummary {
  return {
    id: debt.id,
    title: debt.title,
    priority: debt.priority,
    disposition: debtDisposition(board, debt),
  };
}
export function projectRows(
  board: DebtBoard,
  scope: readonly string[] | null,
  selection: "active" | "closed" | "all",
): readonly DebtSummary[] {
  return [...board.debts.values()]
    .filter((debt) => inScope(debt, scope))
    .filter((debt) => selection === "all" || (selection === "closed") === terminal(debt.state))
    .map((debt) => projectDebtSummary(board, debt))
    .sort(compareDebtRows);
}

/** The established Debt row order: priority first, then canonical identity bytes. */
function compareDebtRows(left: DebtSummary, right: DebtSummary): number {
  return left.priority - right.priority || Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
}

/**
 * Rows for requested creators, grouped by creator in established row order.
 */
export function projectCreatedByRows(
  board: DebtBoard,
  createdByIds: readonly string[],
): ReadonlyMap<string, readonly DebtSummary[]> {
  const requested = new Set(createdByIds);
  const attributed: { createdBy: string; row: DebtSummary }[] = [];
  for (const debt of board.debts.values()) {
    const createdBy = debt.createdBy;
    if (createdBy === undefined || !requested.has(createdBy)) continue;
    attributed.push({ createdBy, row: projectDebtSummary(board, debt) });
  }
  attributed.sort((left, right) => compareDebtRows(left.row, right.row));
  const grouped = new Map<string, DebtSummary[]>();
  for (const { createdBy, row } of attributed) {
    const rows = grouped.get(createdBy);
    if (rows === undefined) grouped.set(createdBy, [row]);
    else rows.push(row);
  }
  return grouped;
}
export function projectBlocked(board: DebtBoard, scope: readonly string[] | null): readonly BlockedDebtRow[] {
  return projectRows(board, scope, "active").flatMap((row) => {
    const debt = board.debts.get(row.id)!;
    if (!debtBlocked(board, debt)) return [];
    const blockers = nonEmptyDebtValues(
      debt.needs
        .filter((need) => !needReleased(board, need))
        .map((id) => ({
          id,
          ...(board.debts.has(id) ? {} : { missing: true as const }),
        })),
    );
    return blockers === undefined ? [] : [{ id: row.id, title: row.title, priority: row.priority, blockers }];
  });
}

export type DebtBoardObservation = Readonly<{
  statusRows: readonly DebtSummary[];
  selectNamespace(namespace: readonly string[]): readonly DebtSummary[];
  selectCreatedBy(createdBy: string): readonly DebtSummary[];
}>;

export function projectDebtBoardObservation(board: DebtBoard): DebtBoardObservation {
  const rows = projectRows(board, null, "all");
  return {
    statusRows: rows,
    selectNamespace: (namespace) => projectRows(board, namespace, "all"),
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

export function buildTree(board: DebtBoard, root: DebtId, relations: DebtRelationProjection): DebtTreeRoot | null {
  const rootDebt = board.debts.get(root);
  if (rootDebt === undefined) return null;
  const walk = (id: DebtId, path: readonly DebtId[]): DebtTreeNode => {
    if (path.includes(id)) return { kind: "cycle", id };
    const debt = board.debts.get(id)!;
    const children = nonEmptyDebtValues(relations.children(id).map((child) => walk(child.id, [...path, id])));
    return {
      kind: "node",
      id,
      title: debt.title,
      state: debt.state,
      priority: debt.priority,
      ...(children === undefined ? {} : { children }),
    };
  };
  const children = nonEmptyDebtValues(relations.children(root).map((child) => walk(child.id, [root])));
  return {
    title: rootDebt.title,
    state: rootDebt.state,
    priority: rootDebt.priority,
    ...(children === undefined ? {} : { children }),
  };
}
