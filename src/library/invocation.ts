/** @architectureCompositionRoot */
import { encodeEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractHead, ContractId, JournalEntry } from "../core/facts/types.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import type { Effect, ReconcileLag, ReconcileResult } from "../git/reconcile.js";
import type { AuditReport } from "../protocol/audit.js";
import type { CandidateCompletion, CompletionEvidence } from "../protocol/completion.js";
import {
  observeExecution,
  type ExecutionObservation,
  type ExecutionObserver,
} from "../protocol/execution-observation.js";
import type { AcceptedProtocolStep } from "../protocol/outcome.js";
import type {
  ContractCheckpoint,
  ExecutionStop,
  ProgressResidue,
  ProtocolProgress,
  VerificationResidue,
} from "../protocol/progress.js";
import type { SettlementReport } from "../settlement/settle.js";
import type { WorldRoot } from "../world.js";
import type { ContinuationReport } from "./continuation.js";
import type { InvocationEffect, ReconciliationEffect, ReconciliationLag, ResetCounts } from "./outcome.js";
import { reconcileLagScope } from "./reconcile.js";

export type InvocationSnapshot = Readonly<{
  facts: readonly JournalEntry[];
  checkpoints: ReadonlyMap<ContractId, ContractCheckpoint>;
  heads: ReadonlyMap<ContractId, ContractHead>;
  affected: readonly ContractId[];
  effects: readonly InvocationEffect[];
  conclusions: ReadonlyMap<ContractId, Readonly<Record<string, unknown>>>;
  reset?: Readonly<{ world: WorldRoot; removed: ResetCounts }>;
}>;

type ReconciliationRecord = Readonly<{
  effects?: readonly ReconciliationEffect[];
  lag?: readonly ReconciliationLag[];
  settlement?: SettlementReport;
  retiredWorktree?: string;
  retainedWorktree?: string;
}>;

const CANDIDATE_CONCLUSION_KEYS = [
  "completion",
  "verification",
  "verificationReuse",
  "verificationSubject",
  "verificationSummary",
  "placement",
] as const;

function entryKey(fact: JournalEntry): string {
  return `${fact.contract}\u0000${fact.entry}`;
}

/** The owner codec's canonical bytes: identity is (contract, entry), the payload is retained whole. */
function entryBytes(fact: JournalEntry): string {
  return encodeEntry(fact);
}

/**
 * The one invocation accumulator. It exists before any admission-capable await, satisfies the lower
 * Protocol progress sink, and holds every confirmed publication, candidate conclusion and physical
 * observation until the single final projection.
 */
export class InvocationAccumulator implements ProtocolProgress {
  private readonly entries = new Map<string, string>();
  private readonly admittedFacts: JournalEntry[] = [];
  private readonly admittedHeads = new Map<ContractId, ContractHead>();
  private readonly admittedCheckpoints = new Map<ContractId, ContractCheckpoint>();
  private readonly affectedContracts = new Set<ContractId>();
  private readonly records: InvocationEffect[] = [];
  private readonly candidateConclusions = new Map<ContractId, Readonly<Record<string, unknown>>>();
  private readonly reportedResidue = new WeakSet<object>();

  private resetState?: { world: WorldRoot; removed: { refs: number; worktrees: number; tasks: number } };

  constructor(private readonly observer?: ExecutionObserver) {}

  beginReset(world: WorldRoot): void {
    this.resetState = { world, removed: { refs: 0, worktrees: 0, tasks: 0 } };
  }

  recordResetRemoved(counts: Partial<ResetCounts>): void {
    if (this.resetState === undefined) throw new Error("reset progress requires its World");
    for (const key of ["refs", "worktrees", "tasks"] as const) this.resetState.removed[key] += counts[key] ?? 0;
  }

  observe(event: ExecutionObservation): void {
    observeExecution(this.observer, event);
  }

  /** A confirmed publication is retained even if folding or later physical work throws. */
  recordPublication(contract: ContractId, head: ContractHead, facts: readonly JournalEntry[]): void {
    const incoming = new Map<string, Readonly<{ fact: JournalEntry; bytes: string }>>();
    for (const fact of facts) {
      const key = entryKey(fact);
      const bytes = entryBytes(fact);
      const previous = incoming.get(key)?.bytes ?? this.entries.get(key);
      if (previous !== undefined && previous !== bytes)
        throw new AuthorityCorruptionError("conflicting invocation receipt");
      incoming.set(key, { fact, bytes });
    }
    let fresh = false;
    for (const [key, { fact, bytes }] of incoming) {
      if (this.entries.has(key)) continue;
      this.entries.set(key, bytes);
      this.admittedFacts.push(fact);
      if (fact.kind === "deliver")
        this.extendConclusions(fact.contract, {
          ...fact.data,
          leading: { kind: "admitted-now", fact: fact.entry },
        });
      this.observe({ kind: "admitted", contractId: contract, fact });
      this.affectedContracts.add(fact.contract);
      fresh = true;
    }
    if (fresh || !this.admittedHeads.has(contract)) this.admittedHeads.set(contract, head);
  }

