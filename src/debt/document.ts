import { isMap, parseDocument, stringify } from "yaml";
import { z } from "zod";
import { formatDebtId, parseDebtId, type DebtCoordinate, type DebtId } from "./identity.js";

export const debtNonblankTextSchema = z.string().refine((value) => value.trim() !== "");
export const debtStateSchema = z.enum(["open", "done", "drop"]);
export const debtPrioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type DebtState = z.infer<typeof debtStateSchema>;
export type DebtPriority = z.infer<typeof debtPrioritySchema>;
export type DebtDocument = Readonly<{
  id: DebtId;
  title: string;
  state: DebtState;
  priority: DebtPriority;
  needs: readonly DebtId[];
  parent: DebtId | null;
  supersedes: readonly DebtId[];
  relates: readonly DebtId[];
  note: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  body: string;
}>;
export type DebtCreationDocument = Omit<DebtDocument, "id" | "createdBy" | "createdAt" | "updatedAt">;

export class DebtAuthorityCorruptionError extends Error {
  /** The Debt document whose bytes failed decode, when the reader knew its coordinate. */
  readonly coordinate?: DebtId;

  constructor(message: string, options?: ErrorOptions & { coordinate?: DebtId }) {
    super(message, options);
    this.name = "DebtAuthorityCorruptionError";
    if (options?.coordinate !== undefined) this.coordinate = options.coordinate;
  }
}

const STATES = new Set<DebtState>(["open", "done", "drop"]);
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
  if (!markdown.startsWith("---\n")) fail("debt document must begin with YAML front matter");
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) fail("debt document front matter is not closed");
  const source = markdown.slice(4, end);
  const parsed = parseDocument(source, { merge: false, prettyErrors: false, strict: true, uniqueKeys: true });
  if (parsed.errors.length > 0 || parsed.warnings.length > 0 || !isMap(parsed.contents)) {
    fail("debt front matter must be one strict YAML mapping", parsed.errors[0]);
  }
  const value = parsed.toJS({ maxAliasCount: 0 }) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("debt front matter must be a mapping");
  return { value: value as Record<string, unknown>, body: markdown.slice(end + 5) };
}

function closed(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  fail: (message: string) => never,
): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown debt front matter key: ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`debt front matter is missing ${key}`);
}
function title(value: unknown, fail: (message: string) => never): string {
  if (typeof value !== "string" || value.trim().length === 0) fail("debt title must be a nonblank string");
  return value;
}
function priority(value: unknown, fail: (message: string) => never): DebtPriority {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0 || value > 3)
    fail("debt priority must be 0, 1, 2, or 3");
  return value as DebtPriority;
}
function state(value: unknown, fail: (message: string) => never): DebtState {
  if (typeof value !== "string" || !STATES.has(value as DebtState)) fail(`debt state is invalid: ${String(value)}`);
  return value as DebtState;
}
function timestamp(value: unknown, field: string, fail: (message: string) => never): string {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (typeof value !== "string" || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    fail(`${field} must be a canonical UTC ISO timestamp`);
  return value;
}
function debtId(value: unknown, field: string, fail: (message: string) => never): DebtId {
  if (typeof value !== "string") fail(`${field} must be a DebtId`);
  try {
    parseDebtId(value);
    return value as DebtId;
  } catch {
    return fail(`${field} must be a canonical DebtId`);
  }
}
function debtIds(value: unknown, field: string, fail: (message: string) => never): readonly DebtId[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  const ids = value.map((item) => debtId(item, field, fail));
  if (new Set(ids).size !== ids.length) fail(`${field} must not contain duplicates`);
  return ids;
}
function nullableDebtId(value: unknown, field: string, fail: (message: string) => never): DebtId | null {
  return value === null ? null : debtId(value, field, fail);
}
function createdBy(value: unknown, fail: (message: string) => never): string {
  if (typeof value !== "string" || value.trim().length === 0) fail("createdBy must be a nonblank string");
  return value;
}
function fields(
  value: Record<string, unknown>,
  body: string,
  fail: (message: string) => never,
): Omit<DebtCreationDocument, "state"> {
  return {
    title: title(value.title, fail),
    priority: priority(value.priority, fail),
    needs: debtIds(value.needs, "needs", fail),
    parent: nullableDebtId(value.parent, "parent", fail),
    supersedes: debtIds(value.supersedes, "supersedes", fail),
    relates: debtIds(value.relates, "relates", fail),
    note: typeof value.note === "string" ? value.note : fail("note must be a string"),
    body,
  };
}

export function parseDebtDocument(bytes: Uint8Array, expected: DebtCoordinate): DebtDocument {
  const coordinate = formatDebtId(expected);
  const fail = (message: string, cause?: unknown): never => {
    throw new DebtAuthorityCorruptionError(message, { coordinate, ...(cause === undefined ? {} : { cause }) });
  };
  const { value, body } = frontMatter(Buffer.from(bytes).toString("utf8"), fail);
  closed(value, STORED_KEYS, REQUIRED_STORED_KEYS, fail);
  const id = debtId(value.id, "id", fail);
  if (id !== formatDebtId(expected)) fail(`debt document ID ${id} does not match its authority path`);
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

export function parseDebtCreationDocument(markdown: string): DebtCreationDocument {
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

export function serializeDebtDocument(document: DebtDocument): Uint8Array {
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
