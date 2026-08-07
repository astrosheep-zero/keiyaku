import { randomBytes } from "node:crypto";
import { observeCarrierForAdmission, type CarrierDecisionObservation } from "../carrier/observe.js";
import type { GitRepository } from "../carrier/repository.js";
import { materializeVerificationCandidate } from "../carrier/verification.js";
import type { WorktreeLeak } from "../carrier/verification.js";
import type { AttemptContext, DecideInput, OfferDecision } from "../core/decide.js";
import { dependencyKeySet } from "../core/subject.js";
import type { ActorId, ContractId, ContractState, DependencyKeySet } from "../core/facts/types.js";
import { entryUlid, gate } from "../core/facts/types.js";
import { decidePlacement, type PlacementRefusal } from "../core/verbs/placement.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import {
  type ProduceVerificationInput,
  type VerificationNonterminalOutcome,
  type VerificationOutcome,
  type VerificationTerminalOutcome,
} from "../verification/producer.js";
import type { VerificationDefinition } from "../verification/types.js";
import { runProtocol, type ProtocolResult } from "./run.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1_000;
export const VERIFIED = gate("verified");

function nextEntryUlid(): ReturnType<typeof entryUlid> {
  let value = "";
  let time = BigInt(Date.now());
  for (let index = 0; index < 10; index += 1) {
    value = ALPHABET[Number(time & 31n)]! + value;
    time >>= 5n;
  }
  let random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  for (let index = 0; index < 16; index += 1) {
    value += ALPHABET[Number(random & 31n)]!;
    random >>= 5n;
  }
  return entryUlid(value);
}

const MAX_SEMANTIC_ATTEMPTS = 3;

export function mintAttempts(input: Readonly<{ entryCount: number }>): readonly AttemptContext[] {
  return Array.from({ length: MAX_SEMANTIC_ATTEMPTS }, () => ({
    entryUlids: Array.from({ length: input.entryCount }, nextEntryUlid),
  }));
}

type IntentAdmissionOptions = Readonly<{
  observedContracts?: readonly ContractId[];
  observe?: (repository: GitRepository, contracts: readonly ContractId[]) => CarrierDecisionObservation;
}>;

/** Observe, decide, and atomically admit one intent with bounded carrier retries. */
export function admitIntent<Input extends Readonly<{ contractId: ContractId }>, Refusal>(
  repository: GitRepository,
  input: Input,
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>,
  options: IntentAdmissionOptions = {},
): ProtocolResult<Refusal> {
  const contracts = options.observedContracts ?? [input.contractId];
  return runProtocol({
    input,
    repository,
    contracts,
    attempts: mintAttempts({ entryCount: 2 }),
    decide,
    ...(options.observe === undefined ? {} : { observe: options.observe }),
  });
}


/** Run the sole placement adjudicator; a gates-unsatisfied refusal is normal pending state. */
export function admitPlacement(
  repository: GitRepository,
  input: Readonly<{ contractId: ContractId; actor?: ActorId; at: string }>,
): ProtocolResult<PlacementRefusal> {
  return runProtocol({
    input,
    repository,
    contracts: [input.contractId],
    attempts: mintAttempts({ entryCount: 2 }),
    observe: observeCarrierForAdmission,
    extendAttempt: (attempt, observedContractCount) => ({
      ...attempt,
      entryUlids: [
        ...attempt.entryUlids,
        ...Array.from(
          { length: Math.max(0, observedContractCount - attempt.entryUlids.length) },
          nextEntryUlid,
        ),
      ],
    }),
    decide: decidePlacement,
  });
}

type VerifyDeliveryInput = Readonly<{
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
    { kind: "snapshot", value: state.delivery.data.candidate },
    { kind: "segment", value: input.verification.segment },
  ]);

  let prepared: ReturnType<typeof materializeVerificationCandidate>;
  try {
    prepared = materializeVerificationCandidate(input.repository, state.delivery.data.candidate);
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
      step = admitIntent(
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
