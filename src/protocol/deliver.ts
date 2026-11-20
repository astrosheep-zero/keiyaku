import { z } from "zod";
import { attestedVerificationSnapshots, VERIFIED } from "../verification/declaration.js";
import { gitObjectIdForSnapshot, snapshotIdSchema } from "../git/identity.js";
import { compactDelivery, type DeliveryIdentity } from "./result-leaves.js";
import { conflictRecoverySchema, worktreeWorkspaceSchema } from "../git/workspace.js";
import {
  materializeIntegrationSnapshot,
  materializeJudgedConflict,
  planIntegration,
  reusableIntegrationSnapshot,
  worktreeChangeId,
  type IntegrationPreparationRefusal,
} from "../git/integration.js";
import {
  captureTender,
  dirtyTenderRefusal,
  materializeTenderSnapshot,
  prepareDeliveryCommitMetadata,
  type DirtyWorkspaceRefusal,
  type TenderCapture,
} from "../git/tender.js";
import {
  consumeConflictHandoff,
  installConflictHandoffBase,
  observeConflictHandoff,
  recordConflictHandoff,
  retireConflictHandoff,
  witnessConflictHandoff,
  workspaceMergeStatePresent,
  worktreePath,
  conflictRecovery,
  type ConflictHandoffWitness,
} from "../git/workspace.js";
import { contractJournal, observeContractsAt, type ContractReadView } from "../git/observe.js";
import {
  preparationIsCurrent,
  preparationAssertions,
  privateStateSeatAttempt,
  runBoundedAttempts,
  spentPreparation,
  type ProtocolResult,
  type SpentPreparation,
} from "./run.js";
import type { PrivateStatePublicationSeat } from "../git/private-state-seat.js";
import { contractState } from "../core/facts/observation.js";
import { observeTarget, type TargetObservation, type TargetWorkspaceRefusal } from "../git/target.js";
import { acquireTargetPlacementFence } from "../git/target-placement.js";
import { currentBranch, readRef } from "../git/repository.js";
import type { GitRepository } from "../git/process.js";
import type {
  ChangeId,
  ContractHead,
  ContractId,
  ContractState,
  DeliverData,
  JournalEntry,
  SnapshotId,
} from "../core/facts/types.js";
import { decideDeliver, matchingDelivery, type DeliverInput, type DeliverRefusal } from "../core/verbs/deliver.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission } from "./attempt.js";
import type { AttemptContext } from "../core/decide.js";
import { readPlaceRegister, type ManagedWorktreeAppointment } from "../workspace-place.js";
import { timestamp, type MutationOperationInput } from "./operations.js";

/** Known prospective and delivered integrations, newest first, without giving Git producer vocabulary. */
export function deliveryIntegrationSnapshots(journal: readonly JournalEntry[]): readonly SnapshotId[] {
  return journal
    .flatMap((entry) => {
      if (entry.kind === "deliver") return [entry.data.integration.snapshot];
      if (entry.kind === "reintegrated") return [entry.data.snapshot];
      if (entry.kind === "attestation") return attestedVerificationSnapshots(entry.data);
      return [];
    })
    .reverse();
}
export const materializedConflictSchema = z
  .object({
    kind: z.literal("integration-conflict-materialized"),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(z.string().refine((value) => value.trim() !== "")).readonly(),
    workspace: worktreeWorkspaceSchema,
    handoffBase: snapshotIdSchema,
    recovery: conflictRecoverySchema,
  })
  .strict()
  .readonly();
export type IntegrationConflictMaterialized = z.infer<typeof materializedConflictSchema>;

type DeliverOperationInput = MutationOperationInput &
  Readonly<{
    deriveDocument: (state: ContractState) => import("./operations.js").DocumentDerivation;
    message?: string;
    requireBranchesToBeUpToDate: boolean;
    includeDirty: boolean;
    materializeConflict: boolean;
    overwrite?: boolean;
    signal?: AbortSignal;
  }>;

export type MechanicalPreparationRefusal =
  | TargetWorkspaceRefusal
  | DirtyWorkspaceRefusal
  | IntegrationPreparationRefusal
  | Readonly<{ kind: "worktree-missing" }>
  | Readonly<{ kind: "target-missing" }>;
type IntegrationConflictRefusal = Extract<IntegrationPreparationRefusal, { reason: "conflict" }>;
type DeliveryFailure =
  | MechanicalPreparationRefusal
  | Readonly<{ kind: "merge-state-present"; worktreePath: string }>
  | import("../verification/declaration.js").VerificationDeclarationRefusal;
