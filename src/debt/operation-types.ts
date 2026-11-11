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
const ownershipRefusalSchema = z
  .strictObject({
    kind: z.literal("refused"),
    reason: z.literal("relation-owned-by-other"),
    related: debtIdSchema,
  })
  .readonly();
const terminalRefusalSchema = z
  .strictObject({
    kind: z.literal("refused"),
    reason: z.literal("invalid-lifecycle-transition"),
    state: z.enum(["done", "drop"]),
  })
  .readonly();
export const debtRefusalSchema = z.union([
  missingRefusalSchema,
  graphRefusalSchema,
  ownershipRefusalSchema,
  terminalRefusalSchema,
]);
export type DebtRefusal = z.output<typeof debtRefusalSchema>;
export const debtParentReadRefusalSchema = missingRefusalSchema;
export type DebtParentReadRefusal = z.output<typeof debtParentReadRefusalSchema>;

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
export type DebtReadPage<Row, Refusal = never> =
  | Readonly<{ kind: "present"; rows?: readonly Row[]; more?: true }>
  | Readonly<{ kind: "absent" }>
  | Refusal;

export const debtMutationResultSchema = z.union([
  z
    .strictObject({ kind: z.literal("accepted"), id: debtIdSchema, warning: debtWarningSchema.exactOptional() })
    .readonly(),
  graphRefusalSchema,
  retryResultSchema,
]);
export const debtChangeSchema = z.enum([
  "title",
  "body",
  "note",
  "state",
  "priority",
  "needs",
  "parent",
  "supersedes",
  "relates",
]);
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
  ownershipRefusalSchema,
  terminalRefusalSchema,
  retryResultSchema,
]);

export type DebtRetry = z.output<typeof debtRetrySchema>;
export type DebtMutationResult = z.output<typeof debtMutationResultSchema>;
export type DebtChange = z.output<typeof debtChangeSchema>;
export type DebtUpdateResult = z.output<typeof debtUpdateResultSchema>;
export type SettledDebtResult =
  | Readonly<{ kind: "changed"; cleanup?: DebtWarning }>
  | Readonly<{ kind: "unchanged" }>
  | Extract<DebtUpdateResult, { kind: "refused" | "retry" }>;
export type AddDebtInput = Readonly<{
  title: string;
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
  actor?: string;
  signal?: AbortSignal;
}>;
export type UpdateDebtInput = Readonly<{
  title?: string;
  body?: string;
  appendBody?: string;
  note?: string;
  state?: DebtState;
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
