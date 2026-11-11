import { z } from "zod";
import { targetName, type ActorId, type ContractId } from "../core/facts/types.js";
import { snapshotIdSchema, contractIdSchema } from "../git/identity.js";
import { deliveryDiffScopeSchema } from "../git/integration.js";
import { requirementIdSchema, gateSchema } from "./result-leaves.js";
import type { GateReport } from "../core/facts/gate.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { admitPlacement, observeTargetPlacement, observeIntegrationTargetMovement } from "./placement.js";
import { reintegrateOperation, type ReintegrationResult } from "./reintegrate.js";
import {
  contractCheckpoint,
  executionStop,
  isOperationalFailure,
  isOperationalStop,
  type ContractCheckpoint,
  type ProtocolProgress,
  type ExecutionStop,
} from "./progress.js";
import type { PlacementStop } from "./operations.js";
import { placementStop, timestamp } from "./operations.js";
import {
  activeReasonSchema,
  targetLifecycleReasonSchema,
  targetWorkspaceReasonSchema,
  checkoutCollisionSchema,
  integrationProblemSchema,
  retrySchema,
  compactRetry,
  compactReason,
  executionIssueSchema,
} from "./result-reasons.js";

const MAX_REINTEGRATION_CYCLES = 3;

const requirementCoordinate = { gate: gateSchema, requirement: requirementIdSchema };
export const requirementProblemSchema = z.union([
  z.strictObject({ ...requirementCoordinate, state: z.literal("missing") }).readonly(),
  z
    .strictObject({ ...requirementCoordinate, state: z.literal("unsatisfied"), summary: z.string().exactOptional() })
    .readonly(),
  z
    .strictObject({
      ...requirementCoordinate,
      state: z.literal("stale"),
      previousContentId: z.string().min(1).exactOptional(),
      currentContentId: z.string().min(1).exactOptional(),
    })
    .readonly(),
]);
export type RequirementProblem = z.output<typeof requirementProblemSchema>;

/** Select already-adjudicated unmet requirements; never recompute currentness. */
export function unmetGateProblems(reports: readonly GateReport[]): readonly RequirementProblem[] {
  return reports
    .filter((report) => !report.satisfied)
    .flatMap((report) =>
      report.requirements.flatMap(({ requirement, current }): RequirementProblem[] => {
        const coordinate = { gate: report.gate, requirement };
        if (current.kind === "missing") return [{ ...coordinate, state: "missing" }];
        if (current.kind === "attested")
          return current.verdict === "satisfied"
            ? []
            : [
                {
                  ...coordinate,
                  state: "unsatisfied",
                  ...(current.summary === undefined ? {} : { summary: current.summary }),
                },
              ];
        return [
          {
            ...coordinate,
            state: "stale",
            ...(current.reason === undefined
              ? {}
              : {
                  previousContentId: current.reason.previousChange,
                  currentContentId: current.reason.currentChange,
                }),
          },
        ];
      }),
    );
}

export const unmetPrerequisiteSchema = z
  .strictObject({
    contractId: contractIdSchema,
    state: z.enum(["missing", "active", "abandoned"]),
  })
  .readonly();
export const placementReasonSchema = z.union([
  activeReasonSchema,
  targetLifecycleReasonSchema,
  targetWorkspaceReasonSchema,
  z.strictObject({ kind: z.enum(["delivery-missing", "target-missing"]) }).readonly(),
  z
    .strictObject({
      kind: z.literal("prerequisites-unsatisfied"),
      unmet: z.array(unmetPrerequisiteSchema).min(1).readonly(),
    })
    .readonly(),
  z
    .strictObject({ kind: z.literal("gates-unsatisfied"), unmet: z.array(requirementProblemSchema).min(1).readonly() })
    .readonly(),
  checkoutCollisionSchema,
  ...integrationProblemSchema.options,
]);
export const placementStopSchema = z
  .union([
    ...placementReasonSchema.options,
    ...retrySchema.options,
    z.strictObject({ kind: z.literal("failed"), diagnostic: z.string().min(1) }).readonly(),
    z
      .strictObject({
        kind: z.literal("target-content-identical"),
        target: z.string().min(1),
        expected: snapshotIdSchema,
        observed: snapshotIdSchema,
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal("target-moved"),
        target: z.string().min(1),
        integration: snapshotIdSchema,
        observed: snapshotIdSchema.nullable(),
      })
      .readonly(),
    executionIssueSchema,
    z.strictObject({ kind: z.literal("physical-lag") }).readonly(),
  ])
  .meta({ id: "contractStop" });
