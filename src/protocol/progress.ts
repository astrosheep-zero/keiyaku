import { encodeEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractHead, ContractId, ContractState, JournalEntry, SnapshotId } from "../core/facts/types.js";
import { GitPlumbingError } from "../git/process.js";
import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import type { ReconcileResult } from "../git/reconcile.js";
import type { WorktreeLeak } from "../git/scratch.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import type { VerificationCleanupFailure } from "./intent.js";
import type { AcceptedProtocolStep, IntentOutcome } from "./outcome.js";

/** A captured interpretation is not an invocation's admission receipt. */
export type ContractCheckpoint = Readonly<{ state: ContractState; journal: readonly JournalEntry[] }>;

export function contractCheckpoint(input: ContractCheckpoint): ContractCheckpoint {
  return { state: input.state, journal: input.journal };
}

export type ExecutionCleanup =
  | Readonly<{
      kind: "verification-cleanup";
      contractId: ContractId;
      snapshot?: SnapshotId;
      failure: VerificationCleanupFailure;
    }>
  | Readonly<{ kind: "worktree-leak"; contractId: ContractId; snapshot?: SnapshotId; leak: WorktreeLeak }>
  | Readonly<{ kind: "private-state-seat-close"; contractId: ContractId; failure: PrivateStateSeatCloseLag }>;

export type ExecutionStage =
  | "admission"
  | "verification"
  | "placement"
  | "reintegration"
  | "continuation"
  | "reconciliation";
export type ExecutionStop = Readonly<{
  kind: "execution-stopped";
  contractId: ContractId;
  stage: ExecutionStage;
  reason: "cancelled" | "failed";
  diagnostic: string;
}>;

