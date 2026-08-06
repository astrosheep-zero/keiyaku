import { currentSubject } from "../subject.js";
import type { ContractBody, ContractState, Gate } from "./types.js";

export function effectiveGates(body: ContractBody): readonly Gate[] {
  const declared: Gate[] = body.gates === undefined ? ["reviewed"] : [...body.gates];
  if (body.verification.length > 0 && !declared.includes("verified")) declared.push("verified");
  return declared;
}

export function gateSatisfied(state: ContractState, gate: Gate): boolean {
  const subject = currentSubject(state, gate);
  if (subject === null) return false;
  return state.attestations.findLast((attestation) => (
    attestation.data.gate === gate && attestation.data.subject === subject
  ))?.data.verdict === "satisfied";
}

export function unsatisfiedGates(state: ContractState): readonly Gate[] {
  if (state.body === null) return [];
  return effectiveGates(state.body).filter((gate) => !gateSatisfied(state, gate));
}

export function gatesSatisfied(state: ContractState): boolean {
  return unsatisfiedGates(state).length === 0;
}