export type CompactPlacementStop = z.output<typeof placementStopSchema>;
export const compactScopeSchema = z
  .strictObject({
    filesChanged: z.number().int().positive().exactOptional(),
    insertions: z.number().int().positive().exactOptional(),
    deletions: z.number().int().positive().exactOptional(),
    paths: z.array(z.string()).min(1).readonly().exactOptional(),
  })
  .readonly();
export const placedSchema = z
  .strictObject({
    kind: z.literal("placed"),
    integration: snapshotIdSchema,
    target: z.string().exactOptional(),
    predecessor: snapshotIdSchema.exactOptional(),
  })
  .readonly();
export const placementSchema = z.union([placedSchema, placementStopSchema]);
export type Placement = z.output<typeof placementSchema>;
export type Placed = z.output<typeof placedSchema>;

export function compactScope(scope: z.output<typeof deliveryDiffScopeSchema>): z.output<typeof compactScopeSchema> {
  return {
    ...(scope.filesChanged === 0 ? {} : { filesChanged: scope.filesChanged }),
    ...(scope.insertions === 0 ? {} : { insertions: scope.insertions }),
    ...(scope.deletions === 0 ? {} : { deletions: scope.deletions }),
    ...(scope.paths === undefined || scope.paths.length === 0 ? {} : { paths: scope.paths }),
  };
}

export function compactPlacementStop(stop: PlacementStop): CompactPlacementStop {
  if ("refusal" in stop) {
    const reason = stop.refusal;
    if (reason.kind === "gates-unsatisfied") return { kind: reason.kind, unmet: unmetGateProblems(reason.unmet) };
    if (reason.kind === "prerequisites-unsatisfied") return { kind: reason.kind, unmet: reason.unmet };
    if (reason.kind === "checkout-not-followable") return reason;
    return compactReason(reason);
  }
  if ("retry" in stop) return compactRetry(stop.retry);
  if (stop.failure === "target-placement-failed") return { kind: "failed", diagnostic: stop.diagnostic };
  if ("integratedAt" in stop)
    return { kind: "target-moved", target: stop.target, integration: stop.integratedAt, observed: stop.observed };
  if (!stop.observedTreeEqualsCandidate || stop.observed === null)
    throw new Error("unexhausted returned target movement requires identical content");
  return { kind: "target-content-identical", target: stop.target, expected: stop.expected, observed: stop.observed };
}

export function compactPlacement(evidence: CompletionEvidence): Placement | undefined {
  if (evidence.completion !== undefined) return { kind: "placed", ...evidence.completion };
  return evidence.placement === undefined ? undefined : compactPlacementStop(evidence.placement);
}

export const candidateCompletionSchema = placedSchema.unwrap().omit({ kind: true }).readonly();
export type CandidateCompletion = z.output<typeof candidateCompletionSchema>;
export type CompletionEvidence = Readonly<{
  completion?: CandidateCompletion;
  placement?: PlacementStop;
}>;
export type CompletionInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  checkpoint: ContractCheckpoint;
  progress: ProtocolProgress;
  actor?: ActorId;
  signal?: AbortSignal;
}>;

export type CompletionResult =
  | Readonly<{
      kind: "completed";
      checkpoint: ContractCheckpoint;
      evidence: CompletionEvidence & { completion: CandidateCompletion };
    }>
  | Readonly<{
      kind: "stopped";
      checkpoint: ContractCheckpoint;
      evidence: CompletionEvidence;
      stop: PlacementStop | ExecutionStop;
    }>;

