import { observeContract, observeDeliveryTarget } from "../../git/observe.js";
import type { GitRepository } from "../../git/repository.js";
import type { ContractId, ContractState, DeliverData, FactKind, Gate, JournalEntry, SnapshotId } from "../../core/facts/types.js";

export type { FactKind } from "../../core/facts/types.js";

export type TimelineEntry = Readonly<{
  kind: FactKind;
  at: string;
  sincePrior: number | null;
  attestation?: Readonly<{
    gate: Gate;
    verdict: "satisfied" | "unsatisfied";
    summary?: string;
  }>;
}>;

export type AuditReport = Readonly<{
  reworks: number;
  reviews: number;
  timeline: readonly TimelineEntry[];
  delivery?: DeliverData;
  targetObservation?: Readonly<{ head: SnapshotId | null; drift: boolean }>;
}>;

type AuditRead = Readonly<{
  state: ContractState | null;
  entries: readonly JournalEntry[];
  report: AuditReport;
}>;

function elapsedSince(prior: string | undefined, current: string): number | null {
  if (prior === undefined) return null;
  const priorMs = Date.parse(prior);
  const currentMs = Date.parse(current);
  return currentMs - priorMs;
}

export function auditReport(entries: readonly JournalEntry[], reviewed: Gate, state?: ContractState, repository?: GitRepository): AuditReport {
  let reworks = 0;
  let reviews = 0;
  const timeline = entries.map((entry, index) => {
    if (entry.kind === "deliver") reworks += 1;
    if (entry.kind === "attestation" && entry.data.gate === reviewed) reviews += 1;
    return {
      kind: entry.kind,
      at: entry.at,
      sincePrior: elapsedSince(entries[index - 1]?.at, entry.at),
      ...(entry.kind === "attestation" ? {
        attestation: {
          gate: entry.data.gate,
          verdict: entry.data.verdict,
          ...(entry.data.summary === undefined ? {} : { summary: entry.data.summary }),
        },
      } : {}),
    };
  });
  const delivery = state?.delivery?.data;
  const targetObservation = state === undefined || repository === undefined
    ? undefined
    : observeDeliveryTarget(repository, state) ?? undefined;
  return {
    reworks,
    reviews,
    timeline,
    ...(delivery === undefined ? {} : { delivery }),
    ...(targetObservation === undefined ? {} : { targetObservation }),
  };
}

export function readAudit(repository: GitRepository, contract: ContractId, reviewed: Gate): AuditRead {
  const observation = observeContract(repository, contract);
  return {
    state: observation.state,
    entries: observation.entries,
    report: auditReport(observation.entries, reviewed, observation.state ?? undefined, repository),
  };
}
