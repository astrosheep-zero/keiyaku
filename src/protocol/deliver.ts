import {
  materializeIntegrationSnapshot,
  materializeJudgedConflict,
  planIntegration,
  worktreeChangeId,
} from "../git/integration.js";
import {
  captureTender,
  dirtyTenderRefusal,
  materializeTenderSnapshot,
  prepareDeliveryCommitMetadata,
} from "../git/tender.js";
import {
  checkoutDetachedSnapshot,
  recordConflictHandoff,
  retireConflictHandoff,
  workspaceMergeStatePresent,
  worktreePath,
} from "../git/workspace.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import { type PrivateStatePublicationSeat } from "../git/private-state-seat.js";
import {
  matchingPrivateRootObservation,
  privateStateSeatAttempt,
  sameSpeculativeWorktreeInput,
  type SpeculativeWorktreeInput,
} from "./run.js";
import type { AttemptContext } from "../core/decide.js";
import { contractState } from "../core/facts/observation.js";
import type { ActorId, ContractId, ContractState, DeliverData, SnapshotId } from "../core/facts/types.js";
import { decideDeliver, type DeliverInput, type DeliverRefusal } from "../core/verbs/deliver.js";
import type { CurrentVerifiedAttestation } from "./intent.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import type { LeadingOutcome } from "./outcome.js";
import type { CompletionEvidence } from "./completion.js";
import { appointmentFor, readPlaceRegister, type ManagedWorktreeAppointment } from "../workspace-place.js";
import type {
  AttemptDecision,
  DeliverConflictRefusal,
  DeliveryPreparationRefusal,
  DocumentDerivation,
  IntentRefusal,
  MutationOperationInput,
} from "./operations.js";
import { attemptDecisionWithSeatClose, timestamp } from "./operations.js";

type DeliveryIdentity = DeliverData;
export type VerificationReuse = CurrentVerifiedAttestation;
export type DeliverValue = DeliveryIdentity & CompletionEvidence;

export type AppointedWorkspace = Readonly<{
  kind: "worktree";
  path: string;
}>;

export type IntegrationConflictMaterialized = Readonly<{
  kind: "integration-conflict-materialized";
  targetHead: SnapshotId;
  conflictPaths: readonly string[];
  workspace: AppointedWorkspace;
}>;
export { decodeMaterializedConflict } from "./result-codec.js";

const DELIVER_CONFLICT_RECOVERY = Object.freeze({
  materialize: "deliver --materialize-conflict --include-dirty",
  continue: "deliver --include-dirty",
} as const);

type DeliverOperationInput = MutationOperationInput &
  Readonly<{
    deriveDocument: (state: ContractState) => DocumentDerivation;
    message?: string;
    requireBranchesToBeUpToDate: boolean;
    includeDirty: boolean;
    materializeConflict: boolean;
    signal?: AbortSignal;
  }>;

type IntegrationConflictRefusal = Extract<IntentRefusal, { kind: "integration-failed"; reason: "conflict" }>;

type DeliveryFailure =
  | DeliveryPreparationRefusal
  | import("../verification/declaration.js").VerificationDeclarationRefusal
  | DeliverRefusal;
async function captureAuthorizedDeliveryTender(
  repository: import("../git/process.js").GitRepository,
  stage: Readonly<{
    contractId: ContractId;
    coordinates: ContractState["coordinates"];
    appointment?: Extract<ManagedWorktreeAppointment, { kind: "appointed" }>;
  }>,
  includeDirty: boolean | undefined,
): Promise<
  | { kind: "prepared"; data: import("../git/tender.js").TenderCapture }
  | { kind: "refused"; refusal: DeliveryPreparationRefusal }
