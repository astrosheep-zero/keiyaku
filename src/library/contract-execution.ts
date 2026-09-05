import { decodeContractDocument } from "../body/decode.js";
import type { ActorId, ContractId, ContractState } from "../core/facts/types.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { admitDeliveryOperation, type IntegrationConflictMaterialized } from "../protocol/deliver.js";
import { withScopeAbortSignal, type RepositoryScope } from "../protocol/operations.js";
import { admitReviewOperation } from "../protocol/review.js";
import { completeCandidate, type CompletionEvidence } from "../protocol/completion.js";
import { ExecutionProgress, contractCheckpoint, executionStop, type ContractCheckpoint } from "../protocol/progress.js";
import { continueDeliveredDependents } from "./continuation.js";
import type { WorktreeHooks } from "./configuration.js";
import type { DeliveryValue } from "./delivery.js";
import { documentDerivation } from "./input.js";
import { completeMutation, projectMutationFinality, type MutationResult, type Review } from "./mutation.js";
import { requireLeadingAdmission } from "./refusal.js";
import { receiptFromProgress, withExecutionReceipt, type MutationOperation } from "./execution-result.js";

type CommonExecutionInput = Readonly<{
  scope: RepositoryScope;
  contractId: ContractId;
  actor?: ActorId;
  signal?: AbortSignal;
  hooks: WorktreeHooks;
}>;
export type DeliveryExecutionInput = CommonExecutionInput &
  Readonly<{
    message?: string;
    requireBranchesToBeUpToDate: boolean;
    includeDirty: boolean;
    materializeConflict: boolean;
  }>;
export type AttestationVerdict = "satisfied" | "unsatisfied";
export type ReviewExecutionInput = CommonExecutionInput & Readonly<{ verdict: AttestationVerdict; summary?: string }>;
type ExecutionContext = CommonExecutionInput & Readonly<{ channel: GitDecodeChannel; progress: ExecutionProgress }>;

function derivedDocument(state: ContractState) {
  return documentDerivation(decodeContractDocument(state.terms.document.bytes), state.terms.gates, state.id);
}

function retainTrailingFailure(context: ExecutionContext, operation: "review" | "deliver", error: unknown): void {
  const receipt = receiptFromProgress(operation, context.contractId, context.progress);
  if (receipt === undefined) throw error;
  try {
    context.progress.recordStop(executionStop(context.contractId, "admission", error, context.signal));
  } catch (unexpected) {
    throw withExecutionReceipt(unexpected, receipt);
  }
}

/** The channel's own retirement cannot hide an already returned admission. */
export async function withContractExecution<Result extends MutationResult<unknown> | IntegrationConflictMaterialized>(
  input: CommonExecutionInput,
  operation: MutationOperation,
  run: (context: ExecutionContext) => Promise<Result>,
): Promise<Result> {
  const progress = new ExecutionProgress();
  const scope = withScopeAbortSignal(input.scope, input.signal);
  let produced: Result | undefined;
  try {
    return await withGitDecodeChannel(scope, async (channel) => {
      const context = {
        ...input,
        scope,
        channel,
        progress,
        ...(scope.signal === undefined ? {} : { signal: scope.signal }),
      };
      produced = await run(context);
      return produced;
    });
  } catch (error) {
    const receipt = receiptFromProgress(operation, input.contractId, progress);
    if (receipt === undefined) throw error;
    if (produced?.kind === "accepted") {
      try {
        progress.recordStop(executionStop(input.contractId, "reconciliation", error, scope.signal));
        const updated = { ...produced, executionStops: progress.snapshot().stops };
        const finality = projectMutationFinality(updated);
        return { ...updated, pending: finality.kind === "accepted-pending" ? finality.pending : [] };
      } catch (unexpected) {
        throw withExecutionReceipt(unexpected, receipt);
      }
    }
    throw withExecutionReceipt(error, receipt);
  }
}

async function advanceAndContinue(
  context: ExecutionContext,
  checkpoint: ContractCheckpoint,
  start: "verification" | "placement",
) {
  const result = await completeCandidate({
    repository: context.scope,
    channel: context.channel,
    checkpoint,
    progress: context.progress,
    start,
    deriveDocument: derivedDocument,
    ...(context.actor === undefined ? {} : { actor: context.actor }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const continuation =
    result.kind !== "completed"
      ? undefined
      : await continueDeliveredDependents({
          ...context,
          completed: result,
          deriveDocument: derivedDocument,
        });
  return { ...result.evidence, ...(continuation === undefined ? {} : { continuation }) };
}

/** Review records testimony, then the same shared node judges automatic placement. */
export async function executeLocalReview(input: ReviewExecutionInput): Promise<MutationResult<Review>> {
  return await withContractExecution(input, "review", async (context) => {
    let value: Review = {};
    try {
      context.signal?.throwIfAborted();
      const leading = requireLeadingAdmission(
        await admitReviewOperation({
          ...context,
          verdict: input.verdict,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
        }),
      );
      value = leading.value;
      if (input.verdict === "satisfied")
        value = { ...value, ...(await advanceAndContinue(context, contractCheckpoint(leading), "placement")) };
    } catch (error) {
      retainTrailingFailure(context, "review", error);
    }
    return await completeMutation({
      ...context,
      operation: "review",
      accepted: context.progress.accepted(context.contractId, value),
      value: (review: Review) => review,
    });
  });
}

function admittedDeliveryValue(context: ExecutionContext): DeliveryValue {
  const fact = context.progress
    .snapshot()
    .facts.find((entry) => entry.contract === context.contractId && entry.kind === "deliver");
  if (fact?.kind !== "deliver") throw new Error("confirmed delivery requires its own receipt");
  return fact.data;
}

/** Delivery admits a candidate; completion and dependent continuation remain automatic. */
export async function executeLocalDelivery(
  input: DeliveryExecutionInput,
): Promise<MutationResult<DeliveryValue> | IntegrationConflictMaterialized> {
  return await withContractExecution(input, "deliver", async (context) => {
    let trailing: CompletionEvidence & Pick<DeliveryValue, "continuation"> = {};
    try {
      context.signal?.throwIfAborted();
      const outcome = await admitDeliveryOperation({ ...input, ...context, deriveDocument: derivedDocument });
      if (outcome.kind === "integration-conflict-materialized") return outcome;
      const leading = requireLeadingAdmission(outcome);
      trailing = await advanceAndContinue(context, contractCheckpoint(leading), "verification");
    } catch (error) {
      retainTrailingFailure(context, "deliver", error);
    }
    const value: DeliveryValue = { ...admittedDeliveryValue(context), ...trailing };
    return await completeMutation({
      ...context,
      operation: "deliver",
      accepted: context.progress.accepted(context.contractId, value),
      value: (delivery: DeliveryValue) => delivery,
    });
  });
}
