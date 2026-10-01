import { z } from "zod";
import { snapshotIdSchema, verdictSchema, verificationStopSchema, placementStopSchema } from "./operations.js";
import { verificationReuseSchema } from "./intent.js";
import type { ActorId, ContractId, EntryUlid } from "../core/facts/types.js";
import { deliveryDiffScopeSchema, readDeliveryScope } from "../git/integration.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { currentVerifiedAttestation, verifyDelivery } from "./intent.js";
import { admitPlacement, observeTargetPlacement } from "./placement.js";
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
import type { DocumentDerivation, PlacementStop, VerificationStop } from "./operations.js";
import { placementStop, timestamp, unpackVerificationOutcome } from "./operations.js";
import { VERIFIED } from "../verification/declaration.js";

const MAX_REINTEGRATION_CYCLES = 3;

const verdictProvenanceSchema = z.object({ mode: z.enum(["ran", "reused"]), verdict: verdictSchema }).strict();
const candidateCompletionSchema = z
  .object({
    integration: snapshotIdSchema,
    predecessor: snapshotIdSchema.optional(),
    target: z
      .string()
      .refine((value) => value.trim() !== "")
      .optional(),
    scope: deliveryDiffScopeSchema.omit({ paths: true }).optional(),
    verification: verdictProvenanceSchema.optional(),
  })
  .strict();
export type CandidateCompletion = z.infer<typeof candidateCompletionSchema>;
const verificationSubjectSchema = verdictProvenanceSchema.extend({ snapshot: snapshotIdSchema }).strict();
type VerificationSubject = z.infer<typeof verificationSubjectSchema>;
export const completionEvidenceSchema = z
  .object({
    completion: candidateCompletionSchema.optional(),
    verification: verificationStopSchema.optional(),
    verificationReuse: verificationReuseSchema.optional(),
    verificationSubject: verificationSubjectSchema.optional(),
    verificationSummary: z
      .string()
      .refine((value) => value.trim() !== "")
      .optional(),
    placement: placementStopSchema.optional(),
  })
  .strict();
export type CompletionEvidence = z.infer<typeof completionEvidenceSchema>;
export type CompletionInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  checkpoint: ContractCheckpoint;
  progress: ProtocolProgress;
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
      stop: PlacementStop | VerificationStop | ExecutionStop;
    }>;

// A cursor controls this node only; it is neither a receipt nor a persisted lifecycle.
type CompletionCursor = {
  checkpoint: ContractCheckpoint;
  evidence: CompletionEvidence;
  ran: EntryUlid | undefined;
  completion?: CandidateCompletion;
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
  input.progress.recordCandidate(state.id, cursor.evidence);
  const current = currentVerifiedAttestation(state);
  if (current !== undefined) {
    cursor.evidence = {
      verificationReuse: current,
      verificationSubject: { snapshot, mode: "reused", verdict: current.verdict },
    };
    input.progress.recordCandidate(state.id, cursor.evidence);
    return;
  }
  const declaration = input.deriveDocument(state).verification;
  if (declaration.kind === "refused") {
    cursor.evidence = { verification: { refusal: declaration.refusal } };
    input.progress.recordCandidate(state.id, cursor.evidence);
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
  const subject: VerificationSubject | undefined =
    verified.reuse !== undefined
      ? { snapshot, mode: "reused", verdict: verified.reuse.verdict }
      : verified.counts === undefined
        ? undefined
        : { snapshot, mode: "ran", verdict: verified.counts.verdict };
  cursor.evidence = {
    ...(verified.reuse === undefined ? {} : { verificationReuse: verified.reuse }),
    ...(subject === undefined ? {} : { verificationSubject: subject }),
    ...(verified.stop === undefined ? {} : { verification: verified.stop }),
    ...(verified.counts?.verdict !== "unsatisfied" || verified.counts.summary === undefined
      ? {}
      : { verificationSummary: verified.counts.summary }),
  };
  input.progress.recordCandidate(state.id, cursor.evidence);
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
    ...(predecessor === undefined || target === undefined ? {} : { predecessor, target }),
  };
  input.progress.recordCompletion(state.id, cursor.completion);
  // Never attach a superseded run's verdict to the final integration.
  const current = currentVerifiedAttestation(state);
  const verification =
    current === undefined
      ? undefined
      : {
          mode: cursor.ran === current.entry ? ("ran" as const) : ("reused" as const),
          verdict: current.verdict,
        };
  cursor.completion = { ...cursor.completion, ...(verification === undefined ? {} : { verification }) };
  input.progress.recordCompletion(state.id, cursor.completion);
  const scope =
    predecessor === undefined ? undefined : await readDeliveryScope(input.repository, predecessor, integration, false);
  const {
    verificationSummary: _oldSummary,
    verificationReuse: _oldReuse,
    verificationSubject: _oldSubject,
    ...evidence
  } = cursor.evidence;
  const completion: CandidateCompletion = {
    integration,
    ...(predecessor === undefined || target === undefined ? {} : { predecessor, target }),
    ...(scope === undefined
      ? {}
      : { scope: { filesChanged: scope.filesChanged, insertions: scope.insertions, deletions: scope.deletions } }),
    ...(verification === undefined ? {} : { verification }),
  };
  cursor.completion = completion;
  input.progress.recordCompletion(state.id, completion);
  return {
    kind: "completed",
    checkpoint: cursor.checkpoint,
    evidence: {
      ...evidence,
      completion,
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

/** Verification blocks completion only when the Contract selected the verified gate; placement owns gate eligibility. */
function verificationBlocks(state: ContractCheckpoint["state"]): boolean {
  return state.terms.gates.includes(VERIFIED);
}

async function verifyCandidateReadiness(
  input: CompletionInput,
  cursor: CompletionCursor,
): Promise<CompletionResult | undefined> {
  const observedPlacement = await observeCandidateTarget(input, cursor);
  await verifyCurrentCandidate(input, cursor);
  const verification = cursor.evidence.verification;
  const blocking = verification !== undefined && verificationBlocks(cursor.checkpoint.state);
  if (blocking || observedPlacement !== undefined) {
    return {
      kind: "stopped",
      checkpoint: cursor.checkpoint,
      evidence: { ...cursor.evidence, ...(observedPlacement === undefined ? {} : { placement: observedPlacement }) },
      stop: blocking ? verification! : observedPlacement!,
    };
  }
  return undefined;
}

async function advanceCandidate(input: CompletionInput, cursor: CompletionCursor): Promise<CompletionResult> {
  if (input.start === "verification") {
    const stopped = await verifyCandidateReadiness(input, cursor);
    if (stopped !== undefined) return stopped;
  }
  const target = cursor.checkpoint.state.coordinates.target;
  let placement = await placeCurrentCandidate(input, cursor);
  for (let cycles = 0; ; cycles += 1) {
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
    const stopped = await verifyCandidateReadiness(input, cursor);
    if (stopped !== undefined) return stopped;
    placement = await placeCurrentCandidate(input, cursor);
  }
}

/** Advance one contract. The trigger owns the leading act; this node owns no other contract. */
export async function completeCandidate(input: CompletionInput): Promise<CompletionResult> {
  const cursor: CompletionCursor = { checkpoint: input.checkpoint, evidence: {}, ran: undefined, stage: "placement" };
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
          ...(target === undefined ? {} : { target, predecessor: integration.predecessor }),
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
