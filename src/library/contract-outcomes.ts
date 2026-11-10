/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { compactReason, retrySchema, type CompactReason } from "../protocol/result-reasons.js";
import { deliveryPreviewReportSchema, type DeliveryPreviewReport } from "../protocol/delivery-preview.js";
import { placementSchema } from "../protocol/completion.js";
import { verifyValueSchema } from "../protocol/verify.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import type { IntentOutcome, IntentRetry } from "../protocol/operations.js";
import { deliveredValueSchema, type Delivery } from "./delivery.js";
import { continuationReportSchema } from "./continuation.js";
import type { InvocationAccumulator } from "./invocation.js";
import type { Kei } from "./kei.js";
import {
  type OperationOutcome,
  type HandoffOutcome,
  type Review,
  type Verify,
  handoffOutcomeSchema,
  operationOutcomeSchema,
  invocationIssueSchema,
  localIssueSchema,
  completionIssueSchema,
  previewIssueSchema,
} from "./outcome.js";
import { operationRefusalSchemas, type OperationRefusals } from "./refusal.js";
import { regionOverlapResultSchema } from "./region.js";
import type { ContractId } from "../core/facts/types.js";

const regionFields = {
  overlaps: z.array(regionOverlapResultSchema).min(1).readonly().exactOptional(),
  overlapError: z.string().exactOptional(),
};
const bindFields = {
  worktreePath: z.string().min(1).exactOptional(),
  target: z.string().min(1).exactOptional(),
  ...regionFields,
};
const amendFields = {
  changedSections: z.array(z.string()).min(1).readonly().exactOptional(),
  gatesChanged: z.literal(true).exactOptional(),
  afterChanged: z.literal(true).exactOptional(),
  ...regionFields,
};
const worktreeChangesSchema = z
  .strictObject({
    staged: z.array(z.string()).min(1).readonly().exactOptional(),
    unstaged: z.array(z.string()).min(1).readonly().exactOptional(),
    untracked: z.array(z.string()).min(1).readonly().exactOptional(),
    unmergedPaths: z.array(z.string()).min(1).readonly().exactOptional(),
  })
  .readonly();
const reviewFields = {
  placement: placementSchema.exactOptional(),
  worktreeChanges: worktreeChangesSchema.exactOptional(),
  continuation: continuationReportSchema.exactOptional(),
};
const bindValueSchema = z.strictObject(bindFields).readonly();
const amendValueSchema = z.strictObject(amendFields).readonly();
export type BindValue = z.output<typeof bindValueSchema> & Readonly<{ kei: Kei }>;
export type AmendValue = z.output<typeof amendValueSchema>;
const localRecoveries = { recoverySnapshots: z.array(snapshotIdSchema).min(1).readonly().exactOptional() };
const bindOutcomes = operationOutcomeSchema(bindFields, operationRefusalSchemas.bind, localIssueSchema);
export const bindOutcomeSchema = z.union([
  bindOutcomes.options[0].unwrap().extend(localRecoveries).readonly(),
  bindOutcomes.options[1].unwrap().omit({ contractId: true }).readonly(),
  ...retrySchema.options,
]);
const amendOutcomes = operationOutcomeSchema(amendFields, operationRefusalSchemas.amend, localIssueSchema);
export const amendOutcomeSchema = z.union([
  amendOutcomes.options[0].unwrap().extend(localRecoveries).readonly(),
  amendOutcomes.options[1],
  amendOutcomes.options[2],
  amendOutcomes.options[3],
]);
export const deliverOutcomeSchema = z.union([
  operationOutcomeSchema(deliveredValueSchema.unwrap().shape, operationRefusalSchemas.deliver, completionIssueSchema),
  handoffOutcomeSchema,
]);
const verifyOutcomes = operationOutcomeSchema(
  { ...verifyValueSchema.unwrap().shape, continuation: continuationReportSchema.exactOptional() },
  operationRefusalSchemas.verify,
  invocationIssueSchema,
);
export const verifyOutcomeSchema = z.union([verifyOutcomes.options[0], verifyOutcomes.options[1]]);
export const reviewOutcomeSchema = operationOutcomeSchema(
  reviewFields,
  operationRefusalSchemas.review,
  completionIssueSchema,
);
const arcOutcomes = operationOutcomeSchema(
  { chapter: z.number().int().positive() },
  operationRefusalSchemas.arc,
  localIssueSchema,
);
export const arcOutcomeSchema = z.union([
  arcOutcomes.options[0].unwrap().extend(localRecoveries).readonly(),
  arcOutcomes.options[1],
  arcOutcomes.options[2],
  arcOutcomes.options[3],
]);
const abandonOutcomes = operationOutcomeSchema({}, operationRefusalSchemas.abandon, localIssueSchema);
export const abandonOutcomeSchema = z.union([
  abandonOutcomes.options[0].unwrap().extend(localRecoveries).readonly(),
  abandonOutcomes.options[1],
  abandonOutcomes.options[2],
  abandonOutcomes.options[3],
]);
const previewIssues = { issues: z.array(previewIssueSchema).min(1).readonly().exactOptional() };
export const deliveryPreviewOutcomeSchema = z.union([
  deliveryPreviewReportSchema.options[0].unwrap().extend(previewIssues).readonly(),
  deliveryPreviewReportSchema.options[1].unwrap().extend(previewIssues).readonly(),
  z
    .strictObject({
      kind: z.literal("refused"),
      contractId: contractIdSchema,
      reason: operationRefusalSchemas["deliver-preview"],
    })
    .readonly(),
]);