  recordAdmission(step: AcceptedProtocolStep): void {
    if (step.state.head === null) throw new Error("admission requires a journal head");
    this.recordPublication(step.state.id, step.state.head, step.facts);
    if (this.admittedHeads.get(step.state.id) === step.state.head) {
      this.admittedCheckpoints.set(step.state.id, { state: step.state, journal: step.journal });
    }
    this.recordResidue(step.state.id, step);
  }

  hasFact(fact: JournalEntry): boolean {
    return this.entries.get(entryKey(fact)) === entryBytes(fact);
  }

  head(contract: ContractId): ContractHead | undefined {
    return this.admittedHeads.get(contract);
  }

  checkpoint(contract: ContractId): ContractCheckpoint | undefined {
    return this.admittedCheckpoints.get(contract);
  }

  recordResidue(contract: ContractId, residue: ProgressResidue): void {
    if (residue.physical !== undefined) this.recordReconciliation(contract, residue.physical);
    for (const failure of residue.seatClose ?? []) this.recordSeatClose(contract, failure);
  }

  recordVerification(
    contract: ContractId,
    snapshot: Parameters<ProtocolProgress["recordVerification"]>[1],
    result: VerificationResidue,
  ): void {
    if (result.cleanup !== undefined)
      this.records.push({
        kind: "cleanup",
        contract,
        issue: {
          kind: "verification-cleanup",
          contractId: contract,
          ...(snapshot === undefined ? {} : { snapshot }),
          failure: result.cleanup,
        },
      });
    if (result.leak !== undefined)
      this.records.push({
        kind: "cleanup",
        contract,
        issue: {
          kind: "worktree-leak",
          contractId: contract,
          ...(snapshot === undefined ? {} : { snapshot }),
          leak: result.leak,
        },
      });
  }

  /** Replace the current candidate's conclusions; accumulated resources are never erased. */
  recordCandidate(contract: ContractId, evidence: CompletionEvidence): void {
    const next: Record<string, unknown> = { ...(this.candidateConclusions.get(contract) ?? {}) };
    for (const key of CANDIDATE_CONCLUSION_KEYS) delete next[key];
    for (const [key, value] of Object.entries(evidence)) if (value !== undefined) next[key] = value;
    this.candidateConclusions.set(contract, next);
  }

  /** The candidate's completion base, known before an optional observation can fail. */
  recordCompletion(contract: ContractId, completion: CandidateCompletion): void {
    this.extendConclusions(contract, { completion });
  }

  recordAudit(contract: ContractId, report: Partial<AuditReport>): void {
    this.extendConclusions(contract, report);
  }

  /** Physical residue a continuation's dependent reconciliation observed. */
  recordPhysical(contract: ContractId, physical: ReconcileResult): void {
    this.recordReconciliation(contract, physical);
  }

  recordPlacementPhysical(contract: ContractId, physical: ReconcileResult): void {
    for (const lag of physical.lag) {
      if (lag.kind !== "target-checkout-retained" || this.reportedResidue.has(lag)) continue;
      this.reportedResidue.add(lag);
      this.records.push({
        kind: "checkout-retained",
        contract,
        path: lag.path,
        target: lag.target,
        diagnostic: lag.diagnostic,
      });
      this.affectedContracts.add(contract);
    }
    this.recordReconciliation(contract, physical);
  }

  /** Incremental continuation progress for the primary Contract. */
  recordContinuation(contract: ContractId, report: ContinuationReport): void {
    this.extendConclusions(contract, { continuation: report });
  }

  recordStop(stop: ExecutionStop): void {
    if (
      this.records.some(
        (record) =>
          record.kind === "execution-stopped" &&
          record.contract === stop.contractId &&
          record.stage === stop.stage &&
          record.reason === stop.reason &&
          record.diagnostic === stop.diagnostic,
      )
    )
      return;
    this.records.push({
      kind: "execution-stopped",
      contract: stop.contractId,
      stage: stop.stage,
      reason: stop.reason,
      diagnostic: stop.diagnostic,
    });
  }

