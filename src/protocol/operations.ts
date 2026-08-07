import {
  prepareDelivery,
  prepareReview,
  type DeliveryPreparationRefusal,
  type ReviewPreparationRefusal,
} from "../carrier/delivery.js";
import {
  extendContractsForAdmission,
  observeCarrier,
  observeContract,
  observeContractsForAdmission,
  type CarrierDecisionObservation,
} from "../carrier/observe.js";
import { reconcile, reconcileBatch, type ReconcileResult } from "../carrier/reconcile.js";
import { NoGitWorldError, repositoryAt, type GitRepository } from "../carrier/repository.js";
import { readDeliveryDiff } from "../carrier/verification.js";
import type { WorktreeLeak } from "../carrier/verification.js";
import { dependencyKeySet } from "../core/subject.js";
import { contractState, documentIsCurrent } from "../core/facts/observation.js";
import type { ActorId, AmendData, ArcData, AttestationData, ChangeId, ContractId, ContractState, ContractTerms, DocumentKey, SnapshotId } from "../core/facts/types.js";
import { gate } from "../core/facts/types.js";
import { decideAbandon, type AbandonRefusal } from "../core/verbs/abandon.js";
import { decideAmend, type AmendInput, type AmendRefusal } from "../core/verbs/amend.js";
import { decideArc, type ArcRefusal } from "../core/verbs/arc.js";
import { decideDeliver, type DeliverInput, type DeliverRefusal } from "../core/verbs/deliver.js";
import type { PlacementRefusal } from "../core/verbs/placement.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import { produceVerification } from "../verification/producer.js";
import type { VerificationDeclarationPreparation, VerificationDeclarationRefusal } from "../verification/declaration.js";
import { admitIntent, admitPlacement, mintAttempts, verifyDelivery, type VerificationRuntimeStop } from "./intent.js";
import { auditReport, readAudit, type AuditReport as AuditReadReport } from "./read/audit.js";
import { readDocuments, type ContractDocumentProjection } from "./read/documents.js";
import {
  readContractBoard,
  readContractObservation,
  type ContractBoard,
  type ContractDisposition,
  type ContractGateCurrent,
  type ContractGateReport,
  type ContractObservation,
  type ContractPhase,
  type ContractRow,
} from "./read/status.js";
import { admitDecidedOffer, type AcceptedAdmission, type DecidedOfferResult } from "./attempt.js";
export { bindOperation } from "./bind.js";
import type { BindRefusal, TargetInputRefusal } from "./bind.js";
import { accepted, admitted, complete, type IntentOutcome as ProtocolIntentOutcome } from "./outcome.js";
import type { ProtocolResult, ProtocolTerminal } from "./run.js";

export type { FactKind, TimelineEntry } from "./read/audit.js";
export type { ContractDocumentProjection } from "./read/documents.js";
type DeliveryFailure = DeliveryPreparationRefusal | VerificationDeclarationRefusal | DeliverRefusal;

type ReviewRefusal = AttestationRefusal | ReviewPreparationRefusal;

const REVIEWED = gate("reviewed");

export type IntentRefusal = AbandonRefusal | AmendRefusal | ArcRefusal | BindRefusal | DeliverRefusal
  | DeliveryPreparationRefusal | PlacementRefusal | ReviewRefusal | TargetInputRefusal | VerificationDeclarationRefusal;

export type { TargetInputRefusal } from "./bind.js";

export type IntentRetry = ProtocolTerminal;
export type IntentOutcome<Value, Refusal = IntentRefusal> = ProtocolIntentOutcome<Value, Refusal>;

type OperationInput = Readonly<{ scope: RepositoryScope; contractId: ContractId; actor?: ActorId }>;

export type AuditReport = AuditReadReport & Readonly<{ attempt?: VerificationStop; leak?: WorktreeLeak }>;

export type DocumentDerivation = Readonly<{ document: DocumentKey; title: string; verification: VerificationDeclarationPreparation }>;

