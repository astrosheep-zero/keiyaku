import { verificationDefinition } from "../body/decode.js";
import type { DecodedContractDocument } from "../body/types.js";
import {
  actorId,
  gate,
  gateWord,
  type ActorId,
  type ContractId,
  type ContractTerms,
  type Gate,
} from "../core/facts/types.js";
import { parseTaskId, type TaskId } from "../task/identity.js";
import type { DocumentDerivation } from "../protocol/operations.js";
import { prepareVerificationDeclaration } from "../verification/declaration.js";

export function actorOption(actor: unknown): Readonly<{ actor?: ActorId }> {
  if (actor === undefined) return {};
  if (typeof actor !== "string" || actor.trim().length === 0) {
    throw new TypeError("actor must be a nonblank string");
  }
  return { actor: actorId(actor) };
}

export function requireMarkdown(value: unknown, label = "markdown"): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireInput(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

export function taskOption(value: unknown): TaskId | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("task must be a TaskId");
  try {
    parseTaskId(value);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "task must be a TaskId");
  }
  return value as TaskId;
}

export function optionalNonblank(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonblank string`);
  }
  return value;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

export function optionalSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return value;
}

export function normalizedList<T>(
  values: unknown,
  label: string,
  brand: (value: string) => T,
): readonly T[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  return values.map((value, index) => {
    if (typeof value !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    try {
      return brand(value);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : `${label}[${index}] is invalid`);
    }
  });
}

export function normalizedGates(values: unknown): readonly Gate[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError("gates must be an array");
  const normalized = values.map((value, index) => {
    if (!gateWord(value)) {
      throw new TypeError(`gates[${index}] must match ^[a-z][a-z0-9-]{0,63}$`);
    }
    return gate(value);
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError("gates must not contain duplicates");
  return normalized;
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
    after,
  };
}

export function documentDerivation(
  document: DecodedContractDocument,
  gates: readonly Gate[],
  contractId?: ContractId,
): DocumentDerivation {
  return {
    document: document.document.key,
    bytes: document.document.bytes,
    title: document.title,
    verification: prepareVerificationDeclaration({
      gates,
      definition: verificationDefinition(document),
      ...(contractId === undefined ? {} : { contractId }),
    }),
  };
}
