import type { DecideInput, OfferDecision } from "../decide.js";
import type { ArcData, ContractId, JournalEntry } from "../facts/types.js";
import { contractId, entryUlid } from "../facts/types.js";

export type ArcInput = Readonly<{
  contractId: ContractId;
  actor?: string;
  at: string;
  data: Readonly<Omit<ArcData, "seq">>;
}>;

export type ArcRefusal = Readonly<{
  kind: "contract-missing" | "terminal";
  contractId: ContractId;
}>;

export function decideArc({ input, attempt, observation }: DecideInput<ArcInput>): OfferDecision<null, ArcRefusal> {
  const id = contractId(input.contractId);
  const current = observation.contracts.get(id);
  if (!current?.state) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (current.state.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };

  const arc: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: id,
    entry: entryUlid(attempt.entryUlids[0]!),
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: {
      seq: (current.state.currentArc?.data.seq ?? 0) + 1,
      title: input.data.title,
      objective: input.data.objective,
      brief: input.data.brief,
    },
  };
  return {
    kind: "offer",
    offer: { facts: [{ contractId: id, expectedHead: current.state.head, entries: [arc] }] },
    handoff: null,
  };
}