> {
  const { contractId, coordinates } = stage;
  const appointed =
    coordinates.workspace === "worktree"
      ? stage.appointment === undefined
        ? appointmentFor(await readPlaceRegister(repository), contractId)
        : { contract: contractId, place: stage.appointment.place }
      : undefined;
  const tender = await captureTender(repository, {
    contractId,
    coordinates,
    ...(appointed === undefined ? {} : { place: appointed.place }),
    captureMergeState: true,
  });
  if (tender.kind === "refused") return tender;
  if (
    ((tender.data.dirty || tender.data.mergeHead !== undefined) && includeDirty !== true) ||
    tender.data.changes.submodules.length > 0
  ) {
    return { kind: "refused", refusal: await dirtyTenderRefusal(repository, contractId, tender.data) };
  }
  return { kind: "prepared", data: tender.data };
}

async function prepareDeliveryWithWorktree(
  repository: import("../git/process.js").GitRepository,
  stage: Readonly<{
    contractId: ContractId;
    coordinates: ContractState["coordinates"];
    appointment?: Extract<ManagedWorktreeAppointment, { kind: "appointed" }>;
  }>,
  input: Readonly<{
    title: string;
    document: string;
    actor?: ActorId;
    message?: string;
    requireBranchesToBeUpToDate?: boolean;
    includeDirty?: boolean;
  }>,
): Promise<
  | { kind: "prepared"; data: DeliverData; worktree: SpeculativeWorktreeInput }
  | { kind: "refused"; refusal: DeliveryPreparationRefusal }
> {
  const { contractId, coordinates } = stage;
  const tender = await captureAuthorizedDeliveryTender(repository, stage, input.includeDirty);
  if (tender.kind === "refused") return tender;
  const commit = await prepareDeliveryCommitMetadata(repository, {
    contractId,
    title: input.title,
    document: input.document,
    at: tender.data.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.message === undefined ? {} : { message: input.message }),
  });
  const tenderSnapshot = await materializeTenderSnapshot(repository, tender.data, commit);
  const requireBranchesToBeUpToDate = input.requireBranchesToBeUpToDate ?? false;
  const integration = await planIntegration(
    repository,
    { contractId, coordinates },
    { ...tender.data, head: tenderSnapshot },
    requireBranchesToBeUpToDate,
  );
  if (integration.kind === "refused") return integration;
  const changeId = await worktreeChangeId(repository, { contractId, coordinates }, tender.data);
  const integrationSnapshot =
    coordinates.target === undefined
      ? tenderSnapshot
      : await materializeIntegrationSnapshot(repository, integration.data.tree, integration.data.predecessor, commit);
  return {
    kind: "prepared",
    data: {
      tenderSnapshot,
      integration: {
        predecessor: integration.data.predecessor,
        snapshot: integrationSnapshot,
        changeId,
      },
      method: "squash",
      policy: { requireBranchesToBeUpToDate },
    },
    worktree: {
      tree: tender.data.tree,
      head: tender.data.head,
      ...(tender.data.mergeHead === undefined ? {} : { mergeHead: tender.data.mergeHead }),
      dirty: tender.data.dirty,
      changeId,
    },
  };
}

export async function prepareDelivery(
  repository: import("../git/process.js").GitRepository,
  stage: Readonly<{
    contractId: ContractId;
    coordinates: ContractState["coordinates"];
    appointment?: Extract<ManagedWorktreeAppointment, { kind: "appointed" }>;
  }>,
  input: Readonly<{
    title: string;
    document: string;
    actor?: ActorId;
    message?: string;
    requireBranchesToBeUpToDate?: boolean;
    includeDirty?: boolean;
  }>,
): Promise<{ kind: "prepared"; data: DeliverData } | { kind: "refused"; refusal: DeliveryPreparationRefusal }> {
  const prepared = await prepareDeliveryWithWorktree(repository, stage, input);
  return prepared.kind === "refused" ? prepared : { kind: "prepared", data: prepared.data };
}

type SpeculativeDelivery = Readonly<{
  observation: GitDecisionObservation;
  state: ContractState | null;
  derivation?: DocumentDerivation;
  preparation?: DeliverInput<DeliveryFailure>["preparation"];
  worktree?: SpeculativeWorktreeInput;
}>;

