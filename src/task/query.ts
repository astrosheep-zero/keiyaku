import type { TaskDocument, TaskPriority, TaskState } from "./document.js";
import { formatTaskId, parseTaskId, sameNamespace, type TaskId } from "./identity.js";
import type { BlockedTaskRow, TaskBoard, TaskRef, TaskRelationProjection, TaskRow } from "./board.js";
import { projectTaskRow, taskBlocked, taskDisposition, taskRef } from "./board.js";

export const DEFAULT_TASK_LIMIT = 100;
export const MAX_TASK_LIMIT = 1_000;
export const TASK_RELATION_PREDICATE_FIELDS = ["under", "needs", "blocks"] as const;
export type TaskRelationPredicateField = (typeof TASK_RELATION_PREDICATE_FIELDS)[number];
function isTaskRelationPredicateField(value: string): value is TaskRelationPredicateField {
  return (TASK_RELATION_PREDICATE_FIELDS as readonly string[]).includes(value);
}

export type TaskQueryComparison = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~";

export type TaskQueryPredicate =
  | Readonly<{ field: "state"; operator: "=" | "!="; value: TaskState }>
  | Readonly<{ field: "priority"; operator: "=" | "!=" | "<" | "<=" | ">" | ">="; value: TaskPriority }>
  | Readonly<{ field: "title" | "id"; operator: "=" | "!=" | "~"; value: string }>
  | Readonly<{ field: "parent"; operator: "=" | "!="; value: TaskId | null }>
  | Readonly<{ field: "under" | "needs" | "blocks"; operator: "=" | "!="; value: TaskId }>
  | Readonly<{ field: "ready" | "blocked"; operator: "=" | "!="; value: boolean }>
  | Readonly<{ field: "created" | "updated"; operator: "=" | "!=" | "<" | "<=" | ">" | ">="; value: string }>;

export type TaskQueryExpression =
  | Readonly<{ kind: "and" | "or"; terms: readonly TaskQueryExpression[] }>
  | Readonly<{ kind: "not"; term: TaskQueryExpression }>
  | Readonly<{ kind: "predicate"; predicate: TaskQueryPredicate }>;

export type TaskQuerySort = "priority" | "created" | "updated" | "id";
export type TaskQueryRow = TaskRow & Readonly<{
  parent: TaskId | null;
  needs: readonly TaskRef[];
  blocks: readonly TaskRef[];
  createdAt: string;
  updatedAt: string;
}>;
export type TaskPage<Row> = Readonly<{
  rows: readonly Row[];
  total: number;
  returned: number;
  truncated: boolean;
}>;

const states: readonly TaskState[] = ["open", "in_progress", "on_hold", "done", "drop"];
const comparisons: readonly TaskQueryComparison[] = ["=", "!=", "<", "<=", ">", ">=", "~"];

