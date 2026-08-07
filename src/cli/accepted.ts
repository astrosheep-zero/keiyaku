import {
  type ContractId,
  type Keiyaku,
  type Outcome,
  type RegionOverlap,
} from "../index.js";
import type { AcceptedFact, AcceptedResult, InvocationResult } from "./result.js";

function hasOverlaps(value: object): value is Readonly<{ overlaps: readonly RegionOverlap[] }> {
  return "overlaps" in value;
}

function hasOverlapFailure(value: object): value is Readonly<{ overlapFailure: string }> {
  return "overlapFailure" in value;
}

function hasDocumentDiff(value: object): value is Readonly<{ documentDiff: string }> {
  return "documentDiff" in value && typeof value.documentDiff === "string";
}

type ResultOptions = Readonly<{
  coordinate?: ContractId;
  reconcile?: Keiyaku;
  report?: import("../index.js").AuditReport;
  obligations?: Pick<AcceptedResult, "verification" | "placement" | "leak">;
}>;

export async function resultFromOutcome<A, Observation extends object = Record<never, never>>(
  verb: string,
  outcome: Outcome<A, Observation>,
  options: ResultOptions = {},
): Promise<InvocationResult> {
  if (outcome.kind === "refused") {
    return {
      kind: "refused",
      verb,
      ...(options.coordinate === undefined ? {} : { contract: options.coordinate }),
      refusal: outcome.refusal,
    };
  }
  if (outcome.kind === "retry") {
    return {
      kind: "retry",
      verb,
      ...(options.coordinate === undefined ? {} : { contract: options.coordinate }),
      detail: outcome.reason,
    };
  }

  const acceptedContract = options.coordinate ?? outcome.facts[0]?.contract;
  if (acceptedContract === undefined) throw new Error("accepted outcome is missing its contract identity");
  const reconciled = options.reconcile === undefined
    ? { effects: [], lag: [] }
    : await options.reconcile.reconcile();
  return {
    kind: "accepted",
    verb,
    contract: acceptedContract,
    head: outcome.head,
    facts: outcome.facts.map((fact): AcceptedFact => ({
      contract: fact.contract,
      entry: fact.entry,
      kind: fact.kind,
    })),
    effects: reconciled.effects,
    ...options.obligations,
    ...(hasOverlaps(outcome) ? { overlaps: outcome.overlaps } : {}),
    ...(hasOverlapFailure(outcome) ? { overlapFailure: outcome.overlapFailure } : {}),
    ...(hasDocumentDiff(outcome) ? { diff: outcome.documentDiff } : {}),
    ...(options.report === undefined ? {} : { report: options.report }),
    ...(reconciled.lag.length === 0 ? {} : { lag: reconciled.lag }),
  };
}
