import { z } from "zod";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fitIdentityStem, normalizeIdentityStem } from "../identity/normalize.js";

export type DebtId = `debt/${string}`;
const STEM_CODE_POINTS = 32;
const DEBT_FILENAME_BYTES = 255;
const DEBT_EXTENSION_BYTES = Buffer.byteLength(".md");
const DEBT_LOCK_EXTENSION_BYTES = Buffer.byteLength(".sqlite");
const GENERATED_SUFFIX = "-0000";
export const DEBT_LOCAL_ID_BYTES =
  DEBT_FILENAME_BYTES - DEBT_EXTENSION_BYTES - DEBT_LOCK_EXTENSION_BYTES - Buffer.byteLength(GENERATED_SUFFIX);
const GENERATED_STEM_BYTES = DEBT_LOCAL_ID_BYTES - Buffer.byteLength(GENERATED_SUFFIX);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function isDebtSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    normalizeIdentityStem({ source: value }) === value
  );
}

export function canonicalDebtId(value: string): DebtId {
  if (!value.startsWith("debt/") || value.slice(5).includes("/")) throw new TypeError("debt ID must be debt/<id>");
  if (!isDebtSegment(value.slice(5))) throw new TypeError("debt ID contains a noncanonical segment");
  return value as DebtId;
}

export const debtIdSchema = z
  .string()
  .regex(/^debt\/[^/]+$/u, "expected flat DebtId")
  .transform((value, context) => {
    try {
      return canonicalDebtId(value);
    } catch {
      context.addIssue({ code: "custom", message: "expected canonical DebtId" });
      return z.NEVER;
    }
  });

export function debtAuthorityPath(debtsDirectory: string, id: DebtId): string {
  return join(debtsDirectory, `${physicalDebtSegment(canonicalDebtId(id).slice(5))}.md`);
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

export function physicalDebtSegment(segment: string): string {
  if (Buffer.byteLength(segment) <= DEBT_LOCAL_ID_BYTES && !WINDOWS_RESERVED.test(segment)) return segment;
  if (Buffer.byteLength(segment) > DEBT_LOCAL_ID_BYTES)
    throw new TypeError("debt identity cannot fit the physical filename budget");
  throw new TypeError("debt identity contains a Windows-reserved physical segment");
}
