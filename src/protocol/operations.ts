import { z } from "zod";
import { boundedListLimit } from "../bounded-list.js";
import type { DecideInput, OfferDecision } from "../core/decide.js";
import type { ActiveContractRefusal } from "../core/facts/observation.js";
import type { ActorId, ContractId, ContractState, DeliverData, DocumentKey } from "../core/facts/types.js";
import { gateReportSchema } from "./result-leaves.js";
export {
  deliverDataSchema,
  gateSchema,
  verdictSchema,
  candidateContentChangeSchema,
  gateCurrentSchema,
  requirementIdSchema,
  requirementReportSchema,
  gateReportSchema,
} from "./result-leaves.js";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import type { IntegrationPreparationRefusal } from "../git/integration.js";
import { integrationPreparationRefusalSchema } from "../git/integration.js";
import { observeContractAt } from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { currentBranch, repositoryAt } from "../git/repository.js";
import type { WorktreeLeak } from "../git/scratch.js";
import { checkoutNotFollowableRefusalSchema } from "../git/target-placement.js";
export { checkoutNotFollowableRefusalSchema } from "../git/target-placement.js";
import { targetWorkspaceRefusalSchema } from "../git/target.js";
import { dirtyWorkspaceRefusalSchema, worktreeMissingRefusalSchema } from "../git/tender.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import type { AcceptedAdmission, DecidedOfferResult } from "./attempt.js";
import { forkSourceMovedRefusalSchema, targetInputRefusalSchema } from "./bind.js";
import { admitIntent, type IntentAdmissionOptions } from "./intent.js";
import type { VerificationResult } from "./intent.js";
import type { VerificationCleanupFailure } from "./progress.js";
import { verificationRuntimeStopSchema } from "./intent.js";
import { complete, type AcceptedProtocolStep, type IntentOutcome as ProtocolIntentOutcome } from "./outcome.js";
import type { PlacementProtocolResult } from "./placement.js";
import type { ProtocolProgress } from "./progress.js";
import { readDocuments, type ContractDocumentProjection } from "./read/documents.js";
import {
  readContractBoard,
  readContractCatalogue,
  readContractObservationAt,
  type ContractBoard,
  type ContractCatalogue,
  type ContractObservation,
} from "./read/status.js";
import type { ProtocolResult, ProtocolTerminal } from "./run.js";
import { protocolTerminalSchema } from "./run.js";

export { changeIdSchema, contractIdSchema, snapshotIdSchema } from "../git/identity.js";
export { entryUlidSchema } from "./attempt.js";
export const activeContractRefusalSchema = z
  .object({ kind: z.enum(["contract-missing", "terminal"]) })
  .strict()
  .readonly();
export const bindRefusalSchema = z.union([
  z
    .object({ kind: z.enum(["contract-exists", "invalid-after", "unknown-prerequisite"]) })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.enum(["target-contract-missing", "target-contract-terminal"]),
      targetContractId: contractIdSchema,
    })
    .strict()
    .readonly(),
]);
export const amendRefusalSchema = z
  .object({
    kind: z.enum(["contract-missing", "terminal", "terms-moved", "unknown-prerequisite", "cyclic-prerequisite"]),
  })
  .strict()
  .readonly();
export const deliverRefusalSchema = z.union([
  z
    .object({ kind: z.enum(["contract-missing", "terminal"]) })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.enum(["target-contract-missing", "target-contract-terminal"]),
      targetContractId: contractIdSchema,
    })
    .strict()
    .readonly(),
]);
export const verificationDeclarationRefusalSchema = z
  .object({ kind: z.literal("verification-declaration-invalid") })
  .strict()
  .readonly();
export const verifyRefusalSchema = z.union([
  z
    .object({ kind: z.literal("verification-not-selected") })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("verification-index-out-of-range"),
      total: z.number().int().nonnegative(),
    })
    .strict()
    .readonly(),
]);
export const placementRefusalSchema = z.union([
  z
    .object({
      kind: z.enum(["target-contract-missing", "target-contract-terminal"]),
      targetContractId: contractIdSchema,
    })
    .strict()
    .readonly(),
  targetWorkspaceRefusalSchema,
  z
    .object({ kind: z.enum(["contract-missing", "delivery-missing", "terminal"]) })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("gates-unsatisfied"),
      unmet: z.array(gateReportSchema).readonly(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("prerequisites-unsatisfied"),
      unmet: z
        .array(
          z
            .object({ contractId: contractIdSchema, state: z.enum(["missing", "active", "abandoned"]) })
            .strict()
            .readonly(),
        )
        .readonly(),
    })
    .strict()
    .readonly(),
]);

