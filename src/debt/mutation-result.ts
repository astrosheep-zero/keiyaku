import { debtIdSchema as debtMutationIdSchema, debtIdsSchema, debtNamespaceSchema, parseDebtId } from "./identity.js";
import { debtNonblankTextSchema, debtStateSchema, debtPrioritySchema } from "./document.js";
import { z } from "zod";

export { debtIdSchema as debtMutationIdSchema } from "./identity.js";

type WithoutUndefined<Value> = {
  [Key in keyof Value as undefined extends Value[Key] ? never : Key]: Value[Key];
} & {
  [Key in keyof Value as undefined extends Value[Key] ? Key : never]?: Exclude<Value[Key], undefined>;
};
function withoutUndefined<Value extends Record<string, unknown>>(
  value: Value,
  keys: readonly (keyof Value & string)[],
): WithoutUndefined<Value> {
  const result: Record<string, unknown> = { ...value };
  for (const key of keys) {
    const field = result[key];
    delete result[key];
    if (field !== undefined) result[key] = field;
  }
  return result as WithoutUndefined<Value>;
}
const timestampSchema = z.string().refine((value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "expected canonical UTC timestamp");
const debtRetrySchema = z
  .object({ kind: z.literal("retry"), reason: z.enum(["busy", "concurrent-modification"]) })
  .strict();
const debtCleanupFailureSchema = z
  .object({ kind: z.literal("lock-release-failed"), diagnostics: z.array(z.string()).readonly() })
  .strict();
const debtViewSchema = z
  .object({
    id: debtMutationIdSchema,
    namespace: debtNamespaceSchema,
    title: debtNonblankTextSchema,
    state: debtStateSchema,
    priority: debtPrioritySchema,
    needs: debtIdsSchema,
    parent: debtMutationIdSchema.nullable(),
    supersedes: debtIdsSchema,
    relates: debtIdsSchema,
    note: z.string(),
    createdBy: debtNonblankTextSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    body: z.string(),
  })
  .strict()
  .superRefine((debt, context) => {
    if (debt.namespace.join("/") !== parseDebtId(debt.id).namespace.join("/"))
      context.addIssue({ code: "custom", path: ["namespace"], message: "namespace must agree with debt ID" });
  })
  .transform(({ createdBy, ...debt }) => withoutUndefined({ ...debt, createdBy }, ["createdBy"]));
export const debtRefusalSchema = z.union([
  z.object({ kind: z.literal("debt-missing"), debtId: debtMutationIdSchema }).strict(),
  z
    .object({
      kind: z.literal("invalid-lifecycle-transition"),
      debtId: debtMutationIdSchema,
      state: debtStateSchema,
      verb: z.enum(["done", "drop"]),
    })
    .strict(),
  z.object({ kind: z.literal("invalid-graph"), diagnostic: z.string() }).strict(),
  z.object({ kind: z.literal("invalid-namespace-context"), path: z.string() }).strict(),
  z
    .object({
      kind: z.literal("relation-owned-by-other"),
      debtId: debtMutationIdSchema,
      related: debtMutationIdSchema,
      declaringDebt: debtMutationIdSchema,
    })
    .strict(),
]);
const debtRefusedResultSchema = z.object({ kind: z.literal("refused"), refusal: debtRefusalSchema }).strict();
export const debtMutationResultSchema = z.union([
  z
    .object({ kind: z.literal("accepted"), value: debtViewSchema, cleanup: debtCleanupFailureSchema.optional() })
    .strict()
    .transform((value) => withoutUndefined(value, ["cleanup"])),
  debtRefusedResultSchema,
  debtRetrySchema,
]);
export const debtUpdateResultSchema = z.union([
  z
    .object({
      kind: z.literal("accepted"),
      value: z
        .object({
          debt: debtViewSchema,
          documentDiff: z.string(),
          changedFields: z
            .array(
              z
                .object({ field: z.string(), action: z.enum(["added", "replaced", "cleared", "changed", "appended"]) })
                .strict(),
            )
            .readonly(),
        })
        .strict(),
      cleanup: debtCleanupFailureSchema.optional(),
    })
    .strict()
    .transform((value) => withoutUndefined(value, ["cleanup"])),
  debtRefusedResultSchema,
  debtRetrySchema,
]);
export const debtBatchResultSchema = z
  .object({
    items: z.array(z.object({ id: debtMutationIdSchema, outcome: debtMutationResultSchema }).strict()).readonly(),
  })
  .strict();
export const debtMutationExecutionResultSchema = z.union([
  debtBatchResultSchema,
  debtMutationResultSchema,
  debtUpdateResultSchema,
]);

export type DebtView = z.infer<typeof debtViewSchema>;
export type DebtCleanupFailure = z.infer<typeof debtCleanupFailureSchema>;
export type DebtRefusal = z.infer<typeof debtRefusalSchema>;
export type DebtRetry = z.infer<typeof debtRetrySchema>["reason"];
export type DebtMutationResult = z.infer<typeof debtMutationResultSchema>;
export type DebtUpdateResult = z.infer<typeof debtUpdateResultSchema>;
export type DebtBatchResult = z.infer<typeof debtBatchResultSchema>;
export type DebtMutationExecutionResult = z.infer<typeof debtMutationExecutionResultSchema>;