function deliveryPreparationInput(input: DeliverOperationInput, derivation: DocumentDerivation) {
  return {
    title: derivation.title,
    document: derivation.bytes,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.message === undefined ? {} : { message: input.message }),
    requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
    includeDirty: input.includeDirty,
  };
}

async function recaptureDeliveryWorktree(
  input: DeliverOperationInput,
  state: ContractState,
): Promise<SpeculativeWorktreeInput | undefined> {
  const tender = await captureAuthorizedDeliveryTender(
    input.scope,
    { contractId: state.id, coordinates: state.coordinates },
    input.includeDirty,
  );
  if (tender.kind === "refused") return undefined;
  return {
    tree: tender.data.tree,
    head: tender.data.head,
    ...(tender.data.mergeHead === undefined ? {} : { mergeHead: tender.data.mergeHead }),
    dirty: tender.data.dirty,
    changeId: await worktreeChangeId(
      input.scope,
      { contractId: state.id, coordinates: state.coordinates },
      tender.data,
    ),
  };
}

async function mechanicalDeliveryPreparation(
  input: DeliverOperationInput,
  state: ContractState,
  derivation: DocumentDerivation,
): Promise<
  | Extract<DeliverInput<DeliveryFailure>["preparation"], { kind: "refused" }>
  | Readonly<{
      kind: "prepared";
      document: DocumentDerivation["document"];
      data: DeliveryIdentity;
      worktree: SpeculativeWorktreeInput;
    }>
> {
  const prepared = await prepareDeliveryWithWorktree(
    input.scope,
    { contractId: state.id, coordinates: state.coordinates },
    deliveryPreparationInput(input, derivation),
  );
  if (prepared.kind === "refused") {
    return { kind: "refused", document: derivation.document, refusal: prepared.refusal };
  }
  return {
    kind: "prepared",
    document: derivation.document,
    data: prepared.data,
    worktree: prepared.worktree,
  };
}

async function speculateDelivery(input: DeliverOperationInput): Promise<SpeculativeDelivery> {
  const observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = contractState(observation.decision, input.contractId);
  const derivation = state === null ? undefined : input.deriveDocument(state);
  if (state === null || derivation === undefined) {
    return { observation, state, preparation: { kind: "unavailable" } };
  }
  if (derivation.verification.kind === "refused") {
    return {
      observation,
      state,
      derivation,
      preparation: { kind: "refused", document: derivation.document, refusal: derivation.verification.refusal },
    };
  }
  if (input.materializeConflict === true && state.terminal === null) return { observation, state, derivation };
  const prepared = await mechanicalDeliveryPreparation(input, state, derivation);
  return prepared.kind === "prepared"
    ? { observation, state, derivation, preparation: prepared, worktree: prepared.worktree }
    : { observation, state, derivation, preparation: prepared };
}

async function resolveDeliveryPreparation(
  input: DeliverOperationInput,
  speculated: SpeculativeDelivery,
): Promise<DeliverInput<DeliveryFailure>["preparation"]> {
  if (speculated.preparation !== undefined) return speculated.preparation;
  if (speculated.state === null || speculated.derivation === undefined) return { kind: "unavailable" };
  const materialization = await materializationMergeStateRefusal(input);
  if (materialization !== undefined) {
    return { kind: "refused", document: speculated.derivation.document, refusal: materialization };
  }
  const prepared = await mechanicalDeliveryPreparation(input, speculated.state, speculated.derivation);
  return prepared.kind === "prepared"
    ? { kind: "prepared", document: prepared.document, data: prepared.data }
    : prepared;
}

