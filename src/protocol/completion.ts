import type { ActorId, ContractId, SnapshotId } from "../core/facts/types.js";
import type { WorktreeLeak } from "../git/scratch.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { VerificationDeclarationPreparation } from "../verification/declaration.js";
import {
  currentVerifiedAttestation,
  verifyDelivery,
  type CurrentVerifiedAttestation,
  type VerificationCleanupFailure,
} from "./intent.js";
import { admitPlacement } from "./placement.js";
import { reintegrateOperation, type ReintegrationResult } from "./reintegrate.js";
import {
  beginCompletion,
  recordCompletionStep,
  type CompletionProgress,
  type ContractCheckpoint,
} from "./progress.js";
import type { PlacementStop, VerificationStop } from "./operations.js";
import { placementStop, timestamp, unpackVerificationOutcome } from "./operations.js";

const MAX_REINTEGRATION_CYCLES = 3;

export type CandidateCompletion = Readonly<{
  integration: SnapshotId;
  verification?: Readonly<{
    mode: "ran" | "reused";
    verdict: "satisfied" | "unsatisfied";
  }>;
}>;

export type CompletionEvidence = Readonly<{
  completion?: CandidateCompletion;
  verification?: VerificationStop;
  verificationReuse?: CurrentVerifiedAttestation;
  verificationSummary?: string;
  placement?: PlacementStop;
  cleanup?: VerificationCleanupFailure;
  leak?: WorktreeLeak;
}>;

type CompletionInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  contractId: ContractId;
  target?: string;
  actor?: ActorId;
  signal?: AbortSignal;
  verification: VerificationDeclarationPreparation;
  checkpoint: ContractCheckpoint;
  verifyInitial: boolean;
}>;

export type CompletionResult =
  | Readonly<{
      kind: "completed";
      progress: CompletionProgress;
      evidence: CompletionEvidence & Readonly<{ completion: CandidateCompletion }>;
    }>
  | Readonly<{
      kind: "stopped";
      progress: CompletionProgress;
      evidence: CompletionEvidence & Readonly<{ placement: PlacementStop }>;
    }>;

type CompletionVerification = Readonly<{
  mode: "ran" | "reused";
  verdict: "satisfied" | "unsatisfied";
  summary?: string;
}>;

function reintegrationStop(result: Exclude<ReintegrationResult, { kind: "accepted" }>): PlacementStop {
  if (result.kind === "placement-failed") {
    return { failure: "target-placement-failed", diagnostic: result.diagnostic };
  }
  if (result.kind === "refused") return { refusal: result.refusal };
  return { retry: result.reason };
}

async function verificationFor(
  input: CompletionInput,
  progress: CompletionProgress,
  snapshot: SnapshotId,
): Promise<
  Readonly<{
    progress: CompletionProgress;
    evidence: Omit<CompletionEvidence, "placement">;
    completionVerification?: CompletionVerification;
  }>
> {
  const current = currentVerifiedAttestation(progress.checkpoint.state);
  if (current !== undefined) {
    return {
      progress,
      evidence: { verificationReuse: current },
      completionVerification: {
        mode: "reused",
        verdict: current.verdict,
        ...(current.summary === undefined ? {} : { summary: current.summary }),
      },
    };
  }
  if (input.verification.kind === "refused") {
    return { progress, evidence: { verification: { refusal: input.verification.refusal } } };
  }
  const result = await verifyDelivery({
    channel: input.channel,
    repository: input.repository,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    state: progress.checkpoint.state,
    snapshot,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.verification.data === null ? {} : { verification: input.verification.data }),
  });
  if (result === null) return { progress, evidence: {} };
  const unpacked = unpackVerificationOutcome(result);
  return {
    progress: unpacked.admission === undefined ? progress : recordCompletionStep(progress, unpacked.admission),
    evidence: {
      ...(unpacked.stop === undefined ? {} : { verification: unpacked.stop }),
      ...(unpacked.counts?.verdict !== "unsatisfied" || unpacked.counts.summary === undefined
        ? {}
        : { verificationSummary: unpacked.counts.summary }),
      ...(unpacked.cleanup === undefined ? {} : { cleanup: unpacked.cleanup }),
      ...(unpacked.leak === undefined ? {} : { leak: unpacked.leak }),
    },
    ...(unpacked.counts === undefined
      ? {}
      : {
          completionVerification: {
            mode: "ran" as const,
            verdict: unpacked.counts.verdict,
            ...(unpacked.counts.summary === undefined ? {} : { summary: unpacked.counts.summary }),
          },
        }),
  };
}

function mergeEvidence(current: CompletionEvidence, next: CompletionEvidence): CompletionEvidence {
  const merged = { ...current, ...next };
  if (next.verification !== undefined) {
    const { verificationReuse: _ignored, ...withoutReuse } = merged;
    return withoutReuse;
  }
  if (next.verificationReuse !== undefined) {
    const { verification: _ignored, ...withoutVerification } = merged;
    return withoutVerification;
  }
  return merged;
}

