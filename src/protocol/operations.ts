import { z } from "zod";
import { boundedListLimit, type LifecycleSelection } from "../bounded-list.js";
import type { DecideInput, OfferDecision } from "../core/decide.js";
import type { ContractId, ContractState, DeliverData, DocumentKey } from "../core/facts/types.js";
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
import { integrationPreparationRefusalSchema } from "../git/integration.js";
import { observeContractAt } from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { currentBranch, repositoryAt } from "../git/repository.js";
export { checkoutNotFollowableRefusalSchema } from "../git/target-placement.js";
import { targetWorkspaceRefusalSchema } from "../git/target.js";
import { dirtyWorkspaceRefusalSchema, worktreeMissingRefusalSchema } from "../git/tender.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import type { AcceptedAdmission, DecidedOfferResult } from "./attempt.js";
import { forkSourceMovedRefusalSchema, targetInputRefusalSchema } from "./bind.js";
import { admitIntent, type IntentAdmissionOptions } from "./intent.js";
import { complete, type IntentOutcome as ProtocolIntentOutcome } from "./outcome.js";
import type { ProtocolProgress } from "./progress.js";
import { readDocuments, type ContractDocumentProjection } from "./read/documents.js";
import {
  readContractMembershipAt,
  readContractCatalogue,
  readContractObservationAt,
  type ContractMembership,
  type ContractCatalogue,
  type ContractObservation,
} from "./read/status.js";
import type { ProtocolTerminal } from "./run.js";
import { targetLifecycleReasonSchema } from "./result-reasons.js";

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
  targetLifecycleReasonSchema,
]);
export const amendRefusalSchema = z.union([
  z
    .strictObject({
      kind: z.enum([
        "contract-missing",
        "terminal",
        "terms-moved",
        "unknown-prerequisite",
        "cyclic-prerequisite",
        "cyclic-target",
      ]),
    })
    .readonly(),
  targetLifecycleReasonSchema,
]);
export const deliverRefusalSchema = z.union([activeContractRefusalSchema, targetLifecycleReasonSchema]);
export const verificationDeclarationRefusalSchema = z
  .object({ kind: z.literal("verification-declaration-invalid") })
  .strict()
  .readonly();
export const verifyRefusalSchema = z
  .object({
    kind: z.literal("verification-index-out-of-range"),
    total: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export const placementRefusalSchema = z.union([
  targetLifecycleReasonSchema,
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
}>;
export type MutationOperationInput = OperationInput &
  Readonly<{ channel: GitDecodeChannel; progress?: ProtocolProgress }>;

/** The decision input of an intent whose verb contributes only its own payload. */
type VoidIntentDecision<Payload extends object> = Payload & Readonly<{ contractId: ContractId; at: string }>;

/**
 * Observe, decide, and atomically admit one intent over the invocation time, then complete it
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
    ids?: readonly ContractId[];
  }>,
): Promise<readonly ContractMembership[]> {
  return readContractMembershipAt(input.scope, input.channel, input.ids);
}

export async function contractCatalogueOperation(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    selection?: LifecycleSelection;
    limit?: number;
  }>,
): Promise<ContractCatalogue> {
  const limit = input.limit === undefined ? undefined : boundedListLimit(input.limit);
  return withGitReadObservation(input.scope, input.channel, (observation) =>
    readContractCatalogue(observation, limit, input.selection),
  );
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
  const state = await stateOperation(input);
  if (state === null || state.delivery === null) return null;
  return state.currentIntegration === null
    ? state.delivery.data
    : { ...state.delivery.data, integration: state.currentIntegration };
}
