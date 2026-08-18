import type { DecideInput, OfferDecision, Preparation } from "../decide.js";
import { activeContract } from "../facts/observation.js";
import type { ActorId, ContractId, JournalEntry, ReintegratedData } from "../facts/types.js";

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
  const reintegrated: JournalEntry = {
    v: 1,
    kind: "reintegrated",
    contract: input.contractId,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: input.preparation.data,
  };
  return {
    kind: "offer",
    offer: { facts: [{ contractId: input.contractId, expectedHead: state.head, entries: [reintegrated] }] },
  };
}
