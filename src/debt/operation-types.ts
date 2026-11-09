import { z } from "zod";
import { debtDocumentSchema, debtStateSchema, type DebtPriority, type DebtState } from "./document.js";
import { debtIdSchema, type DebtId } from "./identity.js";

export const debtViewSchema = z
  .strictObject({ ...debtDocumentSchema.unwrap().shape, namespace: z.array(z.string()).readonly() })
  .readonly();
export const debtCleanupFailureSchema = z
  .strictObject({ kind: z.literal("lock-release-failed"), diagnostics: z.array(z.string()).readonly() })
  .readonly();
export const debtRefusalSchema = z.union([
  z.strictObject({ kind: z.literal("debt-missing"), debtId: debtIdSchema }).readonly(),
  z
    .strictObject({
      kind: z.literal("invalid-lifecycle-transition"),
      debtId: debtIdSchema,
      state: debtStateSchema,
      verb: z.enum(["done", "drop"]),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("invalid-graph"), diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("invalid-namespace-context"), path: z.string() }).readonly(),
  z
    .strictObject({
      kind: z.literal("relation-owned-by-other"),
      debtId: debtIdSchema,
      related: debtIdSchema,
      declaringDebt: debtIdSchema,
    })
    .readonly(),
]);
export const debtRetrySchema = z.enum(["busy", "concurrent-modification"]);
export function debtOutcomeSchema<S extends z.ZodType>(value: S) {
  return z.union([
    z
      .strictObject({ kind: z.literal("accepted"), value, cleanup: debtCleanupFailureSchema.exactOptional() })
      .readonly(),
    z.strictObject({ kind: z.literal("refused"), refusal: debtRefusalSchema }).readonly(),
    z.strictObject({ kind: z.literal("retry"), reason: debtRetrySchema }).readonly(),
  ]);
}
export const debtMutationResultSchema = debtOutcomeSchema(debtViewSchema);
export const debtUpdateResultSchema = debtOutcomeSchema(
  z
    .strictObject({
      debt: debtViewSchema,
      documentDiff: z.string(),
      changedFields: z
        .array(
          z
            .strictObject({
              field: z.string(),
              action: z.enum(["added", "replaced", "cleared", "changed", "appended"]),
            })
            .readonly(),
        )
        .readonly(),
    })
    .readonly(),
);
export const debtBatchResultSchema = z
  .strictObject({
    items: z.array(z.strictObject({ id: debtIdSchema, outcome: debtMutationResultSchema }).readonly()).readonly(),
  })
  .readonly();

export type DebtView = z.output<typeof debtViewSchema>;
export type DebtCleanupFailure = z.output<typeof debtCleanupFailureSchema>;
export type DebtRefusal = z.output<typeof debtRefusalSchema>;
export type DebtRetry = z.output<typeof debtRetrySchema>;
export type DebtMutationResult = DebtOutcome<DebtView>;
export type DebtUpdateResult = z.output<typeof debtUpdateResultSchema>;
export type DebtBatchResult = z.output<typeof debtBatchResultSchema>;
export type DebtOutcome<A> = z.output<ReturnType<typeof debtOutcomeSchema<z.ZodType<A>>>>;
export type DebtLifecycleVerb = Extract<DebtRefusal, { kind: "invalid-lifecycle-transition" }>["verb"];
export type SettledDebtAction = "done";
export type SettledDebtResult =
  | Readonly<{ kind: "changed"; debt: DebtView; action: SettledDebtAction; cleanup?: DebtCleanupFailure }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; refusal: DebtRefusal }>
  | Readonly<{ kind: "retry"; reason: DebtRetry }>;
export type AddDebtInput = Readonly<{
  title: string;
  namespace?: readonly string[];
  body?: string;
  note?: string;
  state?: DebtState;
  priority?: DebtPriority;
  needs?: readonly DebtId[];
  parent?: DebtId | null;
  supersedes?: readonly DebtId[];
  relates?: readonly DebtId[];
  actor?: string;
  signal?: AbortSignal;
}>;
export type AddDebtDocumentInput = Readonly<{
  markdown: string;
  namespace?: readonly string[];
  actor?: string;
  signal?: AbortSignal;
}>;
export type UpdateDebtInput = Readonly<{
  title?: string;
  body?: string;
  appendBody?: string;
  note?: string;
  priority?: DebtPriority;
  needs?: readonly DebtId[];
  addNeeds?: readonly DebtId[];
  dropNeeds?: readonly DebtId[];
  parent?: DebtId | null;
  supersedes?: readonly DebtId[];
  addSupersedes?: readonly DebtId[];
  dropSupersedes?: readonly DebtId[];
  relates?: readonly DebtId[];
  addRelates?: readonly DebtId[];
  dropRelates?: readonly DebtId[];
  signal?: AbortSignal;
}>;
