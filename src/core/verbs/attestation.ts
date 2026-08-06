import type { DecideInput, OfferDecision } from "../decide.js";
import { subjectIsCurrent } from "../subject.js";
import type { ActorId, AttestationData, ContractId, JournalEntry } from "../facts/types.js";
import { contractId, entryUlid } from "../facts/types.js";

export type AttestationInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  data: AttestationData;
}>;

export type AttestationRefusal =
  | Readonly<{ kind: "contract-missing" | "delivery-missing" | "terminal" | "gate-undeclared"; contractId: ContractId }>
  | Readonly<{ kind: "stale-subject"; contractId: ContractId; subject: AttestationData["subject"] }>;

/** Admit captured testimony only for the subject that remains current. */
export function decideAttestation({ input, attempt, observation }: DecideInput<AttestationInput>): OfferDecision<AttestationRefusal> {
  const id = contractId(input.contractId);
  const current = observation.contracts.get(id);
  if (!current?.state) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (current.state.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };
  if (!current.state.delivery) return { kind: "refused", refusal: { kind: "delivery-missing", contractId: id } };
  if (current.state.terms === null || !current.state.terms.gates.includes(input.data.gate)) {
    return { kind: "refused", refusal: { kind: "gate-undeclared", contractId: id } };
  }
  if (!subjectIsCurrent(current.state, input.data.subject)) {
    return { kind: "refused", refusal: { kind: "stale-subject", contractId: id, subject: input.data.subject } };
  }
  const attestation: JournalEntry = {
    v: 1,
    kind: "attestation",
    contract: id,
    entry: entryUlid(attempt.entryUlids[0]!),
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: input.data,
  };
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current.state.head, entries: [attestation] }] } };
}
