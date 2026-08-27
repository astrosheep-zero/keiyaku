import { decodeContractDocument } from "../body/decode.js";
import { withScopeAbortSignal, type RepositoryScope } from "../protocol/operations.js";
import { deliverOperation, type IntegrationConflictMaterialized } from "../protocol/deliver.js";
import { reviewOperation, type ReviewValue } from "../protocol/review.js";
import { continueAcceptedCompletion, type ContinuationReport } from "./continuation.js";
import { completionInput, completeMutation, type MutationResult } from "./mutation.js";
import {
  forwardedMutationFailure,
  KeiyakuRefused,
  KeiyakuRetry,
  requireAccepted,
  type KeiyakuRefusal,
  type KeiyakuRetryReason,
} from "./refusal.js";
import { actorOption, documentDerivation, optionalNonblank } from "./input.js";
import { type WorktreeHooks } from "./configuration.js";
import { Repo, scopeForRepo } from "./repo.js";
import { contractId, type ContractId, type ContractState } from "../core/facts/types.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import type { UpstreamRequestOutcome } from "../akuma/requests.js";
import type { DeliveryValue } from "./delivery.js";

export type DeliveryExecutionInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: ReturnType<typeof actorOption>["actor"];
  message?: string;
  requireBranchesToBeUpToDate: boolean;
  includeDirty: boolean;
  materializeConflict: boolean;
  signal?: AbortSignal;
  hooks: WorktreeHooks;
}>;

export type ReviewExecutionInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: ReturnType<typeof actorOption>["actor"];
  verdict: AttestationVerdict;
  summary?: string;
  hooks: WorktreeHooks;
}>;

export type AttestationVerdict = "satisfied" | "unsatisfied";
export type Review = ReviewValue & Readonly<{ continuation?: ContinuationReport }>;

export type ForwardedMutationReceipt<Value> =
  | Readonly<{ kind: "accepted"; result: MutationResult<Value> }>
  | Readonly<{ kind: "refused"; refusal: KeiyakuRefusal }>
  | Readonly<{ kind: "retry"; reason: KeiyakuRetryReason }>;
export type ForwardedDeliveryReceipt = ForwardedMutationReceipt<DeliveryValue> | IntegrationConflictMaterialized;
export type ForwardedReviewReceipt = ForwardedMutationReceipt<Review>;

function derivedDocument(state: ContractState) {
  return documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id);
}

function operationContext(scope: RepositoryScope, channel: GitDecodeChannel, contractId: ContractId) {
  return { scope, channel, contractId, deriveDocument: derivedDocument };
}

export async function executeLocalDelivery(
  input: DeliveryExecutionInput,
): Promise<MutationResult<DeliveryValue> | IntegrationConflictMaterialized> {
  const scope = withScopeAbortSignal(input.scope, input.signal);
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
      ...completionInput(scope, channel, input.contractId, (delivery: DeliveryValue) => delivery, input.hooks),
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
      ...completionInput(input.scope, channel, input.contractId, (review: Review) => review, input.hooks),
      accepted: continued,
    });
  });
}

export function forwardedReceipt<Receipt>(outcome: UpstreamRequestOutcome, action: string): Receipt {
  if (outcome.kind === "failed") {
    throw new Error(
      outcome.failure.kind === "failed"
        ? outcome.failure.diagnostic
        : `Unexpected Akuma target failure for ${action}: ${outcome.failure.id}`,
    );
  }
  return outcome.result as Receipt;
}

export function requireForwarded(
  receipt: ForwardedDeliveryReceipt,
): MutationResult<DeliveryValue> | IntegrationConflictMaterialized;
export function requireForwarded(receipt: ForwardedReviewReceipt): MutationResult<Review>;
export function requireForwarded(
  receipt: ForwardedDeliveryReceipt | ForwardedReviewReceipt,
): MutationResult<DeliveryValue> | MutationResult<Review> | IntegrationConflictMaterialized {
  if (receipt.kind === "refused") throw new KeiyakuRefused(receipt.refusal);
  if (receipt.kind === "retry") throw new KeiyakuRetry(receipt.reason);
  return receipt.kind === "accepted" ? receipt.result : receipt;
}

export async function executeForwardedDeliver(
  input: Readonly<{
    repo: Repo;
    contractId: string;
    requester: string;
    message?: string;
    includeDirty: boolean;
    materializeConflict: boolean;
    requireBranchesToBeUpToDate: boolean;
    hooks: WorktreeHooks;
    signal?: AbortSignal;
  }>,
): Promise<Readonly<{ result: ForwardedDeliveryReceipt; deliveryFactId?: string }>> {
  const id = contractId(input.contractId);
  const actor = actorOption(input.requester).actor;
  const message = optionalNonblank(input.message, "deliver message");
  try {
    const result = await executeLocalDelivery({
      scope: scopeForRepo(input.repo),
      contractId: id,
      ...(actor === undefined ? {} : { actor }),
      ...(message === undefined ? {} : { message }),
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
      includeDirty: input.includeDirty,
      materializeConflict: input.materializeConflict,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      hooks: input.hooks,
    });
    if (!("facts" in result)) return { result };
    const delivery = result.facts.find((fact) => fact.kind === "deliver");
    if (delivery === undefined) throw new Error("accepted delivery is missing its journal fact");
    return { result: { kind: "accepted", result }, deliveryFactId: delivery.entry };
  } catch (error) {
    return forwardedMutationFailure(error);
  }
}

export async function executeForwardedReview(
  input: Readonly<{
    repo: Repo;
    contractId: string;
    requester: string;
    verdict: AttestationVerdict;
    summary?: string;
    hooks: WorktreeHooks;
  }>,
): Promise<Readonly<{ result: ForwardedReviewReceipt; reviewFactId?: string }>> {
  const id = contractId(input.contractId);
  const actor = actorOption(input.requester).actor;
  if (input.verdict !== "satisfied" && input.verdict !== "unsatisfied") {
    throw new TypeError("verdict must be satisfied or unsatisfied");
  }
  const summary = optionalNonblank(input.summary, "review summary");
  try {
    const result = await executeLocalReview({
      scope: scopeForRepo(input.repo),
      contractId: id,
      ...(actor === undefined ? {} : { actor }),
      verdict: input.verdict,
      ...(summary === undefined ? {} : { summary }),
      hooks: input.hooks,
    });
    const review = result.facts.find((fact) => fact.kind === "attestation");
    if (review === undefined) throw new Error("accepted review is missing its journal fact");
    return { result: { kind: "accepted", result }, reviewFactId: review.entry };
  } catch (error) {
    return forwardedMutationFailure(error);
  }
}
