import { decodeContractDocument } from "../body/decode.js";
import type { ActorId, ContractId, ContractState } from "../core/facts/types.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { deliverOperation, type IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { RepositoryScope } from "../protocol/operations.js";
import { reviewOperation } from "../protocol/review.js";
import { continueAcceptedCompletion } from "./continuation.js";
import type { WorktreeHooks } from "./configuration.js";
import type { DeliveryValue } from "./delivery.js";
import { documentDerivation } from "./input.js";
import { completionInput, completeMutation, completionPending, type MutationResult, type Review } from "./mutation.js";
import { requireAccepted } from "./refusal.js";

export type DeliveryExecutionInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: ActorId;
  message?: string;
  requireBranchesToBeUpToDate: boolean;
  includeDirty: boolean;
  materializeConflict: boolean;
  signal?: AbortSignal;
  hooks: WorktreeHooks;
}>;

export type AttestationVerdict = "satisfied" | "unsatisfied";
export type ReviewExecutionInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: ActorId;
  verdict: AttestationVerdict;
  summary?: string;
  hooks: WorktreeHooks;
}>;

function derivedDocument(state: ContractState) {
  return documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id);
}

function operationContext(scope: RepositoryScope, channel: GitDecodeChannel, contractId: ContractId) {
  return { scope, channel, contractId, deriveDocument: derivedDocument };
}

export async function executeLocalDelivery(
  input: DeliveryExecutionInput,
): Promise<MutationResult<DeliveryValue> | IntegrationConflictMaterialized> {
  const scope = input.scope;
  return withGitDecodeChannel(scope, async (channel) => {
    const operation = operationContext(scope, channel, input.contractId);
    const outcome = await deliverOperation({
      ...operation,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.message === undefined ? {} : { message: input.message }),
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
      includeDirty: input.includeDirty,
      materializeConflict: input.materializeConflict,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (outcome.kind === "integration-conflict-materialized") return outcome;
    const accepted = requireAccepted(outcome);
    const continued = await continueAcceptedCompletion({
      ...operation,
      accepted,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return completeMutation({
      ...completionInput({
        scope,
        channel,
        contractId: input.contractId,
        value: (delivery: DeliveryValue) => delivery,
        hooks: input.hooks,
        valuePending: completionPending,
      }),
      accepted: continued,
    });
  });
}

export async function executeLocalReview(input: ReviewExecutionInput): Promise<MutationResult<Review>> {
  return withGitDecodeChannel(input.scope, async (channel) => {
    const operation = operationContext(input.scope, channel, input.contractId);
    const accepted = requireAccepted(
      await reviewOperation({
        ...operation,
        verdict: input.verdict,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
      }),
    );
    const continued = await continueAcceptedCompletion({
      ...operation,
      accepted,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    });
    return completeMutation({
      ...completionInput({
        scope: input.scope,
        channel,
        contractId: input.contractId,
        value: (review: Review) => review,
        hooks: input.hooks,
        valuePending: completionPending,
      }),
      accepted: continued,
    });
  });
}
