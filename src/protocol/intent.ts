import type { GitDecisionObservation } from "../git/observe.js";
import type { GitDecodeChannel, GitTreeSelection } from "../git/read-observation.js";
import type { GitRepository } from "../git/repository.js";
import type { GitRefAssertion } from "../git/repository.js";
import { materializeVerificationCandidate } from "../git/verification.js";
import type { WorktreeLeak } from "../git/verification.js";
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

const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1_000;

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
  verification?: VerificationDefinition;
}>;

export type VerificationRuntimeStop = Readonly<{
  failure: "timeout" | "unknown-exit";
}> | Readonly<{
  failure: "candidate-unavailable" | "spawn-error";
  diagnostic: string;
}>;

export type VerificationStep = ProtocolResult<AttestationRefusal> | VerificationRuntimeStop;
export type VerificationResult = Readonly<{
  step: VerificationStep;
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

  let prepared: ReturnType<typeof materializeVerificationCandidate>;
  try {
    prepared = materializeVerificationCandidate(input.repository, state.delivery.data.integration.snapshot);
  } catch (error) {
    return {
      step: {
        failure: "candidate-unavailable",
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
  let step: VerificationStep;
  let leak: WorktreeLeak | null = null;
  try {
    const outcome = await input.produce({
      declarations: input.verification.declarations,
      cwd: prepared.cwd,
      timeoutMs: VERIFICATION_TIMEOUT_MS,
      env: input.environment,
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
  } finally {
    leak = prepared.dispose();
  }
  return {
    step,
    ...(leak === null ? {} : { leak }),
  };
}
