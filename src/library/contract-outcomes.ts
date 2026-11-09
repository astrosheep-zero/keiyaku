/** @architectureCompositionRoot */
import { z } from "zod";
import { contractIdSchema } from "../git/identity.js";
import { gateSchema } from "../protocol/result-leaves.js";
import { worktreeWorkspaceSchema } from "../git/workspace.js";
import type { ContractId, Gate } from "../core/facts/types.js";
import { deliveryPreviewReportSchema, type DeliveryPreviewReport } from "../protocol/delivery-preview.js";
import { completionEvidenceShape } from "../protocol/completion.js";
import { reviewAdmissionValueSchema } from "../protocol/review.js";
import { verifyValueSchema } from "../protocol/verify.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import type { IntentOutcome, IntentRetry } from "../protocol/operations.js";
import type { ContractWorkspaceLocation } from "../workspace-place.js";
import { deliveredValueSchema, type Delivery, type DeliveryValue } from "./delivery.js";
import { continuationReportSchema } from "./continuation.js";
import type { InvocationAccumulator } from "./invocation.js";
import type { Kei } from "./kei.js";
import {
  handoffOutcomeSchema,
  operationOutcomeSchema,
  type ContractVerb,
  type HandoffOutcome,
  type OperationOutcome,
  type OutcomeProjection,
  type Review,
  type Verify,
} from "./outcome.js";
import { operationRefusalSchemas, operationRetrySchemas } from "./refusal.js";
import type { OperationRefusals } from "./refusal.js";
import { regionOverlapResultSchema, type AmendRegionObservation, type RegionObservation } from "./region.js";

export type BindValue = Readonly<{
  kei: Kei;
  workspace?: ContractWorkspaceLocation;
  warnings?: readonly string[];
}> &
  RegionObservation;

export type AmendValue = Readonly<{
  documentDiff: string;
  changes: Readonly<{ gates?: readonly Gate[]; after?: readonly ContractId[] }>;
}> &
  AmendRegionObservation;

const bindFields = {
  kei: z.strictObject({ contract: contractIdSchema }).readonly(),
  workspace: worktreeWorkspaceSchema.exactOptional(),
  warnings: z.array(z.string()).readonly().exactOptional(),
};
const amendFields = {
  documentDiff: z.string(),
  changes: z
    .strictObject({
      gates: z.array(gateSchema).readonly().exactOptional(),
      after: z.array(contractIdSchema).readonly().exactOptional(),
    })
    .readonly(),
};
const overlaps = z.array(regionOverlapResultSchema).readonly();
const bindValueSchema = z.union([
  z.strictObject({ ...bindFields, overlaps }).readonly(),
  z.strictObject({ ...bindFields, overlapFailure: z.string() }).readonly(),
]);
const amendValueSchema = z.union([
  z.strictObject({ ...amendFields, overlaps }).readonly(),
  z.strictObject({ ...amendFields, overlapFailure: z.string() }).readonly(),
  z.strictObject(amendFields).readonly(),
]);
export const bindOutcomeSchema = operationOutcomeSchema(
  "bind",
  { value: bindValueSchema },
  operationRefusalSchemas.bind,
  operationRetrySchemas.bind,
);
export const amendOutcomeSchema = operationOutcomeSchema(
  "amend",
  { value: amendValueSchema },
  operationRefusalSchemas.amend,
  operationRetrySchemas.amend,
);
export type BindOutcome = OperationOutcome<"bind", BindValue, OperationRefusals["bind"]>;
export type AmendOutcome = OperationOutcome<"amend", AmendValue, OperationRefusals["amend"]>;
export const deliverOutcomeSchema = z.union([
  operationOutcomeSchema(
    "deliver",
    { value: deliveredValueSchema },
    operationRefusalSchemas.deliver,
    operationRetrySchemas.deliver,
  ),
  handoffOutcomeSchema,
]);
export const verifyOutcomeSchema = operationOutcomeSchema(
  "verify",
  {
    value: verifyValueSchema
      .unwrap()
      .extend({
        continuation: continuationReportSchema.exactOptional(),
      })
      .readonly(),
  },
  operationRefusalSchemas.verify,
  operationRetrySchemas.verify,
);
export const reviewOutcomeSchema = operationOutcomeSchema(
  "review",
  {
    value: z
      .strictObject({
        ...completionEvidenceShape,
        ...reviewAdmissionValueSchema.unwrap().shape,
        continuation: continuationReportSchema.exactOptional(),
      })
      .readonly(),
  },
  operationRefusalSchemas.review,
  operationRetrySchemas.review,
);
export type DeliverOutcome =
  | OperationOutcome<"deliver", Delivery & DeliveryValue, OperationRefusals["deliver"]>
  | HandoffOutcome;
export type VerifyOutcome = OperationOutcome<"verify", Verify, OperationRefusals["verify"]>;
export type ReviewOutcome = OperationOutcome<"review", Review, OperationRefusals["review"]>;
export const deliveryPreviewOutcomeSchema = operationOutcomeSchema(
  "deliver-preview",
  { value: deliveryPreviewReportSchema },
  operationRefusalSchemas["deliver-preview"],
  operationRetrySchemas["deliver-preview"],
);
export type DeliveryPreviewOutcome = OperationOutcome<
  "deliver-preview",
  DeliveryPreviewReport,
  OperationRefusals["deliver-preview"]
>;
export const arcOutcomeSchema = operationOutcomeSchema(
  "arc",
  {},
  operationRefusalSchemas.arc,
  operationRetrySchemas.arc,
);
export const abandonOutcomeSchema = operationOutcomeSchema(
  "abandon",
  {},
  operationRefusalSchemas.abandon,
  operationRetrySchemas.abandon,
);
export type ArcOutcome = OperationOutcome<"arc", void, OperationRefusals["arc"]>;
export type AbandonOutcome = OperationOutcome<"abandon", void, OperationRefusals["abandon"]>;

export type MutationObservation = Readonly<{ observe?: ExecutionObserver }>;

export type DeliveryPreviewInput = Readonly<{ includeDirty?: boolean; showDiff?: boolean; signal?: AbortSignal }>;

export type BindResult = BindOutcome;

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;
/** The refused/retry arms are value-agnostic, so every operation can return them unchanged. */
type ExpectedProjection<Refusal> =
  | Readonly<{ kind: "refused"; contract?: ContractId; refusal: Refusal }>
  | Readonly<{ kind: "retry"; contract?: ContractId; reason: IntentRetry }>;

export function expected<Refusal>(
  contract: ContractId | undefined,
  admission: Exclude<IntentOutcome<unknown, Refusal>, { kind: "accepted" }>,
): ExpectedProjection<Refusal> {
  return admission.kind === "refused"
    ? {
        kind: "refused",
        ...(contract === undefined ? {} : { contract }),
        refusal: admission.refusal,
      }
    : { kind: "retry", ...(contract === undefined ? {} : { contract }), reason: admission.reason };
}

export function acceptedOutcome<Operation extends ContractVerb, Value>(
  operation: Operation,
  contract: ContractId,
  accumulator: InvocationAccumulator,
  value: Value,
): OutcomeProjection<Operation, Value, never> {
  void operation;
  const head = accumulator.head(contract);
  if (head === undefined) throw new Error("missing leading admission receipt");
  return { kind: "accepted", contract, head, value };
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
