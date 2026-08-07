import type { DecideInput, OfferDecision, StampedPreparation } from "../decide.js";
import { activeContract, documentIsCurrent } from "../facts/observation.js";
import type { ActorId, ContractId, DeliverData, JournalEntry } from "../facts/types.js";

export type DeliverInput<Failure = never> = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  preparation: StampedPreparation<DeliverData, Failure>;
}>;

export type DeliverRefusal = Readonly<{
  kind: "contract-missing" | "not-bound" | "terminal" | "document-moved";
  contractId: ContractId;
}>;

export function decideDeliver<Failure>({
  input,
  attempt,
  observation,
}: DecideInput<DeliverInput<Failure>>): OfferDecision<DeliverRefusal | Failure> {
  const state = activeContract(observation, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  if (state.bound === null) return { kind: "refused", refusal: { kind: "not-bound", contractId: input.contractId } };
  if (input.preparation.kind === "unavailable") {
    throw new Error("existing contract requires a stamped delivery preparation");
  }
  if (!documentIsCurrent(state, input.preparation.document)) {
    return { kind: "refused", refusal: { kind: "document-moved", contractId: input.contractId } };
  }
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  const deliver: JournalEntry = {
    v: 1,
    kind: "deliver",
    contract: input.contractId,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: input.preparation.data,
  };
  return { kind: "offer", offer: { facts: [{ contractId: input.contractId, expectedHead: state.head, entries: [deliver] }] } };
}
