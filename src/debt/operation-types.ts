import { z } from "zod";
import type { DebtPriority, DebtState } from "./document.js";
import { debtIdSchema, type DebtId } from "./identity.js";

/** Cardinality is enforced by the schema; TypeScript retains Zod's inferred array type. */
export function nonEmptyDebtArraySchema<Row extends z.ZodType>(row: Row) {
  return z.array(row).min(1).readonly();
}
/** A producer has completely observed this collection; absence means known empty. */
export function nonEmptyDebtValues<T>(values: readonly T[]): readonly T[] | undefined {
  return values.length === 0 ? undefined : values;
}

export const debtWarningSchema = z.string();
export type DebtWarning = z.output<typeof debtWarningSchema>;
export const debtRetrySchema = z.enum(["busy", "concurrent-modification"]);
const retryResultSchema = z.strictObject({ kind: z.literal("retry"), reason: debtRetrySchema }).readonly();
const missingRefusalSchema = z
  .strictObject({ kind: z.literal("refused"), reason: z.literal("debt-missing") })
  .readonly();
const graphRefusalSchema = z
  .strictObject({
    kind: z.literal("refused"),
    reason: z.literal("invalid-graph"),
    diagnostic: z.string(),
  })
  .readonly();
export const debtRefusalSchema = z.union([missingRefusalSchema, graphRefusalSchema]);
export type DebtRefusal = z.output<typeof debtRefusalSchema>;

export function debtReadPageSchema<Row extends z.ZodType>(row: Row) {
  return z.union([
    z
      .strictObject({
        kind: z.literal("present"),
        rows: nonEmptyDebtArraySchema(row).exactOptional(),
        more: z.literal(true).exactOptional(),
      })
      .readonly(),
    z.strictObject({ kind: z.literal("absent") }).readonly(),
  ]);
}
export type DebtReadPage<Row> =
  | Readonly<{ kind: "present"; rows?: readonly Row[]; more?: true }>
  | Readonly<{ kind: "absent" }>;

export const debtMutationNormalResultSchema = z
  .strictObject({ kind: z.literal("accepted"), id: debtIdSchema, warning: debtWarningSchema.exactOptional() })
  .readonly();
export const debtMutationResultSchema = z.union([
  debtMutationNormalResultSchema,
  graphRefusalSchema,
  retryResultSchema,
]);
export const debtChangeSchema = z.enum(["title", "body", "note", "state", "priority", "needs"]);
export const debtUpdateResultSchema = z.union([
  z
    .strictObject({
      kind: z.literal("accepted"),
      changes: nonEmptyDebtArraySchema(debtChangeSchema).exactOptional(),
      warning: debtWarningSchema.exactOptional(),
    })
    .readonly(),
  missingRefusalSchema,
  graphRefusalSchema,
  retryResultSchema,
]);

export type DebtRetry = z.output<typeof debtRetrySchema>;
export type DebtMutationResult = z.output<typeof debtMutationResultSchema>;
export type DebtChange = z.output<typeof debtChangeSchema>;
export type DebtUpdateResult = z.output<typeof debtUpdateResultSchema>;
/** Settlement alone retains a private drop refusal; public updates accept every state transition. */
export type SettledDebtResult =
  | Readonly<{ kind: "changed"; cleanup?: DebtWarning }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "refused"; reason: "debt-missing" }>
  | Readonly<{ kind: "refused"; reason: "invalid-lifecycle-transition"; state: "drop" }>
  | Readonly<{ kind: "retry"; reason: DebtRetry }>;
export type AddDebtInput = Readonly<{
  title: string;
  body?: string;
  priority?: DebtPriority;
  needs?: readonly DebtId[];
  signal?: AbortSignal;
}>;
export type AddDebtDocumentInput = Readonly<{
  markdown: string;
  signal?: AbortSignal;
}>;
export type UpdateDebtInput = Readonly<{
  title?: string;
  body?: string;
  note?: string;
  state?: DebtState;
  priority?: DebtPriority;
  needs?: readonly DebtId[];
  signal?: AbortSignal;
}>;
