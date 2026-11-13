import { z } from "zod";
import { decodeArcDocument } from "../body/arc.js";
import { decodeContractDocument } from "../body/decode.js";
import { KeiyakuError } from "../errors.js";
import { verificationDefinition } from "../body/decode.js";
import type { DecodedContractDocument } from "../body/types.js";
import { contractId, type ContractId, type ContractTerms, type Gate } from "../core/facts/types.js";
import { canonicalDebtId, type DebtId } from "../debt/identity.js";
import type { DocumentDerivation } from "../protocol/operations.js";
import { gateRequirements, prepareVerificationDeclaration } from "../verification/declaration.js";

const amendFields = z.strictObject({
  markdown: z.string().exactOptional(),
  after: z.array(z.string()).readonly().exactOptional(),
  gates: z.array(z.string()).readonly().exactOptional(),
});
export const amendInputSchemas = [
  amendFields.required({ markdown: true }),
  amendFields.required({ after: true }),
  amendFields.required({ gates: true }),
] as const;
export const amendInputSchema = z.union(amendInputSchemas);

export function requireMarkdown(value: unknown, label = "markdown"): string {
  if (typeof value !== "string") throw new KeiyakuError("invalid-input", `${label} must be a string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Core contract parsing stays foundational; the caller boundary declares the category once. */
export function callerContractId(value: string): ContractId {
  try {
    return contractId(value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "contract ID is invalid";
    throw new KeiyakuError("invalid-input", message, { cause });
  }
}

export function requireInput(value: unknown, label: string, allowed?: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new KeiyakuError("invalid-input", `${label} must be an object`);
  if (allowed !== undefined) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) throw new KeiyakuError("invalid-input", `${label} has unknown field: ${key}`);
    }
  }
  return value;
}

export function debtOption(value: unknown): DebtId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new KeiyakuError("invalid-input", "debt must be a DebtId");
  return canonicalDebtId(value);
}

export function optionalNonblank(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new KeiyakuError("invalid-input", `${label} must be a nonblank string`);
  }
  return value;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new KeiyakuError("invalid-input", `${label} must be a boolean`);
  return value;
}

export function optionalSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new KeiyakuError("invalid-input", "signal must be an AbortSignal");
  return value;
}

export function normalizedList<T>(values: unknown, label: string, brand: (value: string) => T): readonly T[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new KeiyakuError("invalid-input", `${label} must be an array`);
  return values.map((value, index) => {
    if (typeof value !== "string") throw new KeiyakuError("invalid-input", `${label}[${index}] must be a string`);
    return brand(value);
  });
}

export function contractTerms(
  document: DecodedContractDocument,
  gates: readonly Gate[],
  after: readonly ContractId[],
): ContractTerms {
  return {
    document: document.document,
    segments: document.segments,
    gates,
    requirements: gateRequirements(gates, verificationDefinition(document)),
    after,
  };
}

export function documentDerivation(document: DecodedContractDocument): DocumentDerivation {
  return {
    document: document.document.key,
    bytes: document.document.bytes,
    title: document.title,
    verification: prepareVerificationDeclaration(verificationDefinition(document)),
  };
}

/** Early CLI acquisition uses the same Library caller boundary, never document-owner capabilities. */
export function validateContractMarkdown(markdown: string): void {
  decodeContractDocument(requireMarkdown(markdown), { requireTimeout: true });
}
export function validateArcMarkdown(markdown: string): void {
  decodeArcDocument(requireMarkdown(markdown));
}
