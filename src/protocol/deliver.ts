import { entryUlidSchema } from "./attempt.js";
import { z } from "zod";
import { candidateContentChangeSchema, snapshotIdSchema } from "./operations.js";
import { conflictRecoverySchema, worktreeWorkspaceSchema } from "../git/workspace.js";
import {
  materializeIntegrationSnapshot,
  materializeJudgedConflict,
  planIntegration,
  reusableIntegrationSnapshot,
  worktreeChangeId,
} from "../git/integration.js";
import {
  captureTender,
  dirtyTenderRefusal,
  materializeTenderSnapshot,
  prepareDeliveryCommitMetadata,
  type TenderCapture,
} from "../git/tender.js";
import {
  checkoutDetachedSnapshot,
  recordConflictHandoff,
  retireConflictHandoff,
  workspaceMergeStatePresent,
  worktreePath,
  conflictRecovery,
} from "../git/workspace.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import { type PrivateStatePublicationSeat } from "../git/private-state-seat.js";
import {
  externalPreparation,
  privateStateSeatAttempt,
  protocolSeatClose,
  runBoundedAttempts,
  sameWorktreeWitness,
  STALE_PRIVATE_STATE_PREPARATION,
  type ContractStateWitness,
  type WorktreeWitness,
} from "./run.js";
import type { AttemptContext } from "../core/decide.js";
import { contractState } from "../core/facts/observation.js";
import type {
  ActorId,
  ChangeId,
  ContractId,
  ContractState,
  DeliverData,
  JournalEntry,
  SnapshotId,
} from "../core/facts/types.js";
import { decideDeliver, type DeliverInput, type DeliverRefusal } from "../core/verbs/deliver.js";
import { currentVerifiedAttestation, type CurrentVerifiedAttestation } from "./intent.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import type { LeadingOutcome } from "./outcome.js";
import type { CompletionEvidence } from "./completion.js";
import { appointmentFor, readPlaceRegister, type ManagedWorktreeAppointment } from "../workspace-place.js";
import type {
  AttemptDecision,
  DeliverConflictRefusal,
  DeliveryPreparationRefusal,
  DocumentDerivation,
  MutationOperationInput,
} from "./operations.js";
import { recordedIntegrationSnapshots, timestamp } from "./operations.js";

type DeliveryIdentity = DeliverData;
export type VerificationReuse = CurrentVerifiedAttestation;
export const deliverLeadingSchema = z
  .object({
    kind: z.enum(["admitted-now", "already-admitted"]),
    fact: entryUlidSchema,
    reusedIntegration: snapshotIdSchema.optional(),
  })
  .strict();
type DeliverLeading = z.infer<typeof deliverLeadingSchema>;
type DeliverValue = DeliveryIdentity &
  CompletionEvidence &
  Readonly<{
    leading: DeliverLeading;
    contentChange?: z.infer<typeof candidateContentChangeSchema>;
  }>;
type AppointedWorkspace = z.infer<typeof worktreeWorkspaceSchema>;
export const materializedConflictSchema = z
  .object({
    kind: z.literal("integration-conflict-materialized"),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(z.string().refine((value) => value.trim() !== "")).readonly(),
    workspace: worktreeWorkspaceSchema,
    handoffBase: snapshotIdSchema,
    recovery: conflictRecoverySchema,
  })
  .strict();
export type IntegrationConflictMaterialized = z.infer<typeof materializedConflictSchema>;

const DELIVER_CONFLICT_RECOVERY = conflictRecovery;

type DeliverOperationInput = MutationOperationInput &
  Readonly<{
    deriveDocument: (state: ContractState) => DocumentDerivation;
    message?: string;
    requireBranchesToBeUpToDate: boolean;
    includeDirty: boolean;
    materializeConflict: boolean;
    overwrite?: boolean;
    signal?: AbortSignal;
  }>;

type DeliverOperationRefusal =
  | import("../core/verbs/deliver.js").DeliverRefusal
  | DeliveryPreparationRefusal
  | import("./operations.js").DeliverConflictRefusal
  | import("../verification/declaration.js").VerificationDeclarationRefusal;

