import {
  prepareDelivery,
  prepareReview,
  type DeliveryPreparationRefusal,
  type ReviewPreparationRefusal,
  type WorkspaceDirtyDelta,
} from "../git/delivery.js";
import {
  currentBranch,
  extendContractsForAdmissionAt,
  observeContractAt,
  observeContractWorld,
  observeContractsForAdmissionAt,
} from "../git/observe.js";
import { reconcile, reconcileBatch, reconcileObservationFailure, type ReconcileResult } from "../git/reconcile.js";
import type { WorktreeHooks } from "../git/hooks.js";
import { NoGitWorldError, repositoryAt, type GitRepository } from "../git/repository.js";
import { withGitReadObservation, type GitDecodeChannel, type GitTreeSelection } from "../git/read-observation.js";
import { readDeliveryDiff } from "../git/verification.js";
import type { WorktreeLeak } from "../git/verification.js";
import { dependencyKeySet } from "../core/subject.js";
import type { AttemptContext } from "../core/decide.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { contractState, documentIsCurrent } from "../core/facts/observation.js";
import type { ActorId, AmendData, ArcData, AttestationData, ContractId, ContractState, ContractTerms, DeliverData, DocumentKey, SnapshotId } from "../core/facts/types.js";
import { gate } from "../core/facts/types.js";
import { decideAbandon, type AbandonRefusal } from "../core/verbs/abandon.js";
import { decideAmend, type AmendInput, type AmendRefusal } from "../core/verbs/amend.js";
import { decideArc, type ArcRefusal } from "../core/verbs/arc.js";
import { decideDeliver, type DeliverInput, type DeliverRefusal } from "../core/verbs/deliver.js";
import type { PlacementRefusal } from "../core/verbs/placement.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import { produceVerification } from "../verification/producer.js";
import type { VerificationDeclarationPreparation, VerificationDeclarationRefusal } from "../verification/declaration.js";
import {
  admitIntent,
  verifyDelivery,
  type VerificationRuntimeStop,
} from "./intent.js";
import { admitPlacement, type PlacementProtocolResult } from "./placement.js";
import type { TargetPlacementRefusal } from "../git/target-placement.js";
import { auditReport, readAuditAt, type AuditReport as AuditReadReport } from "./read/audit.js";
import { readDocuments, type ContractDocumentProjection } from "./read/documents.js";
import {
  readContractBoard,
  readContractObservationAt,
  type ContractBoard,
  type ContractDisposition,
  type ContractGateCurrent,
  type ContractGateReport,
  type ContractObservation,
  type ContractPhase,
  type ContractRow,
} from "./read/status.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission, type DecidedOfferResult } from "./attempt.js";
export { bindOperation } from "./bind.js";
import type { BindRefusal, TargetInputRefusal } from "./bind.js";
import {
  accepted,
  admitted,
  complete,
  type AcceptedProtocolStep,
  type IntentOutcome as ProtocolIntentOutcome,
} from "./outcome.js";
import type { ProtocolResult, ProtocolTerminal } from "./run.js";
import type { CompanionDecorator } from "./run.js";

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
type MutationOperationInput = OperationInput & Readonly<{ channel: GitDecodeChannel }>;

export type AuditReport = AuditReadReport & Readonly<{ attempt?: VerificationStop; leak?: WorktreeLeak }>;

export type DocumentDerivation = Readonly<{ document: DocumentKey; title: string; verification: VerificationDeclarationPreparation }>;

export type StepStop<R> = Readonly<{ refusal: R; retry?: never } | { retry: IntentRetry; refusal?: never }>;

export type VerificationStop = StepStop<AttestationRefusal> | VerificationRuntimeStop;
export type PlacementStop =
  | StepStop<PlacementRefusal | TargetPlacementRefusal>
  | Readonly<{ failure: "target-moved"; contractId: ContractId; target: string; expected: SnapshotId; observed: SnapshotId | null }>
  | Readonly<{ failure: "target-placement-failed"; diagnostic: string }>;

function timestamp(): string { return new Date().toISOString(); }

function mergeAdmissions(current: AcceptedProtocolStep, next: AcceptedProtocolStep): AcceptedProtocolStep {
  const effects = [...(current.physical?.effects ?? []), ...(next.physical?.effects ?? [])];
  const lag = [...(current.physical?.lag ?? []), ...(next.physical?.lag ?? [])];
  return {
    ...next,
    facts: [...current.facts, ...next.facts],
    ...(effects.length === 0 && lag.length === 0 ? {} : { physical: { effects, lag } }),
  };
}

function stepStop<Refusal>(result: ProtocolResult<Refusal>): StepStop<Refusal> | undefined {
  if (result.kind === "accepted") return undefined;
  return result.kind === "refused" ? { refusal: result.refusal } : { retry: result };
}