const mergeStatePresentRefusalSchema = z
  .object({ kind: z.literal("merge-state-present"), worktreePath: z.string().min(1) })
  .strict()
  .readonly();
export const deliverConflictRefusalSchema = z
  .object({
    kind: z.literal("integration-failed"),
    reason: z.literal("conflict"),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(z.string().refine((value) => value.trim() !== "")).readonly(),
  })
  .strict()
  .readonly();
export type DeliverConflictRefusal = z.infer<typeof deliverConflictRefusalSchema>;
const targetMissingRefusalSchema = z
  .object({ kind: z.literal("target-missing") })
  .strict()
  .readonly();
export const deliveryPreparationRefusalSchema = z.union([
  targetWorkspaceRefusalSchema,
  targetMissingRefusalSchema,
  worktreeMissingRefusalSchema,
  dirtyWorkspaceRefusalSchema,
  integrationPreparationRefusalSchema,
  mergeStatePresentRefusalSchema,
]);
export type DeliveryPreparationRefusal = z.infer<typeof deliveryPreparationRefusalSchema>;
/** Preparation that can actually reach a delivery commit, without deliver materialization. */
export type MechanicalPreparationRefusal = Exclude<DeliveryPreparationRefusal, { kind: "merge-state-present" }>;
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
  verifyRefusalSchema,
]);
type IntentRefusal = z.infer<typeof intentRefusalSchema>;

export type IntentRetry = ProtocolTerminal;
export type IntentOutcome<Value, Refusal = IntentRefusal> = ProtocolIntentOutcome<Value, Refusal>;

type OperationInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: import("../core/facts/types.js").ActorId;
}>;
export type MutationOperationInput = OperationInput &
  Readonly<{ channel: GitDecodeChannel; progress?: ProtocolProgress }>;

/** The decision input of an intent whose verb contributes only its own payload. */
type VoidIntentDecision<Payload extends object> = Payload &
  Readonly<{ contractId: ContractId; actor?: ActorId; at: string }>;

/**
 * Observe, decide, and atomically admit one intent over the invoking actor and time, then complete it
 * as a void outcome. The verb contributes only its own decision payload.
 */
export async function admitVoidIntent<Payload extends object, Refusal>(
  input: MutationOperationInput,
  payload: Payload,
  decide: (input: DecideInput<VoidIntentDecision<Payload>>) => OfferDecision<Refusal>,
  options?: IntentAdmissionOptions<Refusal>,
): Promise<IntentOutcome<void, Refusal>> {
  const decisionInput: VoidIntentDecision<Payload> = {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    ...payload,
  };
  return complete(await admitIntent(input.channel, input.scope, decisionInput, decide, options), undefined);
}

export type DocumentDerivation = Readonly<{
  document: DocumentKey;
  bytes: string;
  title: string;
  verification: VerificationDeclarationPreparation;
}>;

type StepStop<R> = Readonly<{ refusal: R; retry?: never } | { retry: IntentRetry; refusal?: never }>;
export const verificationStopSchema = z.union([
  z.object({ refusal: activeContractRefusalSchema }).strict().readonly(),
  z.object({ retry: protocolTerminalSchema }).strict().readonly(),
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
    .strict()
    .readonly(),
  z.object({ retry: protocolTerminalSchema }).strict().readonly(),
  z
    .object({
      failure: z.literal("target-placement-failed"),
      diagnostic: z.string().refine((value) => value.trim() !== ""),
    })
    .strict()
    .readonly(),
  z
    .object({
      failure: z.literal("target-moved"),
      target: z.string().refine((value) => value.trim() !== ""),
      integratedAt: snapshotIdSchema,
      observed: snapshotIdSchema.nullable(),
      observedTreeEqualsCandidate: z.boolean(),
    })
    .strict()
    .readonly(),
  z
    .object({
      failure: z.literal("target-moved"),
      target: z.string().refine((value) => value.trim() !== ""),
      expected: snapshotIdSchema,
      observed: snapshotIdSchema.nullable(),
      observedTreeEqualsCandidate: z.boolean(),
    })
    .strict()
    .readonly(),
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

function stepStop<Refusal>(result: ProtocolResult<Refusal>): StepStop<Refusal> | undefined {
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
          : stepStop(step as ProtocolResult<ActiveContractRefusal>);
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
    const { target, expected, observed, observedTreeEqualsCandidate } = result;
    return { failure: "target-moved", target, expected, observed, observedTreeEqualsCandidate };
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
  const limit = input.limit === undefined ? undefined : boundedListLimit(input.limit);
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
