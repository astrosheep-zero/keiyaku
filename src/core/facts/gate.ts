import { currentSubjectPredicate } from "../subject.js";
import type { AttestationEntry, ContractState, Gate } from "./types.js";

/** Resolve the latest testimony for each requested gate and current subject. */
export function latestCurrentAttestations(
  state: ContractState,
  requested: ReadonlySet<Gate>,
): ReadonlyMap<Gate, AttestationEntry> {
  const attestations = new Map<Gate, AttestationEntry>();
  const subjectIsCurrent = currentSubjectPredicate(state);

  for (let index = state.attestations.length - 1; index >= 0; index -= 1) {
    const attestation = state.attestations[index]!;
    const { gate, subject } = attestation.data;
    if (!requested.has(gate) || attestations.has(gate) || !subjectIsCurrent(subject)) continue;
    attestations.set(gate, attestation);
    if (attestations.size === requested.size) break;
  }

  return attestations;
}

export function gatesSatisfied(state: ContractState): boolean {
  const required = new Set(state.terms.gates);
  if (required.size === 0) return true;

  const attestations = latestCurrentAttestations(state, required);
  return attestations.size === required.size
    && [...attestations.values()].every((entry) => entry.data.verdict === "satisfied");
}
