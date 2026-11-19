/** @architectureCompositionRoot */
import { decodeJournal, encodeEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractHead, ContractId, ContractState, JournalEntry } from "../core/facts/types.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import type { ReconcileResult } from "../git/reconcile.js";
import type { Placed, Placement } from "../protocol/completion.js";
import type { VerifyValue } from "../protocol/verify.js";
import {
  observeExecution,
  type ExecutionObservation,
  type ExecutionObserver,
} from "../protocol/execution-observation.js";
import type { AcceptedProtocolStep } from "../protocol/outcome.js";
import {
  publicationKey,
  type ContractCheckpoint,
  type ExecutionStop,
  type ProgressResidue,
  type ProtocolProgress,
  type VerificationResidue,
} from "../protocol/progress.js";
import type { SettlementReport } from "../settlement/settle.js";
import type { InvocationEffect, InvocationIssue, ReconciliationLag } from "./outcome.js";
import { compactEffect, reconcileLagScope, reconcileLagIsFailure } from "./outcome.js";

type RecordedVerificationCheck = Parameters<ProtocolProgress["recordVerificationCheck"]>[2];

type AdmissionWitness = Readonly<{ bytes: string; reused: boolean }>;
export type InvocationSnapshot = Readonly<{
  facts: readonly JournalEntry[];
  reused?: string;
  checkpoints: ReadonlyMap<ContractId, ContractCheckpoint>;
  heads: ReadonlyMap<ContractId, ContractHead>;
  affected: readonly ContractId[];
  effects: readonly InvocationEffect[];
  placements: ReadonlyMap<ContractId, Placement>;
  verification: ReadonlyMap<ContractId, Pick<VerifyValue, "snapshot" | "checks">>;
}>;

type ReconciliationRecord = Readonly<{
  effects?: ReconcileResult["effects"];
  lag?: readonly ReconciliationLag[];
  settlement?: SettlementReport;
}>;

/**
 * The one invocation accumulator. It exists before any admission-capable await, satisfies the lower
 * Protocol progress sink, and holds confirmed publication, placement and physical observations.
 */
export class InvocationAccumulator implements ProtocolProgress {
  // Canonical witness bytes are custody; observers receive detached, newly admitted facts.
  private readonly entries = new Map<string, AdmissionWitness>();
  private readonly admittedHeads = new Map<ContractId, ContractHead>();
  private readonly admittedCheckpoints = new Map<ContractId, ContractCheckpoint>();
  private readonly affectedContracts = new Set<ContractId>();
  private readonly records: InvocationEffect[] = [];
  private readonly placements = new Map<ContractId, Placement>();
  private readonly verification = new Map<ContractId, Pick<VerifyValue, "snapshot" | "checks">>();
  private readonly reportedResidue = new WeakSet<object>();

  constructor(private readonly observer?: ExecutionObserver) {}

  firstFact<Kind extends JournalEntry["kind"]>(kind: Kind) {
    for (const { bytes, reused } of this.entries.values()) {
      if (reused) continue;
      const fact = decodeJournal(bytes)[0]!;
      if (fact.kind === kind) return fact as Extract<JournalEntry, { kind: Kind }>;
    }
    return undefined;
  }

  observe(event: ExecutionObservation): void {
    observeExecution(this.observer, event);
  }

  /** A confirmed publication is retained even if folding or later physical work throws. */
  recordPublication(contract: ContractId, head: ContractHead, facts: readonly JournalEntry[]): void {
    const fresh = this.recordWitnesses(contract, facts, false);
    if (fresh || !this.admittedHeads.has(contract)) this.admittedHeads.set(contract, head);
  }

  private recordWitnesses(contract: ContractId, facts: readonly JournalEntry[], reused: boolean): boolean {
    const incoming = new Map<string, Readonly<{ owner: ContractId; bytes: string }>>();
    for (const fact of facts) {
      const key = publicationKey(fact);
      const bytes = encodeEntry(fact);
      const previous = incoming.get(key)?.bytes ?? this.entries.get(key)?.bytes;
      if (previous !== undefined && previous !== bytes)
        throw new AuthorityCorruptionError("conflicting invocation receipt");
      incoming.set(key, { owner: fact.contract, bytes });
    }
    let fresh = false;
    for (const [key, { owner, bytes }] of incoming) {
      const known = this.entries.get(key);
      if (known !== undefined && (!known.reused || reused)) continue;
      this.entries.set(key, Object.freeze({ bytes, reused }));
      if (reused) continue;
      this.affectedContracts.add(owner);
      if (this.observer !== undefined)
        this.observe({ kind: "admitted", contractId: contract, fact: decodeJournal(bytes)[0]! });
      fresh = true;
    }
    return fresh;
  }