function placementStop(result: PlacementProtocolResult): PlacementStop | undefined {
  if (result.kind === "accepted") return undefined;
  if (result.kind === "placement-failed") {
    return { failure: "target-placement-failed", diagnostic: result.diagnostic };
  }
  if (result.kind === "target-moved") {
    const { contractId, target, expected, observed } = result;
    return { failure: "target-moved", contractId, target, expected, observed };
  }
  return result.kind === "refused" ? { refusal: result.refusal } : { retry: result };
}

type ScopeOperationInput = Readonly<{ coordinate: string }>;
export type RepositoryScope = GitRepository;
export { NoGitWorldError };
export function scopeOperation(input: ScopeOperationInput): RepositoryScope { return repositoryAt(input.coordinate); }

export function currentBranchOperation(input: Readonly<{ scope: RepositoryScope }>): string | null {
  return currentBranch(input.scope);
}

export async function contractsOperation(input: Readonly<{ scope: RepositoryScope; channel: GitDecodeChannel }>): Promise<ContractBoard> {
  return withGitReadObservation(input.scope, input.channel, readContractBoard);
}

export function contractObservationOperation(input: MutationOperationInput): Promise<ContractObservation> {
  return readContractObservationAt(input.scope, input.channel, input.contractId);
}

export type { ContractBoard, ContractDisposition, ContractGateCurrent, ContractGateReport, ContractObservation, ContractPhase, ContractRow };

export async function documentsOperationAt(
  scope: RepositoryScope,
  channel: GitDecodeChannel,
): Promise<readonly ContractDocumentProjection[]> {
  return withGitReadObservation(scope, channel, readDocuments);
}

export async function stateOperation(input: MutationOperationInput): Promise<ContractState> {
  const state = (await observeContractAt(input.scope, input.channel, input.contractId)).state;
  if (state === null) throw new Error(`contract does not exist: ${input.contractId}`);
  return state;
}

type DeliveryIdentity = DeliverData;

export async function deliveryOperation(input: MutationOperationInput): Promise<DeliveryIdentity | null> {
  const state = (await observeContractAt(input.scope, input.channel, input.contractId)).state;
  return state?.delivery?.data ?? null;
}

type DeliveryDiffOperationInput = Readonly<{ scope: RepositoryScope; integrationPredecessor: SnapshotId; integrationSnapshot: SnapshotId }>;

export async function deliveryDiffOperation(input: DeliveryDiffOperationInput): Promise<string | null> { return readDeliveryDiff(input.scope, input.integrationPredecessor, input.integrationSnapshot); }

type AmendOperationInput = MutationOperationInput & Readonly<{
  source?: ContractTerms;
  deriveAmendment?: (source: ContractTerms) => Readonly<{
    terms: AmendData;
    verification: VerificationDeclarationPreparation;
  }>;
}>;

type Amendment = Readonly<{ source: ContractTerms }> & ReturnType<NonNullable<AmendOperationInput["deriveAmendment"]>>;

export async function amendOperation(
  input: AmendOperationInput,
): Promise<IntentOutcome<Amendment, AmendRefusal | VerificationDeclarationRefusal>> {
  const attempts = mintAttempts({ entryCount: 2 });
  let source = input.source;
  for (let index = 0; index < attempts.length; index += 1) {
    let observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
    const state = contractState(observation.decision, input.contractId);
    if (source === undefined && state !== null) source = state.terms;
    const amendment = source === undefined || input.deriveAmendment === undefined
      ? undefined
      : { source, ...input.deriveAmendment(source) };
    if (amendment !== undefined) {
      observation = await extendContractsForAdmissionAt(input.channel, observation, amendment.terms.after);
    }
    const preparation: AmendInput<VerificationDeclarationRefusal>["preparation"] = amendment === undefined
      ? undefined
      : amendment.verification.kind === "prepared"
        ? { kind: "prepared", data: amendment.terms }
        : { kind: "refused", refusal: amendment.verification.refusal };
    const decision = decideAmend({
      input: {
        contractId: input.contractId,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        at: timestamp(),
        ...(amendment === undefined ? {} : { source: amendment.source }),
        ...(preparation === undefined ? {} : { preparation }),
      },
      attempt: attempts[index]!,
      observation: observation.decision,
    });
    if (decision.kind === "refused") return decision;
    const admission = await admitDecidedOffer({
      channel: input.channel,
      repository: input.scope,
      decisionObservation: observation,
      attempt: attempts[index]!,
      offer: decision.offer,
      primaryContract: input.contractId,
    });
    if (admission.kind === "accepted") {
      if (amendment === undefined) throw new Error("accepted amendment is missing its document derivation");
      return admitted(admission, amendment);
    }
    if (admission.kind === "publication-failed") return { kind: "retry", reason: admission };
    if (admission.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: admission };
  }
  return { kind: "retry", reason: { kind: "exhausted" } };
}

