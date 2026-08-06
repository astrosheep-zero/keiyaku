import { subjectIsCurrent } from "../subject.js";
import type { ContractState, DependencyKeySet, Gate } from "./types.js";

/** A gate passes when a current subject's latest testimony is satisfied. */
export function gateSatisfied(state: ContractState, gate: Gate): boolean {
  const seen = new Set<DependencyKeySet>();
  for (let index = state.attestations.length - 1; index >= 0; index -= 1) {
    const attestation = state.attestations[index]!;
    if (attestation.data.gate !== gate || seen.has(attestation.data.subject)) continue;
    seen.add(attestation.data.subject);
    if (subjectIsCurrent(state, attestation.data.subject)) return attestation.data.verdict === "satisfied";
  }
  return false;
}

export function gatesSatisfied(state: ContractState): boolean {
  return state.terms !== null && state.terms.gates.every((gate) => gateSatisfied(state, gate));
}
