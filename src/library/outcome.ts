/** @architectureCompositionRoot */
import { decodeJournalEntry, decodeDeliverData, encodeEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  contractHead,
  contractId,
  snapshotId,
  gate,
  type ContractHead,
  type ContractId,
  type JournalEntry,
} from "../core/facts/types.js";
import type { Effect, ReconcileResult, ReconcileLag } from "../git/reconcile.js";
import {
  decodeGitReconcileLag,
  decodePrivateStateSeatCloseLag,
  decodeReconcileEffect,
  decodeWorktreeLeak,
} from "../git/result-codec.js";
import {
  decodeContractFileEffect,
  decodeContractFileLag,
  type ContractFileEffect,
  type ContractFileLag,
} from "../contract-worktree.js";
import { decodeSettlementAction, decodeSettlementLag } from "../settlement/result-codec.js";
import type { SettlementAction, SettlementLag, SettlementReport } from "../settlement/settle.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import {
  observeExecution,
  type ExecutionObservation,
  type ExecutionObserver,
} from "../protocol/execution-observation.js";
import {
  executionStop,
  type ContractCheckpoint,
  type ExecutionCleanup,
  type ExecutionStage,
  type ExecutionStop,
  type ProtocolProgress,
  type ProgressResidue,
  type VerificationResidue,
} from "../protocol/progress.js";
import {
  decodeExecutionStop,
  decodePartialAuditReport,
  decodeCompletionEvidenceFields,
  decodeDeliverLeading,
  decodeVerificationCleanupFailure,
} from "../protocol/result-codec.js";
import type { AcceptedProtocolStep } from "../protocol/outcome.js";
import type { CandidateCompletion, CompletionEvidence } from "../protocol/completion.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { AuditReport } from "../protocol/audit.js";
import { decodeAuditReport } from "../protocol/audit.js";
import { decodeReviewValue, type ReviewValue } from "../protocol/review.js";
import { decodeContinuationReport, type ContinuationReport } from "./continuation.js";
import { reconcileLagScope, type ReconcileLagScope } from "./reconcile.js";
import {
  decodeOperationRefusal,
  decodeOperationRetry,
  type OperationRefusals,
  type OperationRetries,
} from "./refusal.js";
import { ownerSchema } from "./result-codec.js";
import { z } from "zod";
import type { WorldRoot } from "../world.js";
import type { NukeConfirmationRefusal, NukeConfirmationRequiredRefusal } from "./refusal.js";

export type { ExecutionCleanup, ExecutionStop } from "../protocol/progress.js";
export { executionStop };

/** The seven Contract verbs, plus the World reset that shares the same envelope shape. */
export type ContractVerb = "bind" | "amend" | "deliver" | "review" | "audit" | "arc" | "abandon";
export type OutcomeOperation = ContractVerb | "nuke";

// ---------------------------------------------------------------------------
// One invocation-wide tagged Effect carrier
// ---------------------------------------------------------------------------

export type ReconciliationEffect = Effect | ContractFileEffect;
export type ReconciliationLag = ReconcileLag | ContractFileLag;
export type ResetOwner = "akuma" | "git" | "task" | "world";

export type InvocationEffect =
  | Readonly<{ kind: "reconciliation-effect"; contract: ContractId; effect: ReconciliationEffect }>
  | Readonly<{ kind: "reconciliation-lag"; contract: ContractId; affects: ReconcileLagScope; lag: ReconciliationLag }>
  | Readonly<{ kind: "checkout-retained"; contract: ContractId; path: string; target: string; diagnostic: string }>
  | Readonly<{ kind: "settlement-action"; contract: ContractId; action: SettlementAction }>
  | Readonly<{ kind: "settlement-lag"; contract: ContractId; lag: SettlementLag }>
  | Readonly<{ kind: "cleanup"; contract: ContractId; issue: ExecutionCleanup }>
  | Readonly<{
      kind: "execution-stopped";
      contract: ContractId;
      stage: ExecutionStage;
      reason: "cancelled" | "failed";
      diagnostic: string;
    }>
  | Readonly<{ kind: "worktree-retired"; contract: ContractId; name: string }>
  | Readonly<{ kind: "worktree-retained"; contract: ContractId; path: string }>
  | Readonly<{ kind: "reset-owner-stopped"; world: string; owner: ResetOwner; diagnostic: string }>
  | Readonly<{ kind: "reset-residue"; world: string; owner: ResetOwner; diagnostic: string }>;

export type ResetEffect = Extract<InvocationEffect, { kind: "reset-owner-stopped" | "reset-residue" }>;

export type PendingAction =
  | "reset"
  | "verification"
  | "placement"
  | "continuation"
  | "reconciliation"
  | "settlement"
  | "cleanup"
  | "execution";