export type DeliverValue = DeliveryIdentity & Readonly<{ verification?: VerificationStop; placement?: PlacementStop; leak?: WorktreeLeak }>;

type AttemptDecision<Value, Refusal = IntentRefusal> =
  | (AcceptedAdmission & Readonly<{ value: Value }>)
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "redecide" }>
  | Readonly<{ kind: "collision" }>
  | Extract<DecidedOfferResult, { kind: "publication-failed" }>;

type DeliverOperationInput = MutationOperationInput & Readonly<{
  deriveDocument?: (state: ContractState) => DocumentDerivation;
  message?: string;
  requireBranchesToBeUpToDate: boolean;
  includeDirty: boolean;
}>;

type PreparedDelivery = Readonly<{ delivery: DeliveryIdentity; derivation: DocumentDerivation }>;

async function deliverAttempt(input: DeliverOperationInput, attempt: AttemptContext): Promise<AttemptDecision<PreparedDelivery>> {
  const decisionObservation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = contractState(decisionObservation.decision, input.contractId);
  const derivation = state === null || input.deriveDocument === undefined
    ? undefined
    : input.deriveDocument(state);
  let preparation: DeliverInput<DeliveryFailure>["preparation"];
  if (state === null || derivation === undefined) {
    preparation = { kind: "unavailable" };
  } else if (derivation.verification.kind === "refused") {
    preparation = {
      kind: "refused",
      document: derivation.document,
      refusal: derivation.verification.refusal,
    };
  } else {
    const prepared = prepareDelivery(input.scope, {
      contractId: state.id,
      coordinates: state.coordinates,
    }, {
      title: derivation.title,
      ...(input.message === undefined ? {} : { message: input.message }),
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
      includeDirty: input.includeDirty,
    });
    preparation = prepared.kind === "refused"
      ? { kind: "refused", document: derivation.document, refusal: prepared.refusal }
      : { kind: "prepared", document: derivation.document, data: prepared.data };
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
  const admitted = await admitDecidedOffer({
    channel: input.channel,
    repository: input.scope,
    decisionObservation,
    attempt,
    offer: decision.offer,
    primaryContract: input.contractId,
  });
  if (admitted.kind === "accepted") {
    if (derivation === undefined) throw new Error("accepted delivery is missing its document derivation");
    return { ...admitted, value: { delivery: preparation.data, derivation } };
  }
  return admitted;
}

async function completeDelivery(
  input: DeliverOperationInput,
  first: Extract<AttemptDecision<PreparedDelivery>, { kind: "accepted" }>,
): Promise<IntentOutcome<DeliverValue>> {
  const derivation = first.value.derivation;
  if (derivation.verification.kind !== "prepared") {
    throw new Error("accepted delivery is missing its Verification preparation");
  }
  let admission: AcceptedProtocolStep = first;
  let verificationValue: VerificationStop | undefined;
  let leak: WorktreeLeak | undefined;
  const verification = await verifyDelivery({
    channel: input.channel,
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
  const placement = await admitPlacement(input.channel, input.scope, first.state.coordinates.target, {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
  });
  const placementValue = placementStop(placement);
  if (placement.kind === "accepted") admission = mergeAdmissions(admission, placement);
  return admitted(admission, {
    ...first.value.delivery,
    ...(verificationValue === undefined ? {} : { verification: verificationValue }),
    ...(placementValue === undefined ? {} : { placement: placementValue }),
    ...(leak === undefined ? {} : { leak }),
  });
}

export async function deliverOperation(
  input: DeliverOperationInput,
): Promise<IntentOutcome<DeliverValue>> {
  const attempts = mintAttempts({ entryCount: 2 });
  let first: Extract<AttemptDecision<PreparedDelivery>, { kind: "accepted" }> | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const result = await deliverAttempt(input, attempts[index]!);
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

export async function abandonOperation(
  input: MutationOperationInput & Readonly<{
    note?: string;
    decorateOffer?: CompanionDecorator;
    observationSelection?: GitTreeSelection;
  }>,
): Promise<IntentOutcome<void, AbandonRefusal>> {
  return complete(
    await admitIntent(input.channel, input.scope, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      ...(input.note === undefined ? {} : { note: input.note }),
    }, decideAbandon, {
      ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
      ...(input.observationSelection === undefined ? {} : { observationSelection: input.observationSelection }),
    }),
    undefined,
  );
}

export async function arcOperation(
  input: MutationOperationInput & Readonly<{ chapter: Omit<ArcData, "seq"> }>,
): Promise<IntentOutcome<void, ArcRefusal>> {
  return complete(
    await admitIntent(input.channel, input.scope, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      data: input.chapter,
    }, decideArc),
    undefined,
  );
}

type ReviewOperationInput = MutationOperationInput & Readonly<{ verdict: AttestationData["verdict"]; summary?: string }>;

export type ReviewValue = Readonly<{ placement?: PlacementStop; workspace?: WorkspaceDirtyDelta }>;

function reviewAttempt(
  input: ReviewOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<Readonly<{ workspace?: WorkspaceDirtyDelta }>, ReviewRefusal>> {
  return reviewAttemptObserved(input, attempt);
}

async function reviewAttemptObserved(
  input: ReviewOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<Readonly<{ workspace?: WorkspaceDirtyDelta }>, ReviewRefusal>> {
  const decisionObservation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = contractState(decisionObservation.decision, input.contractId);
  let preparation: AttestationInput<ReviewRefusal>["preparation"];
  let workspace: WorkspaceDirtyDelta | undefined;
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
            { kind: "change", value: prepared.data.changeId },
          ]),
          verdict: input.verdict,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        },
      };
    if (prepared.kind === "prepared") workspace = prepared.data.workspace;
  }
  const decisionInput: AttestationInput<ReviewRefusal> = {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    ...(preparation === undefined ? {} : { preparation }),
  };
  const decision = decideAttestation({ input: decisionInput, attempt, observation: decisionObservation.decision });
  if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };
  const admitted = await admitDecidedOffer({
    channel: input.channel,
    repository: input.scope,
    decisionObservation,
    attempt,
    offer: decision.offer,
    primaryContract: input.contractId,
  });
  if (admitted.kind === "accepted") return {
    ...admitted,
    value: workspace === undefined ? {} : { workspace },
  };
  return admitted;
}