/** Classify operational failures only; programming errors and corrupt authority still throw. */
export function executionStop(
  contractId: ContractId,
  stage: ExecutionStage,
  error: unknown,
  signal?: AbortSignal,
): ExecutionStop {
  if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
  const cancelled =
    (signal?.aborted === true && error === signal.reason) ||
    (error instanceof Error && error.name === "AbortError") ||
    (signal?.aborted === true && (error instanceof GitPlumbingError || error instanceof SqliteTransactionLockError));
  const errno =
    error instanceof Error && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/u.test(error.code);
  if (!cancelled && !errno && !(error instanceof GitPlumbingError) && !(error instanceof SqliteTransactionLockError))
    throw error;
  return {
    kind: "execution-stopped",
    contractId,
    stage,
    reason: cancelled ? "cancelled" : "failed",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

export type ExecutionSnapshot = Readonly<{
  facts: readonly JournalEntry[];
  checkpoints: ReadonlyMap<ContractId, ContractCheckpoint>;
  heads: ReadonlyMap<ContractId, ContractHead>;
  affected: readonly ContractId[];
  physical: ReconcileResult;
  cleanup: readonly ExecutionCleanup[];
  stops: readonly ExecutionStop[];
}>;

type Residue = Readonly<{ physical?: ReconcileResult; seatClose?: readonly PrivateStateSeatCloseLag[] }>;

/** Invocation-local receipts only: no persistence, scheduling, callbacks, or authority reads. */
export class ExecutionProgress {
  private readonly entries = new Map<string, string>();
  private readonly admittedFacts: JournalEntry[] = [];
  private readonly admittedHeads = new Map<ContractId, ContractHead>();
  private readonly admittedCheckpoints = new Map<ContractId, ContractCheckpoint>();
  private readonly affectedContracts = new Set<ContractId>();
  private readonly effects: ReconcileResult["effects"][number][] = [];
  private readonly lags: ReconcileResult["lag"][number][] = [];
  private readonly cleanupIssues: ExecutionCleanup[] = [];
  private readonly executionStops: ExecutionStop[] = [];
  private readonly reportedResidue = new WeakSet<object>();

  /** A confirmed publication is retained even if folding or later physical work throws. */
  recordPublication(contractId: ContractId, head: ContractHead, facts: readonly JournalEntry[]): void {
    const incoming = new Map<string, Readonly<{ fact: JournalEntry; bytes: string }>>();
    for (const fact of facts) {
      const key = `${fact.contract}\0${fact.entry}`;
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
      this.affectedContracts.add(fact.contract);
      fresh = true;
    }
    if (fresh) this.admittedHeads.set(contractId, head);
  }

  recordAdmission(step: AcceptedProtocolStep): void {
    if (step.state.head === null) throw new Error("admission requires a journal head");
    this.recordPublication(step.state.id, step.state.head, step.facts);
    if (this.admittedHeads.get(step.state.id) === step.state.head) {
      this.admittedCheckpoints.set(step.state.id, contractCheckpoint(step));
    }
    this.recordResidue(step.state.id, step);
  }

  hasFact(fact: JournalEntry): boolean {
    return this.entries.get(`${fact.contract}\0${fact.entry}`) === encodeEntry(fact);
  }

  head(contractId: ContractId): ContractHead | undefined {
    return this.admittedHeads.get(contractId);
  }

  recordResidue(contractId: ContractId, residue: Residue): void {
    if (residue.physical !== undefined) this.recordPhysical(contractId, residue.physical);
    for (const failure of residue.seatClose ?? []) {
      if (this.reportedResidue.has(failure)) continue;
      this.reportedResidue.add(failure);
      this.cleanupIssues.push({ kind: "private-state-seat-close", contractId, failure });
    }
  }

  recordPhysical(contractId: ContractId, physical: ReconcileResult): void {
    if (physical.effects.length > 0 || physical.lag.length > 0) this.affectedContracts.add(contractId);
    for (const effect of physical.effects) {
      if (this.reportedResidue.has(effect)) continue;
      this.reportedResidue.add(effect);
      this.effects.push(effect);
    }
    for (const lag of physical.lag) {
      if (this.reportedResidue.has(lag)) continue;
      this.reportedResidue.add(lag);
      this.lags.push(lag);
    }
  }

  recordVerification(
    contractId: ContractId,
    snapshot: SnapshotId | undefined,
    result: Readonly<{ cleanup?: VerificationCleanupFailure; leak?: WorktreeLeak }>,
  ): void {
    if (result.cleanup !== undefined)
      this.cleanupIssues.push({
        kind: "verification-cleanup",
        contractId,
        ...(snapshot === undefined ? {} : { snapshot }),
        failure: result.cleanup,
      });
    if (result.leak !== undefined)
      this.cleanupIssues.push({
        kind: "worktree-leak",
        contractId,
        ...(snapshot === undefined ? {} : { snapshot }),
        leak: result.leak,
      });
  }

  recordStop(stop: ExecutionStop): void {
    if (!this.executionStops.includes(stop)) this.executionStops.push(stop);
  }

  checkpoint(contractId: ContractId): ContractCheckpoint | undefined {
    return this.admittedCheckpoints.get(contractId);
  }

  snapshot(): ExecutionSnapshot {
    return {
      facts: Object.freeze([...this.admittedFacts]),
      checkpoints: new Map(this.admittedCheckpoints),
      heads: new Map(this.admittedHeads),
      affected: Object.freeze([...this.affectedContracts]),
      physical: { effects: Object.freeze([...this.effects]), lag: Object.freeze([...this.lags]) },
      cleanup: Object.freeze([...this.cleanupIssues]),
      stops: Object.freeze([...this.executionStops]),
    };
  }

  /** One final assembly; a dependent's checkpoint can never replace the addressed head. */
  accepted<Value>(contractId: ContractId, value: Value): Extract<IntentOutcome<Value>, { kind: "accepted" }> {
    const head = this.head(contractId);
    if (head === undefined) throw new Error("missing leading admission receipt");
    const snapshot = this.snapshot();
    return { kind: "accepted", head, facts: snapshot.facts, value, physical: snapshot.physical };
  }
}
