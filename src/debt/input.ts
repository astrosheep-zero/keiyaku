import { z } from "zod";
import { debtPrioritySchema, debtStateSchema } from "./document.js";
import { canonicalDebtId, debtIdSchema, type DebtId } from "./identity.js";
import type { AddDebtDocumentInput, AddDebtInput, UpdateDebtInput } from "./operations.js";

export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function closed(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${label} has unknown field: ${key}`);
  }
}

export function debtId(value: unknown): DebtId {
  if (typeof value !== "string") throw new TypeError("debt ID must be a string");
  return canonicalDebtId(value);
}

export function signal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return value;
}

export function text(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

export function actor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("actor must be a nonblank string");
  }
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
const debtFields = {
  title: titleSchema.exactOptional(),
  body: optionalText,
  note: optionalText,
  state: debtStateSchema.exactOptional(),
  priority: debtPrioritySchema.exactOptional(),
  needs: idsSchema,
  parent: debtIdSchema.nullable().exactOptional(),
  supersedes: idsSchema,
  relates: idsSchema,
};
export const addDebtInputSchema = z.strictObject({
  ...debtFields,
  title: titleSchema,
  actor: z.string().regex(/\S/u, "actor must be a nonblank string").exactOptional(),
});
const updateDebtFields = {
  ...debtFields,
  appendBody: optionalText,
  addNeeds: idsSchema,
  dropNeeds: idsSchema,
  addSupersedes: idsSchema,
  dropSupersedes: idsSchema,
  addRelates: idsSchema,
  dropRelates: idsSchema,
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
  patchFields.safeExtend({ body: optionalText }),
  patchFields.safeExtend({ appendBody: optionalText }),
];
const signalSchema = z.instanceof(AbortSignal).exactOptional();

function parseDebtInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError(result.error.message);
  return result.data;
}

export function addInput(input: unknown): AddDebtInput {
  return parseDebtInput(addDebtInputSchema.extend({ signal: signalSchema }), input);
}

export function addDocumentInput(input: unknown): AddDebtDocumentInput {
  const v = record(input, "addDocument input");
  closed(v, ["markdown", "actor", "signal"], "addDocument input");
  const markdown = text(v.markdown, "markdown");
  if (markdown === undefined) throw new TypeError("markdown is required");
  const createdBy = actor(v.actor),
    abort = signal(v.signal);
  return {
    markdown,
    ...(createdBy === undefined ? {} : { actor: createdBy }),
    ...(abort === undefined ? {} : { signal: abort }),
  };
}

export function updateInput(input: unknown): UpdateDebtInput {
  return parseDebtInput(
    z.union(updateDebtInputSchemas.map((branch) => branch.safeExtend({ signal: signalSchema }))),
    input,
  );
}
