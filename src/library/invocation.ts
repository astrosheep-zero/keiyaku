/** @architectureCompositionRoot */
import { encodeEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractHead, ContractId, JournalEntry } from "../core/facts/types.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import type { ReconcileResult } from "../git/reconcile.js";
import type { DeliveryPreviewReport } from "../protocol/delivery-preview.js";
import type { CandidateCompletion, CompletionEvidence } from "../protocol/completion.js";
import { compactPlacement } from "../protocol/completion.js";
import { compactDelivery, type DeliveryIdentity } from "../protocol/deliver.js";
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
import type {
  ContractConclusion,
  ContractVerb,
  InvocationEffect,
  ReconciliationLag,
  ResetCounts,
  admittedEvidenceSchema,
} from "./outcome.js";
import type { z } from "zod";
import { compactEffect, reconcileLagScope } from "./outcome.js";

type RecordedVerificationCheck = Parameters<ProtocolProgress["recordVerificationCheck"]>[2];

export type InvocationSnapshot = Readonly<{
  facts: readonly JournalEntry[];
  admitted: readonly z.output<typeof admittedEvidenceSchema>[];
  checkpoints: ReadonlyMap<ContractId, ContractCheckpoint>;
  heads: ReadonlyMap<ContractId, ContractHead>;
  affected: readonly ContractId[];
  effects: readonly InvocationEffect[];
  conclusions: ReadonlyMap<ContractId, ContractConclusion>;
  reset?: Readonly<{ world: WorldRoot; removed: ResetCounts; attempted: readonly ("git" | "debt")[] }>;
}>;

type ReconciliationRecord = Readonly<{
  effects?: ReconcileResult["effects"];
  lag?: readonly ReconciliationLag[];
  settlement?: SettlementReport;
}>;

function admissionEvidence(fact: JournalEntry): z.output<typeof admittedEvidenceSchema> {
  const base = { contractId: fact.contract };
  switch (fact.kind) {
    case "deliver":
      return {
        ...base,
        kind: fact.kind,
        candidate: fact.data.tenderSnapshot,
        integration: fact.data.integration.snapshot,
        contentId: fact.data.integration.changeId,
      };
    case "reintegrated":
      return { ...base, kind: fact.kind, integration: fact.data.snapshot, predecessor: fact.data.predecessor };
    case "attestation":
      return {
        ...base,
        kind: fact.kind,
        ...(fact.data.gate === "verified" ? { requirement: fact.data.requirement, verdict: fact.data.verdict } : {}),
      };
    case "arc":
      return { ...base, kind: fact.kind, chapter: fact.data.seq };
    default:
      return { ...base, kind: fact.kind };
  }
}

