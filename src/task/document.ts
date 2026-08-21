import { isMap, parseDocument, stringify } from "yaml";
import { formatTaskId, parseTaskId, type TaskCoordinate, type TaskId } from "./identity.js";

export type TaskState = "open" | "in_progress" | "on_hold" | "done" | "drop";
export type TaskPriority = 0 | 1 | 2 | 3;
export type TaskDocument = Readonly<{
  id: TaskId;
  title: string;
  state: TaskState;
  priority: TaskPriority;
  needs: readonly TaskId[];
  parent: TaskId | null;
  supersedes: readonly TaskId[];
  relates: readonly TaskId[];
  note: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  body: string;
}>;
export type TaskCreationDocument = Omit<TaskDocument, "id" | "createdBy" | "createdAt" | "updatedAt">;

export class TaskAuthorityCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskAuthorityCorruptionError";
  }
}

const STATES = new Set<TaskState>(["open", "in_progress", "on_hold", "done", "drop"]);
const REQUIRED_STORED_KEYS = [
  "id",
  "title",
  "state",
  "priority",
  "needs",
  "parent",
  "supersedes",
  "relates",
  "note",
  "createdAt",
  "updatedAt",
] as const;
const STORED_KEYS = [...REQUIRED_STORED_KEYS, "createdBy"] as const;
const CREATION_KEYS = ["title", "state", "priority", "needs", "parent", "supersedes", "relates", "note"] as const;

function frontMatter(
  markdown: string,
  fail: (message: string, cause?: unknown) => never,
): Readonly<{ value: Record<string, unknown>; body: string }> {
  if (!markdown.startsWith("---\n")) fail("task document must begin with YAML front matter");
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) fail("task document front matter is not closed");
  const source = markdown.slice(4, end);
  const parsed = parseDocument(source, { merge: false, prettyErrors: false, strict: true, uniqueKeys: true });
  if (parsed.errors.length > 0 || parsed.warnings.length > 0 || !isMap(parsed.contents)) {
    fail("task front matter must be one strict YAML mapping", parsed.errors[0]);
  }
  const value = parsed.toJS({ maxAliasCount: 0 }) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("task front matter must be a mapping");
  return { value: value as Record<string, unknown>, body: markdown.slice(end + 5) };
}

function closed(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  fail: (message: string) => never,
): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown task front matter key: ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`task front matter is missing ${key}`);
}
function title(value: unknown, fail: (message: string) => never): string {
  if (typeof value !== "string" || value.trim().length === 0) fail("task title must be a nonblank string");
  return value;
}
function priority(value: unknown, fail: (message: string) => never): TaskPriority {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 3)
    fail("task priority must be 0, 1, 2, or 3");
  return value as TaskPriority;
}
function state(value: unknown, fail: (message: string) => never): TaskState {
  if (typeof value !== "string" || !STATES.has(value as TaskState)) fail("task state is invalid");
  return value as TaskState;
}
function timestamp(value: unknown, field: string, fail: (message: string) => never): string {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (typeof value !== "string" || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    fail(`${field} must be a canonical UTC ISO timestamp`);
  return value;
}
function taskId(value: unknown, field: string, fail: (message: string) => never): TaskId {
  if (typeof value !== "string") fail(`${field} must be a TaskId`);
  try {
    parseTaskId(value);
    return value as TaskId;
  } catch {
    return fail(`${field} must be a canonical TaskId`);
  }
}
function taskIds(value: unknown, field: string, fail: (message: string) => never): readonly TaskId[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  const ids = value.map((item) => taskId(item, field, fail));
  if (new Set(ids).size !== ids.length) fail(`${field} must not contain duplicates`);
  return ids;
}
function nullableTaskId(value: unknown, field: string, fail: (message: string) => never): TaskId | null {
  return value === null ? null : taskId(value, field, fail);
}
function createdBy(value: unknown, fail: (message: string) => never): string {
  if (typeof value !== "string" || value.trim().length === 0) fail("createdBy must be a nonblank string");
  return value;
}
function fields(
  value: Record<string, unknown>,
  body: string,
  fail: (message: string) => never,
): Omit<TaskCreationDocument, "state"> {
  return {
    title: title(value.title, fail),
    priority: priority(value.priority, fail),
    needs: taskIds(value.needs, "needs", fail),
    parent: nullableTaskId(value.parent, "parent", fail),
    supersedes: taskIds(value.supersedes, "supersedes", fail),
    relates: taskIds(value.relates, "relates", fail),
    note: typeof value.note === "string" ? value.note : fail("note must be a string"),
    body,
  };
}

export function parseTaskDocument(bytes: Uint8Array, expected: TaskCoordinate): TaskDocument {
  const fail = (message: string, cause?: unknown): never => {
    throw new TaskAuthorityCorruptionError(message, cause === undefined ? {} : { cause });
  };
  const { value, body } = frontMatter(Buffer.from(bytes).toString("utf8"), fail);
  closed(value, STORED_KEYS, REQUIRED_STORED_KEYS, fail);
  const id = taskId(value.id, "id", fail);
  if (id !== formatTaskId(expected)) fail(`task document ID ${id} does not match its authority path`);
  const createdAt = timestamp(value.createdAt, "createdAt", fail),
    updatedAt = timestamp(value.updatedAt, "updatedAt", fail);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("updatedAt must not precede createdAt");
  return {
    id,
    state: state(value.state, fail),
    createdAt,
    updatedAt,
    ...fields(value, body, fail),
    ...(Object.hasOwn(value, "createdBy") ? { createdBy: createdBy(value.createdBy, fail) } : {}),
  };
}

export function parseTaskCreationDocument(markdown: string): TaskCreationDocument {
  const fail = (message: string): never => {
    throw new TypeError(message);
  };
  const { value, body } = frontMatter(markdown, fail);
  closed(value, CREATION_KEYS, ["title"], fail);
  const complete = {
    state: "open",
    priority: 2,
    needs: [],
    parent: null,
    supersedes: [],
    relates: [],
    note: "",
    ...value,
  };
  return { state: state(complete.state, fail), ...fields(complete, body, fail) };
}

export function serializeTaskDocument(document: TaskDocument): Uint8Array {
  const value = {
    id: document.id,
    title: document.title,
    state: document.state,
    priority: document.priority,
    needs: [...document.needs],
    parent: document.parent,
    supersedes: [...document.supersedes],
    relates: [...document.relates],
    note: document.note,
    ...(document.createdBy === undefined ? {} : { createdBy: document.createdBy }),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
  return Buffer.from(`---\n${stringify(value, { lineWidth: 0 })}---\n${document.body}`);
}
