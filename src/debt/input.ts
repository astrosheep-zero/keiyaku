import { type DebtPriority, type DebtState } from "./document.js";
import { isDebtSegment, parseDebtId, type DebtId } from "./identity.js";
import type { AddDebtInput, UpdateDebtInput } from "./operations.js";
import type { DebtQuerySort } from "./query.js";

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function closed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has unknown field: ${key}`);
  }
}

export function debtId(value: unknown): DebtId {
  if (typeof value !== "string") throw new TypeError("debt ID must be a string");
  parseDebtId(value);
  return value as DebtId;
}

export function signal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return value;
}

function strings(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}

export function debtIds(value: unknown, label: string): readonly DebtId[] | undefined {
  const values = strings(value, label)?.map(debtId);
  if (values !== undefined && new Set(values).size !== values.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return values;
}

export function namespace(value: unknown): readonly string[] | undefined {
  const values = strings(value, "namespace");
  if (values === undefined) return undefined;
  if (!values.every(isDebtSegment)) throw new TypeError("namespace must contain canonical segments");
  return values;
}

export function text(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

export function actor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("actor must be a nonblank string");
  }
  return value;
}

function priority(value: unknown): DebtPriority | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 3) {
    throw new TypeError("priority must be 0..3");
  }
  return value as DebtPriority;
}

export function sort(value: unknown): DebtQuerySort | undefined {
  if (value === undefined) return undefined;
  if (value !== "priority" && value !== "created" && value !== "updated" && value !== "id") {
    throw new TypeError("sort is invalid");
  }
  return value;
}

function state(value: unknown): DebtState | undefined {
  if (value === undefined) return undefined;
  if (value !== "open" && value !== "done" && value !== "drop") {
    throw new TypeError("state is invalid");
  }
  return value;
}

function nullableId(value: unknown): DebtId | null | undefined {
  return value === undefined || value === null ? value : debtId(value);
}

export function addInput(input: unknown): AddDebtInput {
  const value = record(input, "add input");
  closed(
    value,
    [
      "title",
      "namespace",
      "body",
      "note",
      "state",
      "priority",
      "needs",
      "parent",
      "supersedes",
      "relates",
      "actor",
      "signal",
    ],
    "add input",
  );
  const title = text(value.title, "title");
  if (title === undefined || title.trim() === "") throw new TypeError("title is required");
  const selectedNamespace = namespace(value.namespace);
  const body = text(value.body, "body");
  const note = text(value.note, "note");
  const initialState = state(value.state);
  const selectedPriority = priority(value.priority);
  const needs = debtIds(value.needs, "needs");
  const parent = nullableId(value.parent);
  const supersedes = debtIds(value.supersedes, "supersedes");
  const relates = debtIds(value.relates, "relates");
  const createdBy = actor(value.actor);
  const abort = signal(value.signal);
  return {
    title,
    ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
    ...(body === undefined ? {} : { body }),
    ...(note === undefined ? {} : { note }),
    ...(initialState === undefined ? {} : { state: initialState }),
    ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(needs === undefined ? {} : { needs }),
    ...(parent === undefined ? {} : { parent }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(relates === undefined ? {} : { relates }),
    ...(createdBy === undefined ? {} : { actor: createdBy }),
    ...(abort === undefined ? {} : { signal: abort }),
  };
}

export function updateInput(input: unknown): UpdateDebtInput {
  const value = record(input, "update input");
  closed(
    value,
    [
      "title",
      "body",
      "appendBody",
      "note",
      "priority",
      "needs",
      "addNeeds",
      "dropNeeds",
      "parent",
      "supersedes",
      "addSupersedes",
      "dropSupersedes",
      "relates",
      "addRelates",
      "dropRelates",
      "signal",
    ],
    "update input",
  );
  if (value.body !== undefined && value.appendBody !== undefined) {
    throw new TypeError("body and appendBody are mutually exclusive");
  }
  const result: Record<string, unknown> = {};
  const title = text(value.title, "title");
  if (title !== undefined) {
    if (title.trim().length === 0) throw new TypeError("title must be nonblank");
    result.title = title;
  }
  const body = text(value.body, "body");
  if (body !== undefined) result.body = body;
  const appendBody = text(value.appendBody, "appendBody");
  if (appendBody !== undefined) result.appendBody = appendBody;
  const note = text(value.note, "note");
  if (note !== undefined) result.note = note;
  const selectedPriority = priority(value.priority);
  if (selectedPriority !== undefined) result.priority = selectedPriority;
  for (const [key, ids] of [
    ["needs", debtIds(value.needs, "needs")],
    ["addNeeds", debtIds(value.addNeeds, "addNeeds")],
    ["dropNeeds", debtIds(value.dropNeeds, "dropNeeds")],
    ["supersedes", debtIds(value.supersedes, "supersedes")],
    ["addSupersedes", debtIds(value.addSupersedes, "addSupersedes")],
    ["dropSupersedes", debtIds(value.dropSupersedes, "dropSupersedes")],
    ["relates", debtIds(value.relates, "relates")],
    ["addRelates", debtIds(value.addRelates, "addRelates")],
    ["dropRelates", debtIds(value.dropRelates, "dropRelates")],
  ] as const)
    if (ids !== undefined) result[key] = ids;
  const parent = nullableId(value.parent);
  if (parent !== undefined) result.parent = parent;
  const abort = signal(value.signal);
  if (abort !== undefined) result.signal = abort;
  if (Object.keys(result).filter((key) => key !== "signal").length === 0) {
    throw new TypeError("update requires at least one field change");
  }
  return result as UpdateDebtInput;
}
