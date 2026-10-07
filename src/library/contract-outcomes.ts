/** @architectureCompositionRoot */
import type { ContractId, Gate } from "../core/facts/types.js";
import type { AuditReport } from "../protocol/audit.js";
import type { ExecutionObserver } from "../protocol/execution-observation.js";
import type { IntentOutcome, IntentRetry } from "../protocol/operations.js";
import type { ContractWorkspaceLocation } from "../workspace-place.js";
import type { Delivery, DeliveryValue } from "./delivery.js";
import type { InvocationAccumulator } from "./invocation.js";
import type { Keiyaku } from "./keiyaku.js";
import type { ContractVerb, HandoffOutcome, OperationOutcome, OutcomeProjection, Review } from "./outcome.js";
import type { OperationRefusals } from "./refusal.js";
import type { AmendRegionObservation, RegionObservation } from "./region.js";

export type BindValue = Readonly<{
  keiyaku: Keiyaku;
  workspace?: ContractWorkspaceLocation;
  warnings?: readonly string[];
}> &
  RegionObservation;

export type AmendValue = Readonly<{
  documentDiff: string;
  changes: Readonly<{ gates?: readonly Gate[]; after?: readonly ContractId[] }>;
}> &
  AmendRegionObservation;

export type BindOutcome = OperationOutcome<"bind", BindValue, OperationRefusals["bind"]>;
export type AmendOutcome = OperationOutcome<"amend", AmendValue, OperationRefusals["amend"]>;
export type DeliverOutcome =
  | OperationOutcome<"deliver", Delivery & DeliveryValue, OperationRefusals["deliver"]>
  | HandoffOutcome;
export type ReviewOutcome = OperationOutcome<"review", Review, OperationRefusals["review"]>;
export type AuditOutcome = OperationOutcome<"audit", AuditReport, OperationRefusals["audit"]>;
export type ArcOutcome = OperationOutcome<"arc", void, OperationRefusals["arc"]>;
export type AbandonOutcome = OperationOutcome<"abandon", void, OperationRefusals["abandon"]>;

export type MutationObservation = Readonly<{ observe?: ExecutionObserver }>;

export type AuditInput = Readonly<{ includeDirty?: boolean; showDiff?: boolean; signal?: AbortSignal }>;

export type BindResult = BindOutcome;

type AcceptedIntent<Value> = Extract<IntentOutcome<Value>, { kind: "accepted" }>;
type Admission<Value, Refusal> =
  | Readonly<{ kind: "accepted"; accepted: AcceptedIntent<Value> }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "retry"; reason: IntentRetry }>;

export function admissionOf<Value, Refusal>(outcome: IntentOutcome<Value, Refusal>): Admission<Value, Refusal> {
  if (outcome.kind === "accepted") return { kind: "accepted", accepted: outcome };
  return outcome.kind === "refused"
    ? { kind: "refused", refusal: outcome.refusal }
    : { kind: "retry", reason: outcome.reason };
}

/** The refused/retry arms are value-agnostic, so every operation can return them unchanged. */
type ExpectedProjection<Refusal> =
  | Readonly<{ kind: "refused"; contract?: ContractId; refusal: Refusal }>
  | Readonly<{ kind: "retry"; contract?: ContractId; reason: IntentRetry }>;

export function expected<Refusal>(
  contract: ContractId | undefined,
  admission: Exclude<Admission<unknown, Refusal>, { kind: "accepted" }>,
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

export function conclusions(value: object): Readonly<Record<string, unknown>> {
  return value as Readonly<Record<string, unknown>>;
}

export function retainAdmission<Value>(
  accumulator: InvocationAccumulator,
  contract: ContractId,
  leading: AcceptedIntent<Value>,
  verificationResidueRecorded: boolean,
): void {
  accumulator.recordPublication(contract, leading.head, leading.facts);
  accumulator.recordResidue(contract, leading);
  if (!verificationResidueRecorded) accumulator.recordVerification(contract, undefined, leading);
}
