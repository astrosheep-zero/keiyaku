import type { ExecutionProgress } from "./progress.js";
import type { GitDecisionObservation } from "../git/observe.js";
import type { GitDecodeChannel, GitTreeSelection } from "../git/read-observation.js";
import type { GitRepository } from "../git/process.js";
import type { GitRefAssertion } from "../git/repository.js";
import { materializeScratchCandidate, type WorktreeLeak } from "../git/scratch.js";
import type { HookFailure } from "../git/hooks.js";
import { projectSettings } from "../settings.js";
import type { DecideInput, OfferDecision } from "../core/decide.js";
import { dependencyKeySet } from "../core/subject.js";
import type {
  ActorId,
  ContractId,
  ContractState,
  DependencyKeySet,
  EntryUlid,
  SnapshotId,
} from "../core/facts/types.js";
import { latestCurrentAttestations } from "../core/facts/gate.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import {
  executeVerification,
  type VerificationNonterminalOutcome,
  type VerificationTerminalOutcome,
} from "../verification/execution.js";
import { VERIFIED, type VerificationDefinition } from "../verification/declaration.js";
import { runProtocol, type CompanionDecorator, type ProtocolResult } from "./run.js";
import { mintAttempts } from "./attempt.js";

type IntentAdmissionOptions<Input, Refusal, Seed> = Readonly<{
  progress?: ExecutionProgress;
  observedContracts?: readonly ContractId[];
  observe?: (
    repository: GitRepository,
    channel: GitDecodeChannel,
    contracts: readonly ContractId[],
  ) => Promise<GitDecisionObservation>;
  decorateOffer?: CompanionDecorator;
  validateAdmission?: (observation: GitDecisionObservation) => Refusal | undefined | Promise<Refusal | undefined>;
  observationSelection?: GitTreeSelection;
  prepareInput?: (
    observation: GitDecisionObservation,
    input: Seed,
  ) =>
    | Readonly<{ kind: "prepared"; input: Input; assertions?: readonly GitRefAssertion[] }>
    | Readonly<{ kind: "refused"; refusal: Refusal }>
    | Promise<
        | Readonly<{ kind: "prepared"; input: Input; assertions?: readonly GitRefAssertion[] }>
        | Readonly<{ kind: "refused"; refusal: Refusal }>
      >;
}>;

/** Observe, decide, and atomically admit one intent with bounded Git retries. */
export function admitIntent<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
>(
  channel: GitDecodeChannel,
  repository: GitRepository,
  input: Seed,
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>,
  options: IntentAdmissionOptions<Input, Refusal, Seed> = {},
): Promise<ProtocolResult<Refusal>> {
  const contracts = options.observedContracts ?? [input.contractId];
  return runProtocol({
    input,
    channel,
    repository,
    contracts,
    attempts: mintAttempts({ entryCount: 2 }),
    decide,
    progress: options.progress,
    ...(options.observe === undefined ? {} : { observe: options.observe }),
    ...(options.decorateOffer === undefined ? {} : { decorateOffer: options.decorateOffer }),
    ...(options.validateAdmission === undefined ? {} : { validateAdmission: options.validateAdmission }),
    ...(options.observationSelection === undefined ? {} : { observationSelection: options.observationSelection }),
    ...(options.prepareInput === undefined ? {} : { prepareInput: options.prepareInput }),
  });
}

type VerifyDeliveryInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  state: ContractState;
  snapshot?: SnapshotId;
  signal?: AbortSignal;
  verification?: VerificationDefinition;
  progress?: ExecutionProgress;
}>;

export type VerificationRuntimeStop =
  | Readonly<{
      failure: "unknown-exit" | "cancelled";
    }>
  | Readonly<{
      failure: "candidate-unavailable" | "spawn-error";
      diagnostic: string;
    }>
  | Readonly<{
      failure: "environment-failure";
      diagnostic: string;
    }>
  | Readonly<{
      failure: "environment-failure";
      command: number;
      detail: HookFailure;
    }>;

export type VerificationCleanupFailure = Readonly<{
  phase: "destroy";
  command: number;
  detail: HookFailure;
}>;

