import { currentSubjectPredicate } from "../subject.js";
import { gate, type AttestationEntry, type ContractState, type Gate } from "./types.js";

export type GateCurrent =
  | Readonly<{ kind: "attested"; verdict: "satisfied" | "unsatisfied"; summary?: string; at: string }>
  | Readonly<{ kind: "stale"; priorVerdict: "satisfied" | "unsatisfied" }>
  | Readonly<{ kind: "missing" }>;

export type GateReport = Readonly<{ gate: Gate; current: GateCurrent }>;

function fail(): never {
  throw new Error("malformed gate report");
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function decodeAttestedGateCurrent(current: Record<string, unknown>): Extract<GateCurrent, { kind: "attested" }> {
  for (const key of Object.keys(current)) {
    if (key !== "kind" && key !== "verdict" && key !== "at" && key !== "summary") fail();
  }
  if (current.kind !== "attested") fail();
  if (current.verdict !== "satisfied" && current.verdict !== "unsatisfied") fail();
  if (typeof current.at !== "string") fail();
  return {
    kind: "attested",
    verdict: current.verdict,
    at: current.at,
    ...(current.summary === undefined
      ? {}
      : { summary: typeof current.summary === "string" ? current.summary : fail() }),
  };
}

function decodeGateCurrent(value: unknown): GateCurrent {
  const current = object(value);
  if (current.kind === "missing") {
    if (Object.keys(current).length !== 1) fail();
    return { kind: "missing" };
  }
  if (current.kind === "stale") {
    if (current.priorVerdict !== "satisfied" && current.priorVerdict !== "unsatisfied") fail();
    if (Object.keys(current).length !== 2) fail();
    return { kind: "stale", priorVerdict: current.priorVerdict };
  }
  return decodeAttestedGateCurrent(current);
}

export function decodeGateReport(value: unknown): GateReport {
  const record = object(value);
  if (!("gate" in record) || !("current" in record)) fail();
  for (const key of Object.keys(record)) if (key !== "gate" && key !== "current") fail();
  let decodedGate: Gate;
  try {
    if (typeof record.gate !== "string") fail();
    decodedGate = gate(record.gate);
  } catch {
    fail();
  }
  return { gate: decodedGate, current: decodeGateCurrent(record.current) };
}

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
          at: attestation.at,
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