export type StepStop<R> = Readonly<{ refusal: R; retry?: never } | { retry: IntentRetry; refusal?: never }>;

export type VerificationStop = StepStop<AttestationRefusal> | VerificationRuntimeStop;
export type PlacementStop = StepStop<PlacementRefusal>;

function timestamp(): string { return new Date().toISOString(); }

function mergeAdmissions(current: AcceptedAdmission, next: AcceptedAdmission): AcceptedAdmission {
  return { ...next, facts: [...current.facts, ...next.facts] };
}

function stepStop<Refusal>(result: ProtocolResult<Refusal>): StepStop<Refusal> | undefined {
  if (result.kind === "accepted") return undefined;
  return result.kind === "refused" ? { refusal: result.refusal } : { retry: result };
}

type ScopeOperationInput = Readonly<{ coordinate: string }>;
export type RepositoryScope = GitRepository;
export { NoGitWorldError };
export function scopeOperation(input: ScopeOperationInput): RepositoryScope { return repositoryAt(input.coordinate); }

export function contractsOperation(input: Readonly<{ scope: RepositoryScope }>): ContractBoard { return readContractBoard(input.scope); }

export function contractObservationOperation(input: OperationInput): ContractObservation {
  return readContractObservation(input.scope, input.contractId);
}

export type { ContractBoard, ContractDisposition, ContractGateCurrent, ContractGateReport, ContractObservation, ContractPhase, ContractRow };

export function documentsOperation(input: Readonly<{ scope: RepositoryScope }>): readonly ContractDocumentProjection[] { return readDocuments(input.scope); }

export function stateOperation(input: OperationInput): ContractState {
  const state = observeContract(input.scope, input.contractId).state;
  if (state === null) throw new Error(`contract does not exist: ${input.contractId}`);
  return state;
}

export function readStateOperation(input: OperationInput): ContractState | null { return observeContract(input.scope, input.contractId).state; }

type DeliveryIdentity = Readonly<{ snapshotId: SnapshotId; changeId: ChangeId; expectedPredecessor: SnapshotId }>;

export function deliveryOperation(input: OperationInput): DeliveryIdentity | null {
  const state = observeContract(input.scope, input.contractId).state;
  if (state === null || state.delivery === null) return null;
  return {
    snapshotId: state.delivery.data.candidate,
    changeId: state.delivery.data.deliveryPatchId,
    expectedPredecessor: state.delivery.data.expectedPredecessor,
  };
}

function observePrerequisiteClosure(
  repository: GitRepository,
  contracts: readonly ContractId[],
): CarrierDecisionObservation {
  let observation = observeContractsForAdmission(repository, contracts);
  let frontier = contracts.slice(1);
  while (frontier.length > 0) {
    const next = new Set<ContractId>();
    for (const id of frontier) {
      const state = contractState(observation.decision, id);
      if (state === null) continue;
      for (const dependency of state.terms.after) {
        if (!observation.decision.has(dependency)) next.add(dependency);
      }
    }
    frontier = [...next];
    observation = extendContractsForAdmission(repository, observation, frontier);
  }
  return observation;
}

type DeliveryDiffOperationInput = Readonly<{ scope: RepositoryScope; expectedPredecessor: SnapshotId; snapshotId: SnapshotId }>;

export async function deliveryDiffOperation(input: DeliveryDiffOperationInput): Promise<string | null> { return readDeliveryDiff(input.scope, input.expectedPredecessor, input.snapshotId); }

type AmendOperationInput = OperationInput & Readonly<{
  amendment?: Readonly<{
    source: ContractTerms;
    terms: AmendData;
    verification: VerificationDeclarationPreparation;
  }>;
}>;

