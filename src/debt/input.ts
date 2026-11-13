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
    message: "Debt relationships must not contain duplicates",
  })
  .exactOptional();
export const addDebtInputSchema = z.strictObject({
  title: titleSchema.describe("Nonblank one-line summary of the unresolved problem or obligation."),
  body: optionalText.describe("Detailed Markdown description, evidence, and scope."),
  note: optionalText.describe("Short status or resolution note."),
  state: debtStateSchema.exactOptional().describe('Initial lifecycle state: "open" (default), "done", or "drop".'),
  priority: debtPrioritySchema
    .exactOptional()
    .describe("Urgency from 0 (highest/critical) to 3 (lowest); defaults to 2."),
  needs: idsSchema.describe("Distinct prerequisite Debt IDs (debt/<slug>-<hex>) that block this Debt until closed."),
  parent: debtIdSchema.nullable().exactOptional().describe("Parent container Debt ID (debt/<slug>-<hex>), or null."),
  supersedes: idsSchema.describe("Distinct Debt IDs (debt/<slug>-<hex>) replaced by this Debt."),
  relates: idsSchema.describe("Distinct non-blocking related Debt IDs (debt/<slug>-<hex>)."),
});
const updateDebtFields = {
  title: titleSchema.exactOptional().describe("Replacement nonblank one-line title."),
  body: optionalText.describe("Complete replacement Markdown body (mutually exclusive with appendBody)."),
  note: optionalText.describe("Replacement status or closure note."),
  state: debtStateSchema.exactOptional().describe('Target lifecycle state: "open", "done", or "drop".'),
  priority: debtPrioritySchema.exactOptional().describe("Replacement priority from 0 (highest) to 3 (lowest)."),
  needs: idsSchema.describe("Replace the entire needs list with these distinct Debt IDs."),
  parent: debtIdSchema
    .nullable()
    .exactOptional()
    .describe("Replacement parent Debt ID (debt/<slug>-<hex>), or null to clear parent."),
  supersedes: idsSchema.describe("Replace the entire supersedes list with these distinct Debt IDs."),
  relates: idsSchema.describe("Replace the entire relates list with these distinct Debt IDs."),
  appendBody: optionalText.describe(
    "Nonempty Markdown text appended to the existing body (mutually exclusive with body).",
  ),
  addNeeds: idsSchema.describe("Distinct Debt IDs to add to needs."),
  dropNeeds: idsSchema.describe("Distinct Debt IDs to remove from needs."),
  addSupersedes: idsSchema.describe("Distinct Debt IDs to add to supersedes."),
  dropSupersedes: idsSchema.describe("Distinct Debt IDs to remove from supersedes."),
  addRelates: idsSchema.describe("Distinct Debt IDs to add to relates."),
  dropRelates: idsSchema.describe("Distinct Debt IDs to remove from relates."),
};
const patchFields = z
  .strictObject(updateDebtFields)
  .omit({ body: true, appendBody: true })
  .refine(
    (value) =>
      Object.entries(value).some(([key, field]) => {
        if (!Object.hasOwn(updateDebtFields, key) || field === undefined) return false;
        if (key === "appendBody") return field !== "";
        if (key.startsWith("add") || key.startsWith("drop")) return Array.isArray(field) && field.length > 0;
        return true;
      }),
    { message: "update requires at least one field change" },
  );
export const updateDebtInputSchemas = [
  patchFields.safeExtend({ body: updateDebtFields.body }),
  patchFields.safeExtend({ appendBody: updateDebtFields.appendBody }),
];
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
  return parseDebtInput(
    z.union(updateDebtInputSchemas.map((branch) => branch.safeExtend({ signal: signalSchema }))),
    input,
  );
}
