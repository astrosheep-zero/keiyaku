import { z } from "zod";
import { targetName, type ActorId, type ContractId } from "../core/facts/types.js";
import { snapshotIdSchema } from "../git/identity.js";
import { deliveryDiffScopeSchema } from "../git/integration.js";
import { gateReportSchema } from "./result-leaves.js";
import { gateReports, type GateReport } from "../core/facts/gate.js";
import { readDeliveryScope } from "../git/integration.js";
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
  type ExecutionStage,
  type ExecutionStop,
} from "./progress.js";
import type { PlacementStop } from "./operations.js";
import { placementStop, placementStopSchema, timestamp } from "./operations.js";

const MAX_REINTEGRATION_CYCLES = 3;

export const candidateCompletionSchema = z
  .strictObject({
    integration: snapshotIdSchema,
    predecessor: snapshotIdSchema.exactOptional(),
    target: z.string().exactOptional(),
    scope: deliveryDiffScopeSchema.omit({ paths: true }).readonly().exactOptional(),
  })
  .readonly();
export const completionEvidenceShape = {
  completion: candidateCompletionSchema.exactOptional(),
  gates: z.array(gateReportSchema).readonly().exactOptional(),
  placement: placementStopSchema.exactOptional(),
};
export type CandidateCompletion = z.output<typeof candidateCompletionSchema>;
export type CompletionEvidence = Readonly<{
  completion?: CandidateCompletion;
  gates?: readonly GateReport[];
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
  stage: ExecutionStage;
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
  // Movement and the completion base are known before this optional observation; a failed scope
  // read must never erase an already-claimed candidate.
  cursor.completion = {
    integration,
    ...(predecessor === undefined || target === undefined ? {} : { predecessor, target: targetName(target) }),
  };
  input.progress.recordCompletion(state.id, cursor.completion);
  cursor.evidence = { gates: gateReports(state).reports };
  input.progress.recordCandidate(state.id, { ...cursor.evidence, completion: cursor.completion });
  const scope =
    predecessor === undefined ? undefined : await readDeliveryScope(input.repository, predecessor, integration, false);
  const completion: CandidateCompletion = {
    integration,
    ...(predecessor === undefined || target === undefined ? {} : { predecessor, target: targetName(target) }),
    ...(scope === undefined
      ? {}
      : { scope: { filesChanged: scope.filesChanged, insertions: scope.insertions, deletions: scope.deletions } }),
  };
  cursor.completion = completion;
  input.progress.recordCompletion(state.id, completion);
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
  const evidence =
    "kind" in stop && stop.kind === "execution-stopped"
      ? cursor.evidence
      : { ...cursor.evidence, placement: stop as PlacementStop };
  return { kind: "stopped", checkpoint: cursor.checkpoint, evidence, stop };
}

async function placeCurrentCandidate(input: CompletionInput, cursor: CompletionCursor) {
  cursor.stage = "placement";
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
    cursor.evidence = { gates: gateReports(cursor.checkpoint.state).reports };
    input.progress.recordCandidate(cursor.checkpoint.state.id, cursor.evidence);
    let placement: Awaited<ReturnType<typeof placeCurrentCandidate>> | undefined =
      await observeIntegrationTargetMovement(input.repository, cursor.checkpoint.state);
    if (placement === undefined) {
      const targetStop = await observeCandidateTarget(input, cursor);
      if (targetStop !== undefined) return stoppedResult(cursor, targetStop);
      placement = await placeCurrentCandidate(input, cursor);
      cursor.evidence = { gates: gateReports(cursor.checkpoint.state).reports };
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
        contractId: cursor.checkpoint.state.id,
        target: targetName(target),
        integratedAt: cursor.checkpoint.state.currentIntegration!.snapshot,
        observed: placement.observed,
        attempts: cycles,
        observedTreeEqualsCandidate: placement.observedTreeEqualsCandidate,
      });
    }
    cursor.stage = "reintegration";
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
  const cursor: CompletionCursor = { checkpoint: input.checkpoint, evidence: {}, stage: "placement" };
  try {
    return await advanceCandidate(input, cursor);
  } catch (error) {
    if (!isOperationalStop(error, input.signal)) throw error;
    const contractId: ContractId = input.checkpoint.state.id;
    const stop = executionStop(contractId, cursor.stage, error, input.signal);
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
