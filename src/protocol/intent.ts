import { z } from "zod";
import { executionStop, type ProtocolProgress, type VerificationCleanupFailure } from "./progress.js";
import type { GitDecisionObservation } from "../git/observe.js";
import type { GitDecodeChannel, GitTreeSelection } from "../git/read-observation.js";
import type { GitRepository } from "../git/process.js";
import { materializeScratchCandidate, type WorktreeLeak } from "../git/scratch.js";
import { projectSettings } from "../settings.js";
import type { DecideInput, OfferDecision } from "../core/decide.js";
import { activeContract, type ActiveContractRefusal } from "../core/facts/observation.js";
import { dependencyKeySet } from "../core/subject.js";
import type {
  ActorId,
  AttestationEntry,
  ContractId,
  DependencyKeySet,
  RequirementId,
  SnapshotId,
} from "../core/facts/types.js";
import { decideAttestation, type AttestationInput } from "../core/verbs/attestation.js";
import {
  executeVerification,
  type VerificationExecution,
  type VerificationTerminalOutcome,
} from "../verification/execution.js";
import { VERIFIED, type VerificationDeclaration } from "../verification/declaration.js";
import { runProtocol, type CompanionDecorator, type ProtocolPreparation, type ProtocolResult } from "./run.js";
import { mintAttempts } from "./attempt.js";

type CommonIntentAdmissionOptions<Refusal> = Readonly<{
  progress?: ProtocolProgress;
  observedContracts?: readonly ContractId[];
  observe?: (
    repository: GitRepository,
    channel: GitDecodeChannel,
    contracts: readonly ContractId[],
  ) => Promise<GitDecisionObservation>;
  decorateOffer?: CompanionDecorator;
  validateAdmission?: (observation: GitDecisionObservation) => Refusal | undefined | Promise<Refusal | undefined>;
  observationSelection?: GitTreeSelection;
}>;

export type IntentAdmissionOptions<Refusal = never> = CommonIntentAdmissionOptions<Refusal>;

type PreparedIntentAdmissionOptions<Input, Refusal, Seed, Prepared> = CommonIntentAdmissionOptions<Refusal> &
  Readonly<{ preparation: ProtocolPreparation<Input, Refusal, Seed, Prepared> }>;

function admissionOptions<Refusal>(
  options: CommonIntentAdmissionOptions<Refusal>,
): CommonIntentAdmissionOptions<Refusal> {
  return {
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    ...(options.observedContracts === undefined ? {} : { observedContracts: options.observedContracts }),
    ...(options.observe === undefined ? {} : { observe: options.observe }),
    ...(options.decorateOffer === undefined ? {} : { decorateOffer: options.decorateOffer }),
    ...(options.validateAdmission === undefined ? {} : { validateAdmission: options.validateAdmission }),
    ...(options.observationSelection === undefined ? {} : { observationSelection: options.observationSelection }),
  };
}

/** Observe, decide, and atomically admit one intent whose invocation already is its decision input. */
export function admitIntent<Input extends Readonly<{ contractId: ContractId }>, Refusal>(
  channel: GitDecodeChannel,
  repository: GitRepository,
  input: Input,
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>,
  options: IntentAdmissionOptions<Refusal> = {},
): Promise<ProtocolResult<Refusal>> {
  const contracts = options.observedContracts ?? [input.contractId];
  return runProtocol<Input, Refusal, Input, Input>({
    ...admissionOptions(options),
    input,
    channel,
    repository,
    contracts,
    attempts: mintAttempts({ entryCount: 1 }),
    decide,
  });
}

/**
 * Observe, decide, and atomically admit one intent whose repeatable preparation happens outside
 * the publication seat and whose decision input is assembled from the fresh in-custody observation.
 */
export function admitPreparedIntent<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
  Prepared,
>(
  channel: GitDecodeChannel,
  repository: GitRepository,
  input: Seed,
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>,
  options: PreparedIntentAdmissionOptions<Input, Refusal, Seed, Prepared>,
): Promise<ProtocolResult<Refusal>> {
  const contracts = options.observedContracts ?? [input.contractId];
  return runProtocol<Input, Refusal, Seed, Prepared>({
    ...admissionOptions(options),
    input,
    preparation: options.preparation,
    channel,
    repository,
    contracts,
    attempts: mintAttempts({ entryCount: 1 }),
    decide,
  });
}

type VerifyRequirementInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  snapshot: SnapshotId;
  requirement: RequirementId;
  declaration: VerificationDeclaration;
  index: number;
  total: number;
  signal?: AbortSignal;
  progress?: ProtocolProgress;
}>;

const verificationDiagnostic = z.string().refine((value) => value.trim() !== "");
export const verificationRuntimeStopSchema = z.union([
  z
    .object({ failure: z.enum(["unknown-exit", "cancelled"]), diagnostic: verificationDiagnostic.exactOptional() })
    .strict()
    .readonly(),
  z
    .object({ failure: z.enum(["candidate-unavailable", "spawn-error"]), diagnostic: verificationDiagnostic })
    .strict()
    .readonly(),
  z
    .object({ failure: z.literal("environment-failure"), diagnostic: verificationDiagnostic })
    .strict()
    .readonly(),
  z
    .object({
      failure: z.literal("environment-failure"),
      name: z.string().refine((value) => value.trim() !== ""),
      diagnostic: verificationDiagnostic,
    })
    .strict()
    .readonly(),
]);
type VerificationRuntimeStop = z.infer<typeof verificationRuntimeStopSchema>;
type VerificationReuseRefusal = Readonly<{ kind: "verification-reuse" }>;

