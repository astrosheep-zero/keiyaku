import type { DecideInput, OfferDecision, Preparation } from "../decide.js";
import { prerequisitesReach, samePrerequisites, targetCycles } from "../facts/eligibility.js";
import {
  activeContract,
  prerequisiteStatus,
  targetContractRefusal,
  targetContractIdRefusal,
  type TargetContractRefusal,
} from "../facts/observation.js";
import { journalEntry, type AmendData, type ContractId, type ContractTerms } from "../facts/types.js";

/** What one amendment replaces: the source terms it stamps and the terms it asks for. */
export type AmendEdit<Failure = never> = Readonly<{
  source: ContractTerms;
  targetContract?: ContractId;
  preparation: Preparation<AmendData, Failure>;
}>;

export type AmendInput<Failure = never> = Readonly<{
  contractId: ContractId;
  at: string;
  /** Absent when the amendment requests no change: an ordinary no-op, not an empty edit. */
  edit?: AmendEdit<Failure>;
}>;

export type AmendRefusal =
  | Readonly<{
      kind:
        | "contract-missing"
        | "terminal"
        | "terms-moved"
        | "unknown-prerequisite"
        | "cyclic-prerequisite"
        | "cyclic-target";
    }>
  | TargetContractRefusal;

/** The owner's answer for a well-formed amendment request, including one that asks for nothing. */
export type AmendDecision<Failure> = OfferDecision<AmendRefusal | Failure> | Readonly<{ kind: "unchanged" }>;

export function decideAmend<Failure>({
  input,
  attempt,
  observation,
}: DecideInput<AmendInput<Failure>>): AmendDecision<Failure> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };
  const edit = input.edit;
  if (edit === undefined) return { kind: "unchanged" };
  const source = edit.source;
  const termsCurrent =
    source.document.key === current.terms.document.key &&
    source.segments.length === current.terms.segments.length &&
    source.segments.every((value, index) => value === current.terms.segments[index]) &&
    source.gates.length === current.terms.gates.length &&
    source.gates.every((value, index) => value === current.terms.gates[index]) &&
    Object.keys(source.requirements).length === Object.keys(current.terms.requirements).length &&
    source.gates.every((gate) => {
      const expected = source.requirements[gate]!;
      const actual = current.terms.requirements[gate];
      return (
        actual !== undefined &&
        expected.length === actual.length &&
        expected.every((value, index) => value === actual[index])
      );
    }) &&
    samePrerequisites(source.after, current.terms.after);
  if (!termsCurrent) {
    return { kind: "refused", refusal: { kind: "terms-moved" } };
  }
  if (edit.targetContract !== undefined) {
    const refusal = targetContractIdRefusal(observation, edit.targetContract);
    if (refusal !== undefined) return { kind: "refused", refusal };
  }
  if (edit.preparation.kind === "refused") return { kind: "refused", refusal: edit.preparation.refusal };
  const { data } = edit.preparation;
  const targetRefusal = targetContractRefusal(observation, data.target);
  if (targetRefusal !== undefined) return { kind: "refused", refusal: targetRefusal };
  if (targetCycles(id, data.target, observation)) return { kind: "refused", refusal: { kind: "cyclic-target" } };
  const prerequisites = prerequisiteStatus(data.after, observation);
  if (prerequisites === "unknown") {
    return { kind: "refused", refusal: { kind: "unknown-prerequisite" } };
  }
  if (prerequisitesReach(id, data.after, observation)) {
    return { kind: "refused", refusal: { kind: "cyclic-prerequisite" } };
  }
  const entry = journalEntry("amend", input, attempt.entryUlids[0]!, data);
  return { kind: "offer", offer: { facts: [{ contractId: id, entries: [entry] }] } };
}