export type BindOutcome = OperationOutcome<"bind", BindValue, OperationRefusals["bind"]>;
export type AmendOutcome = OperationOutcome<"amend", AmendValue, OperationRefusals["amend"]>;
export type DeliverOutcome = OperationOutcome<"deliver", Delivery, OperationRefusals["deliver"]> | HandoffOutcome;
export type VerifyOutcome = OperationOutcome<"verify", Verify, OperationRefusals["verify"]>;
export type ReviewOutcome = OperationOutcome<"review", Review, OperationRefusals["review"]>;
export type ArcOutcome = OperationOutcome<"arc", Readonly<{ chapter: number }>, OperationRefusals["arc"]>;
export type AbandonOutcome = OperationOutcome<"abandon", Record<never, never>, OperationRefusals["abandon"]>;
export type DeliveryPreviewOutcome =
  | (DeliveryPreviewReport & Readonly<{ issues?: readonly z.output<typeof previewIssueSchema>[] }>)
  | Readonly<{ kind: "refused"; contractId: ContractId; reason: OperationRefusals["deliver-preview"] }>;
export type MutationObservation = Readonly<{ observe?: ExecutionObserver }>;
export type DeliveryPreviewInput = Readonly<{ includeDirty?: boolean; showDiff?: boolean; signal?: AbortSignal }>;
export type BindResult = BindOutcome;

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;
type ExpectedProjection<Refusal> =
  | Readonly<{ kind: "refused"; contract?: ContractId; refusal: Refusal }>
  | Readonly<{ kind: "retry"; contract?: ContractId; reason: IntentRetry }>;
type RetryProjection = Readonly<{ kind: "retry"; contract?: ContractId; reason: IntentRetry }>;
export function expected(
  contract: ContractId | undefined,
  admission: Readonly<{ kind: "retry"; reason: IntentRetry }>,
): RetryProjection;
export function expected<Refusal extends Parameters<typeof compactReason>[0]>(
  contract: ContractId | undefined,
  admission: Readonly<{ kind: "refused"; refusal: Refusal }> | Readonly<{ kind: "retry"; reason: IntentRetry }>,
): ExpectedProjection<CompactReason<Refusal>>;
export function expected<Refusal extends Parameters<typeof compactReason>[0]>(
  contract: ContractId | undefined,
  admission: Readonly<{ kind: "refused"; refusal: Refusal }> | Readonly<{ kind: "retry"; reason: IntentRetry }>,
): ExpectedProjection<CompactReason<Refusal>> {
  return admission.kind === "refused"
    ? { kind: "refused", ...(contract === undefined ? {} : { contract }), refusal: compactReason(admission.refusal) }
    : { kind: "retry", ...(contract === undefined ? {} : { contract }), reason: admission.reason };
}
export function acceptedOutcome<Value>(
  contract: ContractId,
  accumulator: InvocationAccumulator,
  value: Value,
): Readonly<{ kind: "accepted"; contract: ContractId; value: Value }> {
  if (accumulator.head(contract) === undefined) throw new Error("missing leading admission receipt");
  return { kind: "accepted", contract, value };
}
export function retainAdmission<Value>(
  accumulator: InvocationAccumulator,
  contract: ContractId,
  leading: AcceptedIntent<Value>,
): void {
  accumulator.recordPublication(contract, leading.head, leading.facts);
  accumulator.recordResidue(contract, leading);
  accumulator.recordVerification(contract, undefined, leading);
}
