import { dependencyKeys, currentSubjectPredicate } from "../subject.js";
import {
  targetName,
  type AttestationEntry,
  type ChangeId,
  type ContractState,
  type Gate,
  type RequirementId,
} from "./types.js";

export type GateStaleReason = Readonly<{
  kind: "candidate-content-changed";
  target?: string;
  previousChange: ChangeId;
  currentChange: ChangeId;
}>;

export type GateCurrent =
  | Readonly<{ kind: "attested"; verdict: "satisfied" | "unsatisfied"; summary?: string; at: string }>
  | Readonly<{ kind: "stale"; priorVerdict: "satisfied" | "unsatisfied"; reason?: GateStaleReason }>
  | Readonly<{ kind: "missing" }>;

export type RequirementReport = Readonly<{ requirement: RequirementId; current: GateCurrent }>;
export type GateReport = Readonly<{
  gate: Gate;
  requirements: readonly RequirementReport[];
  satisfied: boolean;
  current: GateCurrent;
}>;

function staleReason(state: ContractState, previous: AttestationEntry): GateStaleReason | undefined {
  const target = state.coordinates.target;
  const currentChange = state.currentIntegration?.changeId ?? state.delivery?.data.integration.changeId;
  if (currentChange === undefined) return undefined;
  const previousChange = dependencyKeys(previous.data.subject).find((key) => key.kind === "change")?.value;
  if (previousChange === undefined || previousChange === currentChange) return undefined;
  return {
    kind: "candidate-content-changed",
    ...(target === undefined ? {} : { target: targetName(target) }),
    previousChange,
    currentChange,
  };
}

export type GateReports = Readonly<{
  reports: readonly GateReport[];
  satisfied: boolean;
}>;

/** Resolve latest current testimony independently for each gate and requirement. */
export function latestCurrentAttestations(
  state: ContractState,
  requested: ReadonlySet<Gate>,
): ReadonlyMap<Gate, ReadonlyMap<RequirementId, AttestationEntry>> {
  const attestations = new Map<Gate, Map<RequirementId, AttestationEntry>>();
  const subjectIsCurrent = currentSubjectPredicate(state);
  for (let index = state.attestations.length - 1; index >= 0; index -= 1) {
    const attestation = state.attestations[index]!;
    const { gate, requirement, subject } = attestation.data;
    if (!requested.has(gate) || !subjectIsCurrent(subject)) continue;
    let requirements = attestations.get(gate);
    if (requirements === undefined) {
      requirements = new Map();
      attestations.set(gate, requirements);
    }
    if (!requirements.has(requirement)) requirements.set(requirement, attestation);
  }
  return attestations;
}

export function gatesSatisfied(state: ContractState): boolean {
  return gateReports(state).satisfied;
}

function requirementCurrent(
  state: ContractState,
  current: AttestationEntry | undefined,
  previous: AttestationEntry | undefined,
): GateCurrent {
  if (current !== undefined) {
    return {
      kind: "attested",
      verdict: current.data.verdict,
      ...(current.data.summary === undefined ? {} : { summary: current.data.summary }),
      at: current.at,
    };
  }
  if (previous === undefined) return { kind: "missing" };
  const reason = staleReason(state, previous);
  return {
    kind: "stale",
    priorVerdict: previous.data.verdict,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Aggregate only adjudicated requirements, retaining each individual judgment in the report. */
function aggregateCurrent(requirements: readonly RequirementReport[]): GateCurrent {
  const currents = requirements.map((report) => report.current);
  return (
    currents.find((current) => current.kind === "attested" && current.verdict === "unsatisfied") ??
    currents.find((current) => current.kind === "missing") ??
    currents.find((current) => current.kind === "stale") ??
    currents.reduce((latest, current) =>
      current.kind === "attested" && latest.kind === "attested" && current.at > latest.at ? current : latest,
    )
  );
}

/** Project every declared requirement without allowing consumers to reimplement currency. */
export function gateReports(state: ContractState): GateReports {
  const current = latestCurrentAttestations(state, new Set(state.terms.gates));
  const prior = new Map<Gate, Map<RequirementId, AttestationEntry>>();
  for (let index = state.attestations.length - 1; index >= 0; index -= 1) {
    const entry = state.attestations[index]!;
    let requirements = prior.get(entry.data.gate);
    if (requirements === undefined) {
      requirements = new Map();
      prior.set(entry.data.gate, requirements);
    }
    if (!requirements.has(entry.data.requirement)) requirements.set(entry.data.requirement, entry);
  }
  const reports = state.terms.gates.map((gate): GateReport => {
    const requirements = state.terms.requirements[gate]!.map(
      (requirement): RequirementReport => ({
        requirement,
        current: requirementCurrent(state, current.get(gate)?.get(requirement), prior.get(gate)?.get(requirement)),
      }),
    );
    return {
      gate,
      requirements,
      current: aggregateCurrent(requirements),
      satisfied: requirements.every(
        (report) => report.current.kind === "attested" && report.current.verdict === "satisfied",
      ),
    };
  });
  return { reports, satisfied: reports.every((report) => report.satisfied) };
}
