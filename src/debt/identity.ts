import { z } from "zod";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { contractSegment, type ContractId } from "../core/facts/types.js";
import { identityCoordinate, identitySegments } from "../identity/coordinates.js";
import { fitIdentityStem, normalizeIdentityStem } from "../identity/normalize.js";

export type DebtId = `debt/${string}`;
export type DebtCoordinate = Readonly<{ namespace: readonly string[]; localId: string }>;
const STEM_CODE_POINTS = 32;
const DEBT_FILENAME_BYTES = 255;
const DEBT_EXTENSION_BYTES = Buffer.byteLength(".md");
const DEBT_LOCK_EXTENSION_BYTES = Buffer.byteLength(".sqlite");
const GENERATED_SUFFIX = "-0000";
export const DEBT_LOCAL_ID_BYTES =
  DEBT_FILENAME_BYTES - DEBT_EXTENSION_BYTES - DEBT_LOCK_EXTENSION_BYTES - Buffer.byteLength(GENERATED_SUFFIX);
const GENERATED_STEM_BYTES = DEBT_LOCAL_ID_BYTES - Buffer.byteLength(GENERATED_SUFFIX);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export function isDebtSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    normalizeIdentityStem({ source: value }) === value
  );
}

export function parseDebtId(value: string): DebtCoordinate {
  let segments: readonly string[];
  try {
    segments = identitySegments({ family: "debt", value });
  } catch {
    throw new TypeError("debt ID must be debt/<local-id> or debt/<namespace...>/<local-id>");
  }
  if (!segments.every(isDebtSegment)) throw new TypeError("debt ID contains a noncanonical segment");
  return { namespace: segments.slice(0, -1), localId: segments.at(-1)! };
}

export function formatDebtId(coordinate: DebtCoordinate): DebtId {
  if (![...coordinate.namespace, coordinate.localId].every(isDebtSegment))
    throw new TypeError("debt coordinate contains a noncanonical segment");
  return identityCoordinate({ family: "debt", segments: [...coordinate.namespace, coordinate.localId] }) as DebtId;
}

export function canonicalDebtId(value: string): DebtId {
  const id = formatDebtId(parseDebtId(value));
  if (id !== value) throw new TypeError("debt ID is not canonical");
  return id;
}

export const debtIdSchema = z.string().transform((value, context) => {
  try {
    return canonicalDebtId(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected canonical DebtId" });
    return z.NEVER;
  }
});

export const debtNamespaceSchema = z.array(z.string().refine(isDebtSegment)).readonly();
export const debtIdsSchema = z
  .array(debtIdSchema)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "DebtIds must be unique" });
  })
  .readonly();

export function contractNamespace(id: ContractId): readonly string[] {
  return ["kei", contractSegment(id)];
}

export function debtAuthorityPath(debtsDirectory: string, coordinate: DebtCoordinate): string {
  if (![...coordinate.namespace, coordinate.localId].every(isDebtSegment))
    throw new TypeError("debt coordinate contains a noncanonical segment");
  return join(
    debtsDirectory,
    ...coordinate.namespace.map((segment) => physicalDebtSegment(segment)),
    `${physicalDebtSegment(coordinate.localId)}.md`,
  );
}

export function deriveLocalStem(title: string): string {
  const stem = normalizeIdentityStem({ source: title });
  if (stem.length === 0) throw new TypeError("debt title must contain a normalized identity segment");
  const words = stem.split("-");
  let fitted = words[0]!;
  let count = [...fitted].length;
  for (const word of words.slice(1)) {
    const candidate = count + 1 + [...word].length;
    if (candidate > STEM_CODE_POINTS) break;
    fitted += `-${word}`;
    count = candidate;
  }
  return fitIdentityStem({ stem: fitted, maxBytes: GENERATED_STEM_BYTES });
}

export function allocateLocalId(stem: string, occupied: ReadonlySet<string>): string {
  const seed = randomBytes(2).readUInt16BE(0);
  for (let offset = 0; offset <= 0xffff; offset += 1) {
    const suffix = ((seed + offset) & 0xffff).toString(16).padStart(4, "0");
    const candidate = fitIdentityStem({ stem, maxBytes: DEBT_LOCAL_ID_BYTES, suffix });
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("debt identity hexadecimal suffix space exhausted");
}

export function physicalDebtSegment(segment: string, maxBytes = DEBT_LOCAL_ID_BYTES): string {
  if (Buffer.byteLength(segment) <= maxBytes && !WINDOWS_RESERVED.test(segment)) return segment;
  if (Buffer.byteLength(segment) > maxBytes)
    throw new TypeError("debt identity cannot fit the physical filename budget");
  throw new TypeError("debt identity contains a Windows-reserved physical segment");
}

export function sameNamespace(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
