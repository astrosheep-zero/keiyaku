import { observeContract } from "../../carrier/observe.js";
import type { GitRepository } from "../../carrier/repository.js";
import type { ContractId, ContractState, FactKind, JournalEntry } from "../../core/facts/types.js";

export type { FactKind } from "../../core/facts/types.js";

export type TimelineEntry = Readonly<{
  kind: FactKind;
  at: string;
  sincePrior: number | null;
}>;

export type AuditReport = Readonly<{
  reworks: number;
  reviews: number;
  timeline: readonly TimelineEntry[];
  attempt?: Readonly<{
    failure: "timeout" | "spawn-error" | "unknown-exit";
  }>;
}>;

export type AuditRead = Readonly<{
  state: ContractState | null;
  report: AuditReport;
}>;

function elapsedSince(prior: string | undefined, current: string): number | null {
  if (prior === undefined) return null;
  const priorMs = Date.parse(prior);
  const currentMs = Date.parse(current);
  return Number.isNaN(priorMs) || Number.isNaN(currentMs) ? null : currentMs - priorMs;
}

export function auditReport(entries: readonly JournalEntry[], attempt?: AuditReport["attempt"]): AuditReport {
  let reworks = 0;
  let reviews = 0;
  const timeline = entries.map((entry, index) => {
    if (entry.kind === "deliver") reworks += 1;
    if (entry.kind === "review") reviews += 1;
    return {
      kind: entry.kind,
      at: entry.at,
      sincePrior: elapsedSince(entries[index - 1]?.at, entry.at),
    };
  });
  return {
    reworks,
    reviews,
    timeline,
    ...(attempt === undefined ? {} : { attempt }),
  };
}

export function readAudit(repository: GitRepository, contract: ContractId, attempt?: AuditReport["attempt"]): AuditRead {
  const observation = observeContract(repository, contract);
  return { state: observation.state, report: auditReport(observation.entries, attempt) };
}
