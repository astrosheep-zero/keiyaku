import type { DecideInput, OfferDecision, Preparation } from "../decide.js";
import { activeContract, type ActiveContractRefusal } from "../facts/observation.js";
import { journalEntry, type ActorId, type AttestationData, type ContractId } from "../facts/types.js";

export type AttestationInput<Failure = never> = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  preparation?: Preparation<AttestationData, Failure>;
}>;

export function decideAttestation<Failure>({
  input,
  attempt,
  observation,
}: DecideInput<AttestationInput<Failure>>): OfferDecision<ActiveContractRefusal | Failure> {
  const state = activeContract(observation, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  if (input.preparation === undefined) {
    throw new Error("active contract requires an attestation preparation");
  }
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  const attestation = journalEntry("attestation", input, attempt.entryUlids[0]!, input.preparation.data);
  return {
    kind: "offer",
    offer: { facts: [{ contractId: input.contractId, entries: [attestation] }] },
  };
}