// A cursor controls this node only; it is neither a receipt nor a persisted lifecycle.
type CompletionCursor = {
  checkpoint: ContractCheckpoint;
  evidence: CompletionEvidence;
  completion?: CandidateCompletion;
};

function reintegrationStop(result: Exclude<ReintegrationResult, { kind: "accepted" }>): PlacementStop {
  if (result.kind === "placement-failed") return { failure: "target-placement-failed", diagnostic: result.diagnostic };
  if (result.kind === "refused") return { refusal: result.refusal };
  return { retry: result.reason };
}

async function observeCandidateTarget(
  input: CompletionInput,
  cursor: CompletionCursor,
): Promise<PlacementStop | undefined> {
  const target = cursor.checkpoint.state.coordinates.target;
  if (target === undefined) return undefined;
  const integration = cursor.checkpoint.state.currentIntegration;
  if (integration === null) return undefined;
  try {
    const observed = await observeTargetPlacement(input.repository, {
      contractId: cursor.checkpoint.state.id,
      coordinates: { ...cursor.checkpoint.state.coordinates, target },
      predecessor: integration.predecessor,
      candidate: integration.snapshot,
    });
    return observed.kind === "refused" ? { refusal: observed.refusal } : undefined;
  } catch (error) {
    if (!isOperationalFailure(error)) throw error;
    return { failure: "target-placement-failed", diagnostic: error.message };
  }
}

async function completedResult(
  input: CompletionInput,
  cursor: CompletionCursor,
): Promise<Extract<CompletionResult, { kind: "completed" }>> {
  const state = cursor.checkpoint.state;
  const integration = state.currentIntegration?.snapshot;
  if (integration === undefined) throw new Error("accepted placement requires its integration snapshot");
  const target = state.coordinates.target;
  const predecessor = state.currentIntegration?.predecessor;
  const completion: CandidateCompletion = {
    integration,
    ...(predecessor === undefined || target === undefined ? {} : { predecessor, target: targetName(target) }),
  };
  cursor.completion = completion;
  input.progress.recordCompletion(state.id, completion);
  cursor.evidence = {};
  input.progress.recordCandidate(state.id, { ...cursor.evidence, completion });
  return {
    kind: "completed",
    checkpoint: cursor.checkpoint,
    evidence: { ...cursor.evidence, completion },
  };
}

function stoppedResult(
  cursor: CompletionCursor,
  stop: PlacementStop | ExecutionStop,
): Extract<CompletionResult, { kind: "stopped" }> {
  const evidence = "kind" in stop ? cursor.evidence : { ...cursor.evidence, placement: stop };
  return { kind: "stopped", checkpoint: cursor.checkpoint, evidence, stop };
}

async function placeCurrentCandidate(input: CompletionInput, cursor: CompletionCursor) {
  input.signal?.throwIfAborted();
  input.progress.observe({
    kind: "stage",
    contractId: cursor.checkpoint.state.id,
    stage: "placement",
    state: "started",
  });
  const result = await (async () => {
    try {
      return await admitPlacement({
        channel: input.channel,
        repository: input.repository,
        progress: input.progress,
        target: cursor.checkpoint.state.coordinates.target,
        placement: {
          contractId: cursor.checkpoint.state.id,
          ...(input.actor === undefined ? {} : { actor: input.actor }),
          at: timestamp(),
        },
      });
    } finally {
      input.progress.observe({
        kind: "stage",
        contractId: cursor.checkpoint.state.id,
        stage: "placement",
        state: "finished",
      });
    }
  })();
  if (result.kind === "accepted") {
    cursor.checkpoint = contractCheckpoint(result);
    input.progress.recordResidue(result.state.id, result);
    const acceptedIntegration = result.state.currentIntegration?.snapshot;
    if (acceptedIntegration !== undefined) {
      const acceptedPredecessor = result.state.currentIntegration?.predecessor;
      input.progress.recordCompletion(result.state.id, {
        integration: acceptedIntegration,
        ...(acceptedPredecessor === undefined ? {} : { predecessor: acceptedPredecessor }),
      });
    }
  }
  return result;
}