function replaceVerificationEvidence(current: CompletionEvidence, next: CompletionEvidence): CompletionEvidence {
  const {
    verification: _verification,
    verificationReuse: _verificationReuse,
    verificationSummary: _verificationSummary,
    ...withoutVerification
  } = current;
  return mergeEvidence(withoutVerification, next);
}

function requiredPlacementStop(result: Parameters<typeof placementStop>[0]): PlacementStop {
  const stop = placementStop(result);
  if (stop === undefined) throw new Error("non-accepted placement is missing its stop");
  return stop;
}

function completedResult(
  progress: CompletionProgress,
  evidence: CompletionEvidence,
  completionVerification: CompletionVerification | undefined,
): Extract<CompletionResult, { kind: "completed" }> {
  const state = progress.checkpoint.state;
  const integration = state.currentIntegration?.snapshot;
  if (integration === undefined) throw new Error("accepted placement is missing its final integration");
  const current = completionVerification ?? currentVerifiedAttestation(state);
  const verification =
    current === undefined
      ? undefined
      : ({ mode: completionVerification?.mode ?? "reused", verdict: current.verdict } as const);
  const summary = current?.summary;
  return {
    kind: "completed",
    progress,
    evidence: {
      ...evidence,
      completion: {
        integration,
        ...(verification === undefined ? {} : { verification }),
      },
      ...(verification?.verdict !== "unsatisfied" || summary === undefined ? {} : { verificationSummary: summary }),
    },
  };
}

function stoppedResult(
  progress: CompletionProgress,
  evidence: CompletionEvidence,
  placement: PlacementStop,
): Extract<CompletionResult, { kind: "stopped" }> {
  return { kind: "stopped", progress, evidence: { ...evidence, placement } };
}

async function admitCurrentPlacement(input: CompletionInput) {
  return await admitPlacement({
    channel: input.channel,
    repository: input.repository,
    target: input.target,
    placement: {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
    },
  });
}

/** Advance a captured contract; an observation alone never becomes an admission. */
export async function completeCandidate(input: CompletionInput): Promise<CompletionResult> {
  if (input.checkpoint.state.id !== input.contractId) throw new Error("completion checkpoint contract mismatch");
  let progress = beginCompletion(input.checkpoint);
  let evidence: CompletionEvidence = {};
  let completionVerification: CompletionVerification | undefined;
  if (input.verifyInitial) {
    const snapshot = progress.checkpoint.state.currentIntegration?.snapshot;
    if (snapshot === undefined) throw new Error("accepted delivery is missing its current integration");
    const verified = await verificationFor(input, progress, snapshot);
    progress = verified.progress;
    evidence = mergeEvidence(evidence, verified.evidence);
    completionVerification = verified.completionVerification;
  }

  let placement = await admitCurrentPlacement(input);
  if (placement.kind === "accepted") {
    progress = recordCompletionStep(progress, placement);
    return completedResult(progress, evidence, completionVerification);
  }
  if (placement.kind !== "target-moved" || input.target === undefined || placement.observedTreeEqualsCandidate) {
    return stoppedResult(progress, evidence, requiredPlacementStop(placement));
  }

  let integratedAt: SnapshotId | undefined;
  for (let attempts = 1; attempts <= MAX_REINTEGRATION_CYCLES; attempts += 1) {
    const reintegrated = await reintegrateOperation({
      channel: input.channel,
      repository: input.repository,
      contractId: input.contractId,
      target: input.target,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    });
    if (reintegrated.kind !== "accepted") {
      return stoppedResult(progress, evidence, reintegrationStop(reintegrated));
    }
    progress = recordCompletionStep(progress, reintegrated);
    integratedAt = reintegrated.value.snapshot;
    const verified = await verificationFor(input, progress, reintegrated.value.snapshot);
    progress = verified.progress;
    evidence = replaceVerificationEvidence(evidence, verified.evidence);
    completionVerification = verified.completionVerification;

    placement = await admitCurrentPlacement(input);
    if (placement.kind === "accepted") {
      progress = recordCompletionStep(progress, placement);
      return completedResult(progress, evidence, completionVerification);
    }
    if (placement.kind !== "target-moved" || placement.observedTreeEqualsCandidate) {
      return stoppedResult(progress, evidence, requiredPlacementStop(placement));
    }
    if (attempts === MAX_REINTEGRATION_CYCLES) {
      return stoppedResult(progress, evidence, {
        failure: "target-moved",
        contractId: input.contractId,
        target: input.target,
        integratedAt: integratedAt!,
        observed: placement.observed,
        attempts,
        observedTreeEqualsCandidate: placement.observedTreeEqualsCandidate,
      });
    }
  }
  throw new Error("reintegration cycle bound was not enforced");
}