type DeliverOperationRefusal = Exclude<DeliverRefusal, { kind: "document-moved" }> | DeliveryFailure;
type DeliveryDecision = DeliverInput<DeliveryFailure>;
type DeliveryResult =
  | Exclude<ProtocolResult<DeliverOperationRefusal>, AcceptedAdmission>
  | (Omit<AcceptedAdmission, "facts"> & Readonly<{ value: DeliveryIdentity }>);

type DeliveryStage = Readonly<{
  contractId: ContractId;
  coordinates: ContractState["coordinates"];
  recordedIntegrations?: readonly SnapshotId[];
  appointment?: Extract<ManagedWorktreeAppointment, { kind: "appointed" }>;
}>;
type DeliveryOptions = Readonly<{
  title: string;
  document: string;
  message?: string;
  requireBranchesToBeUpToDate?: boolean;
  includeDirty?: boolean;
  holdIntegration?: (snapshot: SnapshotId) => Promise<void>;
}>;
type DeliveryHints = Readonly<{
  changeId?: ChangeId | undefined;
  targetObservation?: TargetObservation | undefined;
}>;
type DeliveryTender = TenderCapture & Readonly<{ ownedHandoff: boolean }>;

function unauthorizedTender(tender: TenderCapture, includeDirty?: boolean): boolean {
  return (
    ((tender.dirty || tender.mergeHead !== undefined) && includeDirty !== true) || tender.changes.submodules.length > 0
  );
}

async function prepareCapturedDelivery(
  repository: GitRepository,
  stage: DeliveryStage,
  input: DeliveryOptions,
  tender: DeliveryTender,
  hints: DeliveryHints = {},
): Promise<
  | { kind: "prepared"; data: DeliverData }
  | { kind: "refused"; refusal: MechanicalPreparationRefusal; tenderSnapshot: SnapshotId }
> {
  const { contractId, coordinates } = stage;
  let { changeId } = hints;
  const requireBranchesToBeUpToDate = input.requireBranchesToBeUpToDate ?? false;
  const targetless = coordinates.target === undefined;
  const { holdIntegration } = input;
  const holdTenderEarly = holdIntegration !== undefined && targetless;
  // Decide reuse before minting or pinning when the tender could itself be the integration.
  const reuse = (tree: typeof tender.tree, predecessor: SnapshotId) =>
    reusableIntegrationSnapshot(
      repository,
      tree,
      targetless && tender.dirty ? tender.head : predecessor,
      stage.recordedIntegrations ?? [],
    );
  const existingTargetlessIntegration = async () =>
    (await reuse(tender.tree, coordinates.start)) ??
    (tender.dirty || tender.mergeHead !== undefined ? undefined : tender.head);
  const earlyIntegration = holdTenderEarly ? await existingTargetlessIntegration() : undefined;
  if (earlyIntegration !== undefined) await holdIntegration?.(earlyIntegration);
  const commit = await prepareDeliveryCommitMetadata(repository, {
    contractId,
    title: input.title,
    document: input.document,
    at: tender.at,
    ...(input.message === undefined ? {} : { message: input.message }),
  });
  const tenderSnapshot = await materializeTenderSnapshot(repository, tender, commit);
  if (holdTenderEarly && earlyIntegration === undefined) await holdIntegration(tenderSnapshot);
  const integration = await planIntegration(
    repository,
    { coordinates },
    { ...tender, head: tender.ownedHandoff ? tenderSnapshot : tender.head },
    requireBranchesToBeUpToDate,
    hints.targetObservation,
  );
  if (integration.kind === "refused") return { ...integration, tenderSnapshot };
  changeId ??= await worktreeChangeId(repository, stage, tender);
  // A targetless dirty integration is the captured tender, whose sole parent is the worktree head.
  const reusedIntegration = holdTenderEarly
    ? earlyIntegration
    : await reuse(integration.data.tree, integration.data.predecessor);
  const integrationSnapshot =
    reusedIntegration ??
    (targetless
      ? tenderSnapshot
      : await materializeIntegrationSnapshot(repository, integration.data.tree, integration.data.predecessor, commit));
  if (!holdTenderEarly) await holdIntegration?.(integrationSnapshot);
  return {
    kind: "prepared",
    data: {
      ...(input.message === undefined ? {} : { note: input.message }),
      tenderSnapshot,
      integration: { predecessor: integration.data.predecessor, snapshot: integrationSnapshot, changeId },
      method: "squash",
      policy: { requireBranchesToBeUpToDate },
    },
  };
}

