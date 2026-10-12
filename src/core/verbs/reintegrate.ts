import type { DecideInput, OfferDecision, Preparation } from "../decide.js";
import { activeContract } from "../facts/observation.js";
import { journalEntry, type ActorId, type ContractId, type ReintegratedData } from "../facts/types.js";

export type ReintegrateInput<Failure = never> = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  preparation: Preparation<ReintegratedData, Failure>;
}>;

export type ReintegrateRefusal = Readonly<{
  kind: "contract-missing" | "delivery-missing" | "terminal";
  contractId: ContractId;
}>;

export function decideReintegrate<Failure>({
  input,
  attempt,
  observation,
}: DecideInput<ReintegrateInput<Failure>>): OfferDecision<ReintegrateRefusal | Failure> {
  const state = activeContract(observation, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  if (state.delivery === null) {
    return { kind: "refused", refusal: { kind: "delivery-missing", contractId: input.contractId } };
  }
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  const reintegrated = journalEntry("reintegrated", input, attempt.entryUlids[0]!, input.preparation.data);
  return {
    kind: "offer",
    offer: { facts: [{ contractId: input.contractId, entries: [reintegrated] }] },
  };
}
