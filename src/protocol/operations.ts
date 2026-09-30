import { contractIdSchema, snapshotIdSchema, changeIdSchema } from "../git/identity.js";
export { contractIdSchema, snapshotIdSchema, changeIdSchema } from "../git/identity.js";
export { entryUlidSchema } from "./attempt.js";
import { targetInputRefusalSchema, forkSourceMovedRefusalSchema } from "./bind.js";
import { z } from "zod";
import { gate } from "../core/facts/types.js";
import {
  worktreeMissingRefusalSchema,
  unmergedPathsRefusalSchema,
  dirtyWorkspaceRefusalSchema,
} from "../git/tender.js";
import { integrationPreparationRefusalSchema } from "../git/integration.js";
import { checkoutNotFollowableRefusalSchema } from "../git/target-placement.js";
import { conflictRecoverySchema, worktreeWorkspaceSchema } from "../git/workspace.js";
import { protocolTerminalSchema } from "./run.js";
import { verificationRuntimeStopSchema } from "./intent.js";
export const gateSchema = z.string().transform((value, context) => {
  try {
    return gate(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid gate" });
    return z.NEVER;
  }
});
export const deliverDataSchema = z
  .object({
    tenderSnapshot: snapshotIdSchema,
    integration: z
      .object({ predecessor: snapshotIdSchema, snapshot: snapshotIdSchema, changeId: changeIdSchema })
      .strict(),
    method: z.literal("squash"),
    policy: z.object({ requireBranchesToBeUpToDate: z.boolean() }).strict(),
  })
  .strict();
export const verdictSchema = z.enum(["satisfied", "unsatisfied"]);
export const activeContractRefusalSchema = z
  .object({ kind: z.enum(["contract-missing", "terminal"]), contractId: contractIdSchema })
  .strict();
export const bindRefusalSchema = z
  .object({ kind: z.enum(["contract-exists", "invalid-after", "unknown-prerequisite"]), contractId: contractIdSchema })
  .strict();
export const amendRefusalSchema = z
  .object({
    kind: z.enum(["contract-missing", "terminal", "terms-moved", "unknown-prerequisite", "cyclic-prerequisite"]),
    contractId: contractIdSchema,
  })
  .strict();
export const deliverRefusalSchema = z
  .object({ kind: z.enum(["contract-missing", "terminal", "document-moved"]), contractId: contractIdSchema })
  .strict();
export const verificationDeclarationRefusalSchema = z
  .object({ kind: z.literal("verification-declaration-invalid"), contractId: contractIdSchema.optional() })
  .strict();
const staleGateReasonSchema = z
  .object({
    kind: z.literal("candidate-content-changed"),
    target: z.string().optional(),
    previousChange: changeIdSchema,
    currentChange: changeIdSchema,
  })
  .strict();
export const gateReportSchema = z
  .object({
    gate: gateSchema,
    current: z.union([
      z.object({ kind: z.literal("missing") }).strict(),
      z
        .object({ kind: z.literal("attested"), verdict: verdictSchema, at: z.string(), summary: z.string().optional() })
        .strict(),
      z
        .object({ kind: z.literal("stale"), priorVerdict: verdictSchema, reason: staleGateReasonSchema.optional() })
        .strict(),
    ]),
  })
  .strict();
export const placementRefusalSchema = z.union([
  z
    .object({ kind: z.enum(["contract-missing", "delivery-missing", "terminal"]), contractId: contractIdSchema })
    .strict(),
  z
    .object({
      kind: z.literal("gates-unsatisfied"),
      contractId: contractIdSchema,
      unmet: z.array(gateReportSchema).readonly(),
      target: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prerequisites-unsatisfied"),
      contractId: contractIdSchema,
      unmet: z
        .array(z.object({ contractId: contractIdSchema, state: z.enum(["missing", "active", "abandoned"]) }).strict())
        .readonly(),
    })
    .strict(),
]);
import type { ProtocolProgress } from "./progress.js";
import { readDeliveryDiff } from "../git/integration.js";
import { currentBranch, observeContractAt } from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import { repositoryAt } from "../git/repository.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import type { WorktreeLeak } from "../git/scratch.js";
import type { AttestationRefusal } from "../core/verbs/attestation.js";
import type { ContractId, ContractState, DeliverData, DocumentKey, SnapshotId } from "../core/facts/types.js";
import type { IntegrationPreparationRefusal } from "../git/integration.js";
import type { VerificationCleanupFailure, VerificationResult } from "./intent.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import {
  appendPrivateStateSeatClose,
  concatenatePrivateStateSeatClose,
  mergePrivateStateSeatClose,
  type PrivateStateSeatCloseLag,
  type PrivateStateSeatOutcome,
} from "../git/private-state-seat.js";
import type { PlacementProtocolResult } from "./placement.js";
import type { AcceptedAdmission, DecidedOfferResult } from "./attempt.js";
import type { AcceptedProtocolStep, IntentOutcome as ProtocolIntentOutcome } from "./outcome.js";
import type { ProtocolResult, ProtocolTerminal } from "./run.js";
import { readDocuments, type ContractDocumentProjection } from "./read/documents.js";
import {
  readContractBoard,
  readContractCatalogue,
  readContractObservationAt,
  type ContractBoard,
  type ContractCatalogue,
  type ContractObservation,
} from "./read/status.js";
import { boundedListLimit } from "../bounded-list.js";

