import { observeContractWorld, observeDeliveryTargetAt } from "../../git/observe.js";
import { withGitReadObservation, type GitDecodeChannel } from "../../git/read-observation.js";
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

export function auditReport(
  entries: readonly JournalEntry[],
  reviewed: Gate,
  state?: ContractState,
  targetObservation?: AuditReport["targetObservation"],
): AuditReport {
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
  return {
    reworks,
    reviews,
    timeline,
    ...(delivery === undefined ? {} : { delivery }),
    ...(targetObservation === undefined ? {} : { targetObservation }),
  };
}

export async function readAuditAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  contract: ContractId,
  reviewed: Gate,
): Promise<AuditRead> {
  return withGitReadObservation(repository, channel, async (observation) => {
    const world = await observeContractWorld(observation, [contract]);
    const record = world.contracts.get(contract);
    if (record === undefined) throw new Error(`missing requested contract observation: ${contract}`);
    const targetObservation = record.state === null
      ? undefined
      : await observeDeliveryTargetAt(observation, record.state) ?? undefined;
    return {
      state: record.state,
      entries: record.entries,
      report: auditReport(record.entries, reviewed, record.state ?? undefined, targetObservation),
    };
  });
}
