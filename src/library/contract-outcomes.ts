/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import {
  activeReasonSchema,
  declarationReasonSchema,
  preparationReasonSchema,
  retrySchema,
  targetLifecycleReasonSchema,
  targetWorkspaceReasonSchema,
  worktreeMissingReasonSchema,
} from "../protocol/result-reasons.js";
import { deliveryPreviewReportSchema } from "../protocol/delivery-preview.js";
import { placedSchema, placementSchema, placementStopSchema } from "../protocol/completion.js";
import { deliveryIdentitySchema } from "../protocol/result-leaves.js";
import { verifyValueSchema, verifyNormalValueSchema } from "../protocol/verify.js";
import { reviewAdmissionValueSchema } from "../protocol/review.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import { continuationReportSchema, continuationNormalReportSchema } from "./continuation.js";
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
import { regionOverlapResultSchema } from "./region.js";

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
  target: z.string().exactOptional(),
  changedSections: z.array(z.string()).min(1).readonly().exactOptional(),
  gatesChanged: z.literal(true).exactOptional(),
  afterChanged: z.literal(true).exactOptional(),
  ...regionFields,
};
const reviewFields = {
  ...reviewAdmissionValueSchema.unwrap().shape,
  placement: placementSchema.exactOptional(),
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
const bindOutcomes = operationOutcomeSchema(
  bindFields,
  z.union([
    z
      .strictObject({
        kind: z.enum([
          "contract-exists",
          "invalid-after",
          "unknown-prerequisite",
          "invalid-target",
          "target-missing",
          "unborn-head",
          "target-contract-self",
          "fork-source-missing",
          "fork-source-unavailable",
          "fork-source-moved",
        ]),
      })
      .readonly(),
    targetLifecycleReasonSchema,
    targetWorkspaceReasonSchema,
    declarationReasonSchema,
  ]),
  localIssueSchema,
);
export const bindOutcomeSchema = z.union([
  bindOutcomes.options[0].unwrap().extend(localRecoveries).readonly(),
  bindOutcomes.options[1].unwrap().omit({ contractId: true }).readonly(),
  ...retrySchema.options,
]);
export const amendOutcomeSchema = operationOutcomeSchema(
  { ...amendFields, ...localRecoveries },
  z.union([
    activeReasonSchema,
    z
      .strictObject({
        kind: z.enum([
          "terms-moved",
          "unknown-prerequisite",
          "cyclic-prerequisite",
          "cyclic-target",
          "invalid-target",
          "target-missing",
        ]),
      })
      .readonly(),
    targetLifecycleReasonSchema,
    declarationReasonSchema,
    targetWorkspaceReasonSchema,
  ]),
  localIssueSchema,
);
const previewRefusalSchema = z.union([activeReasonSchema, targetLifecycleReasonSchema, declarationReasonSchema]);
const deliveredValueSchema = deliveryIdentitySchema
  .unwrap()
  .extend({
    placement: z
      .union([placedSchema.unwrap().omit({ integration: true }).readonly(), placementStopSchema])
      .exactOptional(),
    continuation: continuationReportSchema.exactOptional(),
  })
  .readonly();
export const deliverySchema = deliveredValueSchema.nullable();
export type Delivery = z.output<typeof deliveredValueSchema>;

export const deliverOutcomeSchema = z.union([
  operationOutcomeSchema(
    deliveredValueSchema.unwrap().shape,
    z.union([
      previewRefusalSchema,
      preparationReasonSchema,
      z.strictObject({ kind: z.literal("merge-state-present"), worktreePath: z.string().min(1) }).readonly(),
    ]),
    invocationIssueSchema,
  ),
  handoffOutcomeSchema,
]);
const verifyOutcomes = operationOutcomeSchema(
  { ...verifyValueSchema.unwrap().shape, continuation: continuationReportSchema.exactOptional() },
  z.union([
    previewRefusalSchema,
    preparationReasonSchema,
    z
      .strictObject({ kind: z.literal("verification-index-out-of-range"), total: z.number().int().nonnegative() })
      .readonly(),
  ]),
  invocationIssueSchema,
);
export const verifyNormalOutcomeSchema = acceptedOutcomeSchema(
  { ...verifyNormalValueSchema.unwrap().shape, continuation: continuationNormalReportSchema.exactOptional() },
  optionalInvocationIssueSchema,
);
export const verifyOutcomeSchema = z.union([verifyOutcomes.options[0], verifyOutcomes.options[1]]);
export const reviewOutcomeSchema = operationOutcomeSchema(
  reviewFields,
  z.union([
    activeReasonSchema,
    worktreeMissingReasonSchema,
    z
      .strictObject({ kind: z.literal("dirty-submodules"), paths: z.array(z.string().min(1)).min(1).readonly() })
      .readonly(),
  ]),
  invocationIssueSchema,
);
export const arcOutcomeSchema = operationOutcomeSchema(
  { chapter: z.number().int().positive(), ...localRecoveries },
  activeReasonSchema,
  localIssueSchema,
);
export const abandonOutcomeSchema = operationOutcomeSchema(localRecoveries, activeReasonSchema, localIssueSchema);
const previewIssues = { issues: z.array(previewIssueSchema).min(1).readonly().exactOptional() };
export const deliveryPreviewOutcomeSchema = z.union([
  deliveryPreviewReportSchema.options[0].unwrap().extend(previewIssues).readonly(),
  deliveryPreviewReportSchema.options[1].unwrap().extend(previewIssues).readonly(),
  z
    .strictObject({
      kind: z.literal("refused"),
      contractId: contractIdSchema,
      reason: previewRefusalSchema,
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