async function decideAndAdmitDelivery(
  input: DeliverOperationInput,
  attempt: AttemptContext,
  seat: PrivateStatePublicationSeat,
  observation: GitDecisionObservation,
  speculated: SpeculativeDelivery,
): Promise<AttemptDecision<DeliveryIdentity>> {
  const preparation = await resolveDeliveryPreparation(input, speculated);
  const decision = decideDeliver({
    input: {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      preparation,
    },
    attempt,
    observation: observation.decision,
  });
  if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };
  if (preparation.kind !== "prepared") throw new Error("offered delivery is missing its mechanical preparation");
  const admission = await admitDecidedOffer({
    channel: input.channel,
    repository: input.scope,
    seat,
    decisionObservation: observation,
    attempt,
    offer: decision.offer,
    primaryContract: input.contractId,
    ...(input.progress === undefined ? {} : input.progress === undefined ? {} : { progress: input.progress }),
  });
  if (admission.kind !== "accepted") return admission;
  return {
    ...admission,
    value: preparation.data,
  };
}

async function deliverAttemptInPrivateStateSeat(
  input: DeliverOperationInput,
  attempt: AttemptContext,
  seat: PrivateStatePublicationSeat,
  speculated: SpeculativeDelivery,
): Promise<AttemptDecision<DeliveryIdentity>> {
  const observation = await matchingPrivateRootObservation(
    input.scope,
    input.channel,
    input.contractId,
    speculated.observation,
    async (fresh) => {
      if (speculated.worktree === undefined) return true;
      const state = contractState(fresh.decision, input.contractId);
      if (state === null) return false;
      return sameSpeculativeWorktreeInput(speculated.worktree, await recaptureDeliveryWorktree(input, state));
    },
  );
  return "kind" in observation
    ? observation
    : await decideAndAdmitDelivery(input, attempt, seat, observation, speculated);
}