export async function prepareDelivery(
  repository: GitRepository,
  stage: DeliveryStage,
  input: DeliveryOptions,
): Promise<{ kind: "prepared"; data: DeliverData } | { kind: "refused"; refusal: MechanicalPreparationRefusal }> {
  const { contractId, coordinates } = stage;
  const place =
    coordinates.workspace === "worktree"
      ? (stage.appointment?.place ?? (await readPlaceRegister(repository)).get(contractId))
      : undefined;
  const tender = await captureTender(repository, {
    contractId,
    coordinates,
    captureMergeState: true,
    ...(place === undefined ? {} : { place }),
  });
  if (tender.kind === "refused") return tender;
  if (unauthorizedTender(tender.data, input.includeDirty))
    return { kind: "refused", refusal: dirtyTenderRefusal(tender.data) };
  const { head, mergeHead } = tender.data;
  const ownedHandoff =
    coordinates.target !== undefined &&
    place !== undefined &&
    mergeHead !== undefined &&
    (
      await observeConflictHandoff(
        repository,
        { contractId, place, workspace: worktreePath(repository, place) },
        { head, mergeHead },
      )
    ).kind === "active";
  const prepared = await prepareCapturedDelivery(repository, stage, input, { ...tender.data, ownedHandoff });
  return prepared.kind === "refused" ? { kind: "refused", refusal: prepared.refusal } : prepared;
}

type ConflictHandoff = Readonly<{
  place: string;
  path: string;
  previousHead: SnapshotId;
  handoffBase: SnapshotId;
}>;

type DeliveryInvocationCapture = Readonly<{
  tender: DeliveryTender;
  place: string;
  path: string;
  handoff?: ConflictHandoffWitness;
}>;

type CapturedDeliveryPreparation = Readonly<{
  preparation: DeliveryDecision["preparation"];
  handoff?: ConflictHandoff;
}>;

/**
 * Capture the invocation's immutable worktree bytes once, outside custody. Later fresh attempts
 * reuse these exact bytes and never recapture the mutable worktree.
 */
async function captureDeliveryInvocation(
  input: DeliverOperationInput,
  state: ContractState,
): Promise<DeliveryInvocationCapture | Readonly<{ kind: "refused"; refusal: DeliveryFailure }>> {
  const { scope, contractId } = input;
  const { coordinates } = state;
  const place = coordinates.workspace === "worktree" ? (await readPlaceRegister(scope)).get(contractId) : undefined;
  if (place === undefined) return { kind: "refused", refusal: { kind: "worktree-missing" } };
  const captured = await captureTender(scope, { contractId, coordinates, place, captureMergeState: true });
  if (captured.kind === "refused") return { kind: "refused", refusal: captured.refusal };
  let tender: DeliveryTender = { ...captured.data, ownedHandoff: false };
  const path = worktreePath(scope, place);
  if (input.materializeConflict) {
    const retirement = await retireConflictHandoff(scope, {
      contractId,
      place,
      workspace: path,
      consumeUnconsumed: true,
    });
    if (retirement.kind === "retained" || (await workspaceMergeStatePresent(scope, path))) {
      return { kind: "refused", refusal: { kind: "merge-state-present", worktreePath: path } };
    }
    // Retirement changes operation metadata only; the captured tree and change identity still apply.
    const { mergeHead: _retired, ...withoutMerge } = captured.data;
    tender = { ...withoutMerge, ownedHandoff: false };
  }
  if (unauthorizedTender(tender, input.includeDirty)) {
    return { kind: "refused", refusal: dirtyTenderRefusal(tender) };
  }
  const { head, mergeHead } = tender;
  const ownership =
    coordinates.target !== undefined && mergeHead !== undefined
      ? await witnessConflictHandoff(scope, { contractId, place, workspace: path }, { head, mergeHead })
      : ({ kind: "unowned" } as const);
  return {
    tender: { ...tender, ownedHandoff: ownership.kind === "owned" },
    place,
    path,
    ...(ownership.kind === "owned" && ownership.witness !== undefined ? { handoff: ownership.witness } : {}),
  };
}

