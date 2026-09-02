import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { contractSegment, type ContractId } from "../core/facts/types.js";
import { identityCoordinate, identitySegments } from "../identity/coordinates.js";
import { normalizeIdentityStem } from "../identity/normalize.js";

export type TaskId = `task/${string}`;
export type TaskCoordinate = Readonly<{ namespace: readonly string[]; localId: string }>;
const STEM_CODE_POINTS = 32;
const TASK_FILENAME_BYTES = 255;
const TASK_EXTENSION_BYTES = Buffer.byteLength(".md");
const TASK_LOCK_EXTENSION_BYTES = Buffer.byteLength(".sqlite");
const GENERATED_SUFFIX = "-0000";
export const TASK_LOCK_ID_BYTES = TASK_FILENAME_BYTES - TASK_LOCK_EXTENSION_BYTES;
export const TASK_LOCAL_ID_BYTES =
  TASK_FILENAME_BYTES - TASK_EXTENSION_BYTES - TASK_LOCK_EXTENSION_BYTES - Buffer.byteLength(GENERATED_SUFFIX);
const GENERATED_STEM_BYTES = TASK_LOCAL_ID_BYTES - Buffer.byteLength(GENERATED_SUFFIX);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function isTaskSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    normalizeIdentityStem({ source: value }) === value
  );
}

export function parseTaskId(value: string): TaskCoordinate {
  let segments: readonly string[];
  try {
    segments = identitySegments({ family: "task", value });
  } catch {
    throw new TypeError("task ID must be task/<local-id> or task/<namespace...>/<local-id>");
  }
  if (!segments.every(isTaskSegment)) throw new TypeError("task ID contains a noncanonical segment");
  return { namespace: segments.slice(0, -1), localId: segments.at(-1)! };
}

export function formatTaskId(coordinate: TaskCoordinate): TaskId {
  if (![...coordinate.namespace, coordinate.localId].every(isTaskSegment))
    throw new TypeError("task coordinate contains a noncanonical segment");
  return identityCoordinate({ family: "task", segments: [...coordinate.namespace, coordinate.localId] }) as TaskId;
}

export function canonicalTaskId(value: string): TaskId {
  const id = formatTaskId(parseTaskId(value));
  if (id !== value) throw new TypeError("task ID is not canonical");
  return id;
}

export function contractNamespace(id: ContractId): readonly string[] {
  return ["kei", contractSegment(id)];
}

export function taskAuthorityPath(tasksDirectory: string, coordinate: TaskCoordinate): string {
  if (![...coordinate.namespace, coordinate.localId].every(isTaskSegment))
    throw new TypeError("task coordinate contains a noncanonical segment");
  return join(
    tasksDirectory,
    ...coordinate.namespace.map((segment) => physicalTaskSegment(segment)),
    `${physicalTaskSegment(coordinate.localId)}.md`,
  );
}

export function deriveLocalStem(title: string): string {
  const stem = normalizeIdentityStem({ source: title });
  if (stem.length === 0) throw new TypeError("task title must contain a normalized identity segment");
  const words = stem.split("-");
  let fitted = words[0]!;
  let count = [...fitted].length;
  for (const word of words.slice(1)) {
    const candidate = count + 1 + [...word].length;
    if (candidate > STEM_CODE_POINTS) break;
    fitted += `-${word}`;
    count = candidate;
  }
  return fitPhysicalStem(fitted);
}

export function allocateLocalId(stem: string, occupied: ReadonlySet<string>): string {
  const seed = randomBytes(2).readUInt16BE(0);
  for (let offset = 0; offset <= 0xffff; offset += 1) {
    const suffix = ((seed + offset) & 0xffff).toString(16).padStart(4, "0");
    const candidate = `${fitPhysicalStem(stem, suffix)}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("task identity hexadecimal suffix space exhausted");
}

function fitPhysicalStem(stem: string, suffix?: string): string {
  const maxBytes = suffix === undefined ? GENERATED_STEM_BYTES : TASK_LOCAL_ID_BYTES - Buffer.byteLength(`-${suffix}`);
  let result = "";
  for (const segment of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(stem)) {
    if (Buffer.byteLength(result + segment.segment) > maxBytes) break;
    result += segment.segment;
  }
  result = result.replace(/-+$/u, "");
  if (result.length === 0) throw new TypeError("task title cannot fit the physical filename budget");
  return result;
}

export function physicalTaskSegment(segment: string, maxBytes = TASK_LOCAL_ID_BYTES): string {
  if (Buffer.byteLength(segment) <= maxBytes && !WINDOWS_RESERVED.test(segment)) return segment;
  if (Buffer.byteLength(segment) > maxBytes)
    throw new TypeError("task identity cannot fit the physical filename budget");
  throw new TypeError("task identity contains a Windows-reserved physical segment");
}

export function sameNamespace(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
