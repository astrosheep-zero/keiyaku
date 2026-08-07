import type { DecideInput, OfferDecision } from "../decide.js";
import { activeContract } from "../facts/observation.js";
import type { ActorId, ContractId, JournalEntry } from "../facts/types.js";

export type AbandonInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  note?: string;
}>;

export type AbandonRefusal = Readonly<{ kind: "contract-missing" | "terminal"; contractId: ContractId }>;

export function decideAbandon({ input, attempt, observation }: DecideInput<AbandonInput>): OfferDecision<AbandonRefusal> {
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
