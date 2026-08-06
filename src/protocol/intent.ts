import { randomBytes } from "node:crypto";
import { observeCarrier, observeContract } from "../carrier/observe.js";
import type { DeliveryPreparation } from "../carrier/delivery.js";
import type { GitRepository } from "../carrier/repository.js";
import { prepareStoredVerification } from "../carrier/verification.js";
import type { DecideInput, OfferDecision } from "../core/decide.js";
import { gateSatisfied, gatesSatisfied } from "../core/facts/gate.js";
import { placeEligibleBounds } from "../core/facts/eligibility.js";
import { currentSubject } from "../core/subject.js";
import type { ContractId, ContractState, SubjectKey } from "../core/facts/types.js";
import { entryUlid } from "../core/facts/types.js";
import { decidePlacement, type PlacementRefusal } from "../core/verbs/placement.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import type {
  ProduceVerificationInput, VerificationOutcome, VerificationSpawnErrorOutcome, VerificationTerminalOutcome, VerificationTimeoutOutcome, VerificationUnknownExitOutcome,
} from "../verification/producer.js";
import { runProtocol, type AttemptContext, type ProtocolResult } from "./run.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1_000;
const VERIFICATION_OUTPUT_LIMIT_BYTES = 64 * 1024;

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

function attempts(entryCount: number): readonly AttemptContext[] {
  return [0, 1, 2].map((ordinal) => ({
    ordinal,
    entryUlids: Array.from({ length: entryCount }, nextEntryUlid),
  }));
}

/** Observe, decide, and atomically admit one intent with bounded carrier retries. */
export function runIntent<Input, Refusal>(
  repository: GitRepository,
  contract: ContractId,
  input: Input,
  decide: (input: DecideInput<Input>) => OfferDecision<null, Refusal>,
  eligibility = false,
): ProtocolResult<null, Refusal> {
  const contracts = [contract];
  return runProtocol({
    input,
    repository,
    contracts,
    attempts: attempts(contracts.length + 2),
    ...(eligibility ? {
      observe: observeCarrier,
      extendAttempt: (attempt: AttemptContext, requiredEntries: number): AttemptContext => {
        if (attempt.entryUlids.length >= requiredEntries) return attempt;
        return {
          ...attempt,
          entryUlids: [
            ...attempt.entryUlids,
            ...Array.from({ length: requiredEntries - attempt.entryUlids.length }, nextEntryUlid),
          ],
        };
      },
    } : {}),
    decide: eligibility
      ? (decisionInput) => {
        const decision = decide(decisionInput);
        return decision.kind === "offer"
          ? { ...decision, offer: placeEligibleBounds(decision.offer, decisionInput.observation, decisionInput.attempt) }
          : decision;
      }
      : decide,
  });
}

type ContractIntent = Readonly<{ contractId: ContractId }>;

type IntentDecision<Input, Refusal> = (input: DecideInput<Input>) => OfferDecision<null, Refusal>;

export function admitBind<Input extends ContractIntent, Refusal>(
  repository: GitRepository,
  input: Input,
  decide: IntentDecision<Input, Refusal>,
): ProtocolResult<null, Refusal> {
  return runIntent(repository, input.contractId, input, decide, true);
}

export function admitAmend<Input extends ContractIntent, Refusal>(
  repository: GitRepository,
  input: Input,
  decide: IntentDecision<Input, Refusal>,
): ProtocolResult<null, Refusal> {
  return runIntent(repository, input.contractId, input, decide, true);
}

export function admitDeliver<Input extends ContractIntent, Refusal>(
  repository: GitRepository,
  input: Input,
  decide: IntentDecision<Input, Refusal>,
): ProtocolResult<null, Refusal> {
  return runIntent(repository, input.contractId, input, decide);
}

export function admitAbandon<Input extends ContractIntent, Refusal>(
  repository: GitRepository,
  input: Input,
  decide: IntentDecision<Input, Refusal>,
): ProtocolResult<null, Refusal> {
  return runIntent(repository, input.contractId, input, decide);
}

export function admitArc<Input extends ContractIntent, Refusal>(
  repository: GitRepository,
  input: Input,
  decide: IntentDecision<Input, Refusal>,
): ProtocolResult<null, Refusal> {
  return runIntent(repository, input.contractId, input, decide);
}

export function admitReview<Input extends ContractIntent, Refusal>(
  repository: GitRepository,
  input: Input,
  decide: IntentDecision<Input, Refusal>,
): ProtocolResult<null, Refusal> {
  return runIntent(repository, input.contractId, input, decide);
}