type IntegrationConflictRefusal = Extract<DeliverOperationRefusal, { kind: "integration-failed"; reason: "conflict" }>;

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
    recordedIntegrations?: readonly SnapshotId[];
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
  captured?: TenderCapture,
): Promise<
  | { kind: "prepared"; data: DeliverData; worktree: WorktreeWitness; reusedIntegration?: SnapshotId }
  | { kind: "refused"; refusal: DeliveryPreparationRefusal }
> {
  const { contractId, coordinates } = stage;
  const tender =
    captured === undefined
      ? await captureAuthorizedDeliveryTender(repository, stage, input.includeDirty)
      : { kind: "prepared" as const, data: captured };
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
  const reusedIntegration = await reusableIntegrationSnapshot(
    repository,
    integration.data.tree,
    integration.data.predecessor,
    stage.recordedIntegrations ?? [],
  );
  const integrationSnapshot =
    reusedIntegration ??
    (coordinates.target === undefined
      ? tenderSnapshot
      : await materializeIntegrationSnapshot(repository, integration.data.tree, integration.data.predecessor, commit));
  return {
    kind: "prepared",
    ...(reusedIntegration === undefined ? {} : { reusedIntegration }),
    data: {
      ...(input.message === undefined ? {} : { note: input.message }),
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
    recordedIntegrations?: readonly SnapshotId[];
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

/**
 * Physical delivery work prepared outside custody. It is never authority: every state-derived part
 * (document, preparation choice) is recomputed from the fresh in-custody Contract, and the carried
 * artifacts stay usable only while the witness and the physical worktree still hold.
 */
type DeliveryArtifacts =
  | Readonly<{ kind: "defer" }>
  | Readonly<{ kind: "reuse"; worktree: WorktreeWitness }>
  | Readonly<{ kind: "refused"; refusal: DeliveryFailure }>
  | Readonly<{ kind: "continuation"; worktree: WorktreeWitness }>
  | Readonly<{ kind: "mechanical"; data: DeliveryIdentity; worktree: WorktreeWitness; reusedIntegration?: SnapshotId }>;

type ExternalDeliveryPreparation =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "artifacts"; witness: ContractStateWitness; artifacts: DeliveryArtifacts }>;

type AssembledDelivery =
  | Readonly<{ kind: "stale" }>
  | Readonly<{
      kind: "assembled";
      state: ContractState | null;
      derivation?: DocumentDerivation;
      preparation?: DeliverInput<DeliveryFailure>["preparation"];
      continuation?: boolean;
      reusedIntegration?: SnapshotId;
      reuse?: boolean;
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
): Promise<WorktreeWitness | undefined> {
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
  journal: readonly JournalEntry[],
  captured?: TenderCapture,
): Promise<
  | Extract<DeliverInput<DeliveryFailure>["preparation"], { kind: "refused" }>
  | Readonly<{
      kind: "prepared";
      document: DocumentDerivation["document"];
      data: DeliveryIdentity;
      worktree: WorktreeWitness;
      reusedIntegration?: SnapshotId;
    }>
> {
  const prepared = await prepareDeliveryWithWorktree(
    input.scope,
    {
      contractId: state.id,
      coordinates: state.coordinates,
      recordedIntegrations: recordedIntegrationSnapshots(journal),
    },
    deliveryPreparationInput(input, derivation),
    captured,
  );
  if (prepared.kind === "refused") {
    return { kind: "refused", document: derivation.document, refusal: prepared.refusal };
  }
  return {
    kind: "prepared",
    document: derivation.document,
    data: prepared.data,
    worktree: prepared.worktree,
    ...(prepared.reusedIntegration === undefined ? {} : { reusedIntegration: prepared.reusedIntegration }),
  };
}

function worktreeInput(
  repository: import("../git/process.js").GitRepository,
  state: ContractState,
  tender: TenderCapture,
): Promise<WorktreeWitness> {
  return worktreeChangeId(repository, { contractId: state.id, coordinates: state.coordinates }, tender).then(
    (changeId) => ({
      tree: tender.tree,
      head: tender.head,
      ...(tender.mergeHead === undefined ? {} : { mergeHead: tender.mergeHead }),
      dirty: tender.dirty,
      changeId,
    }),
  );
}

function hasSupersedingVerification(state: ContractState, journal: readonly JournalEntry[]): boolean {
  if (state.delivery === null) return false;
  const current = currentVerifiedAttestation(state);
  if (current === undefined) return false;
  const deliveryIndex = journal.findIndex((entry) => entry.entry === state.delivery?.entry);
  const verificationIndex = journal.findIndex((entry) => entry.entry === current.entry);
  return deliveryIndex >= 0 && verificationIndex > deliveryIndex;
}

/**
 * Repeatable physical delivery work outside the publication seat: locate the appointed worktree from
 * one non-authoritative private-state read, capture its bytes, and materialize the prepared artifacts.
 */
async function prepareExternalDelivery(input: DeliverOperationInput): Promise<ExternalDeliveryPreparation> {
  return await externalPreparation(input, (observation, state) => prepareDeliveryArtifacts(input, observation, state));
}

async function prepareDeliveryArtifacts(
  input: DeliverOperationInput,
  observation: GitDecisionObservation,
  state: ContractState,
): Promise<DeliveryArtifacts> {
  const derivation = input.deriveDocument(state);
  if (derivation.verification.kind === "refused") return { kind: "defer" };
  if (input.materializeConflict === true && state.terminal === null) return { kind: "defer" };
  const captured = await captureAuthorizedDeliveryTender(
    input.scope,
    { contractId: state.id, coordinates: state.coordinates },
    input.includeDirty,
  );
  if (captured.kind === "refused") return { kind: "refused", refusal: captured.refusal };
  const worktree = await worktreeInput(input.scope, state, captured.data);
  if (reusesCurrentCandidate(input, state, derivation, worktree.changeId)) {
    return { kind: "reuse", worktree };
  }
  if (
    state.terminal === null &&
    state.delivery !== null &&
    worktree.changeId === state.delivery.data.integration.changeId &&
    !hasSupersedingVerification(state, observation.journals.get(state.id)?.entries ?? [])
  ) {
    return {
      kind: "continuation",
      worktree,
    };
  }
  const prepared = await mechanicalDeliveryPreparation(
    input,
    state,
    derivation,
    observation.journals.get(state.id)?.entries ?? [],
    captured.data,
  );
  return prepared.kind === "prepared"
    ? {
        kind: "mechanical",
        data: prepared.data,
        worktree: prepared.worktree,
        ...(prepared.reusedIntegration === undefined ? {} : { reusedIntegration: prepared.reusedIntegration }),
      }
    : { kind: "refused", refusal: prepared.refusal };
}

/**
 * Assemble the in-custody decision input from the fresh Contract. State-derived choices are recomputed
 * here; artifacts the fresh state cannot justify are spent, which restarts the whole preparation.
 */
async function assembleDeliveryAttempt(
  input: DeliverOperationInput,
  observation: GitDecisionObservation,
  external: ExternalDeliveryPreparation,
): Promise<AssembledDelivery> {
  const state = contractState(observation.decision, input.contractId);
  if (external.kind === "unavailable") {
    return state === null
      ? { kind: "assembled", state: null, preparation: { kind: "unavailable" } }
      : { kind: "stale" };
  }
  if (state === null) return { kind: "stale" };
  if (external.witness.head !== state.head) return { kind: "stale" };
  const derivation = input.deriveDocument(state);
  if (derivation.verification.kind === "refused") {
    return {
      kind: "assembled",
      state,
      derivation,
      preparation: { kind: "refused", document: derivation.document, refusal: derivation.verification.refusal },
    };
  }
  const artifacts = external.artifacts;
  if (artifacts.kind === "defer")
    return await completeDeferredDelivery(input, state, derivation, observation.journals.get(state.id)?.entries ?? []);
  if (artifacts.kind === "refused") {
    return {
      kind: "assembled",
      state,
      derivation,
      preparation: { kind: "refused", document: derivation.document, refusal: artifacts.refusal },
    };
  }
  if (!sameWorktreeWitness(artifacts.worktree, await recaptureDeliveryWorktree(input, state))) {
    return { kind: "stale" };
  }
  if (artifacts.kind === "reuse") {
    return reusesCurrentCandidate(input, state, derivation, artifacts.worktree.changeId)
      ? { kind: "assembled", state, derivation, reuse: true }
      : { kind: "stale" };
  }
  if (artifacts.kind === "continuation") {
    const delivery = state.delivery;
    if (delivery === null) return { kind: "stale" };
    return {
      kind: "assembled",
      state,
      derivation,
      preparation: { kind: "prepared", document: derivation.document, data: delivery.data },
      continuation: true,
    };
  }
  return {
    kind: "assembled",
    state,
    derivation,
    preparation: { kind: "prepared", document: derivation.document, data: artifacts.data },
    ...(artifacts.reusedIntegration === undefined ? {} : { reusedIntegration: artifacts.reusedIntegration }),
  };
}

/**
 * Complete a preparation the outside phase could not settle. A requested conflict materialization
 * must retire its owned handoff and then capture the worktree that follows, so it only runs under
 * this custody; an unchanged candidate may still be reused before that materialization.
 */
async function completeDeferredDelivery(
  input: DeliverOperationInput,
  state: ContractState,
  derivation: DocumentDerivation,
  journal: readonly JournalEntry[],
): Promise<AssembledDelivery> {
  if (input.materializeConflict !== true || state.terminal !== null) return { kind: "assembled", state, derivation };
  const worktree = await recaptureDeliveryWorktree(input, state);
  if (worktree !== undefined && reusesCurrentCandidate(input, state, derivation, worktree.changeId)) {
    return { kind: "assembled", state, derivation, reuse: true };
  }
  const materialization = await materializationMergeStateRefusal(input);
  if (materialization !== undefined) {
    return {
      kind: "assembled",
      state,
      derivation,
      preparation: { kind: "refused", document: derivation.document, refusal: materialization },
    };
  }
  const prepared = await mechanicalDeliveryPreparation(input, state, derivation, journal);
  return {
    kind: "assembled",
    state,
    derivation,
    ...(prepared.kind !== "prepared" || prepared.reusedIntegration === undefined
      ? {}
      : { reusedIntegration: prepared.reusedIntegration }),
    preparation:
      prepared.kind === "prepared"
        ? { kind: "prepared", document: derivation.document, data: prepared.data }
        : prepared,
  };
}

function reusesCurrentCandidate(
  input: DeliverOperationInput,
  state: ContractState,
  derivation: DocumentDerivation,
  changeId: ChangeId,
): boolean {
  return (
    input.overwrite !== true &&
    state.terminal === null &&
    state.delivery !== null &&
    derivation.verification.kind === "prepared" &&
    derivation.verification.data !== null &&
    currentVerifiedAttestation(state) === undefined &&
    state.delivery.data.integration.changeId === changeId
  );
}

/** Accept a delivery whose current candidate is already admitted, without admitting it again. */
function currentCandidateDeliveryDecision(
  input: DeliverOperationInput,
  observation: GitDecisionObservation,
  assembled: Extract<AssembledDelivery, { kind: "assembled" }>,
): AttemptDecision<DeliverValue, DeliverOperationRefusal> | undefined {
  const state = assembled.state;
  if (state === null || assembled.derivation === undefined || assembled.reuse !== true) return undefined;
  const record = observation.journals.get(input.contractId);
  const delivery = record?.entries.findLast((entry) => entry.kind === "deliver");
  if (record === undefined || delivery === undefined) throw new Error("current delivery is missing its journal fact");
  input.progress?.recordAdmission({ kind: "accepted", facts: [], state, journal: record.entries });
  return {
    kind: "accepted",
    facts: [],
    state,
    journal: record.entries,
    value: {
      ...state.delivery!.data,
      leading: { kind: "already-admitted", fact: delivery.entry },
    },
  };
}

/** Continue the admitted integration this worktree already carries, without a new offer. */
function continuationDeliveryDecision(
  input: DeliverOperationInput,
  observation: GitDecisionObservation,
  assembled: Extract<AssembledDelivery, { kind: "assembled" }>,
): AttemptDecision<DeliverValue, DeliverOperationRefusal> {
  const record = observation.journals.get(input.contractId);
  const state = record?.state ?? null;
  if (record === undefined || state === null || state.delivery === null || assembled.derivation === undefined) {
    return { kind: "redecide" };
  }
  const delivery = record.entries.findLast((entry) => entry.kind === "deliver");
  if (delivery === undefined) throw new Error("current delivery is missing its journal fact");
  input.progress?.recordAdmission({ kind: "accepted", facts: [], state, journal: record.entries });
  return {
    kind: "accepted",
    facts: [],
    state,
    journal: record.entries,
    value: {
      ...state.delivery.data,
      leading: { kind: "already-admitted", fact: delivery.entry },
    },
  };
}

async function decideAndAdmitDelivery(
  input: DeliverOperationInput,
  attempt: AttemptContext,
  seat: PrivateStatePublicationSeat,
  observation: GitDecisionObservation,
  assembled: Extract<AssembledDelivery, { kind: "assembled" }>,
): Promise<AttemptDecision<DeliverValue, DeliverOperationRefusal>> {
  const current = currentCandidateDeliveryDecision(input, observation, assembled);
  if (current !== undefined) return current;
  if (assembled.continuation === true) return continuationDeliveryDecision(input, observation, assembled);
  const preparation = assembled.preparation ?? STALE_PRIVATE_STATE_PREPARATION;
  if (preparation.kind === "stale") return preparation;
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
  const admission = await admitDecidedOffer({ ...input, seat, observation, attempt, offer: decision.offer });
  if (admission.kind !== "accepted") return admission;
  const deliverFact = admission.facts.find((fact) => fact.contract === input.contractId && fact.kind === "deliver");
  if (deliverFact?.kind !== "deliver") throw new Error("confirmed delivery requires its own receipt");
  const previousChange = assembled.state?.delivery?.data.integration.changeId;
  const currentChange = preparation.data.integration.changeId;
  return {
    ...admission,
    value: {
      ...preparation.data,
      leading: {
        kind: "admitted-now",
        fact: deliverFact.entry,
        ...(assembled.reusedIntegration === undefined ? {} : { reusedIntegration: assembled.reusedIntegration }),
      },
      ...(previousChange === undefined || previousChange === currentChange
        ? {}
        : {
            contentChange: {
              kind: "candidate-content-changed" as const,
              ...(assembled.state?.coordinates.target === undefined
                ? {}
                : { target: assembled.state.coordinates.target }),
              previousChange,
              currentChange,
            },
          }),
    },
  };
}

/**
 * One delivery attempt: the repeatable physical preparation happens outside custody, then a single
 * in-custody observation, witness validation, assembly, decision, and atomic publication.
 */
async function deliverAttempt(
  input: DeliverOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<DeliverValue, DeliverOperationRefusal>> {
  const external = await prepareExternalDelivery(input);
  return await privateStateSeatAttempt(
    input.scope,
    async (seat) => {
      const observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
      const assembled = await assembleDeliveryAttempt(input, observation, external);
      if (assembled.kind === "stale") return STALE_PRIVATE_STATE_PREPARATION;
      return await decideAndAdmitDelivery(input, attempt, seat, observation, assembled);
    },
    protocolSeatClose,
  );
}

function isIntegrationConflict(refusal: DeliverOperationRefusal): refusal is IntegrationConflictRefusal {
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
): Promise<LeadingOutcome<DeliverValue, DeliverOperationRefusal> | IntegrationConflictMaterialized> {
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
    handoffBase: handoffHead,
    recovery: DELIVER_CONFLICT_RECOVERY,
  };
}

async function finishDeliverRefusal(
  input: DeliverOperationInput,
  refusal: DeliverOperationRefusal,
): Promise<LeadingOutcome<DeliverValue, DeliverOperationRefusal> | IntegrationConflictMaterialized> {
  if (!isIntegrationConflict(refusal)) return { kind: "refused", refusal };
  if (input.materializeConflict !== true) return { kind: "refused", refusal: conflictDeliverRefusal(refusal) };
  return await materializeDeliverConflict(input, refusal);
}

export async function admitDeliveryOperation(
  input: DeliverOperationInput,
): Promise<LeadingOutcome<DeliverValue, DeliverOperationRefusal> | IntegrationConflictMaterialized> {
  const result = await runBoundedAttempts<
    Extract<AttemptDecision<DeliverValue, DeliverOperationRefusal>, { kind: "accepted" }>,
    DeliverOperationRefusal
  >(mintAttempts({ entryCount: 1 }), (attempt) => deliverAttempt(input, attempt));
  if (result.kind === "refused") return await finishDeliverRefusal(input, result.refusal);
  if (result.kind !== "accepted") return { kind: "retry", reason: result };
  input.progress?.recordResidue(input.contractId, result);
  return result;
}
