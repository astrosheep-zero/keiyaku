import type { DecideInput, OfferDecision } from "../decide.js";
import { activeContract, type ActiveContractRefusal } from "../facts/observation.js";
import { journalEntry, type ActorId, type ContractId } from "../facts/types.js";

export type ArcInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  data: Readonly<{ title: string; body: string }>;
}>;

export function decideArc({
  input,
  attempt,
  observation,
}: DecideInput<ArcInput>): OfferDecision<ActiveContractRefusal> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };

  const arc = journalEntry("arc", input, attempt.entryUlids[0]!, {
    seq: (current.currentArc?.data.seq ?? 0) + 1,
    title: input.data.title,
    body: input.data.body,
  });
  return {
    kind: "offer",
    offer: { facts: [{ contractId: id, entries: [arc] }] },
  };
}