export const mergeStatePresentRefusalSchema = z
  .object({ kind: z.literal("merge-state-present"), contractId: contractIdSchema, workspace: worktreeWorkspaceSchema })
  .strict();
export type MergeStatePresentRefusal = z.infer<typeof mergeStatePresentRefusalSchema>;
export type UnmergedPathsRefusal = z.infer<typeof unmergedPathsRefusalSchema>;
export const deliverConflictRefusalSchema = z
  .object({
    kind: z.literal("integration-failed"),
    contractId: contractIdSchema,
    reason: z.literal("conflict"),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(z.string().refine((value) => value.trim() !== "")).readonly(),
    recovery: conflictRecoverySchema,
  })
  .strict();
export type DeliverConflictRefusal = z.infer<typeof deliverConflictRefusalSchema>;
export const targetMissingRefusalSchema = z
  .object({ kind: z.literal("target-missing"), contractId: contractIdSchema })
  .strict();
export const deliveryPreparationRefusalSchema = z.union([
  targetMissingRefusalSchema,
  worktreeMissingRefusalSchema,
  dirtyWorkspaceRefusalSchema,
  unmergedPathsRefusalSchema,
  integrationPreparationRefusalSchema,
  mergeStatePresentRefusalSchema,
  checkoutNotFollowableRefusalSchema,
]);
export type DeliveryPreparationRefusal = z.infer<typeof deliveryPreparationRefusalSchema>;
export const intentRefusalSchema = z.union([
  activeContractRefusalSchema,
  amendRefusalSchema,
  bindRefusalSchema,
  forkSourceMovedRefusalSchema,
  deliverRefusalSchema,
  deliveryPreparationRefusalSchema,
  deliverConflictRefusalSchema,
  placementRefusalSchema,
  targetInputRefusalSchema,
  verificationDeclarationRefusalSchema,
]);
export type IntentRefusal = z.infer<typeof intentRefusalSchema>;

export type IntentRetry = ProtocolTerminal;
export type IntentOutcome<Value, Refusal = IntentRefusal> = ProtocolIntentOutcome<Value, Refusal>;

type OperationInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: import("../core/facts/types.js").ActorId;
}>;
export type MutationOperationInput = OperationInput &
  Readonly<{ channel: GitDecodeChannel; progress?: ProtocolProgress }>;

export type DocumentDerivation = Readonly<{
  document: DocumentKey;
  bytes: string;
  title: string;
  verification: VerificationDeclarationPreparation;
}>;

