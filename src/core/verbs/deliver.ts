import type { DecideInput, OfferDecision, StampedPreparation } from "../decide.js";
import { activeContract, documentIsCurrent } from "../facts/observation.js";
import { journalEntry, type ActorId, type ContractId, type DeliverData } from "../facts/types.js";

export type DeliverInput<Failure = never> = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  preparation: StampedPreparation<DeliverData, Failure>;
}>;

export type DeliverRefusal = Readonly<{
  kind: "contract-missing" | "terminal" | "document-moved";
  contractId: ContractId;
}>;

export function decideDeliver<Failure>({
  input,
  attempt,
  observation,
}: DecideInput<DeliverInput<Failure>>): OfferDecision<DeliverRefusal | Failure> {
  const state = activeContract(observation, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  if (input.preparation.kind === "unavailable") {
    throw new Error("existing contract requires a stamped delivery preparation");
  }
  if (!documentIsCurrent(state, input.preparation.document)) {
    return { kind: "refused", refusal: { kind: "document-moved", contractId: input.contractId } };
  }
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  const deliver = journalEntry("deliver", input, attempt.entryUlids[0]!, input.preparation.data);
  return { kind: "offer", offer: { facts: [{ contractId: input.contractId, entries: [deliver] }] } };
}