async function advanceCandidate(input: CompletionInput, cursor: CompletionCursor): Promise<CompletionResult> {
  const target = cursor.checkpoint.state.coordinates.target;
  for (let cycles = 0; ; cycles += 1) {
    input.signal?.throwIfAborted();
    cursor.evidence = {};
    input.progress.recordCandidate(cursor.checkpoint.state.id, cursor.evidence);
    let placement: Awaited<ReturnType<typeof placeCurrentCandidate>> | undefined =
      await observeIntegrationTargetMovement(input.repository, cursor.checkpoint.state);
    if (placement === undefined) {
      const targetStop = await observeCandidateTarget(input, cursor);
      if (targetStop !== undefined) return stoppedResult(cursor, targetStop);
      placement = await placeCurrentCandidate(input, cursor);
      cursor.evidence = {};
      input.progress.recordCandidate(cursor.checkpoint.state.id, cursor.evidence);
    }
    if (placement.kind === "accepted") return await completedResult(input, cursor);
    if (placement.kind !== "target-moved" || target === undefined || placement.observedTreeEqualsCandidate) {
      const stop = placementStop(placement);
      if (stop === undefined) throw new Error("non-accepted placement requires a stop");
      return stoppedResult(cursor, stop);
    }
    if (cycles === MAX_REINTEGRATION_CYCLES) {
      return stoppedResult(cursor, {
        failure: "target-moved",
        target: targetName(target),
        integratedAt: cursor.checkpoint.state.currentIntegration!.snapshot,
        observed: placement.observed,
        observedTreeEqualsCandidate: placement.observedTreeEqualsCandidate,
      });
    }
    input.signal?.throwIfAborted();
    const reintegrated = await reintegrateOperation({
      channel: input.channel,
      repository: input.repository,
      progress: input.progress,
      contractId: cursor.checkpoint.state.id,
      target,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    });
    if (reintegrated.kind !== "accepted") return stoppedResult(cursor, reintegrationStop(reintegrated));
    cursor.checkpoint = contractCheckpoint(reintegrated);
    input.progress.recordResidue(reintegrated.state.id, reintegrated);
  }
}

/** Advance one contract. The trigger owns the leading act; this node owns no other contract. */
export async function completeCandidate(input: CompletionInput): Promise<CompletionResult> {
  const cursor: CompletionCursor = {
    checkpoint: input.checkpoint,
    evidence: {},
  };
  try {
    return await advanceCandidate(input, cursor);
  } catch (error) {
    if (!isOperationalStop(error, input.signal)) throw error;
    const contractId: ContractId = input.checkpoint.state.id;
    const stop = executionStop(contractId, error, input.signal);
    input.progress.recordStop(stop);
    const admitted = input.progress.checkpoint(contractId);
    if (admitted !== undefined) cursor.checkpoint = admitted;
    // Only this invocation's confirmed claim can complete the node after a trailing failure.
    if (admitted?.state.terminal?.kind === "claimed" && input.progress.hasFact(admitted.state.terminal)) {
      if (cursor.completion === undefined) {
        const integration = admitted.state.currentIntegration;
        if (integration === null) throw error;
        const target = admitted.state.coordinates.target;
        cursor.completion = {
          integration: integration.snapshot,
          ...(target === undefined ? {} : { target: targetName(target), predecessor: integration.predecessor }),
        };
        input.progress.recordCompletion(contractId, cursor.completion);
      }
      return {
        kind: "completed",
        checkpoint: cursor.checkpoint,
        evidence: { ...cursor.evidence, completion: cursor.completion },
      };
    }
    return stoppedResult(cursor, stop);
  }
}
