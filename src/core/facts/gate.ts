import { dependencyKeys, subjectApplicabilityFor, type SubjectApplicability } from "../subject.js";
import {
  targetName,
  type AttestationEntry,
  type ChangeId,
  type ContractState,
  type Gate,
  type RequirementId,
  type SnapshotId,
} from "./types.js";

export type GateStaleReason =
  | Readonly<{
      kind: "candidate-content-changed";
      target?: string;
      previousChange: ChangeId;
      currentChange: ChangeId;
    }>
  | Readonly<{
      kind: "snapshot-changed";
      previousSnapshot: SnapshotId;
      currentSnapshot: SnapshotId;
    }>;

export type GateCurrent =
  | Readonly<{ kind: "attested"; verdict: "satisfied" | "unsatisfied"; summary?: string; at: string }>
  | Readonly<{ kind: "stale"; priorVerdict: "satisfied" | "unsatisfied"; reason?: GateStaleReason }>
  | Readonly<{ kind: "applicability-pending"; priorVerdict: "satisfied" | "unsatisfied" }>
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
  const integration = state.currentIntegration ?? state.delivery?.data.integration;
  if (integration === undefined) return undefined;
  const keys = dependencyKeys(previous.data.subject);
  const previousChange = keys.find((key) => key.kind === "change")?.value;
  if (previousChange !== undefined && previousChange !== integration.changeId)
    return {
      kind: "candidate-content-changed",
      ...(target === undefined ? {} : { target: targetName(target) }),
      previousChange,
      currentChange: integration.changeId,
    };
  const previousSnapshot = keys.find((key) => key.kind === "snapshot")?.value;
  if (previousSnapshot === undefined || previousSnapshot === integration.snapshot) return undefined;
  return { kind: "snapshot-changed", previousSnapshot, currentSnapshot: integration.snapshot };
}

export type GateReports = Readonly<{
  reports: readonly GateReport[];
  satisfied: boolean;
}>;

type LatestTestimony = {
  prior: AttestationEntry;
  priorApplicability: SubjectApplicability;
  current?: AttestationEntry;
};

/** Retain the latest current testimony, falling back to the latest record for explanation. */
function latestTestimony(state: ContractState): ReadonlyMap<Gate, ReadonlyMap<RequirementId, LatestTestimony>> {
  const attestations = new Map<Gate, Map<RequirementId, LatestTestimony>>();
  const requested = new Set(state.terms.gates);
  const applicabilityFor = subjectApplicabilityFor(state);
  for (let index = state.attestations.length - 1; index >= 0; index -= 1) {
    const entry = state.attestations[index]!;
    const { gate, requirement, subject } = entry.data;
    if (!requested.has(gate)) continue;
    let requirements = attestations.get(gate);
    if (requirements === undefined) {
      requirements = new Map();
      attestations.set(gate, requirements);
    }
    const testimony = requirements.get(requirement);
    if (testimony?.current !== undefined) continue;
    const applicability = applicabilityFor(subject);
    const latest = testimony ?? { prior: entry, priorApplicability: applicability };
    if (applicability === "current") latest.current = entry;
    requirements.set(requirement, latest);
  }
  return attestations;
}

export function gatesSatisfied(state: ContractState): boolean {
  return gateReports(state).satisfied;
}

function requirementCurrent(state: ContractState, testimony: LatestTestimony | undefined): GateCurrent {
  if (testimony === undefined) return { kind: "missing" };
  const { current, prior, priorApplicability } = testimony;
  if (current !== undefined) {
    return {
      kind: "attested",
      verdict: current.data.verdict,
      ...(current.data.summary === undefined ? {} : { summary: current.data.summary }),
      at: current.at,
    };
  }
  const priorVerdict = prior.data.verdict;
  if (priorApplicability === "applicability-pending") return { kind: "applicability-pending", priorVerdict };
  const reason = staleReason(state, prior);
  return {
    kind: "stale",
    priorVerdict,
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
    currents.find((current) => current.kind === "applicability-pending") ??
    currents.reduce((latest, current) =>
      current.kind === "attested" && latest.kind === "attested" && current.at > latest.at ? current : latest,
    )
  );
}

/** Project every declared requirement without allowing consumers to reimplement currency. */
export function gateReports(state: ContractState): GateReports {
  const testimony = latestTestimony(state);
  const reports = state.terms.gates.map((gate): GateReport => {
    const requirementsTestimony = testimony.get(gate);
    const requirements = state.terms.requirements[gate]!.map(
      (requirement): RequirementReport => ({
        requirement,
        current: requirementCurrent(state, requirementsTestimony?.get(requirement)),
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