type VerificationReuseStep = Readonly<{ kind: "reused" }>;
export type VerificationStep =
  | ProtocolResult<ActiveContractRefusal | VerificationReuseRefusal>
  | VerificationRuntimeStop
  | VerificationReuseStep;
export type VerificationResult = Readonly<{
  step: VerificationStep;
  reuse?: true;
  counts?: Readonly<{ verdict: "satisfied" | "unsatisfied"; summary?: string }>;
  cleanup?: VerificationCleanupFailure;
  leak?: WorktreeLeak;
}>;

function verificationInput(
  outcome: VerificationTerminalOutcome,
  input: Pick<VerifyRequirementInput, "contractId" | "actor" | "at" | "requirement">,
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
        requirement: input.requirement,
        subject,
        verdict: outcome.verdict,
        ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
      },
    },
  };
}

function reusableVerificationAttestation(
  current: AttestationEntry | undefined,
  subject: DependencyKeySet,
  verdict: "satisfied" | "unsatisfied",
  summary: string | undefined,
): true | undefined {
  if (
    current === undefined ||
    current.data.subject !== subject ||
    current.data.verdict !== verdict ||
    current.data.summary !== summary
  )
    return undefined;
  return true;
}

function retainVerificationReceipt(input: VerifyRequirementInput, step: VerificationStep): void {
  if (!("failure" in step) && step.kind === "accepted") input.progress?.recordResidue(input.contractId, step);
}

async function verificationStep(
  input: VerifyRequirementInput,
  execution: VerificationExecution,
  subject: DependencyKeySet,
): Promise<VerificationStep> {
  if (execution.outcome.kind === "terminal") {
    const { verdict, summary } = execution.outcome;
    const admission = await admitIntent<AttestationInput<never>, ActiveContractRefusal | VerificationReuseRefusal>(
      input.channel,
      input.repository,
      verificationInput(execution.outcome, input, subject),
      decideAttestation,
      {
        ...(input.progress === undefined ? {} : { progress: input.progress }),
        validateAdmission: (observation) => {
          const state = activeContract(observation.decision, input.contractId);
          if ("kind" in state) return undefined;
          const current = [...state.attestations]
            .reverse()
            .find(
              (attestation) =>
                attestation.data.gate === VERIFIED &&
                attestation.data.requirement === input.requirement &&
                attestation.data.subject === subject,
            );
          const reuse = reusableVerificationAttestation(current, subject, verdict, summary);
          return reuse === undefined ? undefined : { kind: "verification-reuse" };
        },
      },
    );
    if (admission.kind === "refused" && admission.refusal.kind === "verification-reuse") {
      return { kind: "reused" };
    }
    return admission;
  }
  if (execution.outcome.kind === "candidate-unavailable")
    return { failure: "candidate-unavailable", diagnostic: execution.outcome.diagnostic };
  if (execution.outcome.kind === "environment-failure") {
    return {
      failure: "environment-failure",
      ...("name" in execution.outcome ? { name: execution.outcome.name } : {}),
      diagnostic: execution.outcome.diagnostic,
    };
  }
  if (execution.outcome.kind === "spawn-error")
    return { failure: "spawn-error", diagnostic: execution.outcome.diagnostic };
  if (execution.outcome.kind === "unknown-exit" || execution.outcome.kind === "cancelled")
    return {
      failure: execution.outcome.kind,
      ...(execution.outcome.diagnostic === undefined ? {} : { diagnostic: execution.outcome.diagnostic }),
    };
  throw new Error("Verification execution returned an invalid outcome");
}

function verificationCounts(execution: VerificationExecution): VerificationResult["counts"] {
  if (execution.outcome.kind !== "terminal") return undefined;
  return {
    verdict: execution.outcome.verdict,
    ...(execution.outcome.summary === undefined ? {} : { summary: execution.outcome.summary }),
  };
}

/** Execute and admit one declaration before its caller schedules another check. */
export async function verifyRequirement(input: VerifyRequirementInput): Promise<VerificationResult> {
  const snapshot = input.snapshot;
  const subject = dependencyKeySet([{ kind: "snapshot", value: snapshot }]);

  const execution = await executeVerification({
    repository: input.repository,
    candidate: snapshot,
    contractId: input.contractId,
    declaration: input.declaration,
    requirement: input.requirement,
    index: input.index,
    total: input.total,
    materializeScratchCandidate,
    projectSettings,
    observe: (observation) =>
      input.progress?.observe({ kind: "verification", contractId: input.contractId, snapshot, observation }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  input.progress?.recordVerification(input.contractId, snapshot, execution, {
    requirement: input.requirement,
    index: input.index,
  });
  let step: VerificationStep;
  try {
    step = await verificationStep(input, execution, subject);
  } catch (error) {
    const stop = executionStop(input.contractId, error, input.signal);
    if (stop.reason !== "cancelled") throw error;
    input.progress?.recordStop(stop);
    step = { failure: "cancelled" };
  }
  const counts = verificationCounts(execution);
  retainVerificationReceipt(input, step);
  return {
    step,
    ...("kind" in step && step.kind === "reused" ? { reuse: true } : {}),
    ...(counts === undefined ? {} : { counts }),
    ...(execution.cleanup === undefined ? {} : { cleanup: execution.cleanup }),
    ...(execution.leak === undefined ? {} : { leak: execution.leak }),
  };
}
