import type { DecideInput, OfferDecision, Preparation } from "../decide.js";
import { activeContract } from "../facts/observation.js";
import { contractId, type ActorId, type AttestationData, type ContractId, type JournalEntry } from "../facts/types.js";

export type AttestationInput<Failure = never> = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  preparation?: Preparation<AttestationData, Failure>;
}>;

export type AttestationRefusal = Readonly<{ kind: "contract-missing" | "terminal"; contractId: ContractId }>;

export function decodeAttestationRefusal(value: unknown): AttestationRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed attestation refusal");
  const object = value as Record<string, unknown>;
  if (object.kind !== "contract-missing" && object.kind !== "terminal")
    throw new Error("malformed attestation refusal");
  if (Object.keys(object).some((key) => key !== "kind" && key !== "contractId"))
    throw new Error("malformed attestation refusal");
  try {
    return { kind: object.kind, contractId: contractId(String(object.contractId)) };
  } catch {
    throw new Error("malformed attestation refusal");
  }
}

export function decideAttestation<Failure>({
  input,
  attempt,
  observation,
}: DecideInput<AttestationInput<Failure>>): OfferDecision<AttestationRefusal | Failure> {
  const state = activeContract(observation, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  if (input.preparation === undefined) {
    throw new Error("active contract requires an attestation preparation");
  }
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  const attestation: JournalEntry = {
    v: 1,
    kind: "attestation",
    contract: input.contractId,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: input.preparation.data,
  };
  return {
    kind: "offer",
    offer: { facts: [{ contractId: input.contractId, expectedHead: state.head, entries: [attestation] }] },
  };
}
