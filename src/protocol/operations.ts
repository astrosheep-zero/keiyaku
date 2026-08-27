import { readDeliveryDiff } from "../git/integration.js";
import type { DirtyWorkspaceRefusal } from "../git/tender.js";
import { currentBranch, observeContractAt } from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import { repositoryAt } from "../git/repository.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import type { WorktreeLeak } from "../git/scratch.js";
import type { AbandonRefusal } from "../core/verbs/abandon.js";
import type { AmendRefusal } from "../core/verbs/amend.js";
import type { ArcRefusal } from "../core/verbs/arc.js";
import type { DeliverRefusal } from "../core/verbs/deliver.js";
import type { PlacementRefusal } from "../core/verbs/placement.js";
import type { AttestationRefusal } from "../core/verbs/attestation.js";
import type { ContractId, ContractState, DeliverData, DocumentKey, SnapshotId } from "../core/facts/types.js";
import type { BindRefusal, ForkSourceMovedRefusal, TargetInputRefusal } from "./bind.js";
import type { IntegrationPreparationRefusal } from "../git/integration.js";
import type { TargetPlacementRefusal } from "../git/target-placement.js";
import type { VerificationCleanupFailure, VerificationRuntimeStop, VerificationResult } from "./intent.js";
import type {
  VerificationDeclarationPreparation,
  VerificationDeclarationRefusal,
} from "../verification/declaration.js";
import type { PlacementProtocolResult } from "./placement.js";
import type { AcceptedAdmission, DecidedOfferResult } from "./attempt.js";
import type { AcceptedProtocolStep, IntentOutcome as ProtocolIntentOutcome } from "./outcome.js";
import type { ProtocolResult, ProtocolTerminal } from "./run.js";
import { readDocuments, type ContractDocumentProjection } from "./read/documents.js";
import {
  readContractBoard,
  readContractObservationAt,
  type ContractBoard,
  type ContractObservation,
} from "./read/status.js";

export type MergeStatePresentRefusal = Readonly<{
  kind: "merge-state-present";
  contractId: ContractId;
  workspace: Readonly<{
    kind: "worktree" | "worktree";
    path: string;
  }>;
}>;

export type UnmergedPathsRefusal = Readonly<{
  kind: "unmerged-paths";
  contractId: ContractId;
  paths: readonly string[];
}>;

export type DeliverConflictRefusal = Readonly<{
  kind: "integration-failed";
  contractId: ContractId;
  reason: "conflict";
  targetHead: SnapshotId;
  conflictPaths: readonly string[];
  recovery: Readonly<{
    materialize: "deliver --materialize-conflict";
    continue: "deliver";
  }>;
}>;

export type DeliveryPreparationRefusal =
  | Readonly<{
      kind: "target-missing" | "worktree-missing";
      contractId: ContractId;
    }>
  | DirtyWorkspaceRefusal
  | UnmergedPathsRefusal
  | IntegrationPreparationRefusal
  | MergeStatePresentRefusal
  | TargetPlacementRefusal;

export type IntentRefusal =
  | AbandonRefusal
  | AmendRefusal
  | ArcRefusal
  | BindRefusal
  | ForkSourceMovedRefusal
  | DeliverRefusal
  | DeliveryPreparationRefusal
  | DeliverConflictRefusal
  | PlacementRefusal
  | AttestationRefusal
  | TargetInputRefusal
  | VerificationDeclarationRefusal;

export type IntentRetry = ProtocolTerminal;
export type IntentOutcome<Value, Refusal = IntentRefusal> = ProtocolIntentOutcome<Value, Refusal>;

type OperationInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: import("../core/facts/types.js").ActorId;
}>;
export type MutationOperationInput = OperationInput & Readonly<{ channel: GitDecodeChannel }>;

export type DocumentDerivation = Readonly<{
  document: DocumentKey;
  bytes: string;
  title: string;
  verification: VerificationDeclarationPreparation;
}>;

type StepStop<R> = Readonly<{ refusal: R; retry?: never } | { retry: IntentRetry; refusal?: never }>;
export type VerificationStop = StepStop<AttestationRefusal | VerificationDeclarationRefusal> | VerificationRuntimeStop;
export type PlacementStop =
  | StepStop<
      | PlacementRefusal
      | TargetPlacementRefusal
      | IntegrationPreparationRefusal
      | Readonly<{ kind: "target-missing"; contractId: ContractId }>
    >
  | Readonly<{
      failure: "target-moved";
      contractId: ContractId;
      target: string;
      expected: SnapshotId;
      observed: SnapshotId | null;
      observedTreeEqualsCandidate: boolean;
    }>
  | Readonly<{
      failure: "target-moved";
      contractId: ContractId;
      target: string;
      integratedAt: SnapshotId;
      observed: SnapshotId | null;
      attempts: number;
      observedTreeEqualsCandidate: boolean;
    }>
  | Readonly<{ failure: "target-placement-failed"; diagnostic: string }>;