/** A surface this invocation did not finish; `required` separates owed work from retained residue. */
export type PendingSurface = Readonly<{ surface: PendingAction; required: boolean }>;

// ---------------------------------------------------------------------------
// The one accumulator
// ---------------------------------------------------------------------------

export type InvocationSnapshot = Readonly<{
  facts: readonly JournalEntry[];
  checkpoints: ReadonlyMap<ContractId, ContractCheckpoint>;
  heads: ReadonlyMap<ContractId, ContractHead>;
  affected: readonly ContractId[];
  effects: readonly InvocationEffect[];
  conclusions: ReadonlyMap<ContractId, Readonly<Record<string, unknown>>>;
  reset?: Readonly<{ world: WorldRoot; removed: ResetCounts }>;
}>;

export type ReconciliationRecord = Readonly<{
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

// ---------------------------------------------------------------------------
// The public envelope
// ---------------------------------------------------------------------------

export type EnvelopeFields = Readonly<{
  operation: ContractVerb;
  contract?: ContractId;
  facts: readonly JournalEntry[];
  effects: readonly InvocationEffect[];
  pending: readonly PendingSurface[];
}>;

export type AcceptedOutcome<Operation extends ContractVerb, Value> = EnvelopeFields &
  Readonly<{ operation: Operation; kind: "accepted"; contract: ContractId; head: ContractHead; value: Value }>;

export type RefusedOutcome<Operation extends ContractVerb, Refusal> = EnvelopeFields &
  Readonly<{ operation: Operation; kind: "refused"; refusal: Refusal }>;

export type RetryOutcome<Operation extends ContractVerb> = EnvelopeFields &
  Readonly<{ operation: Operation; kind: "retry"; reason: OperationRetries[Operation] }>;

/** A no-fact integration handoff; only delivery produces one. */
export type HandoffOutcome = EnvelopeFields &
  Readonly<{
    operation: "deliver";
    kind: "handoff";
    contract: ContractId;
    value: IntegrationConflictMaterialized;
  }>;

export type OperationOutcome<Operation extends ContractVerb, Value, Refusal> =
  | AcceptedOutcome<Operation, Value>
  | RefusedOutcome<Operation, Refusal>
  | RetryOutcome<Operation>;

/** Every public answer this owner can project for one operation. Only delivery hands off. */
export type ProjectedOutcome<Operation extends ContractVerb, Value, Refusal> =
  | AcceptedOutcome<Operation, Value>
  | RefusedOutcome<Operation, Refusal>
  | RetryOutcome<Operation>
  | (Operation extends "deliver" ? HandoffOutcome : never);

export type ResetCounts = Readonly<{ refs: number; worktrees: number; tasks: number }>;
export type ResetValue = Readonly<{ removed: ResetCounts }>;
export type ResetRefusal = NukeConfirmationRefusal | NukeConfirmationRequiredRefusal;
export type ResetOutcome =
  | Readonly<{
      operation: "nuke";
      kind: "accepted";
      world: WorldRoot;
      value: ResetValue;
      effects: readonly ResetEffect[];
      pending: readonly PendingSurface[];
    }>
  | Readonly<{
      operation: "nuke";
      kind: "refused";
      world: WorldRoot;
      refusal: ResetRefusal;
      effects: readonly ResetEffect[];
      pending: readonly PendingSurface[];
    }>;

type ResetProjection = Readonly<{ world: WorldRoot }> &
  (
    | Readonly<{ kind: "accepted" }>
    | Readonly<{ kind: "refused"; refusal: ResetRefusal }>
    | Readonly<{ kind: "failed"; error: unknown }>
  );

export type OperationEvidenceValues = Readonly<{
  bind: z.infer<typeof bindEvidenceSchema>;
  amend: z.infer<typeof amendEvidenceSchema>;
  deliver: import("./delivery.js").DeliveryValue;
  review: Review;
  audit: AuditReport;
  arc: Readonly<Record<string, never>>;
  abandon: Readonly<Record<string, never>>;
}>;

type PartialContractEnvelope = {
  [Operation in ContractVerb]: Omit<EnvelopeFields, "operation"> &
    Readonly<{
      operation: Operation;
      head?: ContractHead;
      value?: Partial<OperationEvidenceValues[Operation]>;
    }>;
}[ContractVerb];
export type PartialOutcomeEnvelope =
  | PartialContractEnvelope
  | Readonly<{
      operation: "nuke";
      world: string;
      effects: readonly ResetEffect[];
      pending: readonly PendingSurface[];
      value?: ResetValue;
    }>;

function surface(surface: PendingAction, required: boolean): PendingSurface {
  return { surface, required };
}

function phasePending(operation: OutcomeOperation, value: unknown): readonly PendingSurface[] {
  if (operation === "audit") {
    const report = value as AuditReport | undefined;
    return report?.verification?.kind === "stopped" ? [surface("verification", true)] : [];
  }
  if (operation !== "review" && operation !== "deliver") return [];
  const concluded = value as
    | { verification?: unknown; placement?: unknown; continuation?: ContinuationReport }
    | undefined;
  if (concluded === undefined) return [];
  const pending: PendingSurface[] = [];
  if (concluded.verification !== undefined) pending.push(surface("verification", true));
  if (concluded.placement !== undefined) pending.push(surface("placement", true));
  if (concluded.continuation !== undefined && concluded.continuation.stopped.length > 0)
    pending.push(surface("continuation", true));
  return pending;
}

function stopSurface(stage: ExecutionStage): PendingAction {
  return stage === "admission" ? "execution" : stage === "reintegration" ? "placement" : stage;
}

function effectPending(effects: readonly InvocationEffect[]): readonly PendingSurface[] {
  const pending: PendingSurface[] = [];
  for (const effect of effects) {
    if (effect.kind === "reconciliation-lag") {
      if (effect.affects !== "none") pending.push(surface(effect.affects, true));
    } else if (effect.kind === "checkout-retained") pending.push(surface("placement", true));
    else if (effect.kind === "settlement-lag") pending.push(surface("settlement", true));
    else if (effect.kind === "cleanup") pending.push(surface("cleanup", false));
    else if (effect.kind === "execution-stopped") pending.push(surface(stopSurface(effect.stage), true));
    else if (effect.kind === "reset-owner-stopped") pending.push(surface("reset", true));
    else if (effect.kind === "reset-residue") pending.push(surface("reset", false));
  }
  return pending;
}

/**
 * Pending is computed here and nowhere else, from the operation's conclusions and the invocation's
 * effects. It is never taken from a transported summary.
 */
function projectPending(
  operation: OutcomeOperation,
  value: unknown,
  effects: readonly InvocationEffect[],
): readonly PendingSurface[] {
  const merged = new Map<PendingAction, boolean>();
  for (const entry of [...phasePending(operation, value), ...effectPending(effects)])
    merged.set(entry.surface, entry.required || merged.get(entry.surface) === true);
  return [...merged].map(([name, required]) => ({ surface: name, required }));
}

// ---------------------------------------------------------------------------
// The one projector
// ---------------------------------------------------------------------------

/** What the invocation reached when its owned work stopped. */
export type OutcomeProjection<Operation extends ContractVerb, Value, Refusal> =
  | Readonly<{
      kind: "accepted";
      contract: ContractId;
      head: ContractHead;
      value: Value;
    }>
  | Readonly<{ kind: "refused"; contract?: ContractId; refusal: Refusal }>
  | Readonly<{ kind: "retry"; contract?: ContractId; reason: OperationRetries[Operation] }>
  | Readonly<{ kind: "failed"; contract?: ContractId; error: unknown }>
  | (Operation extends "deliver"
      ? Readonly<{ kind: "handoff"; contract: ContractId; value: IntegrationConflictMaterialized }>
      : never);

export type Projected<Operation extends ContractVerb, Value, Refusal> =
  | Readonly<{ kind: "returned"; outcome: ProjectedOutcome<Operation, Value, Refusal> }>
  | Readonly<{ kind: "failed"; error: KeiyakuError }>;

function envelopeOf(
  operation: ContractVerb,
  snapshot: InvocationSnapshot,
  contract: ContractId | undefined,
  value: unknown,
): { fields: Omit<EnvelopeFields, "operation" | "pending">; pending: readonly PendingSurface[] } {
  return {
    fields: {
      ...(contract === undefined ? {} : { contract }),
      facts: snapshot.facts,
      effects: snapshot.effects,
    },
    pending: projectPending(operation, value, snapshot.effects),
  };
}

/**
 * The single final projector. It reads one immutable accumulator snapshot after owned teardown and
 * produces the shared envelope for a complete answer or, on the failure path, the same envelope as
 * the exceptional receipt. There is no independently assembled partial result.
 */
export function project(
  operation: "nuke",
  snapshot: InvocationSnapshot,
  projection: ResetProjection,
): Readonly<{ kind: "returned"; outcome: ResetOutcome }> | Readonly<{ kind: "failed"; error: KeiyakuError }>;
export function project<Operation extends ContractVerb, Value, Refusal>(
  operation: Operation,
  snapshot: InvocationSnapshot,
  projection: OutcomeProjection<Operation, Value, Refusal>,
): Projected<Operation, Value, Refusal>;
export function project<Value, Refusal>(
  operation: OutcomeOperation,
  snapshot: InvocationSnapshot,
  projection: OutcomeProjection<ContractVerb, Value, Refusal> | ResetProjection,
): Projected<ContractVerb, Value, Refusal> | Readonly<{ kind: "returned"; outcome: ResetOutcome }> {
  if ("world" in projection) {
    if (operation !== "nuke") throw new Error("reset projection requires nuke");
    const effects = snapshot.effects.filter(
      (effect): effect is ResetEffect => effect.kind === "reset-owner-stopped" || effect.kind === "reset-residue",
    );
    const value = { removed: snapshot.reset?.removed ?? { refs: 0, worktrees: 0, tasks: 0 } };
    const base = { operation, world: projection.world, effects, pending: projectPending(operation, value, effects) };
    if (projection.kind === "failed")
      return {
        kind: "failed",
        error: withOutcomeReceipt(projection.error, { ...base, value }),
      };
    return {
      kind: "returned",
      outcome:
        projection.kind === "refused"
          ? { ...base, kind: "refused", refusal: projection.refusal }
          : { ...base, kind: "accepted", value },
    };
  }
  if (operation === "nuke") throw new Error("nuke requires a World projection");
  const contract = projection.contract;
  const value =
    projection.kind === "accepted" || projection.kind === "handoff"
      ? projection.value
      : contract === undefined
        ? undefined
        : snapshot.conclusions.get(contract);
  const { fields, pending } = envelopeOf(operation, snapshot, contract, value);
  const base = { operation, ...fields, pending };
  switch (projection.kind) {
    case "accepted":
      return {
        kind: "returned",
        outcome: {
          ...base,
          kind: "accepted",
          contract: projection.contract,
          head: projection.head,
          value: projection.value,
        },
      };
    case "handoff":
      return {
        kind: "returned",
        outcome: {
          ...base,
          kind: "handoff",
          contract: projection.contract,
          value: projection.value,
        } as HandoffOutcome,
      };
    case "refused":
      return { kind: "returned", outcome: { ...base, kind: "refused", refusal: projection.refusal } };
    case "retry":
      return { kind: "returned", outcome: { ...base, kind: "retry", reason: projection.reason } };
    case "failed": {
      const head = contract === undefined ? undefined : snapshot.heads.get(contract);
      // This is trusted owner evidence, not wire input. A decoder must never mask the original failure.
      const partial = {
        operation,
        ...fields,
        pending,
        ...(head === undefined ? {} : { head }),
        ...(value === undefined ? {} : { value }),
      } as PartialContractEnvelope;
      return { kind: "failed", error: withOutcomeReceipt(projection.error, partial) };
    }
  }
}

// ---------------------------------------------------------------------------
// Exceptional failure
// ---------------------------------------------------------------------------

export type KeiyakuErrorCategory =
  | "invalid-input"
  | "authority-corruption"
  | "unknown-outcome"
  | "aborted"
  | "internal";

export type KeiyakuErrorOptions = Readonly<{ cause?: unknown; outcome?: PartialOutcomeEnvelope }>;

/** The one exceptional failure: a category, the native original cause, and an optional same-envelope receipt. */
export class KeiyakuError extends Error {
  readonly category: KeiyakuErrorCategory;
  readonly outcome?: PartialOutcomeEnvelope;

  constructor(category: KeiyakuErrorCategory, message: string, options: KeiyakuErrorOptions = {}) {
    super(message);
    this.name = "KeiyakuError";
    this.category = category;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.outcome !== undefined) this.outcome = options.outcome;
  }
}