export function amendOperation(input: AmendOperationInput): IntentOutcome<void, AmendRefusal | VerificationDeclarationRefusal> {
  const amendment = input.amendment;
  const preparation: AmendInput<VerificationDeclarationRefusal>["preparation"] = amendment === undefined
    ? undefined
    : amendment.verification.kind === "prepared"
      ? { kind: "prepared", data: amendment.terms }
      : { kind: "refused", refusal: amendment.verification.refusal };
  const decisionInput: AmendInput<VerificationDeclarationRefusal> = {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    ...(amendment === undefined ? {} : { source: amendment.source }),
    ...(preparation === undefined ? {} : { preparation }),
  };
  return complete(
    admitIntent(
      input.scope,
      decisionInput,
      decideAmend,
      {
        observedContracts: [input.contractId, ...(amendment?.terms.after ?? [])],
        observe: observePrerequisiteClosure,
      },
    ),
    undefined,
  );
}

export type DeliverValue = DeliveryIdentity & Readonly<{ verification?: VerificationStop; placement?: PlacementStop; leak?: WorktreeLeak }>;

type AttemptDecision<Value, Refusal = IntentRefusal> =
  | (AcceptedAdmission & Readonly<{ value: Value }>)
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "redecide" }>
  | Readonly<{ kind: "collision" }>
  | Extract<DecidedOfferResult, { kind: "publication-failed" }>;

type DeliverOperationInput = OperationInput & Readonly<{ derivation?: DocumentDerivation; message?: string }>;

function deliverAttempt(input: DeliverOperationInput, attempt: Parameters<typeof admitDecidedOffer>[2]): AttemptDecision<DeliveryIdentity> {
  const decisionObservation = observeContractsForAdmission(input.scope, [input.contractId]);
  const state = contractState(decisionObservation.decision, input.contractId);
  let preparation: DeliverInput<DeliveryFailure>["preparation"];
  if (state === null || input.derivation === undefined) {
    preparation = { kind: "unavailable" };
  } else if (input.derivation.verification.kind === "refused") {
    preparation = {
      kind: "refused",
      document: input.derivation.document,
      refusal: input.derivation.verification.refusal,
    };
  } else {
    const prepared = prepareDelivery(input.scope, {
      contractId: state.id,
      coordinates: state.coordinates,
    }, {
      title: input.derivation.title,
      ...(input.message === undefined ? {} : { message: input.message }),
    });
    preparation = prepared.kind === "refused"
      ? { kind: "refused", document: input.derivation.document, refusal: prepared.refusal }
      : { kind: "prepared", document: input.derivation.document, data: prepared.data };
  }
  const decisionInput: DeliverInput<DeliveryFailure> = {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    preparation,
  };
  const decision = decideDeliver({ input: decisionInput, attempt, observation: decisionObservation.decision });
  if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };
  if (preparation.kind !== "prepared") {
    throw new Error("offered delivery is missing its mechanical preparation");
  }
  const admitted = admitDecidedOffer(
    input.scope,
    decisionObservation,
    attempt,
    decision.offer,
    input.contractId,
  );
  if (admitted.kind === "accepted") {
    return { ...admitted, value: {
      snapshotId: preparation.data.candidate,
      changeId: preparation.data.deliveryPatchId,
      expectedPredecessor: preparation.data.expectedPredecessor,
    } };
  }
  return admitted;
}

