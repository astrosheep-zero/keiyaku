import type { DecideInput, OfferDecision } from "../decide.js";
import { activeContract, type ActiveContractRefusal } from "../facts/observation.js";
import { journalEntry, type ActorId, type ContractId } from "../facts/types.js";

export type AbandonInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  note?: string;
}>;

export function decideAbandon({
  input,
  attempt,
  observation,
}: DecideInput<AbandonInput>): OfferDecision<ActiveContractRefusal> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };
  const data = input.note === undefined ? {} : { note: input.note };
  const abandoned = journalEntry("abandoned", input, attempt.entryUlids[0]!, data);
  return { kind: "offer", offer: { facts: [{ contractId: id, entries: [abandoned] }] } };
}