  recordAdmission(step: AcceptedProtocolStep, reused?: NonNullable<ContractState["delivery"]>): void {
    if (step.state.head === null) throw new Error("admission requires a journal head");
    this.recordPublication(step.state.id, step.state.head, step.facts);
    if (reused !== undefined) this.recordWitnesses(step.state.id, [reused], true);
    if (this.admittedHeads.get(step.state.id) === step.state.head) {
      this.admittedCheckpoints.set(step.state.id, { state: step.state, journal: step.journal });
    }
    this.recordResidue(step.state.id, step);
  }

  hasFact(fact: JournalEntry): boolean {
    const known = this.entries.get(publicationKey(fact));
    return known?.reused !== true && known?.bytes === encodeEntry(fact);
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
    const resource = { ...(snapshot === undefined ? {} : { snapshot }), ...coordinate };
    if (result.cleanup !== undefined)
      this.recordDiagnostic(contract, { ...resource, severity: "optional", ...result.cleanup });
    if (result.leak !== undefined)
      this.recordDiagnostic(contract, { ...resource, severity: "optional", ...result.leak });
  }

  recordVerificationCheck(
    contract: ContractId,
    snapshot: Parameters<ProtocolProgress["recordVerificationCheck"]>[1],
    check: RecordedVerificationCheck,
  ): void {
    const checks = this.verification.get(contract)?.checks ?? [];
    this.verification.set(contract, { snapshot, checks: [...checks, check] });
  }

  recordCandidate(contract: ContractId, placement: Placement | undefined): void {
    if (placement === undefined) this.placements.delete(contract);
    else this.placements.set(contract, placement);
  }

  recordCompletion(contract: ContractId, movement: Omit<Placed, "kind">): Placed {
    const retained = this.placements.get(contract);
    if (retained?.kind === "placed") return retained;
    const placement: Placed = { kind: "placed", ...movement };
    this.recordCandidate(contract, placement);
    return placement;
  }

  /** Physical residue a continuation's dependent reconciliation observed. */
  recordPhysical(contract: ContractId, physical: ReconcileResult): void {
    this.recordReconciliation(contract, physical);
  }

  recordPlacementPhysical(contract: ContractId, physical: ReconcileResult): void {
    this.recordReconciliation(contract, physical);
  }

  recordStop(stop: ExecutionStop): void {
    this.records.push({
      kind: "issue",
      contract: stop.contractId,
      issue: { kind: "execution-stopped", severity: "required", reason: stop.reason, diagnostic: stop.diagnostic },
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
          severity: "required",
          ...(lag.debtId === undefined ? {} : { debtId: lag.debtId }),
          diagnostic: `${lag.surface}: ${lag.diagnostic}`,
        },
      });
    for (const failure of report.seatClose ?? []) this.recordSeatClose(contract, failure);
  }

  snapshot(): InvocationSnapshot {
    const admissions = [...this.entries.values()];
    const reused = admissions.find((entry) => entry.reused)?.bytes;
    return {
      get facts() {
        return Object.freeze(
          decodeJournal(admissions.flatMap((entry) => (entry.reused ? [] : [entry.bytes])).join("")),
        );
      },
      ...(reused === undefined ? {} : { reused }),
      checkpoints: new Map(this.admittedCheckpoints),
      heads: new Map(this.admittedHeads),
      affected: Object.freeze([...this.affectedContracts]),
      effects: Object.freeze([...this.records]),
      placements: new Map(this.placements),
      verification: new Map(this.verification),
    };
  }

  private recordSeatClose(contract: ContractId, failure: PrivateStateSeatCloseLag): void {
    if (this.reportedResidue.has(failure)) return;
    this.reportedResidue.add(failure);
    this.recordDiagnostic(contract, { severity: "required", diagnostic: failure.diagnostic });
  }

  private recordDiagnostic(
    contract: ContractId,
    issue: Omit<Extract<InvocationIssue, { kind: "diagnostic" }>, "kind" | "contractId">,
  ): void {
    const diagnostic =
      issue.diagnostic.length > 4096 ? `${issue.diagnostic.slice(0, 4096)}\n[diagnostic truncated]` : issue.diagnostic;
    this.records.push({ kind: "issue", contract, issue: { ...issue, kind: "diagnostic", diagnostic } });
  }

  private recordLag(contract: ContractId, lag: ReconciliationLag): void {
    if (reconcileLagScope(lag) !== "none") this.affectedContracts.add(contract);
    this.records.push({
      kind: "issue",
      contract,
      issue: {
        ...lag,
        severity: reconcileLagIsFailure(lag) ? "required" : "optional",
      },
    });
  }
}
