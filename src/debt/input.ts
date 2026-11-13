import { KeiyakuError } from "../errors.js";
import { z } from "zod";
import { debtPrioritySchema, debtStateSchema } from "./document.js";
import { canonicalDebtId, debtIdSchema, type DebtId } from "./identity.js";
import type { AddDebtDocumentInput, AddDebtInput, UpdateDebtInput } from "./operations.js";

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KeiyakuError("invalid-input", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function closed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new KeiyakuError("invalid-input", `${label} has unknown field: ${key}`);
  }
}

export function debtId(value: unknown): DebtId {
  if (typeof value !== "string") throw new KeiyakuError("invalid-input", "debt ID must be a string");
  return canonicalDebtId(value);
}

export function signal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new KeiyakuError("invalid-input", "signal must be an AbortSignal");
  return value;
}

export function text(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new KeiyakuError("invalid-input", `${label} must be a string`);
  return value;
}

const optionalText = z.string().exactOptional();
const titleSchema = z.string().regex(/\S/u, "title must be nonblank");
const idsSchema = z
  .array(debtIdSchema)
  .readonly()
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Debt needs must not contain duplicates",
  })
  .exactOptional();
export const addDebtInputSchema = z.strictObject({
  title: titleSchema.describe("Nonblank one-line summary of the unresolved problem or obligation."),
  body: optionalText.describe("Detailed Markdown description, evidence, and scope."),
  priority: debtPrioritySchema
    .exactOptional()
    .describe("Urgency from 0 (highest/critical) to 3 (lowest); defaults to 2."),
  needs: idsSchema.describe("Distinct prerequisite Debt IDs (debt/<slug>-<hex>) that block this Debt until closed."),
});
const UPDATE_FIELDS = ["title", "body", "note", "state", "priority", "needs"] as const;
export const updateDebtInputSchema = z
  .strictObject({
    title: titleSchema.exactOptional().describe("Replacement nonblank one-line title."),
    body: optionalText.describe("Complete replacement Markdown body; an empty string clears it."),
    note: optionalText.describe("Replacement current status or closure explanation; an empty string clears it."),
    state: debtStateSchema.exactOptional().describe('Target lifecycle state: "open", "done", or "drop".'),
    priority: debtPrioritySchema.exactOptional().describe("Replacement priority from 0 (highest) to 3 (lowest)."),
    needs: idsSchema.describe("Replace the entire needs list; an empty list clears it."),
  })
  .refine((value) => UPDATE_FIELDS.some((field) => value[field] !== undefined), {
    message: "update requires at least one field",
  });
const signalSchema = z.instanceof(AbortSignal).exactOptional();

function parseDebtInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new KeiyakuError("invalid-input", result.error.message);
  return result.data;
}

export function addInput(input: unknown): AddDebtInput {
  return parseDebtInput(addDebtInputSchema.extend({ signal: signalSchema }), input);
}

export function addDocumentInput(input: unknown): AddDebtDocumentInput {
  const v = record(input, "addDocument input");
  closed(v, ["markdown", "signal"], "addDocument input");
  const markdown = text(v.markdown, "markdown");
  if (markdown === undefined) throw new KeiyakuError("invalid-input", "markdown is required");
  const abort = signal(v.signal);
  return {
    markdown,
    ...(abort === undefined ? {} : { signal: abort }),
  };
}

export function updateInput(input: unknown): UpdateDebtInput {
  return parseDebtInput(updateDebtInputSchema.safeExtend({ signal: signalSchema }), input);
}
