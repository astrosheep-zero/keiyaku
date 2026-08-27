import {
  materializeIntegrationSnapshot,
  materializeJudgedConflict,
  planIntegration,
  workspaceMergeStatePresent,
  worktreeChangeId,
} from "../git/integration.js";
import {
  captureTender,
  dirtyTenderRefusal,
  materializeTenderSnapshot,
  prepareDeliveryCommitMetadata,
} from "../git/tender.js";
import { worktreePath } from "../git/workspace.js";
import { observeContractsForAdmissionAt } from "../git/observe.js";
import type { AttemptContext } from "../core/decide.js";
import { contractState } from "../core/facts/observation.js";
import type { ActorId, ContractId, ContractState, DeliverData, JournalEntry, SnapshotId } from "../core/facts/types.js";
import { decideDeliver, type DeliverInput, type DeliverRefusal } from "../core/verbs/deliver.js";
import type { CurrentVerifiedAttestation } from "./intent.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import { admitted } from "./outcome.js";
import { completeCandidate, type CompletionEvidence, type CompletionResult } from "./completion.js";
import { appointmentFor, readPlaceRegister, type ManagedWorktreeAppointment } from "../workspace-place.js";
import type {
  AttemptDecision,
  DeliverConflictRefusal,
  DeliveryPreparationRefusal,
  DocumentDerivation,
  IntentOutcome,
  IntentRefusal,
  MutationOperationInput,
} from "./operations.js";
import { timestamp } from "./operations.js";

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

const DELIVER_CONFLICT_RECOVERY = Object.freeze({
  materialize: "deliver --materialize-conflict",
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
type PreparedDelivery = Readonly<{
  delivery: DeliveryIdentity;
  derivation: DocumentDerivation;
  workspacePath?: string;
}>;

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
    ((tender.data.dirty || tender.data.mergeHead !== undefined) && input.includeDirty !== true) ||
    tender.data.changes.submodules.length > 0
  ) {
    return { kind: "refused", refusal: await dirtyTenderRefusal(repository, contractId, tender.data) };
  }
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
        changeId: await worktreeChangeId(repository, { contractId, coordinates }, tender.data),
      },
      method: "squash",
      policy: { requireBranchesToBeUpToDate },
    },
  };
}

async function deliverAttempt(
  input: DeliverOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<PreparedDelivery>> {
  const decisionObservation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = contractState(decisionObservation.decision, input.contractId);
  const derivation = state === null ? undefined : input.deriveDocument(state);
  let preparation: DeliverInput<DeliveryFailure>["preparation"];
  if (state === null || derivation === undefined) {
    preparation = { kind: "unavailable" };
  } else if (derivation.verification.kind === "refused") {
    preparation = { kind: "refused", document: derivation.document, refusal: derivation.verification.refusal };
  } else {
    const materialization =
      input.materializeConflict === true && state.terminal === null
        ? await materializationMergeStateRefusal(input)
        : undefined;
    const prepared =
      materialization === undefined
        ? await prepareDelivery(
            input.scope,
            {
              contractId: state.id,
              coordinates: state.coordinates,
            },
            {
              title: derivation.title,
              document: derivation.bytes,
              ...(input.actor === undefined ? {} : { actor: input.actor }),
              ...(input.message === undefined ? {} : { message: input.message }),
              requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
              includeDirty: input.includeDirty,
            },
          )
        : { kind: "refused" as const, refusal: materialization };
    preparation =
      prepared.kind === "refused"
        ? { kind: "refused", document: derivation.document, refusal: prepared.refusal }
        : {
            kind: "prepared",
            document: derivation.document,
            data: prepared.data,
          };
  }
  const decision = decideDeliver({
    input: {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      preparation,
    },
    attempt,
    observation: decisionObservation.decision,
  });
  if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };
  if (preparation.kind !== "prepared") throw new Error("offered delivery is missing its mechanical preparation");
  const admission = await admitDecidedOffer({
    channel: input.channel,
    repository: input.scope,
    decisionObservation,
    attempt,
    offer: decision.offer,
    primaryContract: input.contractId,
  });
  if (admission.kind === "accepted") {
    if (derivation === undefined) throw new Error("accepted delivery is missing its document derivation");
    return {
      ...admission,
      value: {
        delivery: preparation.data,
        derivation,
      },
    };
  }
  return admission;
}

async function completeDelivery(
  input: DeliverOperationInput,
  first: Extract<AttemptDecision<PreparedDelivery>, { kind: "accepted" }>,
): Promise<IntentOutcome<DeliverValue>> {
  const derivation = first.value.derivation;
  if (derivation.verification.kind !== "prepared") {
    throw new Error("accepted delivery is missing its Verification preparation");
  }
  const completed = await completeCandidate({
    channel: input.channel,
    repository: input.scope,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(first.state.coordinates.target === undefined ? {} : { target: first.state.coordinates.target }),
    verification: derivation.verification,
    initial: first,
    verifyInitial: true,
  });
  return admitted(completed.admission, {
    ...first.value.delivery,
    ...completed.evidence,
  });
}

export async function continueDeliveryOperation(
  input: Readonly<{
    scope: MutationOperationInput["scope"];
    channel: MutationOperationInput["channel"];
    state: ContractState;
    journal: readonly JournalEntry[];
    deriveDocument: (state: ContractState) => DocumentDerivation;
    actor?: ActorId;
    signal?: AbortSignal;
  }>,
): Promise<CompletionResult> {
  const contractId = input.state.id;
  return await completeCandidate({
    channel: input.channel,
    repository: input.scope,
    contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.state.coordinates.target === undefined ? {} : { target: input.state.coordinates.target }),
    verification: input.deriveDocument(input.state).verification,
    initial: { kind: "accepted", state: input.state, journal: input.journal, facts: [] },
    verifyInitial: true,
  });
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
  | Readonly<{ workspace: AppointedWorkspace; coordinates: ContractState["coordinates"] }>
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
  };
}

async function materializationMergeStateRefusal(
  input: DeliverOperationInput,
): Promise<DeliveryPreparationRefusal | undefined> {
  const appointed = await appointedDeliverWorkspace(input);
  if ("kind" in appointed) return appointed.refusal;
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
): Promise<IntentOutcome<DeliverValue> | IntegrationConflictMaterialized> {
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
  if (tender.data.dirty || tender.data.changes.submodules.length > 0) {
    return { kind: "refused", refusal: await dirtyTenderRefusal(input.scope, input.contractId, tender.data) };
  }
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
): Promise<IntentOutcome<DeliverValue> | IntegrationConflictMaterialized> {
  if (!isIntegrationConflict(refusal)) return { kind: "refused", refusal };
  if (input.materializeConflict !== true) return { kind: "refused", refusal: conflictDeliverRefusal(refusal) };
  return await materializeDeliverConflict(input, refusal);
}

export async function deliverOperation(
  input: DeliverOperationInput,
): Promise<IntentOutcome<DeliverValue> | IntegrationConflictMaterialized> {
  const attempts = mintAttempts({ entryCount: 2 });
  let first: Extract<AttemptDecision<PreparedDelivery>, { kind: "accepted" }> | null = null;
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
  return await completeDelivery(input, first);
}