function fail(message: string): never { throw new TypeError(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${label} has unknown field: ${key}`);
}
function taskId(value: unknown, label: string): TaskId {
  if (typeof value !== "string") fail(`${label} must be a TaskId`);
  try {
    const coordinate = parseTaskId(value);
    if (formatTaskId(coordinate) !== value) fail(`${label} must be a canonical TaskId`);
  } catch { fail(`${label} must be a canonical TaskId`); }
  return value as TaskId;
}
function comparison(value: unknown): TaskQueryComparison {
  if (typeof value !== "string" || !comparisons.includes(value as TaskQueryComparison)) fail("query operator is invalid");
  return value as TaskQueryComparison;
}
function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail(`${field} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function equalityOperator(operator: TaskQueryComparison, field: string): "=" | "!=" {
  if (operator !== "=" && operator !== "!=") fail(`${field} supports only = and !=`);
  return operator;
}

function orderedOperator(
  operator: TaskQueryComparison,
  field: string,
): Exclude<TaskQueryComparison, "~"> {
  if (operator === "~") fail(`${field} does not support ~`);
  return operator;
}

function normalizeStatePredicate(
  input: Record<string, unknown>,
  operator: TaskQueryComparison,
): TaskQueryPredicate {
  if (typeof input.value !== "string" || !states.includes(input.value as TaskState)) fail("state value is invalid");
  return { field: "state", operator: equalityOperator(operator, "state"), value: input.value as TaskState };
}

function normalizePriorityPredicate(
  input: Record<string, unknown>,
  operator: TaskQueryComparison,
): TaskQueryPredicate {
  if (typeof input.value !== "number" || !Number.isInteger(input.value) || input.value < 0 || input.value > 3) {
    fail("priority value must be 0..3");
  }
  return { field: "priority", operator: orderedOperator(operator, "priority"), value: input.value as TaskPriority };
}

function normalizeTextPredicate(
  input: Record<string, unknown>,
  field: "title" | "id",
  operator: TaskQueryComparison,
): TaskQueryPredicate {
  if (typeof input.value !== "string" || input.value.length === 0) fail(`${field} value must be nonblank`);
  if (operator !== "=" && operator !== "!=" && operator !== "~") fail(`${field} supports only =, !=, and ~`);
  if (field === "id" && operator !== "~") taskId(input.value, "id value");
  return { field, operator, value: input.value };
}

function normalizeParentPredicate(
  input: Record<string, unknown>,
  operator: TaskQueryComparison,
): TaskQueryPredicate {
  const value = input.value === null ? null : taskId(input.value, "parent value");
  return { field: "parent", operator: equalityOperator(operator, "parent"), value };
}

function normalizeRelationPredicate(
  input: Record<string, unknown>,
  field: TaskRelationPredicateField,
  operator: TaskQueryComparison,
): TaskQueryPredicate {
  return { field, operator: equalityOperator(operator, field), value: taskId(input.value, `${field} value`) };
}

function normalizeBooleanPredicate(
  input: Record<string, unknown>,
  field: "ready" | "blocked",
  operator: TaskQueryComparison,
): TaskQueryPredicate {
  if (typeof input.value !== "boolean") fail(`${field} value must be boolean`);
  return { field, operator: equalityOperator(operator, field), value: input.value };
}

function normalizeTimestampPredicate(
  input: Record<string, unknown>,
  field: "created" | "updated",
  operator: TaskQueryComparison,
): TaskQueryPredicate {
  return { field, operator: orderedOperator(operator, field), value: timestamp(input.value, `${field} value`) };
}

function predicate(value: unknown): TaskQueryPredicate {
  const input = object(value, "query predicate");
  closed(input, ["field", "operator", "value"], "query predicate");
  const field = input.field;
  if (typeof field !== "string") fail("query predicate field is required");
  const operator = comparison(input.operator);
  switch (field) {
    case "state": return normalizeStatePredicate(input, operator);
    case "priority": return normalizePriorityPredicate(input, operator);
    case "title": return normalizeTextPredicate(input, "title", operator);
    case "id": return normalizeTextPredicate(input, "id", operator);
    case "parent": return normalizeParentPredicate(input, operator);
    case "ready": return normalizeBooleanPredicate(input, "ready", operator);
    case "blocked": return normalizeBooleanPredicate(input, "blocked", operator);
    case "created": return normalizeTimestampPredicate(input, "created", operator);
    case "updated": return normalizeTimestampPredicate(input, "updated", operator);
    default:
      if (isTaskRelationPredicateField(field)) return normalizeRelationPredicate(input, field, operator);
      return fail(`unknown query field: ${field}`);
  }
}

export function normalizeTaskQuery(value: unknown): TaskQueryExpression {
  const input = object(value, "query expression");
  if (input.kind === "predicate") { closed(input, ["kind", "predicate"], "query expression"); return { kind: "predicate", predicate: predicate(input.predicate) }; }
  if (input.kind === "not") { closed(input, ["kind", "term"], "query expression"); return { kind: "not", term: normalizeTaskQuery(input.term) }; }
  if (input.kind === "and" || input.kind === "or") {
    closed(input, ["kind", "terms"], "query expression");
    if (!Array.isArray(input.terms) || input.terms.length === 0) fail(`${input.kind} query requires terms`);
    return { kind: input.kind, terms: input.terms.map((term) => normalizeTaskQuery(term)) };
  }
  fail("query expression kind is invalid");
}

function compare(left: string | number, operator: Exclude<TaskQueryComparison, "~">, right: string | number): boolean {
  if (operator === "=") return left === right;
  if (operator === "!=") return left !== right;
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  if (operator === ">") return left > right;
  return left >= right;
}
function membership(left: boolean, operator: "=" | "!=", right: boolean): boolean { return operator === "=" ? left === right : left !== right; }

function descendants(relations: TaskRelationProjection, parent: TaskId): Set<TaskId> {
  const result = new Set<TaskId>(), pending = [parent];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const child of relations.children(current)) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      pending.push(child.id);
    }
  }
  return result;
}
function relation(
  board: TaskBoard,
  relations: TaskRelationProjection,
  id: TaskId,
  field: "needs" | "blocks",
  target: TaskId,
): boolean {
  const task = board.tasks.get(id);
  if (task === undefined) return false;
  return field === "needs" ? task.needs.includes(target) : relations.blocks(id).some((ref) => ref.id === target);
}

function matchText(left: string, operator: "=" | "!=" | "~", right: string): boolean {
  return operator === "~" ? left.includes(right) : compare(left, operator, right);
}