  /** Physical reconciliation observations: effects, lags, settlement, and worktree topology. */
  recordReconciliation(contract: ContractId, record: ReconcileResult | ReconciliationRecord): void {
    for (const effect of "effects" in record ? (record.effects ?? []) : []) {
      if (this.reportedResidue.has(effect)) continue;
      this.reportedResidue.add(effect);
      this.records.push({ kind: "reconciliation-effect", contract, effect });
      this.affectedContracts.add(contract);
    }
    for (const lag of "lag" in record ? (record.lag ?? []) : []) {
      if (this.reportedResidue.has(lag)) continue;
      this.reportedResidue.add(lag);
      this.recordLag(contract, lag);
    }
    const settlement = "settlement" in record ? record.settlement : undefined;
    if (settlement !== undefined) this.recordSettlement(contract, settlement);
    const retired = "retiredWorktree" in record ? record.retiredWorktree : undefined;
    if (
      retired !== undefined &&
      !this.records.some(
        (entry) => entry.kind === "worktree-retired" && entry.contract === contract && entry.name === retired,
      )
    )
      this.records.push({ kind: "worktree-retired", contract, name: retired });
    const retained = "retainedWorktree" in record ? record.retainedWorktree : undefined;
    if (
      retained !== undefined &&
      !this.records.some(
        (entry) => entry.kind === "worktree-retained" && entry.contract === contract && entry.path === retained,
      )
    )
      this.records.push({ kind: "worktree-retained", contract, path: retained });
  }

  recordSettlement(contract: ContractId, report: SettlementReport): void {
    for (const action of report.actions) this.records.push({ kind: "settlement-action", contract, action });
    for (const lag of report.lags) this.records.push({ kind: "settlement-lag", contract, lag });
    for (const failure of report.seatClose ?? []) this.recordSeatClose(contract, failure);
  }

  recordChannelRetirement(contract: ContractId, error: unknown): void {
    this.records.push({
      kind: "cleanup",
      contract,
      issue: {
        kind: "decode-channel-retirement",
        contractId: contract,
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    });
  }

  /** World reset observations share the carrier without pretending a Contract admission happened. */
  recordReset(effect: Extract<InvocationEffect, { kind: "reset-owner-stopped" | "reset-residue" }>): void {
    this.records.push(effect);
  }

  /** Replace the current candidate conclusions; accumulated resources are never erased. */
  recordConclusions(contract: ContractId, patch: Readonly<Record<string, unknown>>): void {
    this.candidateConclusions.set(contract, patch);
  }

  extendConclusions(contract: ContractId, patch: Readonly<Record<string, unknown>>): void {
    this.candidateConclusions.set(contract, { ...(this.candidateConclusions.get(contract) ?? {}), ...patch });
  }

  conclusions(contract: ContractId): Readonly<Record<string, unknown>> | undefined {
    return this.candidateConclusions.get(contract);
  }

  snapshot(): InvocationSnapshot {
    return {
      facts: Object.freeze([...this.admittedFacts]),
      checkpoints: new Map(this.admittedCheckpoints),
      heads: new Map(this.admittedHeads),
      affected: Object.freeze([...this.affectedContracts]),
      effects: Object.freeze([...this.records]),
      conclusions: new Map(this.candidateConclusions),
      ...(this.resetState === undefined
        ? {}
        : {
            reset: Object.freeze({
              world: this.resetState.world,
              removed: Object.freeze({ ...this.resetState.removed }),
            }),
          }),
    };
  }

  private recordSeatClose(contract: ContractId, failure: PrivateStateSeatCloseLag): void {
    if (this.reportedResidue.has(failure)) return;
    this.reportedResidue.add(failure);
    this.records.push({
      kind: "cleanup",
      contract,
      issue: { kind: "private-state-seat-close", contractId: contract, failure },
    });
  }

  private recordLag(contract: ContractId, lag: ReconciliationLag): void {
    const affects = reconcileLagScope(lag);
    this.records.push({ kind: "reconciliation-lag", contract, affects, lag });
    if (affects !== "none") this.affectedContracts.add(contract);
  }
}

export function physicalOf(snapshot: InvocationSnapshot): ReconcileResult {
  const effects: Effect[] = [];
  const lag: ReconcileLag[] = [];
  for (const record of snapshot.effects) {
    if (record.kind === "reconciliation-effect" && record.effect.kind !== "contract-file")
      effects.push(record.effect as Effect);
    else if (record.kind === "reconciliation-lag" && record.lag.kind !== "contract-file-failed")
      lag.push(record.lag as ReconcileLag);
  }
  return { effects, lag };
}