function entryKey(fact: JournalEntry): string {
  return `${fact.contract}\u0000${fact.entry}`;
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
  private readonly admitted: z.output<typeof admittedEvidenceSchema>[] = [];
  private readonly candidateConclusions = new Map<ContractId, ContractConclusion>();
  private readonly reportedResidue = new WeakSet<object>();

  private resetState?: {
    world: WorldRoot;
    removed: { refs: number; worktrees: number; debts: number };
    attempted: ("git" | "debt")[];
  };

  constructor(
    private readonly observer?: ExecutionObserver,
    private readonly operation?: ContractVerb,
  ) {}

  beginReset(world: WorldRoot): void {
    this.resetState = { world, removed: { refs: 0, worktrees: 0, debts: 0 }, attempted: [] };
  }

  recordResetAttempt(owner: "git" | "debt"): void {
    if (this.resetState === undefined) throw new Error("reset progress requires its World");
    if (!this.resetState.attempted.includes(owner)) this.resetState.attempted.push(owner);
  }

  recordResetRemoved(counts: Partial<ResetCounts>): void {
    if (this.resetState === undefined) throw new Error("reset progress requires its World");
    for (const key of ["refs", "worktrees", "debts"] as const) this.resetState.removed[key] += counts[key] ?? 0;
  }

  observe(event: ExecutionObservation): void {
    observeExecution(this.observer, event);
  }

  /** A confirmed publication is retained even if folding or later physical work throws. */
  recordPublication(contract: ContractId, head: ContractHead, facts: readonly JournalEntry[]): void {
    const incoming = new Map<string, Readonly<{ fact: JournalEntry; bytes: string }>>();
    for (const fact of facts) {
      const key = entryKey(fact);
      const bytes = encodeEntry(fact);
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
      this.admitted.push(admissionEvidence(fact));
      if (fact.kind === "deliver") this.recordDelivery(fact.contract, compactDelivery(fact.data));
      if (fact.kind === "reintegrated" && this.conclusions(fact.contract)?.candidate !== undefined)
        this.extendConclusions(fact.contract, { integration: fact.data.snapshot });
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
    return this.entries.get(entryKey(fact)) === encodeEntry(fact);
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
    coordinate?: Readonly<{ requirement: string; index: number }>,
  ): void {
    if (result.cleanup !== undefined)
      this.records.push({
        kind: "issue",
        contract,
        issue: {
          kind: "verification-cleanup",
          ...(snapshot === undefined ? {} : { snapshot }),
          ...coordinate,
          name: result.cleanup.name,
          diagnostic: result.cleanup.diagnostic,
        },
      });
    if (result.leak !== undefined)
      this.records.push({
        kind: "issue",
        contract,
        issue: {
          kind: "worktree-leak",
          ...(snapshot === undefined ? {} : { snapshot }),
          ...coordinate,
          ...(result.leak.path === undefined ? {} : { path: result.leak.path }),
          diagnostic: result.leak.diagnostic,
        },
      });
  }

  recordVerificationCheck(
    contract: ContractId,
    snapshot: Parameters<ProtocolProgress["recordVerificationCheck"]>[1],
    check: RecordedVerificationCheck,
  ): void {
    const checks = this.candidateConclusions.get(contract)?.checks ?? [];
    this.extendConclusions(contract, { snapshot, checks: [...checks, check] });
  }

  /** Replace the current candidate's conclusions; accumulated resources are never erased. */
  recordCandidate(contract: ContractId, evidence: CompletionEvidence): void {
    const { placement: _placement, ...current } = this.candidateConclusions.get(contract) ?? {};
    const placement = compactPlacement(evidence);
    this.candidateConclusions.set(contract, { ...current, ...(placement === undefined ? {} : { placement }) });
  }

  /** The candidate's completion base, known before an optional observation can fail. */
  recordCompletion(contract: ContractId, completion: CandidateCompletion): void {
    this.extendConclusions(contract, { placement: { kind: "placed", ...completion } });
  }

  recordDeliveryPreview(contract: ContractId, report: Partial<DeliveryPreviewReport>): void {
    this.extendConclusions(contract, { preview: { ...this.conclusions(contract)?.preview, ...report } });
  }

  /** Physical residue a continuation's dependent reconciliation observed. */
  recordPhysical(contract: ContractId, physical: ReconcileResult): void {
    this.recordReconciliation(contract, physical);
  }

  recordPlacementPhysical(contract: ContractId, physical: ReconcileResult): void {
    this.recordReconciliation(contract, physical);
  }

  /** Incremental continuation progress; verify also retains its known-empty partial observation. */
  recordContinuation(contract: ContractId, report: ContinuationReport): void {
    if (this.operation === "verify" || report.claimed !== undefined || report.stopped !== undefined)
      this.extendConclusions(contract, { continuation: report });
  }

  recordStop(stop: ExecutionStop): void {
    if (
      this.records.some(
        (record) =>
          record.kind === "issue" &&
          record.issue.kind === "execution-stopped" &&
          record.contract === stop.contractId &&
          record.issue.reason === stop.reason &&
          record.issue.diagnostic === stop.diagnostic,
      )
    )
      return;
    this.records.push({
      kind: "issue",
      contract: stop.contractId,
      issue: { kind: "execution-stopped", reason: stop.reason, diagnostic: stop.diagnostic },
    });
  }

  /** Physical reconciliation observations: effects, lags, settlement, and worktree topology. */
  recordReconciliation(contract: ContractId, record: ReconcileResult | ReconciliationRecord): void {
    for (const effect of "effects" in record ? (record.effects ?? []) : []) {
      if (this.reportedResidue.has(effect)) continue;
      this.reportedResidue.add(effect);
      this.affectedContracts.add(contract);
      const movement = compactEffect(effect);
      if (movement !== undefined) this.records.push({ kind: "movement", contract, effect: movement });
    }
    for (const lag of "lag" in record ? (record.lag ?? []) : []) {
      if (this.reportedResidue.has(lag)) continue;
      this.reportedResidue.add(lag);
      this.recordLag(contract, lag);
    }
    const settlement = "settlement" in record ? record.settlement : undefined;
    if (settlement !== undefined) this.recordSettlement(contract, settlement);
  }

  recordSettlement(contract: ContractId, report: SettlementReport): void {
    for (const action of report.actions)
      this.records.push({ kind: "movement", contract, effect: { kind: "debt-settled", debtId: action.debtId } });
    for (const lag of report.lags)
      this.records.push({
        kind: "issue",
        contract,
        issue: {
          kind: "settlement-failed",
          ...(lag.debtId === undefined ? {} : { debtId: lag.debtId }),
          diagnostic: `${lag.surface}: ${lag.diagnostic}`,
        },
      });
    for (const failure of report.seatClose ?? []) this.recordSeatClose(contract, failure);
  }

  recordChannelRetirement(contract: ContractId, error: unknown): void {
    this.records.push({
      kind: "issue",
      contract,
      issue: {
        kind: "decode-channel-retirement",
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    });
  }

  /** World reset observations share the carrier without pretending a Contract admission happened. */
  recordReset(effect: Extract<InvocationEffect, { kind: "reset-owner-stopped" | "reset-residue" }>): void {
    this.records.push(effect);
  }

  recordDelivery(contract: ContractId, value: DeliveryIdentity): void {
    this.extendConclusions(contract, value);
  }

  extendConclusions(contract: ContractId, patch: ContractConclusion): void {
    this.candidateConclusions.set(contract, { ...(this.candidateConclusions.get(contract) ?? {}), ...patch });
  }

  conclusions(contract: ContractId): ContractConclusion | undefined {
    return this.candidateConclusions.get(contract);
  }

  snapshot(): InvocationSnapshot {
    return {
      facts: Object.freeze([...this.admittedFacts]),
      admitted: Object.freeze([...this.admitted]),
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
              attempted: Object.freeze([...this.resetState.attempted]),
            }),
          }),
    };
  }

  private recordSeatClose(contract: ContractId, failure: PrivateStateSeatCloseLag): void {
    if (this.reportedResidue.has(failure)) return;
    this.reportedResidue.add(failure);
    this.records.push({
      kind: "issue",
      contract,
      issue: { kind: "private-state-seat-close", diagnostic: failure.diagnostic },
    });
  }

  private recordLag(contract: ContractId, lag: ReconciliationLag): void {
    if (reconcileLagScope(lag) !== "none") this.affectedContracts.add(contract);
    this.records.push({ kind: "issue", contract, issue: lag });
  }
}