async function deliverAttempt(
  input: DeliverOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<DeliveryIdentity>> {
  const speculated = await speculateDelivery(input);
  return await privateStateSeatAttempt(
    input.scope,
    async (seat) => await deliverAttemptInPrivateStateSeat(input, attempt, seat, speculated),
    attemptDecisionWithSeatClose,
  );
}

function isIntegrationConflict(refusal: IntentRefusal): refusal is IntegrationConflictRefusal {
  return refusal.kind === "integration-failed" && refusal.reason === "conflict";
}

function conflictDeliverRefusal(refusal: IntegrationConflictRefusal): DeliverConflictRefusal {
  if (refusal.conflictPaths === undefined) throw new Error("conflicted integration is missing conflict paths");
  return {
    kind: "integration-failed",
    contractId: refusal.contractId,
    reason: "conflict",
    targetHead: refusal.targetHead,
    conflictPaths: refusal.conflictPaths,
    recovery: DELIVER_CONFLICT_RECOVERY,
  };
}

async function appointedDeliverWorkspace(
  input: DeliverOperationInput,
): Promise<
  | Readonly<{ workspace: AppointedWorkspace; coordinates: ContractState["coordinates"]; state: ContractState }>
  | { kind: "refused"; refusal: DeliveryPreparationRefusal }
> {
  const observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = contractState(observation.decision, input.contractId);
  if (state === null) return { kind: "refused", refusal: { kind: "worktree-missing", contractId: input.contractId } };
  const appointment = appointmentFor(await readPlaceRegister(input.scope), input.contractId);
  if (appointment === undefined) {
    return { kind: "refused", refusal: { kind: "worktree-missing", contractId: input.contractId } };
  }
  return {
    workspace: { kind: "worktree", path: worktreePath(input.scope, appointment.place) },
    coordinates: state.coordinates,
    state,
  };
}

async function materializationMergeStateRefusal(
  input: DeliverOperationInput,
): Promise<DeliveryPreparationRefusal | undefined> {
  const appointed = await appointedDeliverWorkspace(input);
  if ("kind" in appointed) return appointed.refusal;
  const appointment = appointmentFor(await readPlaceRegister(input.scope), input.contractId);
  if (appointment === undefined) return { kind: "worktree-missing", contractId: input.contractId };
  const retirement = await retireConflictHandoff(input.scope, {
    contractId: input.contractId,
    place: appointment.place,
    workspace: appointed.workspace.path,
    consume: true,
  });
  if (retirement.kind === "retained")
    return { kind: "merge-state-present", contractId: input.contractId, workspace: appointed.workspace };
  return await mergeStatePresentRefusal(input, appointed.workspace);
}

async function mergeStatePresentRefusal(
  input: DeliverOperationInput,
  workspace: AppointedWorkspace,
): Promise<Extract<DeliveryPreparationRefusal, { kind: "merge-state-present" }> | undefined> {
  if (!(await workspaceMergeStatePresent(input.scope, workspace.path))) return undefined;
  return { kind: "merge-state-present", contractId: input.contractId, workspace };
}

async function materializeDeliverConflict(
  input: DeliverOperationInput,
  refusal: IntegrationConflictRefusal,
): Promise<LeadingOutcome<DeliveryIdentity, IntentRefusal> | IntegrationConflictMaterialized> {
  if (refusal.conflictPaths === undefined) throw new Error("conflicted integration is missing conflict paths");
  const appointed = await appointedDeliverWorkspace(input);
  if ("kind" in appointed) return appointed;
  const { workspace, coordinates } = appointed;
  const appointment = appointmentFor(await readPlaceRegister(input.scope), input.contractId);
  if (appointment === undefined)
    return { kind: "refused", refusal: { kind: "worktree-missing", contractId: input.contractId } };
  const mergeState = await mergeStatePresentRefusal(input, workspace);
  if (mergeState !== undefined) return { kind: "refused", refusal: mergeState };
  const tender = await captureTender(input.scope, {
    contractId: input.contractId,
    coordinates,
    place: appointment.place,
  });
  if (tender.kind === "refused") return tender;
  if (tender.data.changes.submodules.length > 0 || (tender.data.dirty && input.includeDirty !== true)) {
    return { kind: "refused", refusal: await dirtyTenderRefusal(input.scope, input.contractId, tender.data) };
  }
  let handoffHead = tender.data.head;
  if (tender.data.dirty) {
    const derivation = input.deriveDocument(appointed.state);
    const commit = await prepareDeliveryCommitMetadata(input.scope, {
      contractId: input.contractId,
      title: derivation.title,
      document: derivation.bytes,
      at: tender.data.at,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.message === undefined ? {} : { message: input.message }),
    });
    handoffHead = await materializeTenderSnapshot(input.scope, tender.data, commit);
    await checkoutDetachedSnapshot(input.scope, workspace.path, handoffHead);
  }
  await recordConflictHandoff(input.scope, {
    contractId: input.contractId,
    place: appointment.place,
    workspace: workspace.path,
    head: handoffHead,
    mergeHead: refusal.targetHead,
  });
  await materializeJudgedConflict(input.scope, workspace.path, refusal.targetHead);
  return {
    kind: "integration-conflict-materialized",
    targetHead: refusal.targetHead,
    conflictPaths: refusal.conflictPaths,
    workspace,
  };
}

async function finishDeliverRefusal(
  input: DeliverOperationInput,
  refusal: IntentRefusal,
): Promise<LeadingOutcome<DeliveryIdentity, IntentRefusal> | IntegrationConflictMaterialized> {
  if (!isIntegrationConflict(refusal)) return { kind: "refused", refusal };
  if (input.materializeConflict !== true) return { kind: "refused", refusal: conflictDeliverRefusal(refusal) };
  return await materializeDeliverConflict(input, refusal);
}

export async function admitDeliveryOperation(
  input: DeliverOperationInput,
): Promise<LeadingOutcome<DeliveryIdentity, IntentRefusal> | IntegrationConflictMaterialized> {
  const attempts = mintAttempts({ entryCount: 2 });
  let first: Extract<AttemptDecision<DeliveryIdentity>, { kind: "accepted" }> | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const result = await deliverAttempt(input, attempts[index]!);
    if (result.kind === "accepted") {
      first = result;
      break;
    }
    if (result.kind === "refused") return await finishDeliverRefusal(input, result.refusal);
    if (result.kind === "publication-failed") return { kind: "retry", reason: result };
    if (result.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: result };
  }
  if (first === null) return { kind: "retry", reason: { kind: "exhausted" } };
  input.progress?.recordResidue(input.contractId, first);
  return first;
}
