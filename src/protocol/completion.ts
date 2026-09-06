import type { ActorId, ContractId, EntryUlid, SnapshotId } from "../core/facts/types.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { currentVerifiedAttestation, verifyDelivery, type CurrentVerifiedAttestation } from "./intent.js";
import { admitPlacement } from "./placement.js";
import { reintegrateOperation, type ReintegrationResult } from "./reintegrate.js";
import {
  contractCheckpoint,
  executionStop,
  type ContractCheckpoint,
  type ExecutionProgress,
  type ExecutionStage,
  type ExecutionStop,
} from "./progress.js";
import type { DocumentDerivation, PlacementStop, VerificationStop } from "./operations.js";
import { placementStop, timestamp, unpackVerificationOutcome } from "./operations.js";

const MAX_REINTEGRATION_CYCLES = 3;

export type CandidateCompletion = Readonly<{
  integration: SnapshotId;
  verification?: Readonly<{ mode: "ran" | "reused"; verdict: "satisfied" | "unsatisfied" }>;
}>;

/** Candidate conclusions only. Invocation-owned receipts and cleanup live in progress. */
export type CompletionEvidence = Readonly<{
  completion?: CandidateCompletion;
  verification?: VerificationStop;
  verificationReuse?: CurrentVerifiedAttestation;
  verificationSummary?: string;
  placement?: PlacementStop;
}>;

export type CompletionInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  checkpoint: ContractCheckpoint;
  progress: ExecutionProgress;
  start: "verification" | "placement";
  deriveDocument(state: ContractCheckpoint["state"]): DocumentDerivation;
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
  ran: EntryUlid | undefined;
  stage: ExecutionStage;
};

function reintegrationStop(result: Exclude<ReintegrationResult, { kind: "accepted" }>): PlacementStop {
  if (result.kind === "placement-failed") return { failure: "target-placement-failed", diagnostic: result.diagnostic };
  if (result.kind === "refused") return { refusal: result.refusal };
  return { retry: result.reason };
}

async function verifyCurrentCandidate(input: CompletionInput, cursor: CompletionCursor): Promise<void> {
  cursor.stage = "verification";
  input.signal?.throwIfAborted();
  const state = cursor.checkpoint.state;
  const snapshot = state.currentIntegration?.snapshot;
  if (snapshot === undefined) throw new Error("delivery completion requires an integration snapshot");
  cursor.evidence = {};
  cursor.ran = undefined;
  const current = currentVerifiedAttestation(state);
  if (current !== undefined) {
    cursor.evidence = { verificationReuse: current };
    return;
  }
  const declaration = input.deriveDocument(state).verification;
  if (declaration.kind === "refused") {
    cursor.evidence = { verification: { refusal: declaration.refusal } };
    return;
  }
  const result = await verifyDelivery({
    channel: input.channel,
    repository: input.repository,
    contractId: state.id,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    state,
    snapshot,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    progress: input.progress,
    ...(declaration.data === null ? {} : { verification: declaration.data }),
  });
  if (result === null) return;
  const verified = unpackVerificationOutcome(result);
  if (verified.admission !== undefined) {
    cursor.checkpoint = contractCheckpoint(verified.admission);
    input.progress.recordResidue(state.id, verified.admission);
    cursor.ran = verified.admission.facts.find(
      (fact) => fact.kind === "attestation" && fact.data.gate === "verified",
    )?.entry;
  }
  cursor.evidence = {
    ...(verified.stop === undefined ? {} : { verification: verified.stop }),
    ...(verified.counts?.verdict !== "unsatisfied" || verified.counts.summary === undefined
      ? {}
      : { verificationSummary: verified.counts.summary }),
  };
}

function completedResult(cursor: CompletionCursor): Extract<CompletionResult, { kind: "completed" }> {
  const state = cursor.checkpoint.state;
  const integration = state.currentIntegration?.snapshot;
  if (integration === undefined) throw new Error("accepted placement requires its integration snapshot");
  // Never attach a superseded run's verdict to the final integration.
  const current = currentVerifiedAttestation(state);
  const verification =
    current === undefined
      ? undefined
      : {
          mode: cursor.ran === current.entry ? ("ran" as const) : ("reused" as const),
          verdict: current.verdict,
        };
  const { verificationSummary: _oldSummary, verificationReuse: _oldReuse, ...evidence } = cursor.evidence;
  return {
    kind: "completed",
    checkpoint: cursor.checkpoint,
    evidence: {
      ...evidence,
      completion: { integration, ...(verification === undefined ? {} : { verification }) },
      ...(current === undefined || verification?.mode !== "reused" ? {} : { verificationReuse: current }),
      ...(current?.verdict !== "unsatisfied" || current.summary === undefined
        ? {}
        : { verificationSummary: current.summary }),
    },
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
  const result = await admitPlacement({
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
  if (result.kind === "accepted") {
    cursor.checkpoint = contractCheckpoint(result);
    input.progress.recordResidue(result.state.id, result);
  }
  return result;
}

async function advanceCandidate(input: CompletionInput, cursor: CompletionCursor): Promise<CompletionResult> {
  if (input.start === "verification") await verifyCurrentCandidate(input, cursor);
  const target = cursor.checkpoint.state.coordinates.target;
  let placement = await placeCurrentCandidate(input, cursor);
  for (let cycles = 0; ; cycles += 1) {
    if (placement.kind === "accepted") return completedResult(cursor);
    if (placement.kind !== "target-moved" || target === undefined || placement.observedTreeEqualsCandidate) {
      const stop = placementStop(placement);
      if (stop === undefined) throw new Error("non-accepted placement requires a stop");
      return stoppedResult(cursor, stop);
    }
    if (cycles === MAX_REINTEGRATION_CYCLES) {
      return stoppedResult(cursor, {
        failure: "target-moved",
        contractId: cursor.checkpoint.state.id,
        target,
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
    await verifyCurrentCandidate(input, cursor);
    placement = await placeCurrentCandidate(input, cursor);
  }
}

/** Advance one contract. The trigger owns the leading act; this node owns no other contract. */
export async function completeCandidate(input: CompletionInput): Promise<CompletionResult> {
  const cursor: CompletionCursor = { checkpoint: input.checkpoint, evidence: {}, ran: undefined, stage: "placement" };
  try {
    return await advanceCandidate(input, cursor);
  } catch (error) {
    const contractId: ContractId = input.checkpoint.state.id;
    const stop = executionStop(contractId, cursor.stage, error, input.signal);
    input.progress.recordStop(stop);
    const admitted = input.progress.checkpoint(contractId);
    if (admitted !== undefined) cursor.checkpoint = admitted;
    // Only this invocation's confirmed claim can complete the node after a trailing failure.
    if (admitted?.state.terminal?.kind === "claimed" && input.progress.hasFact(admitted.state.terminal)) {
      return completedResult(cursor);
    }
    return stoppedResult(cursor, stop);
  }
}