/** One explicit caller-validation phase; its failures are invalid input with a native TypeError cause. */
export function validated<Value>(phase: () => Value): Value {
  try {
    return phase();
  } catch (error) {
    if (error instanceof KeiyakuError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new KeiyakuError("invalid-input", message, {
      cause: error instanceof TypeError ? error : new TypeError(message),
    });
  }
}

export function errorCategory(error: unknown): KeiyakuErrorCategory {
  if (error instanceof AuthorityCorruptionError) return "authority-corruption";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "aborted";
  return "internal";
}

function errorDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Attach this invocation's partial envelope without changing the error's own identity or category. */
export function withOutcomeReceipt(error: unknown, outcome: PartialOutcomeEnvelope): KeiyakuError {
  if (error instanceof KeiyakuError) {
    const current = new KeiyakuError(error.category, error.message, { cause: error.cause, outcome });
    for (const key of ["requestId", "action", "requestOutcome"]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (descriptor !== undefined) Object.defineProperty(current, key, { ...descriptor, enumerable: false });
    }
    return current;
  }
  return new KeiyakuError(errorCategory(error), errorDiagnostic(error), { cause: error, outcome });
}

// ---------------------------------------------------------------------------
// Public value decoders shared by the wire and the CLI adapter
// ---------------------------------------------------------------------------

export type Review = ReviewValue & Readonly<{ continuation?: ContinuationReport }>;

export function decodeReview(value: unknown): Review {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed review");
  const { continuation, ...protocol } = value as Record<string, unknown>;
  const review = decodeReviewValue(protocol);
  return continuation === undefined ? review : { ...review, continuation: decodeContinuationReport(continuation) };
}

export const auditReportSchema = ownerSchema(
  decodeAuditReport,
  "expected audit report",
) satisfies z.ZodType<AuditReport>;
export const reviewSchema = ownerSchema(decodeReview, "expected review") satisfies z.ZodType<Review>;

// ---------------------------------------------------------------------------
// Interim wire schema for the one envelope
// ---------------------------------------------------------------------------

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`malformed ${label}`);
  return value as Record<string, unknown>;
}