async function completeDelivery(
  input: DeliverOperationInput,
  first: Extract<AttemptDecision<DeliveryIdentity>, { kind: "accepted" }>,
): Promise<IntentOutcome<DeliverValue>> {
  if (input.derivation === undefined) {
    throw new Error("accepted delivery is missing its document derivation");
  }
  const derivation = input.derivation;
  if (derivation.verification.kind !== "prepared") {
    throw new Error("accepted delivery is missing its Verification preparation");
  }
  let admission: AcceptedAdmission = first;
  let verificationValue: VerificationStop | undefined;
  let leak: WorktreeLeak | undefined;
  const verification = await verifyDelivery({
    repository: input.scope,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    state: first.state,
    environment: process.env,
    produce: produceVerification,
    ...(derivation.verification.data === null
      ? {}
      : { verification: derivation.verification.data }),
  });
  if (verification !== null) {
    leak = verification.leak;
    if ("failure" in verification.step) verificationValue = verification.step;
    else {
      verificationValue = stepStop(verification.step);
      if (verification.step.kind === "accepted") admission = mergeAdmissions(admission, verification.step);
    }
  }
  const placement = admitPlacement(input.scope, {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
  });
  const placementValue = stepStop(placement);
  if (placement.kind === "accepted") admission = mergeAdmissions(admission, placement);
  return admitted(admission, {
    ...first.value,
    ...(verificationValue === undefined ? {} : { verification: verificationValue }),
    ...(placementValue === undefined ? {} : { placement: placementValue }),
    ...(leak === undefined ? {} : { leak }),
  });
}

export async function deliverOperation(
  input: DeliverOperationInput,
): Promise<IntentOutcome<DeliverValue>> {
  const attempts = mintAttempts({ entryCount: 2 });
  let first: Extract<AttemptDecision<DeliveryIdentity>, { kind: "accepted" }> | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const result = deliverAttempt(input, attempts[index]!);
    if (result.kind === "accepted") {
      first = result;
      break;
    }
    if (result.kind === "refused") return result;
    if (result.kind === "publication-failed") return { kind: "retry", reason: result };
    if (result.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: result };
    if (result.kind === "redecide") continue;
  }
  if (first === null) return { kind: "retry", reason: { kind: "exhausted" } };
  return completeDelivery(input, first);
}

export function abandonOperation(
  input: OperationInput & Readonly<{ note?: string }>,
): IntentOutcome<void, AbandonRefusal> {
  return complete(
    admitIntent(input.scope, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      ...(input.note === undefined ? {} : { note: input.note }),
    }, decideAbandon),
    undefined,
  );
}

export function arcOperation(
  input: OperationInput & Readonly<{ chapter: Omit<ArcData, "seq"> }>,
): IntentOutcome<void, ArcRefusal> {
  return complete(
    admitIntent(input.scope, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      data: input.chapter,
    }, decideArc),
    undefined,
  );
}

type ReviewOperationInput = OperationInput & Readonly<{ verdict: AttestationData["verdict"]; summary?: string }>;

export type ReviewValue = Readonly<{ placement?: PlacementStop }>;

function reviewAttempt(
  input: ReviewOperationInput,
  attempt: Parameters<typeof admitDecidedOffer>[2],
): AttemptDecision<void, ReviewRefusal> {
  const decisionObservation = observeContractsForAdmission(input.scope, [input.contractId]);
  const state = contractState(decisionObservation.decision, input.contractId);
  let preparation: AttestationInput<ReviewRefusal>["preparation"];
  if (state !== null) {
    const prepared = prepareReview(input.scope, { contractId: state.id, coordinates: state.coordinates });
    preparation = prepared.kind === "refused"
      ? { kind: "refused", refusal: prepared.refusal }
      : {
        kind: "prepared",
        data: {
          gate: REVIEWED,
          subject: dependencyKeySet([
            { kind: "document", value: state.terms.document.key },
            { kind: "change", value: prepared.data },
          ]),
          verdict: input.verdict,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        },
      };
  }
  const decisionInput: AttestationInput<ReviewRefusal> = {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    ...(preparation === undefined ? {} : { preparation }),
  };
  const decision = decideAttestation({ input: decisionInput, attempt, observation: decisionObservation.decision });
  if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };
  const admitted = admitDecidedOffer(
    input.scope,
    decisionObservation,
    attempt,
    decision.offer,
    input.contractId,
  );
  if (admitted.kind === "accepted") return { ...admitted, value: undefined };
  return admitted;
}

