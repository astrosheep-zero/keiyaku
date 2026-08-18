import { type TaskPriority, type TaskState } from "./document.js";
import { isTaskSegment, parseTaskId, type TaskId } from "./identity.js";
import type { AddTaskInput, UpdateTaskInput } from "./operations.js";
import { isValidTaskLimit, MAX_TASK_LIMIT, type TaskQuerySort } from "./query.js";

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

export function taskId(value: unknown): TaskId {
  if (typeof value !== "string") throw new TypeError("task ID must be a string");
  parseTaskId(value);
  return value as TaskId;
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

export function taskIds(value: unknown, label: string): readonly TaskId[] | undefined {
  const values = strings(value, label)?.map(taskId);
  if (values !== undefined && new Set(values).size !== values.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return values;
}

export function namespace(value: unknown): readonly string[] | undefined {
  const values = strings(value, "namespace");
  if (values === undefined) return undefined;
  if (!values.every(isTaskSegment)) throw new TypeError("namespace must contain canonical segments");
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

export function priority(value: unknown): TaskPriority | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 3) {
    throw new TypeError("priority must be 0..3");
  }
  return value as TaskPriority;
}

export function limit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !isValidTaskLimit(value)) {
    throw new TypeError(`limit must be an integer from 1 to ${MAX_TASK_LIMIT}`);
  }
  return value;
}

export function sort(value: unknown): TaskQuerySort | undefined {
  if (value === undefined) return undefined;
  if (value !== "priority" && value !== "created" && value !== "updated" && value !== "id") {
    throw new TypeError("sort is invalid");
  }
  return value;
}

export function state(value: unknown): TaskState | undefined {
  if (value === undefined) return undefined;
  if (value !== "open" && value !== "in_progress" && value !== "on_hold"
    && value !== "done" && value !== "drop") {
    throw new TypeError("state is invalid");
  }
  return value;
}

function nullableId(value: unknown): TaskId | null | undefined {
  return value === undefined || value === null ? value : taskId(value);
}

export function addInput(input: unknown): AddTaskInput {
  const value = record(input, "add input");
  closed(value, [
    "title", "namespace", "body", "note", "state", "priority", "needs", "parent",
    "supersedes", "relates", "actor", "signal",
  ], "add input");
  const title = text(value.title, "title");
  if (title === undefined || title.trim() === "") throw new TypeError("title is required");
  const selectedNamespace = namespace(value.namespace);
  const body = text(value.body, "body");
  const note = text(value.note, "note");
  const initialState = state(value.state);
  const selectedPriority = priority(value.priority);
  const needs = taskIds(value.needs, "needs");
  const parent = nullableId(value.parent);
  const supersedes = taskIds(value.supersedes, "supersedes");
  const relates = taskIds(value.relates, "relates");
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

export function updateInput(input: unknown): UpdateTaskInput {
  const value = record(input, "update input");
  closed(value, [
    "title", "body", "appendBody", "note", "priority", "needs", "addNeeds", "dropNeeds",
    "parent", "supersedes", "addSupersedes", "dropSupersedes", "relates", "addRelates",
    "dropRelates", "signal",
  ], "update input");
  if (value.body !== undefined && value.appendBody !== undefined) {
    throw new TypeError("body and appendBody are mutually exclusive");
  }
  const result: Record<string, unknown> = {};
  const title = text(value.title, "title");
  if (title !== undefined) {
    if (title.trim().length === 0) throw new TypeError("title must be nonblank");
    result.title = title;
  }
  const body = text(value.body, "body"); if (body !== undefined) result.body = body;
  const appendBody = text(value.appendBody, "appendBody"); if (appendBody !== undefined) result.appendBody = appendBody;
  const note = text(value.note, "note"); if (note !== undefined) result.note = note;
  const selectedPriority = priority(value.priority); if (selectedPriority !== undefined) result.priority = selectedPriority;
  for (const [key, ids] of [
    ["needs", taskIds(value.needs, "needs")],
    ["addNeeds", taskIds(value.addNeeds, "addNeeds")],
    ["dropNeeds", taskIds(value.dropNeeds, "dropNeeds")],
    ["supersedes", taskIds(value.supersedes, "supersedes")],
    ["addSupersedes", taskIds(value.addSupersedes, "addSupersedes")],
    ["dropSupersedes", taskIds(value.dropSupersedes, "dropSupersedes")],
    ["relates", taskIds(value.relates, "relates")],
    ["addRelates", taskIds(value.addRelates, "addRelates")],
    ["dropRelates", taskIds(value.dropRelates, "dropRelates")],
  ] as const) if (ids !== undefined) result[key] = ids;
  const parent = nullableId(value.parent); if (parent !== undefined) result.parent = parent;
  const abort = signal(value.signal); if (abort !== undefined) result.signal = abort;
  if (Object.keys(result).filter((key) => key !== "signal").length === 0) {
    throw new TypeError("update requires at least one field change");
  }
  return result as UpdateTaskInput;
}
