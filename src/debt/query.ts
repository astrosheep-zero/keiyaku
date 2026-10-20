import type { DebtDocument, DebtPriority, DebtState } from "./document.js";
import { formatDebtId, parseDebtId, sameNamespace, type DebtId } from "./identity.js";
import type { DebtBoard, DebtRef, DebtRelationProjection, DebtRow } from "./board.js";
import { projectDebtRow, debtBlocked, debtDisposition, debtRef } from "./board.js";
import { projectBoundedList, type BoundedList } from "../bounded-list.js";

export const DEBT_RELATION_PREDICATE_FIELDS = ["under", "needs", "blocks"] as const;
export type DebtRelationPredicateField = (typeof DEBT_RELATION_PREDICATE_FIELDS)[number];

type DebtQueryComparison = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~";

export type DebtQueryPredicate =
  | Readonly<{ field: "state"; operator: "=" | "!="; value: DebtState }>
  | Readonly<{ field: "priority"; operator: "=" | "!=" | "<" | "<=" | ">" | ">="; value: DebtPriority }>
  | Readonly<{ field: "title" | "id"; operator: "=" | "!=" | "~"; value: string }>
  | Readonly<{ field: "parent"; operator: "=" | "!="; value: DebtId | null }>
  | Readonly<{ field: "under" | "needs" | "blocks"; operator: "=" | "!="; value: DebtId }>
  | Readonly<{ field: "ready" | "blocked"; operator: "=" | "!="; value: boolean }>
  | Readonly<{ field: "created" | "updated"; operator: "=" | "!=" | "<" | "<=" | ">" | ">="; value: string }>;

export type DebtQueryExpression =
  | Readonly<{ kind: "and" | "or"; terms: readonly DebtQueryExpression[] }>
  | Readonly<{ kind: "not"; term: DebtQueryExpression }>
  | Readonly<{ kind: "predicate"; predicate: DebtQueryPredicate }>;

export type DebtQuerySort = "priority" | "created" | "updated" | "id";
export type DebtQueryRow = DebtRow &
  Readonly<{
    parent: DebtId | null;
    needs: readonly DebtRef[];
    blocks: readonly DebtRef[];
    createdAt: string;
    updatedAt: string;
  }>;
export type DebtPage<Row> = BoundedList<Row>;

const states: readonly DebtState[] = ["open", "done", "drop"];
const comparisons: readonly DebtQueryComparison[] = ["=", "!=", "<", "<=", ">", ">=", "~"];

