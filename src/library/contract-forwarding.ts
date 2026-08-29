import { decodeContractDocument } from "../body/decode.js";
import { contractId, type ContractId, type ContractState } from "../core/facts/types.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { deliverOperation, type IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { RepositoryScope } from "../protocol/operations.js";
import { reviewOperation } from "../protocol/review.js";
import { auditContract, type AuditInput } from "./audit.js";
import type { AuditReport } from "../protocol/audit.js";
import { continueAcceptedCompletion } from "./continuation.js";
import type { WorktreeHooks } from "./configuration.js";
import type { DeliveryValue } from "./delivery.js";
import { actorOption, documentDerivation, invalidInput, optionalNonblank } from "./input.js";
import { completionInput, completeMutation, type MutationResult } from "./mutation.js";
import { forwardedMutationFailure, KeiyakuRefused, KeiyakuRetry, requireAccepted } from "./refusal.js";
import {
  isForwardedDeliveryReceipt,
  isForwardedAuditReceipt,
  isForwardedReviewReceipt,
  type ForwardedAuditReceipt,
  type ForwardedDeliveryReceipt,
  type ForwardedReviewReceipt,
  type Review,
} from "./contract-forwarding-result.js";
export {
  isAuditReport,
  isForwardedAuditReceipt,
  isForwardedDeliveryReceipt,
  isForwardedReviewReceipt,
} from "./contract-forwarding-result.js";
export type {
  ForwardedAuditReceipt,
  ForwardedDeliveryReceipt,
  ForwardedMutationReceipt,
  ForwardedReviewReceipt,
  Review,
} from "./contract-forwarding-result.js";
import { Repo, scopeForRepo } from "./repo.js";

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

export type AttestationVerdict = "satisfied" | "unsatisfied";
export type ReviewExecutionInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: ReturnType<typeof actorOption>["actor"];
  verdict: AttestationVerdict;
  summary?: string;
  hooks: WorktreeHooks;
}>;

type ForwardedOutcome = Readonly<{
  kind: string;
  result?: unknown;
  failure?: unknown;
  requestId?: string;
  action?: string;
}>;

function returnedRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

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

function transportIntegrityError(outcome: ForwardedOutcome, action: string): Error {
  return new Error(
    `transport integrity: request ${outcome.requestId ?? "unknown"} action ${outcome.action ?? action} returned an invalid live result`,
  );
}

function upstreamFailure(outcome: ForwardedOutcome, action: string): Error | null {
  if (outcome.kind !== "failed") return null;
  const failure = returnedRecord(outcome.failure);
  return new Error(
    failure?.kind === "failed" && typeof failure.diagnostic === "string"
      ? failure.diagnostic
      : `Unexpected Akuma target failure for ${action}`,
  );
}

export function forwardedDeliveryReceipt(outcome: ForwardedOutcome): ForwardedDeliveryReceipt {
  const failure = upstreamFailure(outcome, "contract.deliver");
  if (failure !== null) throw failure;
  if (!isForwardedDeliveryReceipt(outcome.result)) throw transportIntegrityError(outcome, "contract.deliver");
  return outcome.result;
}

export function forwardedReviewReceipt(outcome: ForwardedOutcome): ForwardedReviewReceipt {
  const failure = upstreamFailure(outcome, "contract.review");
  if (failure !== null) throw failure;
  if (!isForwardedReviewReceipt(outcome.result)) throw transportIntegrityError(outcome, "contract.review");
  return outcome.result;
}

export function forwardedAuditReceipt(outcome: ForwardedOutcome): ForwardedAuditReceipt {
  const failure = upstreamFailure(outcome, "contract.audit");
  if (failure !== null) throw failure;
  if (!isForwardedAuditReceipt(outcome.result)) throw transportIntegrityError(outcome, "contract.audit");
  return outcome.result;
}

export function requireForwarded(
  receipt: ForwardedDeliveryReceipt,
): MutationResult<DeliveryValue> | IntegrationConflictMaterialized;
export function requireForwarded(receipt: ForwardedReviewReceipt): MutationResult<Review>;
export function requireForwarded(receipt: ForwardedAuditReceipt): MutationResult<AuditReport>;
export function requireForwarded(
  receipt: ForwardedDeliveryReceipt | ForwardedReviewReceipt | ForwardedAuditReceipt,
):
  | MutationResult<DeliveryValue>
  | MutationResult<Review>
  | MutationResult<AuditReport>
  | IntegrationConflictMaterialized {
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
    hooks: Parameters<typeof executeLocalDelivery>[0]["hooks"];
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
    hooks: Parameters<typeof executeLocalReview>[0]["hooks"];
  }>,
): Promise<Readonly<{ result: ForwardedReviewReceipt; reviewFactId?: string }>> {
  const id = contractId(input.contractId);
  const actor = actorOption(input.requester).actor;
  if (input.verdict !== "satisfied" && input.verdict !== "unsatisfied") {
    invalidInput("verdict must be satisfied or unsatisfied");
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

export async function executeForwardedAudit(
  input: Readonly<{
    repo: Repo;
    contractId: string;
    requester: string;
    includeDirty: boolean;
    showDiff: boolean;
    requireBranchesToBeUpToDate: boolean;
    hooks: AuditInput["hooks"];
    signal?: AbortSignal;
  }>,
): Promise<Readonly<{ result: ForwardedAuditReceipt; auditReport?: AuditReport }>> {
  const id = contractId(input.contractId);
  const actor = actorOption(input.requester).actor;
  try {
    const result = await auditContract({
      scope: scopeForRepo(input.repo),
      contractId: id,
      input: {
        ...(actor === undefined ? {} : { actor }),
        includeDirty: input.includeDirty,
        showDiff: input.showDiff,
        requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
        ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    });
    return { result: { kind: "accepted", result }, auditReport: result.value };
  } catch (error) {
    return forwardedMutationFailure(error);
  }
}