export type AttemptDecision<Value, Refusal = IntentRefusal> =
  | (AcceptedAdmission & Readonly<{ value: Value }>)
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "redecide" }>
  | Readonly<{ kind: "collision" }>
  | Extract<DecidedOfferResult, { kind: "publication-failed" }>;

export function timestamp(): string {
  return new Date().toISOString();
}

export function mergeAdmissions(current: AcceptedProtocolStep, next: AcceptedProtocolStep): AcceptedProtocolStep {
  const effects = [...(current.physical?.effects ?? []), ...(next.physical?.effects ?? [])];
  const lag = [...(current.physical?.lag ?? []), ...(next.physical?.lag ?? [])];
  return {
    ...next,
    facts: [...current.facts, ...next.facts],
    ...(effects.length === 0 && lag.length === 0 ? {} : { physical: { effects, lag } }),
  };
}

export function stepStop<Refusal>(result: ProtocolResult<Refusal>): StepStop<Refusal> | undefined {
  if (result.kind === "accepted") return undefined;
  return result.kind === "refused" ? { refusal: result.refusal } : { retry: result };
}

export function unpackVerificationOutcome(verification: VerificationResult): Readonly<{
  cleanup?: VerificationCleanupFailure;
  leak?: WorktreeLeak;
  stop?: VerificationStop;
  admission?: AcceptedProtocolStep;
  counts?: NonNullable<VerificationResult["counts"]>;
}> {
  const step = verification.step;
  const stop = "failure" in step ? step : stepStop(step);
  const admission = !("failure" in step) && step.kind === "accepted" ? step : undefined;
  return {
    ...(verification.cleanup === undefined ? {} : { cleanup: verification.cleanup }),
    ...(verification.leak === undefined ? {} : { leak: verification.leak }),
    ...(stop === undefined ? {} : { stop }),
    ...(admission === undefined ? {} : { admission }),
    ...(verification.counts === undefined ? {} : { counts: verification.counts }),
  };
}

export function placementStop(
  result: PlacementProtocolResult<IntegrationPreparationRefusal>,
): PlacementStop | undefined {
  if (result.kind === "accepted") return undefined;
  if (result.kind === "placement-failed") return { failure: "target-placement-failed", diagnostic: result.diagnostic };
  if (result.kind === "target-moved") {
    const { contractId, target, expected, observed, observedTreeEqualsCandidate } = result;
    return { failure: "target-moved", contractId, target, expected, observed, observedTreeEqualsCandidate };
  }
  return result.kind === "refused" ? { refusal: result.refusal } : { retry: result };
}

export type RepositoryScope = GitRepository;

export function withScopeAbortSignal(scope: RepositoryScope, signal: AbortSignal | undefined): RepositoryScope {
  return signal === undefined ? scope : { ...scope, signal };
}

export async function scopeOperation(
  input: Readonly<{ coordinate: string; gitPath?: string }>,
): Promise<RepositoryScope> {
  return await repositoryAt(input.coordinate, input.gitPath);
}

export async function currentBranchOperation(input: Readonly<{ scope: RepositoryScope }>): Promise<string | null> {
  return await currentBranch(input.scope);
}

export async function contractsOperation(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
  }>,
): Promise<ContractBoard> {
  return withGitReadObservation(input.scope, input.channel, (observation) => readContractBoard(observation));
}

export async function contractObservationOperation(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    contractId: ContractId;
  }>,
): Promise<ContractObservation> {
  return await readContractObservationAt(input.scope, input.channel, input.contractId);
}

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

export async function deliveryOperation(input: MutationOperationInput): Promise<DeliverData | null> {
  const state = (await observeContractAt(input.scope, input.channel, input.contractId)).state;
  if (state === null || state === undefined || state.delivery === null) return null;
  return state.currentIntegration === null
    ? state.delivery.data
    : { ...state.delivery.data, integration: state.currentIntegration };
}

export async function deliveryDiffOperation(
  input: Readonly<{
    scope: RepositoryScope;
    integrationPredecessor: SnapshotId;
    integrationSnapshot: SnapshotId;
  }>,
): Promise<string | null> {
  return await readDeliveryDiff(input.scope, input.integrationPredecessor, input.integrationSnapshot);
}