/** Prepare one attempt's decision data from the immutable invocation capture and fresh authority. */
async function prepareCapturedDeliveryAttempt(
  input: DeliverOperationInput,
  state: ContractState,
  captured: DeliveryInvocationCapture,
  journal: readonly JournalEntry[],
  targetObservation: TargetObservation | undefined,
): Promise<CapturedDeliveryPreparation> {
  const { scope, contractId } = input;
  const { coordinates } = state;
  const { title, bytes: document, document: key, verification } = input.deriveDocument(state);
  const refuse = (refusal: DeliveryFailure) => ({ preparation: { kind: "refused" as const, document: key, refusal } });
  if (state.terms.gates.includes(VERIFIED) && verification.kind === "refused") return refuse(verification.refusal);
  const { tender } = captured;
  let changeId: ChangeId | undefined;
  if (!input.overwrite && state.delivery !== null) {
    changeId = await worktreeChangeId(scope, { coordinates }, tender);
    const delivery = matchingDelivery(state, changeId, input.overwrite);
    if (delivery !== undefined) return { preparation: { kind: "reuse", document: key, delivery } };
  }
  const prepared = await prepareCapturedDelivery(
    scope,
    { contractId, coordinates, recordedIntegrations: deliveryIntegrationSnapshots(journal) },
    {
      title,
      document,
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
      ...(input.message === undefined ? {} : { message: input.message }),
    },
    tender,
    { changeId, targetObservation },
  );
  if (prepared.kind === "prepared") return { preparation: { ...prepared, document: key } };
  const result = refuse(prepared.refusal);
  if (
    !input.materializeConflict ||
    prepared.refusal.kind !== "integration-failed" ||
    prepared.refusal.reason !== "conflict"
  )
    return result;
  return {
    ...result,
    handoff: {
      place: captured.place,
      path: captured.path,
      previousHead: tender.head,
      handoffBase: prepared.tenderSnapshot,
    },
  };
}

type DeliveryAdmission = Readonly<{
  seat: PrivateStatePublicationSeat;
  observation: ContractReadView;
  capture: DeliveryInvocationCapture | undefined;
  prepared: CapturedDeliveryPreparation | undefined;
  expectedRef: TargetObservation | undefined;
  attempt: AttemptContext;
}>;

async function admitCapturedDelivery(
  input: DeliverOperationInput,
  { seat, observation, capture, prepared, expectedRef, attempt }: DeliveryAdmission,
): Promise<DeliveryResult | SpentPreparation> {
  const { scope, contractId } = input;
  const state = contractState(observation.decision, contractId);
  const preparation = prepared?.preparation ?? { kind: "unavailable" };
  const decision = decideDeliver({
    input: {
      contractId,
      at: timestamp(),
      preparation,
      ...(expectedRef?.kind === "refused" ? { destinationRefusal: expectedRef.refusal } : {}),
    },
    attempt,
    observation: observation.decision,
  });
  if (decision.kind === "refused") {
    return decision.refusal.kind === "document-moved"
      ? spentPreparation
      : { kind: "refused", refusal: decision.refusal };
  }
  if (decision.kind === "reuse") {
    if (state === null) throw new Error("reused delivery has no observed Contract");
    const { delivery } = decision;
    const { entries: journal } = contractJournal(observation.journals, contractId);
    input.progress?.recordDeliveryReuse({ state, journal }, delivery);
    const value = compactDelivery(
      { ...delivery.data, integration: state.currentIntegration ?? delivery.data.integration },
      true,
    );
    return { kind: "accepted", state, journal, value };
  }
  const handoff = capture?.handoff;
  const admission = await admitDecidedOffer({
    ...input,
    seat,
    observation,
    attempt,
    offer: decision.offer,
    assertions: preparationAssertions(expectedRef),
    ...(capture === undefined || handoff === undefined
      ? {}
      : {
          prepareRefCompanion: async () => {
            const result = await consumeConflictHandoff(
              scope,
              { contractId, place: capture.place, workspace: capture.path },
              handoff,
            );
            return result.kind === "skip"
              ? { kind: "none" as const }
              : { kind: "companion" as const, update: result.update };
          },
        }),
  });
  if (admission.kind !== "accepted") return admission;
  const fact = admission.facts.find((entry) => entry.contract === contractId && entry.kind === "deliver");
  if (fact?.kind !== "deliver") throw new Error("confirmed delivery requires its own receipt");
  const previousContentId = state?.delivery?.data.integration.changeId;
  const value = compactDelivery(
    fact.data,
    false,
    previousContentId === fact.data.integration.changeId ? undefined : previousContentId,
  );
  return { kind: "accepted", state: admission.state, journal: admission.journal, value };
}

type PreparedDelivery = Readonly<{
  expectedHead: ContractHead | null;
  expectedRef?: TargetObservation;
  prepared: CapturedDeliveryPreparation | undefined;
}>;

type ConflictProjection =
  | Readonly<{ kind: "refused"; refusal: DeliverOperationRefusal }>
  | IntegrationConflictMaterialized
  | SpentPreparation;

