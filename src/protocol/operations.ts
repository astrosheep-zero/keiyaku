import {
  materializeIntegrationSnapshot,
  planIntegration,
  prepareReviewIntegration,
  readDeliveryDiff,
  type IntegrationPreparationRefusal,
} from "../git/integration.js";
import {
  captureTender,
  dirtyTenderDelta,
  dirtyTenderRefusal,
  materializeTenderSnapshot,
  type DirtyWorkspaceRefusal,
  type WorkspaceDirtyDelta,
} from "../git/tender.js";
import {
  currentBranch,
  extendContractsForAdmissionAt,
  observeContractAt,
  observeContractWorld,
  observeContractsForAdmissionAt,
  type GitDecisionObservation,
} from "../git/observe.js";
import {
  reconcile,
  reconcileBatch,
  reconcileObservationFailure,
  type ReconcileResult,
} from "../git/reconcile.js";
import type { WorktreeHooks } from "../git/hooks.js";
import { NoGitWorldError, repositoryAt, type GitRepository } from "../git/repository.js";
import { withGitReadObservation, type GitDecodeChannel, type GitTreeSelection } from "../git/read-observation.js";
import type { WorktreeLeak } from "../git/scratch.js";
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
import type { VerificationDeclarationPreparation, VerificationDeclarationRefusal } from "../verification/declaration.js";
import {
  admitIntent,
  currentVerifiedAttestation,
  verifyDelivery,
  type CurrentVerifiedAttestation,
  type VerificationResult,
  type VerificationStep,
  type VerificationRuntimeStop,
  type VerificationCleanupFailure,
} from "./intent.js";
import {
  admitPlacement,
  observeProspectiveTargetPlacement,
  type PlacementProtocolResult,
  type ProspectiveTargetPreview,
} from "./placement.js";
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
export type DeliveryPreparationRefusal = Readonly<{ kind: "target-missing" | "worktree-missing"; contractId: ContractId }>
  | DirtyWorkspaceRefusal
  | IntegrationPreparationRefusal
  | TargetPlacementRefusal;
type ReviewPreparationRefusal = Readonly<{ kind: "target-missing" | "worktree-missing"; contractId: ContractId }>
  | DirtyWorkspaceRefusal
  | IntegrationPreparationRefusal;
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

export type AuditTargetPreview = ProspectiveTargetPreview;

export type AuditPreview =
  | Readonly<{ kind: "blocked"; refusal: DeliveryPreparationRefusal }>
  | Readonly<{
      kind: "ready";
      candidate: DeliveryIdentity;
      target?: AuditTargetPreview;
      diff?: string | null;
    }>;

export type AuditReport = AuditReadReport & Readonly<{
  preview?: AuditPreview;
  attempt?: VerificationStop;
  cleanup?: VerificationCleanupFailure;
  leak?: WorktreeLeak;
}>;

export type VerificationReuse = CurrentVerifiedAttestation;

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

function verificationStop(step: VerificationStep): VerificationStop | undefined {
  return "failure" in step ? step : stepStop(step);
}

