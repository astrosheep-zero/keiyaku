import type { GitDecisionObservation } from "../git/observe.js";
import type { GitDecodeChannel, GitTreeSelection } from "../git/read-observation.js";
import type { GitRepository } from "../git/repository.js";
import type { GitRefAssertion } from "../git/repository.js";
import { materializeScratchCandidate } from "../git/verification.js";
import type { WorktreeLeak } from "../git/verification.js";
import { runHookCommands, worktreeHooksFrom, type HookFailure, type WorktreeHooks } from "../git/hooks.js";
import { projectSettings } from "../settings.js";
import type { DecideInput, OfferDecision } from "../core/decide.js";
import { dependencyKeySet } from "../core/subject.js";
import type { ActorId, ContractId, ContractState, DependencyKeySet } from "../core/facts/types.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import {
  type ProduceVerificationInput,
  type VerificationNonterminalOutcome,
  type VerificationOutcome,
  type VerificationTerminalOutcome,
} from "../verification/producer.js";
import { VERIFIED, type VerificationDefinition } from "../verification/declaration.js";
import { runProtocol, type CompanionDecorator, type ProtocolResult } from "./run.js";
import { mintAttempts } from "./attempt.js";

type IntentAdmissionOptions<Input, Refusal, Seed> = Readonly<{
  observedContracts?: readonly ContractId[];
  observe?: (repository: GitRepository, channel: GitDecodeChannel, contracts: readonly ContractId[]) => Promise<GitDecisionObservation>;
  decorateOffer?: CompanionDecorator;
  observationSelection?: GitTreeSelection;
  prepareInput?: (
    observation: GitDecisionObservation,
    input: Seed,
  ) => Readonly<{ kind: "prepared"; input: Input; assertions?: readonly GitRefAssertion[] }>
    | Readonly<{ kind: "refused"; refusal: Refusal }>
    | Promise<
        Readonly<{ kind: "prepared"; input: Input; assertions?: readonly GitRefAssertion[] }>
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
    ...(options.observe === undefined ? {} : { observe: options.observe }),
    ...(options.decorateOffer === undefined ? {} : { decorateOffer: options.decorateOffer }),
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
  environment: NodeJS.ProcessEnv;
  produce: (input: ProduceVerificationInput) => Promise<VerificationOutcome>;
  signal?: AbortSignal;
  verification?: VerificationDefinition;
}>;

export type VerificationRuntimeStop = Readonly<{
  failure: "unknown-exit" | "cancelled";
}> | Readonly<{
  failure: "candidate-unavailable" | "spawn-error";
  diagnostic: string;
}> | Readonly<{
  failure: "environment-failure";
  diagnostic: string;
}> | Readonly<{
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

/** Run Verification for an observed delivery, then tender its fact. */
export async function verifyDelivery(
  input: VerifyDeliveryInput,
): Promise<VerificationResult | null> {
  const state = input.state;
  if (
    state.delivery === null
    || input.verification === undefined
  ) return null;
  const subject = dependencyKeySet([
    { kind: "snapshot", value: state.delivery.data.integration.snapshot },
    { kind: "segment", value: input.verification.segment },
  ]);

  let prepared: ReturnType<typeof materializeScratchCandidate>;
  try {
    prepared = materializeScratchCandidate(input.repository, state.delivery.data.integration.snapshot);
  } catch (error) {
    return {
      step: {
        failure: "candidate-unavailable",
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
  let step: VerificationStep | undefined;
  let cleanup: VerificationCleanupFailure | undefined;
  let leak: WorktreeLeak | null = null;
  let hooks: WorktreeHooks | undefined;
  try {
    try {
      hooks = worktreeHooksFrom({ settings: projectSettings(prepared.cwd) });
    } catch (error) {
      step = {
        failure: "environment-failure",
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
    if (hooks !== undefined) {
      const readiness = await runHookCommands(prepared.cwd, hooks.create, input.signal);
      if (readiness.kind === "cancelled") {
        step = { failure: "cancelled" };
      } else if (readiness.kind === "failed") {
        step = { failure: "environment-failure", command: readiness.command, detail: readiness.failure };
      } else {
        const outcome = await input.produce({
          declarations: input.verification.declarations,
          cwd: prepared.cwd,
          env: input.environment,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        if (outcome.kind === "terminal") {
          step = await admitIntent<AttestationInput<never>, AttestationRefusal>(
            input.channel,
            input.repository,
            verificationInput(outcome, input, subject),
            decideAttestation,
          );
        } else {
          step = runtimeStop(outcome);
        }
      }
    }
  } finally {
    if (hooks !== undefined) {
      const destroy = await runHookCommands(prepared.cwd, hooks.destroy);
      if (destroy.kind === "cancelled") throw new Error("scratch destroy cancelled without a signal");
      if (destroy.kind === "failed") cleanup = { phase: "destroy", command: destroy.command, detail: destroy.failure };
    }
    const removeLeak = prepared.dispose();
    if (removeLeak !== null) leak = removeLeak;
  }
  if (step === undefined) throw new Error("Verification ended without an outcome");
  return {
    step,
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(leak === null ? {} : { leak }),
  };
}