function fail(message: string): never {
  throw new TypeError(message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${label} has unknown field: ${key}`);
}
/** Semantic refusals identify the caller input part; textual offsets belong to the CLI. */
export class DebtQueryPredicateError extends TypeError {
  constructor(
    message: string,
    readonly part: "field" | "operator" | "value",
  ) {
    super(message);
  }
}

function invalidPredicate(message: string, part: DebtQueryPredicateError["part"] = "value"): never {
  throw new DebtQueryPredicateError(message, part);
}

function debtId(value: unknown, label: string): DebtId {
  if (typeof value !== "string") invalidPredicate(`${label} must be a DebtId`);
  try {
    const coordinate = parseDebtId(value);
    if (formatDebtId(coordinate) !== value) invalidPredicate(`${label} must be a canonical DebtId`);
  } catch {
    invalidPredicate(`${label} must be a canonical DebtId`);
  }
  return value as DebtId;
}
function comparison(value: unknown): DebtQueryComparison {
  if (typeof value !== "string" || !comparisons.includes(value as DebtQueryComparison))
    invalidPredicate("query operator is invalid", "operator");
  return value as DebtQueryComparison;
}
function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    invalidPredicate(`${field} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function equalityOperator(operator: DebtQueryComparison, field: string): "=" | "!=" {
  if (operator !== "=" && operator !== "!=") invalidPredicate(`${field} supports only = and !=`, "operator");
  return operator;
}

function orderedOperator(operator: DebtQueryComparison, field: string): Exclude<DebtQueryComparison, "~"> {
  if (operator === "~") invalidPredicate(`${field} does not support ~`, "operator");
  return operator;
}

function normalizeStatePredicate(input: Record<string, unknown>, operator: DebtQueryComparison): DebtQueryPredicate {
  if (typeof input.value !== "string" || !states.includes(input.value as DebtState))
    invalidPredicate("state value is invalid");
  return { field: "state", operator: equalityOperator(operator, "state"), value: input.value as DebtState };
}

function normalizePriorityPredicate(input: Record<string, unknown>, operator: DebtQueryComparison): DebtQueryPredicate {
  if (typeof input.value !== "number" || !Number.isInteger(input.value) || input.value < 0 || input.value > 3) {
    invalidPredicate("priority value must be 0..3");
  }
  return { field: "priority", operator: orderedOperator(operator, "priority"), value: input.value as DebtPriority };
}

function normalizeTextPredicate(
  input: Record<string, unknown>,
  field: "title" | "id",
  operator: DebtQueryComparison,
): DebtQueryPredicate {
  if (typeof input.value !== "string" || input.value.length === 0) invalidPredicate(`${field} value must be nonblank`);
  if (operator !== "=" && operator !== "!=" && operator !== "~")
    invalidPredicate(`${field} supports only =, !=, and ~`, "operator");
  if (field === "id" && operator !== "~") debtId(input.value, "id value");
  return { field, operator, value: input.value };
}

function normalizeParentPredicate(input: Record<string, unknown>, operator: DebtQueryComparison): DebtQueryPredicate {
  const value = input.value === null ? null : debtId(input.value, "parent value");
  return { field: "parent", operator: equalityOperator(operator, "parent"), value };
}

function normalizeRelationPredicate(
  input: Record<string, unknown>,
  field: DebtRelationPredicateField,
  operator: DebtQueryComparison,
): DebtQueryPredicate {
  return { field, operator: equalityOperator(operator, field), value: debtId(input.value, `${field} value`) };
}

function normalizeBooleanPredicate(
  input: Record<string, unknown>,
  field: "ready" | "blocked",
  operator: DebtQueryComparison,
): DebtQueryPredicate {
  if (typeof input.value !== "boolean") invalidPredicate(`${field} value must be boolean`);
  return { field, operator: equalityOperator(operator, field), value: input.value };
}

function normalizeTimestampPredicate(
  input: Record<string, unknown>,
  field: "created" | "updated",
  operator: DebtQueryComparison,
): DebtQueryPredicate {
  return { field, operator: orderedOperator(operator, field), value: timestamp(input.value, `${field} value`) };
}

export function normalizeDebtQueryPredicate(value: unknown): DebtQueryPredicate {
  const input = object(value, "query predicate");
  closed(input, ["field", "operator", "value"], "query predicate");
  const field = input.field;
  if (typeof field !== "string") invalidPredicate("query predicate field is required", "field");
  const operator = comparison(input.operator);
  switch (field) {
    case "state":
      return normalizeStatePredicate(input, operator);
    case "priority":
      return normalizePriorityPredicate(input, operator);
    case "title":
      return normalizeTextPredicate(input, "title", operator);
    case "id":
      return normalizeTextPredicate(input, "id", operator);
    case "parent":
      return normalizeParentPredicate(input, operator);
    case "ready":
      return normalizeBooleanPredicate(input, "ready", operator);
    case "blocked":
      return normalizeBooleanPredicate(input, "blocked", operator);
    case "created":
      return normalizeTimestampPredicate(input, "created", operator);
    case "updated":
      return normalizeTimestampPredicate(input, "updated", operator);
    default:
      if (field === "under" || field === "needs" || field === "blocks")
        return normalizeRelationPredicate(input, field, operator);
      return invalidPredicate(`unknown query field: ${field}`, "field");
  }
}

export function normalizeDebtQuery(value: unknown): DebtQueryExpression {
  const input = object(value, "query expression");
  if (input.kind === "predicate") {
    closed(input, ["kind", "predicate"], "query expression");
    return { kind: "predicate", predicate: normalizeDebtQueryPredicate(input.predicate) };
  }
  if (input.kind === "not") {
    closed(input, ["kind", "term"], "query expression");
    return { kind: "not", term: normalizeDebtQuery(input.term) };
  }
  if (input.kind === "and" || input.kind === "or") {
    closed(input, ["kind", "terms"], "query expression");
    if (!Array.isArray(input.terms) || input.terms.length === 0) fail(`${input.kind} query requires terms`);
    return { kind: input.kind, terms: input.terms.map((term) => normalizeDebtQuery(term)) };
  }
  fail("query expression kind is invalid");
}

/** CLI selection and native default share Debt-owned terminal-state semantics. */
export function debtQuerySelection(
  selection: "active" | "closed" | "all" = "active",
  where?: DebtQueryExpression,
): DebtQueryExpression {
  if (selection === "all" && where !== undefined) return where;
  const state = (value: "done" | "drop", operator: "=" | "!="): DebtQueryExpression => ({
    kind: "predicate",
    predicate: { field: "state", operator, value },
  });
  const selected: DebtQueryExpression =
    selection === "all"
      ? { kind: "or", terms: [state("done", "="), state("done", "!=")] }
      : selection === "closed"
        ? { kind: "or", terms: [state("done", "="), state("drop", "=")] }
        : { kind: "and", terms: [state("done", "!="), state("drop", "!=")] };
  return where === undefined ? selected : { kind: "and", terms: [selected, where] };
}

function compare(left: string | number, operator: Exclude<DebtQueryComparison, "~">, right: string | number): boolean {
  if (operator === "=") return left === right;
  if (operator === "!=") return left !== right;
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  if (operator === ">") return left > right;
  return left >= right;
}
function membership(left: boolean, operator: "=" | "!=", right: boolean): boolean {
  return operator === "=" ? left === right : left !== right;
}

function descendants(relations: DebtRelationProjection, parent: DebtId): Set<DebtId> {
  const result = new Set<DebtId>(),
    pending = [parent];
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
  board: DebtBoard,
  relations: DebtRelationProjection,
  id: DebtId,
  field: "needs" | "blocks",
  target: DebtId,
): boolean {
  const debt = board.debts.get(id);
  if (debt === undefined) return false;
  return field === "needs" ? debt.needs.includes(target) : relations.blocks(id).some((ref) => ref.id === target);
}

function matchText(left: string, operator: "=" | "!=" | "~", right: string): boolean {
  return operator === "~" ? left.includes(right) : compare(left, operator, right);
}

function matchRelation(selected: boolean, operator: "=" | "!="): boolean {
  return operator === "=" ? selected : !selected;
}

function matchesPredicate(
  board: DebtBoard,
  relations: DebtRelationProjection,
  debt: DebtDocument,
  value: DebtQueryPredicate,
  under: ReadonlyMap<DebtId, Set<DebtId>>,
): boolean {
  switch (value.field) {
    case "state":
      return compare(debt.state, value.operator, value.value);
    case "priority":
      return compare(debt.priority, value.operator, value.value);
    case "title":
      return matchText(debt.title, value.operator, value.value);
    case "id":
      return matchText(debt.id, value.operator, value.value);
    case "parent":
      return compare(debt.parent ?? "", value.operator, value.value ?? "");
    case "under":
      return matchRelation(under.get(value.value)?.has(debt.id) === true, value.operator);
    case "needs":
      return matchRelation(relation(board, relations, debt.id, "needs", value.value), value.operator);
    case "blocks":
      return matchRelation(relation(board, relations, debt.id, "blocks", value.value), value.operator);
    case "ready":
      return membership(debtDisposition(board, debt) === "ready", value.operator, value.value);
    case "blocked":
      return membership(debtBlocked(board, debt), value.operator, value.value);
    case "created":
      return compare(debt.createdAt, value.operator, value.value);
    case "updated":
      return compare(debt.updatedAt, value.operator, value.value);
  }
}

function matches(
  board: DebtBoard,
  relations: DebtRelationProjection,
  debt: DebtDocument,
  expression: DebtQueryExpression,
  under: ReadonlyMap<DebtId, Set<DebtId>>,
): boolean {
  if (expression.kind === "not") return !matches(board, relations, debt, expression.term, under);
  if (expression.kind !== "predicate") {
    return expression.kind === "and"
      ? expression.terms.every((term) => matches(board, relations, debt, term, under))
      : expression.terms.some((term) => matches(board, relations, debt, term, under));
  }
  return matchesPredicate(board, relations, debt, expression.predicate, under);
}
function row(board: DebtBoard, relations: DebtRelationProjection, debt: DebtDocument): DebtQueryRow {
  return {
    ...projectDebtRow(board, relations, debt),
    parent: debt.parent,
    needs: debt.needs.map((need) => debtRef(board, need)),
    blocks: relations.blocks(debt.id),
    createdAt: debt.createdAt,
    updatedAt: debt.updatedAt,
  };
}
function sortDebts(debts: readonly DebtDocument[], sort: DebtQuerySort): readonly DebtDocument[] {
  return [...debts].sort((left, right) => {
    const tie = Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
    if (sort === "id") return tie;
    if (sort === "priority") return left.priority - right.priority || tie;
    const compared = left[sort === "created" ? "createdAt" : "updatedAt"].localeCompare(
      right[sort === "created" ? "createdAt" : "updatedAt"],
    );
    return (sort === "updated" ? -compared : compared) || tie;
  });
}
export function projectQueryRows(
  board: DebtBoard,
  relations: DebtRelationProjection,
  input: Readonly<{
    scope: readonly string[] | null;
    expression: DebtQueryExpression;
    sort?: DebtQuerySort;
  }>,
): readonly DebtQueryRow[] {
  const { scope, expression, sort = "priority" } = input;
  const under = new Map(queryUnderTargets(expression).map((target) => [target, descendants(relations, target)]));
  return sortDebts(
    [...board.debts.values()]
      .filter((debt) => scope === null || sameNamespace(parseDebtId(debt.id).namespace, scope))
      .filter((debt) => matches(board, relations, debt, expression, under)),
    sort,
  ).map((debt) => row(board, relations, debt));
}

export function projectQuery(
  board: DebtBoard,
  relations: DebtRelationProjection,
  input: Readonly<{
    scope: readonly string[] | null;
    expression: DebtQueryExpression;
    sort?: DebtQuerySort;
    limit: number;
  }>,
): DebtPage<DebtQueryRow> {
  return projectBoundedList(projectQueryRows(board, relations, input), input.limit);
}

export function underExpression(parent: DebtId): DebtQueryExpression {
  return { kind: "predicate", predicate: { field: "under", operator: "=", value: parent } };
}

export function queryUnderTargets(expression: DebtQueryExpression): readonly DebtId[] {
  const targets = new Set<DebtId>();
  function collect(value: DebtQueryExpression): void {
    if (value.kind === "predicate" && value.predicate.field === "under") targets.add(value.predicate.value);
    else if (value.kind === "not") collect(value.term);
    else if (value.kind !== "predicate") value.terms.forEach(collect);
  }
  collect(expression);
  return [...targets];
}