function nonblank(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("expected nonblank text");
  return value;
}

function decodeCoordinate(value: unknown): ContractId {
  if (typeof value !== "string") throw new Error("expected contract identity");
  return contractId(value);
}

function decodeReconciliationEffect(value: unknown): ReconciliationEffect {
  try {
    return decodeContractFileEffect(value);
  } catch {
    return decodeReconcileEffect(value);
  }
}

function decodeReconciliationLag(value: unknown): ReconciliationLag {
  try {
    return decodeGitReconcileLag(value);
  } catch {
    return decodeContractFileLag(value);
  }
}

function decodeCleanup(value: unknown): ExecutionCleanup {
  const record = plainRecord(value, "cleanup");
  const contract = decodeCoordinate(record.contractId);
  if (record.kind === "decode-channel-retirement") {
    if (Object.keys(record).some((key) => !["kind", "contractId", "diagnostic"].includes(key)))
      throw new Error("malformed cleanup");
    return { kind: "decode-channel-retirement", contractId: contract, diagnostic: nonblank(record.diagnostic) };
  }
  const allowed =
    record.kind === "private-state-seat-close"
      ? ["kind", "contractId", "failure"]
      : record.kind === "verification-cleanup"
        ? ["kind", "contractId", "snapshot", "failure"]
        : ["kind", "contractId", "snapshot", "leak"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("malformed cleanup");
  if (record.kind === "private-state-seat-close")
    return {
      kind: "private-state-seat-close",
      contractId: contract,
      failure: decodePrivateStateSeatCloseLag(record.failure),
    };
  const snapshot =
    record.snapshot === undefined
      ? {}
      : typeof record.snapshot === "string"
        ? { snapshot: snapshotId(record.snapshot) }
        : (() => {
            throw new Error("malformed cleanup");
          })();
  if (record.kind === "verification-cleanup")
    return {
      kind: "verification-cleanup",
      contractId: contract,
      ...snapshot,
      failure: decodeVerificationCleanupFailure(record.failure),
    };
  if (record.kind === "worktree-leak")
    return { kind: "worktree-leak", contractId: contract, ...snapshot, leak: decodeWorktreeLeak(record.leak) };
  throw new Error("malformed cleanup");
}

const EFFECT_KEYS: Readonly<Record<string, readonly string[]>> = {
  "reconciliation-effect": ["kind", "contract", "effect"],
  "reconciliation-lag": ["kind", "contract", "affects", "lag"],
  "settlement-action": ["kind", "contract", "action"],
  "settlement-lag": ["kind", "contract", "lag"],
  cleanup: ["kind", "contract", "issue"],
  "checkout-retained": ["kind", "contract", "path", "target", "diagnostic"],
  "execution-stopped": ["kind", "contract", "stage", "reason", "diagnostic"],
  "worktree-retired": ["kind", "contract", "name"],
  "worktree-retained": ["kind", "contract", "path"],
  "reset-owner-stopped": ["kind", "world", "owner", "diagnostic"],
  "reset-residue": ["kind", "world", "owner", "diagnostic"],
};

function effectKeys(kind: unknown): readonly string[] {
  return typeof kind === "string" ? (EFFECT_KEYS[kind] ?? []) : [];
}

export function decodeInvocationEffect(value: unknown): InvocationEffect {
  const record = plainRecord(value, "invocation effect");
  const kind = record.kind;
  const expected = effectKeys(kind);
  if (expected.length === 0 || Object.keys(record).some((key) => !expected.includes(key)))
    throw new Error("malformed invocation effect");
  if (expected.some((key) => !(key in record))) throw new Error("malformed invocation effect");
  if (kind === "reconciliation-effect")
    return { kind, contract: decodeCoordinate(record.contract), effect: decodeReconciliationEffect(record.effect) };
  if (kind === "reconciliation-lag") {
    const lag = decodeReconciliationLag(record.lag);
    const affects = reconcileLagScope(lag);
    if (record.affects !== affects) throw new Error("malformed reconciliation requiredness");
    return { kind, contract: decodeCoordinate(record.contract), affects, lag };
  }
  if (kind === "checkout-retained")
    return {
      kind,
      contract: decodeCoordinate(record.contract),
      path: nonblank(record.path),
      target: nonblank(record.target),
      diagnostic: nonblank(record.diagnostic),
    };
  if (kind === "settlement-action")
    return { kind, contract: decodeCoordinate(record.contract), action: decodeSettlementAction(record.action) };
  if (kind === "settlement-lag")
    return { kind, contract: decodeCoordinate(record.contract), lag: decodeSettlementLag(record.lag) };
  if (kind === "cleanup") {
    const contract = decodeCoordinate(record.contract);
    const issue = decodeCleanup(record.issue);
    if (issue.contractId !== contract) throw new Error("malformed cleanup owner");
    return { kind, contract, issue };
  }
  if (kind === "execution-stopped") {
    const stop = decodeExecutionStop({
      kind: record.kind,
      contractId: record.contract,
      stage: record.stage,
      reason: record.reason,
      diagnostic: record.diagnostic,
    });
    return {
      kind,
      contract: stop.contractId,
      stage: stop.stage,
      reason: stop.reason,
      diagnostic: stop.diagnostic,
    };
  }
  if (kind === "worktree-retired")
    return { kind, contract: decodeCoordinate(record.contract), name: nonblank(record.name) };
  if (kind === "worktree-retained")
    return { kind, contract: decodeCoordinate(record.contract), path: nonblank(record.path) };
  if (kind !== "reset-owner-stopped" && kind !== "reset-residue") throw new Error("malformed invocation effect");
  return decodeResetEffect(record, kind);
}

function decodeResetEffect(record: Record<string, unknown>, kind: ResetEffect["kind"]): ResetEffect {
  const owner = record.owner;
  if (owner !== "akuma" && owner !== "git" && owner !== "task" && owner !== "world")
    throw new Error("malformed invocation effect");
  return { kind, world: nonblank(record.world), owner, diagnostic: nonblank(record.diagnostic) };
}

function decodePending(value: unknown): PendingSurface {
  const record = plainRecord(value, "pending surface");
  const surfaces: readonly PendingAction[] = [
    "reset",
    "verification",
    "placement",
    "continuation",
    "reconciliation",
    "settlement",
    "cleanup",
    "execution",
  ];
  if (!surfaces.includes(record.surface as PendingAction) || typeof record.required !== "boolean")
    throw new Error("malformed pending surface");
  if (Object.keys(record).some((key) => key !== "surface" && key !== "required"))
    throw new Error("malformed pending surface");
  return { surface: record.surface as PendingAction, required: record.required };
}

const VERBS: readonly OutcomeOperation[] = ["bind", "amend", "deliver", "review", "audit", "arc", "abandon", "nuke"];

function envelopeRecord(
  input: unknown,
  label: "partial" | "complete",
): { envelope: Record<string, unknown>; operation: OutcomeOperation } {
  const record = plainRecord(input, label);
  const operation = record.operation;
  if (typeof operation !== "string" || !(VERBS as readonly string[]).includes(operation))
    throw new Error(`malformed ${label}`);
  const allowed = [
    "operation",
    "effects",
    "pending",
    ...(operation === "nuke" ? ["world"] : ["contract", "head", "facts"]),
    ...(label === "partial"
      ? ["value"]
      : record.kind === "accepted" || record.kind === "handoff"
        ? ["kind", "value"]
        : record.kind === "refused"
          ? ["kind", "refusal"]
          : record.kind === "retry"
            ? ["kind", "reason"]
            : []),
  ];
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(`malformed ${label}`);
  if (
    (operation !== "nuke" && !Array.isArray(record.facts)) ||
    !Array.isArray(record.effects) ||
    !Array.isArray(record.pending)
  )
    throw new Error(`malformed ${label}`);
  return { envelope: record, operation: operation as OutcomeOperation };
}

const regionOverlapSchema = z
  .object({
    contract: z.string().transform(contractId),
    patterns: z
      .array(
        z
          .object({
            mine: z.string(),
            theirs: z.string(),
            relation: z.enum(["same", "mine-within-theirs", "theirs-within-mine", "intersect"]).optional(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();
const bindEvidenceSchema = z
  .object({
    keiyaku: z
      .object({ contract: z.string().transform(contractId) })
      .strict()
      .optional(),
    workspace: z
      .object({ kind: z.literal("worktree"), path: z.string().min(1) })
      .strict()
      .optional(),
    warnings: z.array(z.string()).readonly().optional(),
    overlaps: z.array(regionOverlapSchema).readonly().optional(),
    overlapFailure: z.string().optional(),
  })
  .strict()
  .refine((value) => value.overlaps === undefined || value.overlapFailure === undefined);
const amendEvidenceSchema = z
  .object({
    documentDiff: z.string().optional(),
    changes: z
      .object({
        gates: z.array(z.string().transform(gate)).readonly().optional(),
        after: z.array(z.string().transform(contractId)).readonly().optional(),
      })
      .strict()
      .optional(),
    overlaps: z.array(regionOverlapSchema).readonly().optional(),
    overlapFailure: z.string().optional(),
  })
  .strict()
  .refine((value) => value.overlaps === undefined || value.overlapFailure === undefined);

function decodePartialDelivery(value: unknown): Partial<OperationEvidenceValues["deliver"]> {
  const object = plainRecord(value, "delivery evidence");
  const identityKeys = ["tenderSnapshot", "integration", "method", "policy"];
  const conclusionKeys = [
    "leading",
    "completion",
    "verification",
    "verificationReuse",
    "verificationSubject",
    "verificationSummary",
    "placement",
    "continuation",
  ];
  if (Object.keys(object).some((key) => !identityKeys.includes(key) && !conclusionKeys.includes(key)))
    throw new Error("malformed delivery evidence");
  const identity = identityKeys.some((key) => key in object)
    ? decodeDeliverData(Object.fromEntries(identityKeys.map((key) => [key, object[key]])))
    : {};
  return {
    ...identity,
    ...decodeCompletionEvidenceFields(object),
    ...(object.leading === undefined ? {} : { leading: decodeDeliverLeading(object.leading) }),
    ...(object.continuation === undefined ? {} : { continuation: decodeContinuationReport(object.continuation) }),
  };
}

function decodePartialValue(operation: ContractVerb, value: unknown): Partial<OperationEvidenceValues[ContractVerb]> {
  if (operation === "audit") return decodePartialAuditReport(value);
  if (operation === "review") return decodeReview(value);
  if (operation === "deliver") return decodePartialDelivery(value);
  if (operation === "bind") {
    const input = plainRecord(value, "bind evidence");
    const ability = input.keiyaku;
    const identity =
      ability !== null && typeof ability === "object" && "toJSON" in ability && typeof ability.toJSON === "function"
        ? ability.toJSON()
        : ability;
    return bindEvidenceSchema.parse({ ...input, ...(ability === undefined ? {} : { keiyaku: identity }) });
  }
  if (operation === "amend") return amendEvidenceSchema.parse(value);
  if (Object.keys(plainRecord(value, "empty evidence")).length !== 0) throw new Error("malformed empty evidence");
  return {};
}

/** Complete and partial modes consume the same envelope and operation-owned payload decoders. */
function decodeEnvelope(input: unknown, mode: "partial"): PartialOutcomeEnvelope {
  const { envelope, operation } = envelopeRecord(input, mode);
  const effects = (envelope.effects as unknown[]).map(decodeInvocationEffect);
  const pending = (envelope.pending as unknown[]).map(decodePending);
  if (operation === "nuke") {
    const resetEffects = effects.map((effect) => {
      if (effect.kind !== "reset-owner-stopped" && effect.kind !== "reset-residue")
        throw new Error("malformed reset effect");
      return effect;
    });
    const value =
      envelope.value === undefined
        ? undefined
        : z
            .object({
              removed: z
                .object({
                  refs: z.number().int().nonnegative(),
                  worktrees: z.number().int().nonnegative(),
                  tasks: z.number().int().nonnegative(),
                })
                .strict(),
            })
            .strict()
            .parse(envelope.value);
    return {
      operation,
      world: nonblank(envelope.world),
      effects: resetEffects,
      pending,
      ...(value === undefined ? {} : { value }),
    };
  }
  if (effects.some((effect) => effect.kind === "reset-owner-stopped" || effect.kind === "reset-residue"))
    throw new Error("reset effect on Contract operation");
  const base = {
    operation,
    ...(envelope.contract === undefined ? {} : { contract: decodeCoordinate(envelope.contract) }),
    ...(envelope.head === undefined ? {} : { head: contractHead(nonblank(envelope.head)) }),
    facts: (envelope.facts as unknown[]).map(decodeJournalEntry),
    effects,
    pending,
  };
  const value = envelope.value === undefined ? undefined : decodePartialValue(operation, envelope.value);
  // The operation selects its exact partial payload; no independent receipt schema or unknown value exists.
  return { ...base, ...(value === undefined ? {} : { value }) } as PartialContractEnvelope;
}

/** One envelope decoder for every operation; the operation's own value schema supplies its value. */
export function outcomeSchema<Operation extends ContractVerb, Value>(
  operation: Operation,
  valueSchema: z.ZodType<Value>,
  handoffSchema?: z.ZodType<IntegrationConflictMaterialized>,
): z.ZodType<ProjectedOutcome<Operation, Value, OperationRefusals[Operation]> | HandoffOutcome> {
  return ownerSchema((input): ProjectedOutcome<Operation, Value, OperationRefusals[Operation]> | HandoffOutcome => {
    const { envelope, operation: seen } = envelopeRecord(input, "complete");
    if (seen !== operation) throw new Error("malformed outcome");
    const base = {
      operation,
      ...(envelope.contract === undefined ? {} : { contract: decodeCoordinate(envelope.contract) }),
      facts: (envelope.facts as unknown[]).map(decodeJournalEntry),
      effects: (envelope.effects as unknown[]).map(decodeInvocationEffect),
      pending: (envelope.pending as unknown[]).map(decodePending),
    };
    if (base.effects.some((effect) => effect.kind === "reset-owner-stopped" || effect.kind === "reset-residue"))
      throw new Error("malformed Contract effects");
    if (envelope.kind === "accepted") {
      if (base.contract === undefined || typeof envelope.head !== "string") throw new Error("malformed outcome");
      const parsed = valueSchema.safeParse(envelope.value);
      if (!parsed.success) throw new Error("malformed outcome");
      return {
        ...base,
        kind: "accepted",
        contract: base.contract,
        head: contractHead(envelope.head),
        value: parsed.data,
      };
    }
    if (envelope.kind === "refused")
      return { ...base, kind: "refused", refusal: decodeOperationRefusal(operation, envelope.refusal) };
    if (envelope.kind === "retry")
      return { ...base, kind: "retry", reason: decodeOperationRetry(operation, envelope.reason) };
    if (envelope.kind !== "handoff" || handoffSchema === undefined || base.contract === undefined)
      throw new Error("malformed outcome");
    const parsed = handoffSchema.safeParse(envelope.value);
    if (!parsed.success) throw new Error("malformed outcome");
    return { ...base, operation: "deliver", kind: "handoff", contract: base.contract, value: parsed.data };
  }, "expected outcome");
}

// ---------------------------------------------------------------------------
// Wire failure: category, diagnostic, and the same-envelope receipt
// ---------------------------------------------------------------------------

export type FailureWire = Readonly<{
  kind: "failed";
  category: KeiyakuErrorCategory;
  diagnostic: string;
  causeClass?: string;
  causeDiagnostic?: string;
  outcome?: PartialOutcomeEnvelope;
}>;

const NATIVE_CAUSES = {
  Error,
  TypeError,
  RangeError,
  ReferenceError,
  SyntaxError,
  URIError,
  EvalError,
  AuthorityCorruptionError,
};

function causeWire(cause: unknown): Pick<FailureWire, "causeClass" | "causeDiagnostic"> {
  return cause instanceof Error ? { causeClass: cause.name, causeDiagnostic: cause.message } : {};
}

export function encodeFailureWire(error: unknown): FailureWire {
  return error instanceof KeiyakuError
    ? {
        kind: "failed",
        category: error.category,
        diagnostic: error.message,
        ...causeWire(error.cause),
        ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
      }
    : { kind: "failed", category: errorCategory(error), diagnostic: errorDiagnostic(error), ...causeWire(error) };
}

export function decodeFailureWire(value: unknown): KeiyakuError | null {
  try {
    const record = plainRecord(value, "failure");
    const allowed = ["kind", "category", "diagnostic", "causeClass", "causeDiagnostic", "outcome"];
    if (Object.keys(record).some((key) => !allowed.includes(key)) || record.kind !== "failed") return null;
    const category = record.category;
    if (
      category !== "invalid-input" &&
      category !== "authority-corruption" &&
      category !== "unknown-outcome" &&
      category !== "aborted" &&
      category !== "internal"
    )
      return null;
    if (typeof record.diagnostic !== "string") return null;
    let cause: Error | undefined;
    if (record.causeClass !== undefined || record.causeDiagnostic !== undefined) {
      if (typeof record.causeClass !== "string" || typeof record.causeDiagnostic !== "string") return null;
      const constructor = Object.hasOwn(NATIVE_CAUSES, record.causeClass)
        ? NATIVE_CAUSES[record.causeClass as keyof typeof NATIVE_CAUSES]
        : Error;
      cause = new constructor(record.causeDiagnostic);
      cause.name = record.causeClass;
    }
    return new KeiyakuError(category, record.diagnostic, {
      ...(cause === undefined ? {} : { cause }),
      ...(record.outcome === undefined ? {} : { outcome: decodeEnvelope(record.outcome, "partial") }),
    });
  } catch {
    return null;
  }
}
