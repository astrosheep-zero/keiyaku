import type { DecideInput, OfferDecision } from "../decide.js";
import { activeContract } from "../facts/observation.js";
import type { ActorId, ArcData, ContractId, JournalEntry } from "../facts/types.js";

export type ArcInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  data: Readonly<Omit<ArcData, "seq">>;
}>;

export type ArcRefusal = Readonly<{
  kind: "contract-missing" | "terminal";
  contractId: ContractId;
}>;

export function decideArc({ input, attempt, observation }: DecideInput<ArcInput>): OfferDecision<ArcRefusal> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };

  const arc: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: id,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: {
      seq: (current.currentArc?.data.seq ?? 0) + 1,
      title: input.data.title,
      objective: input.data.objective,
      brief: input.data.brief,
    },
  };
  return {
    kind: "offer",
    offer: { facts: [{ contractId: id, expectedHead: current.head, entries: [arc] }] },
  };
}