type StepStop<R> = Readonly<{ refusal: R; retry?: never } | { retry: IntentRetry; refusal?: never }>;
export const verificationStopSchema = z.union([
  z.object({ refusal: z.union([activeContractRefusalSchema, verificationDeclarationRefusalSchema]) }).strict(),
  z.object({ retry: protocolTerminalSchema }).strict(),
  verificationRuntimeStopSchema,
]);
export type VerificationStop = z.infer<typeof verificationStopSchema>;
export const placementStopSchema = z.union([
  z
    .object({
      refusal: z.union([
        placementRefusalSchema,
        checkoutNotFollowableRefusalSchema,
        integrationPreparationRefusalSchema,
        targetMissingRefusalSchema,
      ]),
    })
    .strict(),
  z.object({ retry: protocolTerminalSchema }).strict(),
  z
    .object({
      failure: z.literal("target-placement-failed"),
      diagnostic: z.string().refine((value) => value.trim() !== ""),
    })
    .strict(),
  z
    .object({
      failure: z.literal("target-moved"),
      contractId: contractIdSchema,
      target: z.string().refine((value) => value.trim() !== ""),
      integratedAt: snapshotIdSchema,
      observed: snapshotIdSchema.nullable(),
      attempts: z.number().int(),
      observedTreeEqualsCandidate: z.boolean(),
    })
    .strict(),
  z
    .object({
      failure: z.literal("target-moved"),
      contractId: contractIdSchema,
      target: z.string().refine((value) => value.trim() !== ""),
      expected: snapshotIdSchema,
      observed: snapshotIdSchema.nullable(),
      observedTreeEqualsCandidate: z.boolean(),
    })
    .strict(),
]);
export type PlacementStop = z.infer<typeof placementStopSchema>;
export type AttemptDecision<Value, Refusal = IntentRefusal> =
  | (AcceptedAdmission & Readonly<{ value: Value }>)
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "redecide" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "collision" }>
  | Extract<DecidedOfferResult, { kind: "publication-failed" }>;

export function timestamp(): string {
  return new Date().toISOString();
}

export function attemptDecisionWithSeatClose<Value, Refusal = IntentRefusal>(
  outcome: PrivateStateSeatOutcome<AttemptDecision<Value, Refusal>>,
): AttemptDecision<Value, Refusal> {
  return mergePrivateStateSeatClose(outcome, (value, closeLag: PrivateStateSeatCloseLag) => {
    if (value.kind !== "accepted") throw new Error(closeLag.diagnostic);
    return { ...value, seatClose: appendPrivateStateSeatClose(value.seatClose, closeLag) };
  });
}

export function mergeAdmissions(current: AcceptedProtocolStep, next: AcceptedProtocolStep): AcceptedProtocolStep {
  const effects = [...(current.physical?.effects ?? []), ...(next.physical?.effects ?? [])];
  const lag = [...(current.physical?.lag ?? []), ...(next.physical?.lag ?? [])];
  const seatClose = concatenatePrivateStateSeatClose(current.seatClose, next.seatClose);
  return {
    ...next,
    facts: [...current.facts, ...next.facts],
    ...(effects.length === 0 && lag.length === 0 ? {} : { physical: { effects, lag } }),
    ...(seatClose === undefined ? {} : { seatClose }),
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
  reuse?: VerificationResult["reuse"];
  counts?: NonNullable<VerificationResult["counts"]>;
}> {
  const step = verification.step;
  const stop: VerificationStop | undefined =
    "failure" in step
      ? step
      : "refusal" in step && step.refusal.kind === "verification-reuse"
        ? undefined
        : "kind" in step && step.kind === "reused"
          ? undefined
          : stepStop(step as ProtocolResult<AttestationRefusal>);
  const admission = !("failure" in step) && step.kind === "accepted" ? step : undefined;
  return {
    ...(verification.cleanup === undefined ? {} : { cleanup: verification.cleanup }),
    ...(verification.leak === undefined ? {} : { leak: verification.leak }),
    ...(stop === undefined ? {} : { stop }),
    ...(admission === undefined ? {} : { admission }),
    ...(verification.reuse === undefined ? {} : { reuse: verification.reuse }),
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
  return signal === undefined
    ? scope
    : { ...scope, signal: scope.signal === undefined ? signal : AbortSignal.any([scope.signal, signal]) };
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

export async function contractCatalogueOperation(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    limit?: number;
  }>,
): Promise<ContractCatalogue> {
  const limit = boundedListLimit(input.limit);
  return withGitReadObservation(input.scope, input.channel, (observation) => readContractCatalogue(observation, limit));
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

/** A legitimately absent Contract is `null`; the caller maps absence to its own domain answer. */
export async function stateOperation(input: MutationOperationInput): Promise<ContractState | null> {
  return (await observeContractAt(input.scope, input.channel, input.contractId)).state;
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
