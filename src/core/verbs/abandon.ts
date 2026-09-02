import type { DecideInput, OfferDecision } from "../decide.js";
import { activeContract } from "../facts/observation.js";
import { contractId, type ActorId, type ContractId, type JournalEntry } from "../facts/types.js";

export type AbandonInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  note?: string;
}>;

export type AbandonRefusal = Readonly<{ kind: "contract-missing" | "terminal"; contractId: ContractId }>;

export function decodeAbandonRefusal(value: unknown): AbandonRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed abandon refusal");
  const object = value as Record<string, unknown>;
  if (object.kind !== "contract-missing" && object.kind !== "terminal") throw new Error("malformed abandon refusal");
  if (Object.keys(object).some((key) => key !== "kind" && key !== "contractId"))
    throw new Error("malformed abandon refusal");
  try {
    return { kind: object.kind, contractId: contractId(String(object.contractId)) };
  } catch {
    throw new Error("malformed abandon refusal");
  }
}

export function decideAbandon({
  input,
  attempt,
  observation,
}: DecideInput<AbandonInput>): OfferDecision<AbandonRefusal> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };
  const abandoned: JournalEntry = {
    v: 1,
    kind: "abandoned",
    contract: id,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: input.note === undefined ? {} : { note: input.note },
  };
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current.head, entries: [abandoned] }] } };
}
