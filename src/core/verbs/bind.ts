import type { DecideInput, OfferDecision, Preparation } from "../decide.js";
import { prerequisiteStatus } from "../facts/eligibility.js";
import { contractState } from "../facts/observation.js";
import type { ActorId, BindData, ContractId, JournalEntry } from "../facts/types.js";

export type BindInput<Failure = never> = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  preparation: Preparation<BindData, Failure>;
}>;

export type BindRefusal = Readonly<{
  kind: "contract-exists" | "invalid-after" | "unknown-prerequisite";
  contractId: ContractId;
}>;

export function decideBind<Failure>({ input, attempt, observation }: DecideInput<BindInput<Failure>>): OfferDecision<BindRefusal | Failure> {
  const id = input.contractId;
  const current = contractState(observation, id);
  if (current !== null) return { kind: "refused", refusal: { kind: "contract-exists", contractId: id } };
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  const { data } = input.preparation;
  if (data.terms.after.includes(id)) return { kind: "refused", refusal: { kind: "invalid-after", contractId: id } };
  const prerequisites = prerequisiteStatus(data.terms.after, observation);
  if (prerequisites === "unknown") {
    return { kind: "refused", refusal: { kind: "unknown-prerequisite", contractId: id } };
  }
  const bind: JournalEntry = {
    v: 1,
    kind: "bind",
    contract: id,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data,
  };
  const entries: JournalEntry[] = [bind];
  if (prerequisites === "claimed") {
    const bound: JournalEntry = {
      v: 1,
      kind: "bound",
      contract: id,
      entry: attempt.entryUlids[1]!,
      at: input.at,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      data: {},
    };
    entries.push(bound);
  }
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: null, entries }] } };
}
