import { join } from "node:path";
import { identityCoordinate, identitySegments } from "../identity/coordinates.js";
import { normalizeIdentityStem } from "../identity/normalize.js";

export type TaskId = `task/${string}`;
export type TaskCoordinate = Readonly<{ namespace: readonly string[]; localId: string }>;
const STEM_CODE_POINTS = 32;

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

export function taskAuthorityPath(tasksDirectory: string, coordinate: TaskCoordinate): string {
  return join(tasksDirectory, ...coordinate.namespace, `${coordinate.localId}.md`);
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
  return fitted;
}

export function allocateLocalId(stem: string, occupied: ReadonlySet<string>): string {
  if (!occupied.has(stem)) return stem;
  for (let suffix = 2; Number.isSafeInteger(suffix); suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("task identity collision ordinal exceeded the safe integer range");
}

export function sameNamespace(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