export async function reviewOperation(
  input: ReviewOperationInput,
): Promise<IntentOutcome<ReviewValue, ReviewRefusal>> {
  const git = input.scope;
  const attempts = mintAttempts({ entryCount: 2 });
  let review: Extract<AttemptDecision<Readonly<{ workspace?: WorkspaceDirtyDelta }>, ReviewRefusal>, { kind: "accepted" | "refused" }> | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const result = await reviewAttempt(input, attempts[index]!);
    if (result.kind === "accepted" || result.kind === "refused") {
      review = result;
      break;
    }
    if (result.kind === "publication-failed") return { kind: "retry", reason: result };
    if (result.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: result };
  }
  if (review === null) return { kind: "retry", reason: { kind: "exhausted" } };
  if (review.kind !== "accepted") return review;
  if (input.verdict !== "satisfied") return admitted(review, review.value);

  const placement = await admitPlacement(input.channel, git, review.state.coordinates.target, {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
  });
  const stopped = placementStop(placement);
  const admission = placement.kind === "accepted" ? mergeAdmissions(review, placement) : review;
  return admitted(admission, { ...review.value, ...(stopped === undefined ? {} : { placement: stopped }) });
}

export async function auditOperation(
  input: MutationOperationInput & Readonly<{ deriveDocument?: (state: ContractState) => DocumentDerivation }>,
): Promise<IntentOutcome<AuditReport>> {
  const git = input.scope;
  const initial = await readAuditAt(git, input.channel, input.contractId, REVIEWED);
  if (initial.state === null) return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.contractId } };
  const derivation = input.deriveDocument?.(initial.state);
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
    channel: input.channel,
    repository: git,
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
    ? auditReport(verification.step.journal, REVIEWED, initial.state, initial.report.targetObservation)
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
export type ReconcileObservation = Readonly<{ state: ContractState | null; report: ReconcileReport }>;
type ReconcileOptions = Readonly<{ hooks: WorktreeHooks; retryHooks: boolean }>;

export async function reconcileOperation(input: MutationOperationInput & ReconcileOptions): Promise<ReconcileObservation> {
  try {
    const observation = await reconcile({
      repository: input.scope,
      channel: input.channel,
      contractId: input.contractId,
      hooks: input.hooks,
      retryHooks: input.retryHooks,
    });
    return { state: observation.state, report: observation.result };
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
    return { state: null, report: reconcileObservationFailure(error) };
  }
}

type RepoReconcileItem = Readonly<{ contractId: ContractId; state: ContractState | null; report: ReconcileReport }>;

export type RepoReconcileReport = Readonly<{ contracts: readonly RepoReconcileItem[] }>;

export async function reconcileAllOperation(
  input: Readonly<{ scope: RepositoryScope; channel: GitDecodeChannel }> & ReconcileOptions,
): Promise<RepoReconcileReport> {
  const git = input.scope;
  const observation = await withGitReadObservation(input.scope, input.channel, (read) => observeContractWorld(read));
  const contracts = (await reconcileBatch(
    git,
    input.channel,
    observation.contracts.keys(),
    input.hooks,
    input.retryHooks,
  )).map((item): RepoReconcileItem => ({
    contractId: item.contract,
    state: item.state,
    report: item.result,
  }));
  return { contracts };
}