async function projectConflict(
  input: DeliverOperationInput,
  handoff: ConflictHandoff,
  conflict: IntegrationConflictRefusal,
): Promise<ConflictProjection> {
  const { scope, contractId } = input;
  const { place, path, previousHead, handoffBase } = handoff;
  if (await workspaceMergeStatePresent(scope, path)) {
    return { kind: "refused", refusal: { kind: "merge-state-present", worktreePath: path } };
  }
  if (
    (await currentBranch(scope, path)) !== null ||
    (await readRef({ ...scope, effectiveCwd: path }, "HEAD")) !== gitObjectIdForSnapshot(previousHead)
  ) {
    return spentPreparation;
  }
  if (previousHead !== handoffBase) await installConflictHandoffBase(scope, path, previousHead, handoffBase);
  await recordConflictHandoff(scope, {
    contractId,
    place,
    workspace: path,
    head: handoffBase,
    mergeHead: conflict.targetHead,
  });
  if (!(await materializeJudgedConflict(scope, path, conflict.targetHead))) {
    // The native merge refused before creating a live operation. Retire the reservation through the
    // same handoff owner that recovers receipts without operations, and report the judged conflict
    // without claiming a materialization that did not happen.
    await retireConflictHandoff(scope, { contractId, place, workspace: path, consumeUnconsumed: true });
    return { kind: "refused", refusal: conflict };
  }
  return {
    kind: "integration-conflict-materialized",
    targetHead: conflict.targetHead,
    conflictPaths: conflict.conflictPaths,
    workspace: { kind: "worktree", path },
    handoffBase,
    recovery: conflictRecovery,
  };
}

async function attemptDelivery(
  input: DeliverOperationInput,
  capture: DeliveryInvocationCapture | undefined,
  { expectedHead, expectedRef, prepared }: PreparedDelivery,
  attempt: AttemptContext,
): Promise<DeliveryResult | IntegrationConflictMaterialized | SpentPreparation> {
  const { scope, channel, contractId } = input;
  const seated = await privateStateSeatAttempt<DeliveryResult | SpentPreparation>(scope, async (seat) => {
    const observation = await observeContractsAt(scope, channel, [contractId]);
    if (!(await preparationIsCurrent(scope, observation, contractId, expectedHead, expectedRef)))
      return spentPreparation;
    return await admitCapturedDelivery(input, {
      seat,
      observation,
      capture,
      prepared,
      expectedRef,
      attempt,
    });
  });
  if (seated.kind !== "refused" || prepared?.handoff === undefined) return seated;
  const { refusal } = seated;
  return refusal.kind === "integration-failed" && refusal.reason === "conflict"
    ? await projectConflict(input, prepared.handoff, refusal)
    : seated;
}

export async function admitDeliveryOperation(input: DeliverOperationInput) {
  const { scope, channel, contractId } = input;
  const incoming = input.materializeConflict ? await acquireTargetPlacementFence(scope, contractId) : undefined;
  try {
    const initial = await observeContractsAt(scope, channel, [contractId]);
    const initialState = contractState(initial.decision, contractId);
    const captured =
      initialState === null || initialState.terminal !== null
        ? undefined
        : await captureDeliveryInvocation(input, initialState);
    if (captured !== undefined && "kind" in captured) return captured;
    const capture: DeliveryInvocationCapture | undefined = captured;
    const result = await runBoundedAttempts<
      PreparedDelivery,
      DeliveryResult | IntegrationConflictMaterialized,
      DeliverOperationRefusal
    >(
      mintAttempts({ entryCount: 1 }),
      async () => {
        const before = await observeContractsAt(scope, channel, [contractId]);
        const state = contractState(before.decision, contractId);
        const target = state?.terminal === null ? state.coordinates.target : undefined;
        const expectedRef = target === undefined ? undefined : await observeTarget(scope, target);
        if (state === null || state.terminal !== null) {
          return {
            kind: "prepared",
            prepared: {
              expectedHead: state?.head ?? null,
              ...(expectedRef === undefined ? {} : { expectedRef }),
              prepared: undefined,
            },
          };
        }
        if (capture === undefined) return spentPreparation;
        const prepared = await prepareCapturedDeliveryAttempt(
          input,
          state,
          capture,
          contractJournal(before.journals, contractId).entries,
          expectedRef,
        );
        return {
          kind: "prepared",
          prepared: {
            expectedHead: state.head,
            ...(expectedRef === undefined ? {} : { expectedRef }),
            prepared,
          },
        };
      },
      async (prepared, attempt) => await attemptDelivery(input, capture, prepared, attempt),
    );
    if (result.kind === "accepted") {
      input.progress?.recordResidue(contractId, result);
      return result;
    }
    if (result.kind === "refused" || result.kind === "integration-conflict-materialized") return result;
    return { kind: "retry" as const, reason: result };
  } finally {
    incoming?.close();
  }
}
