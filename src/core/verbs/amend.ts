import type { DecideInput, OfferDecision, Preparation } from "../decide.js";
import { prerequisitesReach, samePrerequisites } from "../facts/eligibility.js";
import { activeContract, prerequisiteStatus } from "../facts/observation.js";
import type { ActorId, AmendData, ContractId, ContractTerms, JournalEntry } from "../facts/types.js";

export type AmendInput<Failure = never> = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  source?: ContractTerms;
  preparation?: Preparation<AmendData, Failure>;
}>;

export type AmendRefusal = Readonly<{
  kind: "contract-missing" | "terminal" | "terms-moved" | "unknown-prerequisite" | "cyclic-prerequisite";
  contractId: ContractId;
}>;

export function decideAmend<Failure>({ input, attempt, observation }: DecideInput<AmendInput<Failure>>): OfferDecision<AmendRefusal | Failure> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };
  if (input.preparation === undefined || input.source === undefined) {
    throw new Error("existing contract requires an amend preparation and source terms");
  }
  const source = input.source;
  const termsCurrent = source.document.key === current.terms.document.key
    && source.segments.length === current.terms.segments.length
    && source.segments.every((value, index) => value === current.terms.segments[index])
    && source.gates.length === current.terms.gates.length
    && source.gates.every((value, index) => value === current.terms.gates[index])
    && samePrerequisites(source.after, current.terms.after);
  if (!termsCurrent) {
    return { kind: "refused", refusal: { kind: "terms-moved", contractId: id } };
  }
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  const { data } = input.preparation;
  const prerequisites = prerequisiteStatus(data.after, observation);
  if (prerequisites === "unknown") {
    return { kind: "refused", refusal: { kind: "unknown-prerequisite", contractId: id } };
  }
  if (prerequisitesReach(id, data.after, observation)) {
    return { kind: "refused", refusal: { kind: "cyclic-prerequisite", contractId: id } };
  }
  const entry: JournalEntry = {
    v: 1,
    kind: "amend",
    contract: id,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data,
  };
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current.head, entries: [entry] }] } };
}
