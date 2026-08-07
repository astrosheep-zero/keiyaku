import { currentSubjectPredicate } from "../subject.js";
import type { AttestationEntry, ContractState, Gate } from "./types.js";

export type GateCurrent =
  | Readonly<{ kind: "attested"; verdict: "satisfied" | "unsatisfied"; summary?: string }>
  | Readonly<{ kind: "stale"; priorVerdict: "satisfied" | "unsatisfied" }>
  | Readonly<{ kind: "missing" }>;

export type GateReport = Readonly<{ gate: Gate; current: GateCurrent }>;

export type GateReports = Readonly<{
  reports: readonly GateReport[];
  satisfied: boolean;
}>;

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
  return gateReports(state).satisfied;
}

/** Project every declared gate without allowing consumers to reimplement currency. */
export function gateReports(state: ContractState): GateReports {
  const declared = state.terms.gates;
  const requested = new Set(declared);
  const current = latestCurrentAttestations(state, requested);
  const prior = new Map<Gate, AttestationEntry>();
  for (let index = state.attestations.length - 1; index >= 0; index -= 1) {
    const entry = state.attestations[index]!;
    if (!prior.has(entry.data.gate) && requested.has(entry.data.gate)) prior.set(entry.data.gate, entry);
  }
  const reports = declared.map((gate): GateReport => {
    const attestation = current.get(gate);
    if (attestation !== undefined) {
      return {
        gate,
        current: {
          kind: "attested",
          verdict: attestation.data.verdict,
          ...(attestation.data.summary === undefined ? {} : { summary: attestation.data.summary }),
        },
      };
    }
    const previous = prior.get(gate);
    return previous === undefined
      ? { gate, current: { kind: "missing" } }
      : { gate, current: { kind: "stale", priorVerdict: previous.data.verdict } };
  });
  return {
    reports,
    satisfied: reports.every((report) => report.current.kind === "attested" && report.current.verdict === "satisfied"),
  };
}
