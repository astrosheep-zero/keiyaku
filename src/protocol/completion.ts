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
import type { AcceptedProtocolStep } from "./outcome.js";
import type { PlacementStop, VerificationStop } from "./operations.js";
import { mergeAdmissions, placementStop, timestamp, unpackVerificationOutcome } from "./operations.js";

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
  initial: AcceptedProtocolStep;
  verifyInitial: boolean;
}>;

export type CompletionResult = Readonly<{
  admission: AcceptedProtocolStep;
  evidence: CompletionEvidence;
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
  admission: AcceptedProtocolStep,
  snapshot: SnapshotId,
): Promise<
  Readonly<{
    admission: AcceptedProtocolStep;
    evidence: Omit<CompletionEvidence, "placement">;
    completionVerification?: CompletionVerification;
  }>
> {
  const current = currentVerifiedAttestation(admission.state);
  if (current !== undefined) {
    return {
      admission,
      evidence: { verificationReuse: current },
      completionVerification: {
        mode: "reused",
        verdict: current.verdict,
        ...(current.summary === undefined ? {} : { summary: current.summary }),
      },
    };
  }
  if (input.verification.kind === "refused") {
    return { admission, evidence: { verification: { refusal: input.verification.refusal } } };
  }
  const result = await verifyDelivery({
    channel: input.channel,
    repository: input.repository,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    state: admission.state,
    snapshot,
    environment: process.env,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.verification.data === null ? {} : { verification: input.verification.data }),
  });
  if (result === null) return { admission, evidence: {} };
  const unpacked = unpackVerificationOutcome(result);
  return {
    admission: unpacked.admission === undefined ? admission : mergeAdmissions(admission, unpacked.admission),
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

function acceptedCompletion(
  admission: AcceptedProtocolStep,
  completionVerification: CompletionVerification | undefined,
): CompletionEvidence {
  const integration = admission.state.currentIntegration?.snapshot;
  if (integration === undefined) throw new Error("accepted placement is missing its final integration");
  const current = completionVerification ?? currentVerifiedAttestation(admission.state);
  const verification =
    current === undefined
      ? undefined
      : ({ mode: completionVerification?.mode ?? "reused", verdict: current.verdict } as const);
  const summary = current?.summary;
  return {
    completion: {
      integration,
      ...(verification === undefined ? {} : { verification }),
    },
    ...(verification?.verdict !== "unsatisfied" || summary === undefined ? {} : { verificationSummary: summary }),
  };
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

export async function completeCandidate(input: CompletionInput): Promise<CompletionResult> {
  let admission = input.initial;
  let evidence: CompletionEvidence = {};
  let completionVerification: CompletionVerification | undefined;
  if (input.verifyInitial) {
    const snapshot = admission.state.currentIntegration?.snapshot;
    if (snapshot === undefined) throw new Error("accepted delivery is missing its current integration");
    const verified = await verificationFor(input, admission, snapshot);
    admission = verified.admission;
    evidence = mergeEvidence(evidence, verified.evidence);
    completionVerification = verified.completionVerification;
  }

  let placement = await admitCurrentPlacement(input);
  if (placement.kind === "accepted") {
    admission = mergeAdmissions(admission, placement);
    return { admission, evidence: mergeEvidence(evidence, acceptedCompletion(admission, completionVerification)) };
  }
  if (placement.kind !== "target-moved" || input.target === undefined) {
    return { admission, evidence: mergeEvidence(evidence, { placement: requiredPlacementStop(placement) }) };
  }
  if (placement.observedTreeEqualsCandidate) {
    return { admission, evidence: mergeEvidence(evidence, { placement: requiredPlacementStop(placement) }) };
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
      return { admission, evidence: mergeEvidence(evidence, { placement: reintegrationStop(reintegrated) }) };
    }
    admission = mergeAdmissions(admission, reintegrated);
    integratedAt = reintegrated.value.snapshot;
    const verified = await verificationFor(input, admission, reintegrated.value.snapshot);
    admission = verified.admission;
    evidence = replaceVerificationEvidence(evidence, verified.evidence);
    completionVerification = verified.completionVerification;

    placement = await admitCurrentPlacement(input);
    if (placement.kind === "accepted") {
      admission = mergeAdmissions(admission, placement);
      return { admission, evidence: mergeEvidence(evidence, acceptedCompletion(admission, completionVerification)) };
    }
    if (placement.kind !== "target-moved") {
      return { admission, evidence: mergeEvidence(evidence, { placement: requiredPlacementStop(placement) }) };
    }
    if (placement.observedTreeEqualsCandidate) {
      return { admission, evidence: mergeEvidence(evidence, { placement: requiredPlacementStop(placement) }) };
    }
    if (attempts === MAX_REINTEGRATION_CYCLES) {
      return {
        admission,
        evidence: mergeEvidence(evidence, {
          placement: {
            failure: "target-moved",
            contractId: input.contractId,
            target: input.target,
            integratedAt: integratedAt!,
            observed: placement.observed,
            attempts,
            observedTreeEqualsCandidate: placement.observedTreeEqualsCandidate,
          },
        }),
      };
    }
  }
  throw new Error("reintegration cycle bound was not enforced");
}
