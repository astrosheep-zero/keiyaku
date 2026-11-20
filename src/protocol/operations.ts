import { boundedListLimit, type LifecycleSelection } from "../bounded-list.js";
import type { DecideInput, OfferDecision } from "../core/decide.js";
import type { ContractId, ContractState, DeliverData, DocumentKey } from "../core/facts/types.js";
export {
  deliverDataSchema,
  gateSchema,
  verdictSchema,
  candidateContentChangeSchema,
  gateCurrentSchema,
  requirementIdSchema,
  requirementReportSchema,
} from "./result-leaves.js";
import { observeContractAt } from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { currentBranch, repositoryAt } from "../git/repository.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import { admitIntent, type IntentAdmissionOptions } from "./intent.js";
import { mintAttempts, type AcceptedAdmission } from "./attempt.js";
import { runBoundedAttempts, type ProtocolResult } from "./run.js";
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

export { changeIdSchema, contractIdSchema, snapshotIdSchema } from "../git/identity.js";
export { entryUlidSchema } from "./attempt.js";

type OperationInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
}>;
export type MutationOperationInput = OperationInput &
  Readonly<{ channel: GitDecodeChannel; progress?: ProtocolProgress }>;

/** The decision input of an intent whose verb contributes only its own payload. */
type VoidIntentDecision<Payload extends object> = Payload & Readonly<{ contractId: ContractId; at: string }>;

/** Admit an intent that needs no seat-external preparation. */
export async function admitSimpleIntent<Payload extends object, Refusal>(
  input: MutationOperationInput,
  payload: Payload,
  decide: (input: DecideInput<VoidIntentDecision<Payload>>) => OfferDecision<Refusal>,
  options?: Omit<IntentAdmissionOptions<Refusal>, "progress">,
): Promise<ProtocolResult<Refusal>> {
  const decisionInput: VoidIntentDecision<Payload> = {
    contractId: input.contractId,
    at: timestamp(),
    ...payload,
  };
  const result = await runBoundedAttempts<undefined, AcceptedAdmission, Refusal>(
    mintAttempts({ entryCount: 1 }),
    async () => ({ kind: "prepared", prepared: undefined }),
    async (_prepared, attempt) =>
      await admitIntent(input.channel, input.scope, decisionInput, decide, {
        ...options,
        attempt,
        ...(input.progress === undefined ? {} : { progress: input.progress }),
      }),
  );
  if (result.kind === "accepted") input.progress?.recordResidue(input.contractId, result);
  return result;
}

export type DocumentDerivation = Readonly<{
  document: DocumentKey;
  bytes: string;
  title: string;
  verification: VerificationDeclarationPreparation;
}>;

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
    readContractCatalogue(observation, limit, input.selection, "readable"),
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