function matchRelation(selected: boolean, operator: "=" | "!="): boolean {
  return operator === "=" ? selected : !selected;
}

function matchesPredicate(
  board: TaskBoard,
  relations: TaskRelationProjection,
  task: TaskDocument,
  value: TaskQueryPredicate,
  under: ReadonlyMap<TaskId, Set<TaskId>>,
): boolean {
  switch (value.field) {
    case "state": return compare(task.state, value.operator, value.value);
    case "priority": return compare(task.priority, value.operator, value.value);
    case "title": return matchText(task.title, value.operator, value.value);
    case "id": return matchText(task.id, value.operator, value.value);
    case "parent": return compare(task.parent ?? "", value.operator, value.value ?? "");
    case "under": return matchRelation(under.get(value.value)?.has(task.id) === true, value.operator);
    case "needs": return matchRelation(relation(board, relations, task.id, "needs", value.value), value.operator);
    case "blocks": return matchRelation(relation(board, relations, task.id, "blocks", value.value), value.operator);
    case "ready": return membership(taskDisposition(board, task) === "ready", value.operator, value.value);
    case "blocked": return membership(taskBlocked(board, task), value.operator, value.value);
    case "created": return compare(task.createdAt, value.operator, value.value);
    case "updated": return compare(task.updatedAt, value.operator, value.value);
  }
}

function matches(
  board: TaskBoard,
  relations: TaskRelationProjection,
  task: TaskDocument,
  expression: TaskQueryExpression,
  under: ReadonlyMap<TaskId, Set<TaskId>>,
): boolean {
  if (expression.kind === "not") return !matches(board, relations, task, expression.term, under);
  if (expression.kind !== "predicate") {
    return expression.kind === "and"
      ? expression.terms.every((term) => matches(board, relations, task, term, under))
      : expression.terms.some((term) => matches(board, relations, task, term, under));
  }
  return matchesPredicate(board, relations, task, expression.predicate, under);
}
function row(board: TaskBoard, relations: TaskRelationProjection, task: TaskDocument): TaskQueryRow {
  return {
    ...projectTaskRow(board, relations, task),
    parent: task.parent,
    needs: task.needs.map((need) => taskRef(board, need)),
    blocks: relations.blocks(task.id),
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}
function sortTasks(tasks: readonly TaskDocument[], sort: TaskQuerySort): readonly TaskDocument[] {
  return [...tasks].sort((left, right) => {
    const tie = Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
    if (sort === "id") return tie;
    if (sort === "priority") return left.priority - right.priority || tie;
    const compared = left[sort === "created" ? "createdAt" : "updatedAt"].localeCompare(right[sort === "created" ? "createdAt" : "updatedAt"]);
    return (sort === "updated" ? -compared : compared) || tie;
  });
}
export function projectQuery(
  board: TaskBoard,
  relations: TaskRelationProjection,
  input: Readonly<{
    scope: readonly string[] | null;
    expression: TaskQueryExpression;
    sort?: TaskQuerySort;
    limit?: number;
  }>,
): TaskPage<TaskQueryRow> {
  const { scope, expression, sort = "priority", limit = DEFAULT_TASK_LIMIT } = input;
  const under = new Map(queryUnderTargets(expression).map((target) => [target, descendants(relations, target)]));
  const selected = sortTasks([...board.tasks.values()].filter((task) => scope === null || sameNamespace(parseTaskId(task.id).namespace, scope))
    .filter((task) => matches(board, relations, task, expression, under)), sort);
  const rows = selected.slice(0, limit).map((task) => row(board, relations, task));
  return { rows, total: selected.length, returned: rows.length, truncated: rows.length < selected.length };
}

export function projectPage<Row>(rows: readonly Row[], limit = DEFAULT_TASK_LIMIT): TaskPage<Row> {
  const visible = rows.slice(0, limit);
  return { rows: visible, total: rows.length, returned: visible.length, truncated: visible.length < rows.length };
}

export function underExpression(parent: TaskId): TaskQueryExpression {
  return { kind: "predicate", predicate: { field: "under", operator: "=", value: parent } };
}

export function queryUnderTargets(expression: TaskQueryExpression): readonly TaskId[] {
  const targets = new Set<TaskId>();
  function collect(value: TaskQueryExpression): void {
    if (value.kind === "predicate" && value.predicate.field === "under") targets.add(value.predicate.value);
    else if (value.kind === "not") collect(value.term);
    else if (value.kind !== "predicate") value.terms.forEach(collect);
  }
  collect(expression);
  return [...targets];
}

export function isValidTaskLimit(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_TASK_LIMIT;
}

export type TaskQueryPage = TaskPage<TaskQueryRow>;
export type TaskBlockedPage = TaskPage<BlockedTaskRow>;