export function placeIfEligible(
  repository: GitRepository,
  input: Readonly<{ contractId: ContractId; actor?: string; at: string }>,
): ProtocolResult<null, PlacementRefusal> | null {
  const state = observeContract(repository, input.contractId).state;
  if (!state || state.terminal || !gatesSatisfied(state)) return null;
  return runIntent(repository, input.contractId, input, decidePlacement, true);
}

export type VerifyPreparedDeliveryInput = Readonly<{
  repository: GitRepository;
  contractId: ContractId;
  actor?: string;
  at: string;
  prepared: Extract<DeliveryPreparation, { kind: "prepared" }>;
  environment: NodeJS.ProcessEnv;
  produce: (input: ProduceVerificationInput) => Promise<VerificationOutcome>;
}>;

export type VerifyStoredDeliveryInput = Readonly<{
  repository: GitRepository;
  contractId: ContractId;
  actor?: string;
  at: string;
  state: ContractState;
  environment: NodeJS.ProcessEnv;
  produce: (input: ProduceVerificationInput) => Promise<VerificationOutcome>;
}>;

type VerificationAdmissionInput = Readonly<{
  contractId: ContractId;
  actor?: string;
  at: string;
}>;

type VerificationAuditAttempt = Readonly<{
  failure: "timeout" | "spawn-error" | "unknown-exit";
}>;

function auditAttempt(
  outcome: VerificationTimeoutOutcome | VerificationSpawnErrorOutcome | VerificationUnknownExitOutcome,
): VerificationAuditAttempt {
  switch (outcome.kind) {
    case "timeout": return { failure: "timeout" };
    case "spawn-error": return { failure: "spawn-error" };
    case "unknown-exit": return { failure: "unknown-exit" };
  }
}

function verificationInput(
  outcome: VerificationTerminalOutcome,
  input: VerificationAdmissionInput,
  subject: SubjectKey,
): AttestationInput {
  return {
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: input.at,
    data: {
      gate: "verified" as const,
      subject,
      verdict: outcome.verdict,
      summary: outcome.summary,
    },
  };
}

/** Run the declarations pinned by an admitted delivery, then tender their fact. */
export async function verifyPreparedDelivery(
  input: VerifyPreparedDeliveryInput,
): Promise<ProtocolResult<null, AttestationRefusal> | null> {
  const current = observeContract(input.repository, input.contractId).state;
  if (
    !current
    || current.terminal
    || current.delivery === null
    || current.delivery.data.candidate !== input.prepared.delivery.candidate
    || current.body === null
    || current.body.verification.length === 0
  ) return null;
  if (gateSatisfied(current, "verified")) return null;
  const subject = currentSubject(current, "verified");
  if (subject === null) throw new Error("verified subject requires a delivery and body");

  const prepared = prepareStoredVerification(input.repository, current);
  if (prepared === null) return null;
  try {
    const outcome = await input.produce({
      candidateTree: prepared.candidateTree,
      declarations: current.body.verification,
      cwd: prepared.cwd,
      timeoutMs: VERIFICATION_TIMEOUT_MS,
      stdoutLimitBytes: VERIFICATION_OUTPUT_LIMIT_BYTES,
      stderrLimitBytes: VERIFICATION_OUTPUT_LIMIT_BYTES,
      env: input.environment,
    });
    if (outcome.kind !== "terminal") return null;
    return runIntent(input.repository, input.contractId, verificationInput(outcome, input, subject), decideAttestation);
  } finally {
    prepared.dispose();
  }
}

/** Run Verification for the current stored delivery, then tender its fact. */
export async function verifyStoredDelivery(
  input: VerifyStoredDeliveryInput,
): Promise<ProtocolResult<null, AttestationRefusal> | VerificationAuditAttempt | null> {
  const state = input.state;
  if (
    state.terminal
    || state.delivery === null
    || state.body === null
    || state.body.verification.length === 0
    || gateSatisfied(state, "verified")
  ) return null;
  const subject = currentSubject(state, "verified");
  if (subject === null) throw new Error("verified subject requires a delivery and body");

  const prepared = prepareStoredVerification(input.repository, state);
  if (prepared === null) return null;
  try {
    const outcome = await input.produce({
      candidateTree: prepared.candidateTree,
      declarations: state.body.verification,
      cwd: prepared.cwd,
      timeoutMs: VERIFICATION_TIMEOUT_MS,
      stdoutLimitBytes: VERIFICATION_OUTPUT_LIMIT_BYTES,
      stderrLimitBytes: VERIFICATION_OUTPUT_LIMIT_BYTES,
      env: input.environment,
    });
    if (outcome.kind === "terminal") {
      return runIntent(input.repository, input.contractId, verificationInput(outcome, input, subject), decideAttestation);
    }
    return auditAttempt(outcome);
  } finally {
    prepared.dispose();
  }
}