function unpackVerificationOutcome(verification: VerificationResult): Readonly<{
  cleanup?: VerificationCleanupFailure;
  leak?: WorktreeLeak;
  stop?: VerificationStop;
  admission?: AcceptedProtocolStep;
}> {
  const stop = verificationStop(verification.step);
  const admission = !("failure" in verification.step) && verification.step.kind === "accepted"
    ? verification.step
    : undefined;
  return {
    ...(verification.cleanup === undefined ? {} : { cleanup: verification.cleanup }),
    ...(verification.leak === undefined ? {} : { leak: verification.leak }),
    ...(stop === undefined ? {} : { stop }),
    ...(admission === undefined ? {} : { admission }),
  };
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
export async function scopeOperation(input: ScopeOperationInput): Promise<RepositoryScope> {
  return await repositoryAt(input.coordinate);
}

export async function currentBranchOperation(input: Readonly<{ scope: RepositoryScope }>): Promise<string | null> {
  return await currentBranch(input.scope);
}

export async function contractsOperation(input: Readonly<{ scope: RepositoryScope; channel: GitDecodeChannel }>): Promise<ContractBoard> {
  return withGitReadObservation(input.scope, input.channel, readContractBoard);
}

export async function contractObservationOperation(input: MutationOperationInput): Promise<ContractObservation> {
  return await readContractObservationAt(input.scope, input.channel, input.contractId);
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

export async function deliveryDiffOperation(input: DeliveryDiffOperationInput): Promise<string | null> { return await readDeliveryDiff(input.scope, input.integrationPredecessor, input.integrationSnapshot); }

type AmendOperationInput = MutationOperationInput & Readonly<{
  source?: ContractTerms;
  deriveAmendment?: (source: ContractTerms) => Readonly<{
    terms: AmendData;
    verification: VerificationDeclarationPreparation;
  }>;
}>;

type Amendment = Readonly<{ source: ContractTerms }> & ReturnType<NonNullable<AmendOperationInput["deriveAmendment"]>>;

async function extendPrerequisiteClosureAt(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  seeds: readonly ContractId[],
): Promise<GitDecisionObservation> {
  let current = observation;
  const visited = new Set<ContractId>();
  let pending = [...seeds];
  while (pending.length > 0) {
    const batch = [...new Set(pending.filter((id) => !visited.has(id)))];
    pending = [];
    if (batch.length === 0) break;
    current = await extendContractsForAdmissionAt(channel, current, batch);
    for (const id of batch) {
      visited.add(id);
      const state = contractState(current.decision, id);
      if (state !== null) pending.push(...state.terms.after);
    }
  }
  return current;
}

export async function amendOperation(
  input: AmendOperationInput,
): Promise<IntentOutcome<Amendment, AmendRefusal | VerificationDeclarationRefusal>> {
  const attempts = mintAttempts({ entryCount: 1 });
  let source = input.source;
  for (let index = 0; index < attempts.length; index += 1) {
    let observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
    const state = contractState(observation.decision, input.contractId);
    if (source === undefined && state !== null) source = state.terms;
    const amendment = source === undefined || input.deriveAmendment === undefined
      ? undefined
      : { source, ...input.deriveAmendment(source) };
    if (amendment !== undefined) {
      observation = await extendPrerequisiteClosureAt(
        input.channel,
        observation,
        [...new Set([...(state?.terms.after ?? []), ...amendment.terms.after])],
      );
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

export type DeliverValue = DeliveryIdentity & Readonly<{
  verification?: VerificationStop;
  verificationReuse?: VerificationReuse;
  placement?: PlacementStop;
  cleanup?: VerificationCleanupFailure;
  leak?: WorktreeLeak;
}>;

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
  signal?: AbortSignal;
}>;

type PreparedDelivery = Readonly<{ delivery: DeliveryIdentity; derivation: DocumentDerivation }>;

export async function prepareDelivery(
  repository: GitRepository,
  stage: Readonly<{ contractId: ContractId; coordinates: ContractState["coordinates"] }>,
  input: Readonly<{ title: string; message?: string; requireBranchesToBeUpToDate?: boolean; includeDirty?: boolean }>,
): Promise<{ kind: "prepared"; data: DeliverData } | { kind: "refused"; refusal: DeliveryPreparationRefusal }> {
  const { contractId, coordinates } = stage;
  if (coordinates.workspace === "here" && coordinates.target !== undefined) {
    const branch = await currentBranch(repository);
    if (branch !== coordinates.target) {
      return { kind: "refused", refusal: { kind: "workspace-not-on-target", contractId, target: coordinates.target, branch } };
    }
  }
  const tender = await captureTender(repository, stage);
  if (tender.kind === "refused") return tender;
  if ((tender.data.dirty && input.includeDirty !== true) || tender.data.changes.submodules.length > 0) {
    return { kind: "refused", refusal: await dirtyTenderRefusal(repository, contractId, tender.data) };
  }
  const tenderSnapshot = await materializeTenderSnapshot(repository, tender.data, {
    contractId,
    title: input.title,
    ...(input.message === undefined ? {} : { message: input.message }),
  });
  const requireBranchesToBeUpToDate = input.requireBranchesToBeUpToDate ?? false;
  const integration = await planIntegration(repository, stage, { ...tender.data, head: tenderSnapshot }, requireBranchesToBeUpToDate);
  if (integration.kind === "refused") return integration;
  const integrationSnapshot = coordinates.target === undefined
    ? tenderSnapshot
    : await materializeIntegrationSnapshot(repository, integration.data.tree, integration.data.predecessor, {
      contractId,
      title: input.title,
      ...(input.message === undefined ? {} : { message: input.message }),
    });
  return {
    kind: "prepared",
    data: {
      tenderSnapshot,
      integration: { predecessor: integration.data.predecessor, snapshot: integrationSnapshot, changeId: integration.data.changeId },
      method: "squash",
      policy: { requireBranchesToBeUpToDate },
    },
  };
}

export async function prepareReview(
  repository: GitRepository,
  stage: Readonly<{ contractId: ContractId; coordinates: ContractState["coordinates"] }>,
): Promise<{ kind: "prepared"; data: Readonly<{ changeId: DeliverData["integration"]["changeId"]; workspace?: WorkspaceDirtyDelta }> }
  | { kind: "refused"; refusal: ReviewPreparationRefusal }> {
  const tender = await captureTender(repository, stage);
  if (tender.kind === "refused") return tender;
  if (tender.data.changes.submodules.length > 0) {
    return { kind: "refused", refusal: await dirtyTenderRefusal(repository, stage.contractId, tender.data) };
  }
  const workspace = await dirtyTenderDelta(repository, tender.data);
  return await prepareReviewIntegration(repository, stage, tender.data, workspace);
}

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
    const prepared = await prepareDelivery(input.scope, {
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
  let verificationReuse: VerificationReuse | undefined;
  let cleanup: VerificationCleanupFailure | undefined;
  let leak: WorktreeLeak | undefined;
  const currentVerified = currentVerifiedAttestation(first.state);
  if (currentVerified !== undefined) {
    verificationReuse = currentVerified;
  } else {
    const verification = await verifyDelivery({
      channel: input.channel,
      repository: input.scope,
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      state: first.state,
      snapshot: first.value.delivery.integration.snapshot,
      environment: process.env,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(derivation.verification.data === null
        ? {}
        : { verification: derivation.verification.data }),
    });
    if (verification !== null) {
      const unpacked = unpackVerificationOutcome(verification);
      cleanup = unpacked.cleanup;
      leak = unpacked.leak;
      verificationValue = unpacked.stop;
      if (unpacked.admission !== undefined) admission = mergeAdmissions(admission, unpacked.admission);
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
    ...(verificationReuse === undefined ? {} : { verificationReuse }),
    ...(placementValue === undefined ? {} : { placement: placementValue }),
    ...(cleanup === undefined ? {} : { cleanup }),
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
  return await completeDelivery(input, first);
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

async function reviewAttempt(
  input: ReviewOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<Readonly<{ workspace?: WorkspaceDirtyDelta }>, ReviewRefusal>> {
  return await reviewAttemptObserved(input, attempt);
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
    const prepared = await prepareReview(input.scope, { contractId: state.id, coordinates: state.coordinates });
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
  const attempts = mintAttempts({ entryCount: 1 });
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
  return admitted(admission, {
    ...(review.value.workspace === undefined ? {} : { workspace: review.value.workspace }),
    ...(stopped === undefined ? {} : { placement: stopped }),
  });
}

type AuditOperationInput = MutationOperationInput & Readonly<{
  deriveDocument?: (state: ContractState) => DocumentDerivation;
  requireBranchesToBeUpToDate?: boolean;
  includeDirty?: boolean;
  showDiff?: boolean;
  signal?: AbortSignal;
}>;

async function auditCandidateVerification(
  input: AuditOperationInput,
  state: ContractState,
  snapshot: SnapshotId,
  definition: NonNullable<DocumentDerivation["verification"]["data"]>,
): Promise<ReturnType<typeof unpackVerificationOutcome>> {
  const verification = await verifyDelivery({
    channel: input.channel,
    repository: input.scope,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    state,
    snapshot,
    environment: process.env,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    verification: definition,
  });
  if (verification === null) {
    throw new Error("audit verification preparation unexpectedly produced no attempt");
  }
  return unpackVerificationOutcome(verification);
}

async function readyAuditPreview(
  repository: RepositoryScope,
  state: ContractState,
  candidate: DeliveryIdentity,
  showDiff: boolean,
): Promise<Extract<AuditPreview, { kind: "ready" }>> {
  const targetName = state.coordinates.target;
  const target = targetName === undefined
    ? undefined
    : await observeProspectiveTargetPlacement(repository, {
      contractId: state.id,
      coordinates: { ...state.coordinates, target: targetName },
      predecessor: candidate.integration.predecessor,
      candidate: candidate.integration.snapshot,
    });
  const diff = showDiff
    ? await readDeliveryDiff(repository, candidate.integration.predecessor, candidate.integration.snapshot)
    : undefined;
  return {
    kind: "ready",
    candidate,
    ...(target === undefined ? {} : { target }),
    ...(diff === undefined ? {} : { diff }),
  };
}

export async function auditOperation(input: AuditOperationInput): Promise<IntentOutcome<AuditReport>> {
  const initial = await readAuditAt(input.scope, input.channel, input.contractId, REVIEWED);
  if (initial.state === null) return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.contractId } };
  const derivation = input.deriveDocument?.(initial.state);
  if (derivation === undefined || !documentIsCurrent(initial.state, derivation.document)) {
    return { kind: "refused", refusal: { kind: "document-moved", contractId: input.contractId } };
  }
  if (derivation.verification.kind === "refused") {
    return { kind: "refused", refusal: derivation.verification.refusal };
  }

  const prepared = await prepareDelivery(input.scope, {
    contractId: initial.state.id,
    coordinates: initial.state.coordinates,
  }, {
    title: derivation.title,
    requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate ?? false,
    includeDirty: input.includeDirty ?? false,
  });
  if (prepared.kind === "refused") {
    return accepted(initial.state, [], { ...initial.report, preview: { kind: "blocked", refusal: prepared.refusal } });
  }

  const verified = derivation.verification.data === null
    ? undefined
    : await auditCandidateVerification(input, initial.state, prepared.data.integration.snapshot, derivation.verification.data);
  const report = verified?.admission === undefined
    ? initial.report
    : auditReport(verified.admission.journal, REVIEWED, initial.state, initial.report.targetObservation);
  const value: AuditReport = {
    ...report,
    preview: await readyAuditPreview(input.scope, initial.state, prepared.data, input.showDiff === true),
    ...(verified?.stop === undefined ? {} : { attempt: verified.stop }),
    ...(verified?.cleanup === undefined ? {} : { cleanup: verified.cleanup }),
    ...(verified?.leak === undefined ? {} : { leak: verified.leak }),
  };
  return verified?.admission === undefined
    ? accepted(initial.state, [], value)
    : admitted(verified.admission, value);
}

export type ReconcileReport = ReconcileResult;
export type ReconcileObservation = Readonly<{ state: ContractState | null; report: ReconcileReport }>;
type ReconcileOptions = Readonly<{ hooks: WorktreeHooks; retryHooks: boolean; retainTerminalWorktree?: boolean }>;

export async function reconcileOperation(input: MutationOperationInput & ReconcileOptions): Promise<ReconcileObservation> {
  try {
    const observation = await reconcile({
      repository: input.scope,
      channel: input.channel,
      contractId: input.contractId,
      hooks: input.hooks,
      retryHooks: input.retryHooks,
      ...(input.retainTerminalWorktree === undefined ? {} : { retainTerminalWorktree: input.retainTerminalWorktree }),
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
  const observation = await withGitReadObservation(input.scope, input.channel, async (read) => await observeContractWorld(read));
  const contracts = (await reconcileBatch(
    git,
    input.channel,
    observation.contracts.keys(),
    {
      hooks: input.hooks,
      retryHooks: input.retryHooks,
      retainTerminalWorktree: input.retainTerminalWorktree ?? false,
    },
  )).map((item): RepoReconcileItem => ({
    contractId: item.contract,
    state: item.state,
    report: item.result,
  }));
  return { contracts };
}