export function reviewOperation(
  input: ReviewOperationInput,
): IntentOutcome<ReviewValue, ReviewRefusal> {
  const carrier = input.scope;
  const attempts = mintAttempts({ entryCount: 2 });
  let review: Extract<AttemptDecision<void, ReviewRefusal>, { kind: "accepted" | "refused" }> | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const result = reviewAttempt(input, attempts[index]!);
    if (result.kind === "accepted" || result.kind === "refused") {
      review = result;
      break;
    }
    if (result.kind === "publication-failed") return { kind: "retry", reason: result };
    if (result.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: result };
  }
  if (review === null) return { kind: "retry", reason: { kind: "exhausted" } };
  if (review.kind !== "accepted") return review;
  if (input.verdict !== "satisfied") return admitted(review, {});

  const placement = admitPlacement(carrier, {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
  });
  const placementStop = stepStop(placement);
  const admission = placement.kind === "accepted" ? mergeAdmissions(review, placement) : review;
  return admitted(admission, placementStop === undefined ? {} : { placement: placementStop });
}

export async function auditOperation(
  input: OperationInput & Readonly<{ derivation?: DocumentDerivation }>,
): Promise<IntentOutcome<AuditReport>> {
  const carrier = input.scope;
  const initial = readAudit(carrier, input.contractId, REVIEWED);
  if (initial.state === null) return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.contractId } };
  const derivation = input.derivation;
  if (derivation === undefined) {
    return { kind: "refused", refusal: { kind: "document-moved", contractId: input.contractId } };
  }

  if (!documentIsCurrent(initial.state, derivation.document)) {
    return { kind: "refused", refusal: { kind: "document-moved", contractId: input.contractId } };
  }
  if (derivation.verification.kind === "refused") {
    return { kind: "refused", refusal: derivation.verification.refusal };
  }

  if (initial.state.delivery === null || derivation.verification.data === null) {
    return accepted(initial.state, [], initial.report);
  }

  const verification = await verifyDelivery({
    repository: carrier,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    state: initial.state,
    environment: process.env,
    produce: produceVerification,
    verification: derivation.verification.data,
  });
  if (verification === null) {
    throw new Error("audit verification preparation unexpectedly produced no attempt");
  }
  const attempt = "failure" in verification.step
    ? verification.step
    : verification.step.kind === "accepted"
      ? undefined
      : verification.step.kind === "refused"
        ? { refusal: verification.step.refusal }
        : { retry: verification.step };
  const report = !("failure" in verification.step) && verification.step.kind === "accepted"
    ? auditReport(verification.step.journal, REVIEWED)
    : initial.report;
  const value = {
    ...report,
    ...(attempt === undefined ? {} : { attempt }),
    ...(verification.leak === undefined ? {} : { leak: verification.leak }),
  };
  return !("failure" in verification.step) && verification.step.kind === "accepted"
    ? admitted(verification.step, value)
    : accepted(initial.state, [], value);
}

export type ReconcileReport = ReconcileResult;

export function reconcileOperation(input: OperationInput): ReconcileReport {
  return reconcile({ repository: input.scope, state: observeContract(input.scope, input.contractId).state });
}

type RepoReconcileItem =
  | Readonly<{ contractId: ContractId; kind: "reconciled"; report: ReconcileReport }>
  | Readonly<{ contractId: ContractId; kind: "failed"; diagnostic: string }>;

export type RepoReconcileReport = Readonly<{ contracts: readonly RepoReconcileItem[] }>;

function reconcileError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function reconcileAllOperation(input: Readonly<{ scope: RepositoryScope }>): RepoReconcileReport {
  const carrier = input.scope;
  const observation = observeCarrier(carrier);
  const contracts = reconcileBatch(carrier, [...observation.contracts].map(([id, record]) => ({ id, state: record.state }))).map((item): RepoReconcileItem => (
    item.kind === "reconciled"
      ? { contractId: item.contract, kind: "reconciled", report: item.result }
      : { contractId: item.contract, kind: "failed", diagnostic: reconcileError(item.error) }
  ));
  return { contracts };
}
