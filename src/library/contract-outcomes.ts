/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { retrySchema } from "../protocol/result-reasons.js";
import { deliveryPreviewReportSchema } from "../protocol/delivery-preview.js";
import { placementSchema } from "../protocol/completion.js";
import { verifyValueSchema, verifyNormalValueSchema } from "../protocol/verify.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import type { IntentOutcome } from "../protocol/operations.js";
import { deliveredValueSchema } from "./delivery.js";
import { continuationReportSchema, continuationNormalReportSchema } from "./continuation.js";
import type { InvocationAccumulator } from "./invocation.js";
import type { Kei } from "./kei.js";
import {
  handoffOutcomeSchema,
  operationOutcomeSchema,
  acceptedOutcomeSchema,
  optionalInvocationIssueSchema,
  optionalLocalIssueSchema,
  invocationIssueSchema,
  localIssueSchema,
  previewIssueSchema,
} from "./outcome.js";
import { operationRefusalSchemas } from "./refusal.js";
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
export const bindNormalOutcomeSchema = acceptedOutcomeSchema(
  { ...bindFields, ...localRecoveries },
  optionalLocalIssueSchema,
);
const bindOutcomes = operationOutcomeSchema(bindFields, operationRefusalSchemas.bind, localIssueSchema);
export const bindOutcomeSchema = z.union([
  bindOutcomes.options[0].unwrap().extend(localRecoveries).readonly(),
  bindOutcomes.options[1].unwrap().omit({ contractId: true }).readonly(),
  ...retrySchema.options,
]);
export const amendOutcomeSchema = operationOutcomeSchema(
  { ...amendFields, ...localRecoveries },
  operationRefusalSchemas.amend,
  localIssueSchema,
);
export const deliverOutcomeSchema = z.union([
  operationOutcomeSchema(deliveredValueSchema.unwrap().shape, operationRefusalSchemas.deliver, invocationIssueSchema),
  handoffOutcomeSchema,
]);
const verifyOutcomes = operationOutcomeSchema(
  { ...verifyValueSchema.unwrap().shape, continuation: continuationReportSchema.exactOptional() },
  operationRefusalSchemas.verify,
  invocationIssueSchema,
);
export const verifyNormalOutcomeSchema = acceptedOutcomeSchema(
  { ...verifyNormalValueSchema.unwrap().shape, continuation: continuationNormalReportSchema.exactOptional() },
  optionalInvocationIssueSchema,
);
export const verifyOutcomeSchema = z.union([verifyOutcomes.options[0], verifyOutcomes.options[1]]);
export const reviewOutcomeSchema = operationOutcomeSchema(
  reviewFields,
  operationRefusalSchemas.review,
  invocationIssueSchema,
);
export const arcOutcomeSchema = operationOutcomeSchema(
  { chapter: z.number().int().positive(), ...localRecoveries },
  operationRefusalSchemas.arc,
  localIssueSchema,
);
export const abandonOutcomeSchema = operationOutcomeSchema(
  localRecoveries,
  operationRefusalSchemas.abandon,
  localIssueSchema,
);
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

export type BindOutcome =
  z.output<typeof bindOutcomeSchema> extends infer Answer
    ? Answer extends { kind: "accepted" }
      ? Answer & Readonly<{ kei: Kei }>
      : Answer
    : never;
export type AmendOutcome = z.output<typeof amendOutcomeSchema>;
export type DeliverOutcome = z.output<typeof deliverOutcomeSchema>;
export type VerifyOutcome = z.output<typeof verifyOutcomeSchema>;
export type ReviewOutcome = z.output<typeof reviewOutcomeSchema>;
export type ArcOutcome = z.output<typeof arcOutcomeSchema>;
export type AbandonOutcome = z.output<typeof abandonOutcomeSchema>;
export type DeliveryPreviewOutcome = z.output<typeof deliveryPreviewOutcomeSchema>;
export type MutationObservation = Readonly<{ observe?: ExecutionObserver }>;
export type DeliveryPreviewInput = Readonly<{ includeDirty?: boolean; showDiff?: boolean; signal?: AbortSignal }>;

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;
export function retainAdmission<Value>(
  accumulator: InvocationAccumulator,
  contract: ContractId,
  leading: AcceptedIntent<Value>,
): void {
  accumulator.recordPublication(contract, leading.head, leading.facts);
  accumulator.recordResidue(contract, leading);
  accumulator.recordVerification(contract, undefined, leading);
}