export type VerificationStep = ProtocolResult<AttestationRefusal> | VerificationRuntimeStop;
export type VerificationResult = Readonly<{
  step: VerificationStep;
  counts?: Readonly<{ passed: number; total: number; verdict: "satisfied" | "unsatisfied"; summary?: string }>;
  cleanup?: VerificationCleanupFailure;
  leak?: WorktreeLeak;
}>;

function runtimeStop(outcome: VerificationNonterminalOutcome): VerificationRuntimeStop {
  return outcome.kind === "spawn-error"
    ? { failure: outcome.kind, diagnostic: outcome.diagnostic }
    : { failure: outcome.kind };
}

function verificationInput(
  outcome: VerificationTerminalOutcome,
  input: Pick<VerifyDeliveryInput, "contractId" | "actor" | "at">,
  subject: DependencyKeySet,
): AttestationInput {
  return {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: input.at,
    preparation: {
      kind: "prepared",
      data: {
        gate: VERIFIED,
        subject,
        verdict: outcome.verdict,
        ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
      },
    },
  };
}

export type CurrentVerifiedAttestation = Readonly<{
  entry: EntryUlid;
  verdict: "satisfied" | "unsatisfied";
  summary?: string;
}>;

/** Read the latest current verified attestation through the generic currentness judge. */
export function currentVerifiedAttestation(state: ContractState): CurrentVerifiedAttestation | undefined {
  const current = latestCurrentAttestations(state, new Set([VERIFIED])).get(VERIFIED);
  return current === undefined
    ? undefined
    : {
        entry: current.entry,
        verdict: current.data.verdict,
        ...(current.data.summary === undefined ? {} : { summary: current.data.summary }),
      };
}

/** Run Verification against an explicit or admitted integration snapshot. */
export async function verifyDelivery(input: VerifyDeliveryInput): Promise<VerificationResult | null> {
  const snapshot = input.snapshot ?? input.state.currentIntegration?.snapshot;
  if (snapshot === undefined || input.verification === undefined) return null;
  const subject = dependencyKeySet([
    { kind: "snapshot", value: snapshot },
    { kind: "segment", value: input.verification.segment },
  ]);

  const execution = await executeVerification({
    repository: input.repository,
    candidate: snapshot,
    declarations: input.verification.declarations,
    materializeScratchCandidate,
    projectSettings,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  input.progress?.recordVerification(input.contractId, snapshot, execution);
  let step: VerificationStep;
  if (execution.outcome.kind === "terminal") {
    step = await admitIntent<AttestationInput<never>, AttestationRefusal>(
      input.channel,
      input.repository,
      verificationInput(execution.outcome, input, subject),
      decideAttestation,
      { progress: input.progress },
    );
  } else if (execution.outcome.kind === "candidate-unavailable") {
    step = { failure: "candidate-unavailable", diagnostic: execution.outcome.diagnostic };
  } else if (execution.outcome.kind === "environment-failure") {
    step =
      "diagnostic" in execution.outcome
        ? { failure: "environment-failure", diagnostic: execution.outcome.diagnostic }
        : { failure: "environment-failure", command: execution.outcome.command, detail: execution.outcome.detail };
  } else if (
    execution.outcome.kind === "unknown-exit" ||
    execution.outcome.kind === "cancelled" ||
    execution.outcome.kind === "spawn-error"
  ) {
    step = runtimeStop(execution.outcome);
  } else {
    throw new Error("Verification execution returned an invalid outcome");
  }
  if (!("failure" in step) && step.kind === "accepted") input.progress?.recordResidue(input.contractId, step);
  return {
    step,
    ...(execution.outcome.kind === "terminal"
      ? {
          counts: {
            passed: execution.outcome.passed,
            total: execution.outcome.total,
            verdict: execution.outcome.verdict,
            ...(execution.outcome.summary === undefined ? {} : { summary: execution.outcome.summary }),
          },
        }
      : {}),
    ...(execution.cleanup === undefined ? {} : { cleanup: execution.cleanup }),
    ...(execution.leak === undefined ? {} : { leak: execution.leak }),
  };
}
