import { contractHeadSchema } from "../git/identity.js";
/** @architectureCompositionRoot */
import { z } from "zod";
import { decodeJournalEntry, encodeEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { type ContractHead, type ContractId, type JournalEntry } from "../core/facts/types.js";
import { reconcileEffectSchema, type Effect, type ReconcileResult, type ReconcileLag } from "../git/reconcile.js";
import { contractFileEffectSchema } from "../contract-worktree.js";
import { settlementActionSchema, settlementLagSchema } from "../settlement/settle.js";
import type { SettlementReport } from "../settlement/settle.js";
import type { PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import {
  observeExecution,
  type ExecutionObservation,
  type ExecutionObserver,
} from "../protocol/execution-observation.js";
import {
  executionStop,
  executionCleanupSchema,
  executionStageSchema,
  type ContractCheckpoint,
  type ProtocolProgress,
  type ProgressResidue,
  type VerificationResidue,
  type ExecutionStage,
  type ExecutionStop,
} from "../protocol/progress.js";
import type { AcceptedProtocolStep } from "../protocol/outcome.js";
import { completionEvidenceSchema } from "../protocol/completion.js";
import type { CandidateCompletion, CompletionEvidence } from "../protocol/completion.js";
import { materializedConflictSchema } from "../protocol/deliver.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import { auditReportSchema, type AuditReport } from "../protocol/audit.js";
import { reviewAdmissionValueSchema } from "../protocol/review.js";
import { continuationReportSchema, type ContinuationReport } from "./continuation.js";
import { reconciliationLagSchema, reconcileLagScope } from "./reconcile.js";
import {
  operationRefusalSchemas,
  operationRetrySchemas,
  nukeConfirmationRefusalSchema,
  nukeConfirmationRequiredRefusalSchema,
  type OperationRefusals,
  type OperationRetries,
} from "./refusal.js";
import { contractIdSchema, gateSchema, deliverDataSchema } from "../protocol/operations.js";
import { worktreeWorkspaceSchema } from "../git/workspace.js";
import { deliveryValueSchema } from "./delivery.js";
import { regionOverlapSchema } from "./region.js";
import type { WorldRoot } from "../world.js";
export type { ExecutionCleanup, ExecutionStop } from "../protocol/progress.js";
export { executionStop, auditReportSchema };

/** The seven Contract verbs, plus the World reset that shares the same envelope shape. */
export type ContractVerb = "bind" | "amend" | "deliver" | "review" | "audit" | "arc" | "abandon";
export type OutcomeOperation = ContractVerb | "nuke";

// ---------------------------------------------------------------------------
// One invocation-wide tagged Effect carrier
// ---------------------------------------------------------------------------

export const reconciliationEffectSchema = z.union([reconcileEffectSchema, contractFileEffectSchema]);
export type ReconciliationEffect = z.infer<typeof reconciliationEffectSchema>;
export type ReconciliationLag = z.infer<typeof reconciliationLagSchema>;
const resetOwnerSchema = z.enum(["akuma", "git", "task", "world"]);
export type ResetOwner = z.infer<typeof resetOwnerSchema>;
const resetEffectFields = { world: z.string().min(1), owner: resetOwnerSchema, diagnostic: z.string().min(1) };
export const resetEffectSchema = z.union([
  z.object({ kind: z.literal("reset-owner-stopped"), ...resetEffectFields }).strict(),
  z.object({ kind: z.literal("reset-residue"), ...resetEffectFields }).strict(),
]);
export type ResetEffect = z.infer<typeof resetEffectSchema>;
export const contractEffectSchema = z.union([
  z
    .object({
      kind: z.literal("reconciliation-effect"),
      contract: contractIdSchema,
      effect: reconciliationEffectSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconciliation-lag"),
      contract: contractIdSchema,
      affects: z.enum(["none", "reconciliation", "placement", "continuation"]),
      lag: reconciliationLagSchema,
    })
    .strict()
    .refine((value) => value.affects === reconcileLagScope(value.lag), "invalid reconciliation requiredness"),
  z
    .object({
      kind: z.literal("checkout-retained"),
      contract: contractIdSchema,
      path: z.string().min(1),
      target: z.string().min(1),
      diagnostic: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("settlement-action"), contract: contractIdSchema, action: settlementActionSchema })
    .strict(),
  z.object({ kind: z.literal("settlement-lag"), contract: contractIdSchema, lag: settlementLagSchema }).strict(),
  z
    .object({ kind: z.literal("cleanup"), contract: contractIdSchema, issue: executionCleanupSchema })
    .strict()
    .refine((value) => value.contract === value.issue.contractId, "invalid cleanup owner"),
  z
    .object({
      kind: z.literal("execution-stopped"),
      contract: contractIdSchema,
      stage: executionStageSchema,
      reason: z.enum(["cancelled", "failed"]),
      diagnostic: z.string().refine((value) => value.trim() !== ""),
    })
    .strict(),
  z.object({ kind: z.literal("worktree-retired"), contract: contractIdSchema, name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("worktree-retained"), contract: contractIdSchema, path: z.string().min(1) }).strict(),
]);
export const invocationEffectSchema = z.union([contractEffectSchema, resetEffectSchema]);
export type InvocationEffect = z.infer<typeof invocationEffectSchema>;
const pendingActionSchema = z.enum([
  "reset",
  "verification",
  "placement",
  "continuation",
  "reconciliation",
  "settlement",
  "cleanup",
  "execution",
]);
export type PendingAction = z.infer<typeof pendingActionSchema>;
const pendingSurfaceSchema = z.object({ surface: pendingActionSchema, required: z.boolean() }).strict();
export type PendingSurface = z.infer<typeof pendingSurfaceSchema>;

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

export type EnvelopeFields = Omit<z.infer<typeof envelopeFieldsSchema>, "contract"> & {
  readonly contract?: ContractId;
};
export type AcceptedOutcome<Operation extends ContractVerb, Value> = Omit<
  z.infer<ReturnType<typeof acceptedOutcomeSchema<Operation, Value>>>,
  "value"
> & { readonly value: Value };
export type RefusedOutcome<Operation extends ContractVerb, Refusal> = z.infer<
  ReturnType<typeof refusedOutcomeSchema<Operation, Refusal>>
>;
export type RetryOutcome<Operation extends ContractVerb> = z.infer<ReturnType<typeof retryOutcomeSchema<Operation>>>;
export type HandoffOutcome = z.infer<typeof handoffOutcomeSchema>;
export type OperationOutcome<Operation extends ContractVerb, Value, Refusal> =
  | AcceptedOutcome<Operation, Value>
  | RefusedOutcome<Operation, Refusal>
  | RetryOutcome<Operation>;
export type ProjectedOutcome<Operation extends ContractVerb, Value, Refusal> =
  | OperationOutcome<Operation, Value, Refusal>
  | (Operation extends "deliver" ? HandoffOutcome : never);
export type ResetCounts = z.infer<typeof resetCountsSchema>;
export type ResetValue = z.infer<typeof resetValueSchema>;
export type ResetRefusal =
  | z.infer<typeof nukeConfirmationRefusalSchema>
  | z.infer<typeof nukeConfirmationRequiredRefusalSchema>;
type WithWorld<Value> = Value extends { world: string } ? Omit<Value, "world"> & { readonly world: WorldRoot } : never;
export type ResetOutcome = WithWorld<z.infer<typeof resetOutcomeSchema>>;

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

type PartialContractEnvelope = z.infer<typeof partialContractEnvelopeSchema>;
export type PartialOutcomeEnvelope = z.infer<typeof partialOutcomeEnvelopeSchema>;

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
      effects: snapshot.effects.filter(
        (effect): effect is z.infer<typeof contractEffectSchema> =>
          effect.kind !== "reset-owner-stopped" && effect.kind !== "reset-residue",
      ),
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

// Public value composition: owned nested declarations, no local re-decoding.
export const reviewSchema = completionEvidenceSchema
  .extend({
    ...reviewAdmissionValueSchema.shape,
    continuation: continuationReportSchema.optional(),
  })
  .strict();
export type Review = z.infer<typeof reviewSchema>;
const bindEvidenceSchema = z
  .object({
    keiyaku: z.object({ contract: contractIdSchema }).strict().optional(),
    workspace: worktreeWorkspaceSchema.optional(),
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
        gates: z.array(gateSchema).readonly().optional(),
        after: z.array(contractIdSchema).readonly().optional(),
      })
      .strict()
      .optional(),
    overlaps: z.array(regionOverlapSchema).readonly().optional(),
    overlapFailure: z.string().optional(),
  })
  .strict()
  .refine((value) => value.overlaps === undefined || value.overlapFailure === undefined);
const partialDeliverySchema = deliveryValueSchema.partial().superRefine((value, context) => {
  const fields = deliverDataSchema.keyof().options;
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length !== 0 && present.length !== fields.length)
    context.addIssue({ code: "custom", message: "delivery identity must be complete when present" });
});
const partialValueSchemas = {
  bind: bindEvidenceSchema,
  amend: amendEvidenceSchema,
  deliver: partialDeliverySchema,
  review: reviewSchema,
  audit: auditReportSchema.partial(),
  arc: z.object({}).strict(),
  abandon: z.object({}).strict(),
} as const;
const journalEntrySchema = z.unknown().transform((value, context) => {
  try {
    return decodeJournalEntry(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid journal fact" });
    return z.NEVER;
  }
});
const envelopeFieldsSchema = z
  .object({
    operation: z.enum(["bind", "amend", "deliver", "review", "audit", "arc", "abandon"]),
    contract: contractIdSchema.optional(),
    facts: z.array(journalEntrySchema).readonly(),
    effects: z.array(contractEffectSchema).readonly(),
    pending: z.array(pendingSurfaceSchema).readonly(),
  })
  .strict();
function definedContract<Value extends { contract?: ContractId | undefined }>(
  value: Value,
): Omit<Value, "contract"> & { readonly contract?: ContractId } {
  const { contract, ...fields } = value;
  return { ...fields, ...(contract === undefined ? {} : { contract }) };
}
function acceptedOutcomeSchema<Operation extends ContractVerb, Value>(operation: Operation, value: z.ZodType<Value>) {
  return envelopeFieldsSchema
    .extend({
      operation: z.literal(operation),
      kind: z.literal("accepted"),
      contract: contractIdSchema,
      head: contractHeadSchema,
      value,
    })
    .strict();
}
function refusedOutcomeSchema<Operation extends ContractVerb, Refusal>(
  operation: Operation,
  refusal: z.ZodType<Refusal>,
) {
  return envelopeFieldsSchema
    .extend({ operation: z.literal(operation), kind: z.literal("refused"), refusal })
    .strict()
    .transform(definedContract);
}
function retryOutcomeSchema<Operation extends ContractVerb>(operation: Operation) {
  return envelopeFieldsSchema
    .extend({
      operation: z.literal(operation),
      kind: z.literal("retry"),
      reason: operationRetrySchemas[operation] as z.ZodType<OperationRetries[Operation]>,
    })
    .strict()
    .transform(definedContract);
}
const handoffOutcomeSchema = envelopeFieldsSchema
  .extend({
    operation: z.literal("deliver"),
    kind: z.literal("handoff"),
    contract: contractIdSchema,
    value: materializedConflictSchema,
  })
  .strict();
/** Complete and exceptional modes use the same envelope and nested owner declarations. */
export function outcomeSchema<Operation extends ContractVerb, Value>(
  operation: Operation,
  value: z.ZodType<Value>,
  handoff?: Operation extends "deliver" ? z.ZodType<IntegrationConflictMaterialized> : never,
) {
  const accepted = acceptedOutcomeSchema(operation, value);
  const refused = refusedOutcomeSchema(
    operation,
    operationRefusalSchemas[operation] as unknown as z.ZodType<OperationRefusals[Operation]>,
  );
  const retry = retryOutcomeSchema(operation);
  const ordinary = z.union([accepted, refused, retry]);
  return (
    handoff === undefined ? ordinary : z.union([ordinary, handoffOutcomeSchema.extend({ value: handoff }).strict()])
  ) as z.ZodType<ProjectedOutcome<Operation, Value, OperationRefusals[Operation]>>;
}
function partialContractSchema<Operation extends ContractVerb, Value>(operation: Operation, value: z.ZodType<Value>) {
  return envelopeFieldsSchema
    .extend({ operation: z.literal(operation), head: contractHeadSchema.optional(), value: value.optional() })
    .strict();
}
const resetCountsSchema = z
  .object({
    refs: z.number().int().nonnegative(),
    worktrees: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
  })
  .strict();
const resetValueSchema = z.object({ removed: resetCountsSchema }).strict();
const resetBaseSchema = z
  .object({
    operation: z.literal("nuke"),
    world: z.string().min(1),
    effects: z.array(resetEffectSchema).readonly(),
    pending: z.array(pendingSurfaceSchema).readonly(),
  })
  .strict();
const resetOutcomeSchema = z.union([
  resetBaseSchema.extend({ kind: z.literal("accepted"), value: resetValueSchema }).strict(),
  resetBaseSchema
    .extend({
      kind: z.literal("refused"),
      refusal: z.union([nukeConfirmationRefusalSchema, nukeConfirmationRequiredRefusalSchema]),
    })
    .strict(),
]);
const partialContractEnvelopeSchema = z.union([
  partialContractSchema("bind", partialValueSchemas.bind),
  partialContractSchema("amend", partialValueSchemas.amend),
  partialContractSchema("deliver", partialValueSchemas.deliver),
  partialContractSchema("review", partialValueSchemas.review),
  partialContractSchema("audit", partialValueSchemas.audit),
  partialContractSchema("arc", partialValueSchemas.arc),
  partialContractSchema("abandon", partialValueSchemas.abandon),
]);
export const partialOutcomeEnvelopeSchema = z.union([
  partialContractEnvelopeSchema,
  resetBaseSchema.extend({ value: resetValueSchema.optional() }).strict(),
]);

// ---------------------------------------------------------------------------
// Wire failure: category, diagnostic, and the same-envelope receipt
// ---------------------------------------------------------------------------

const errorCategorySchema = z.enum(["invalid-input", "authority-corruption", "unknown-outcome", "aborted", "internal"]);
export const failureWireSchema = z
  .object({
    kind: z.literal("failed"),
    category: errorCategorySchema,
    diagnostic: z.string(),
    causeClass: z.string().optional(),
    causeDiagnostic: z.string().optional(),
    outcome: partialOutcomeEnvelopeSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.causeClass === undefined) === (value.causeDiagnostic === undefined),
    "native cause requires class and diagnostic",
  );
export type FailureWire = z.infer<typeof failureWireSchema>;

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
  const parsed = failureWireSchema.safeParse(value);
  if (!parsed.success) return null;
  const wire = parsed.data;
  let cause: Error | undefined;
  if (wire.causeClass !== undefined && wire.causeDiagnostic !== undefined) {
    const constructor = Object.hasOwn(NATIVE_CAUSES, wire.causeClass)
      ? NATIVE_CAUSES[wire.causeClass as keyof typeof NATIVE_CAUSES]
      : Error;
    cause = new constructor(wire.causeDiagnostic);
    cause.name = wire.causeClass;
  }
  return new KeiyakuError(wire.category, wire.diagnostic, {
    ...(cause === undefined ? {} : { cause }),
    ...(wire.outcome === undefined ? {} : { outcome: wire.outcome }),
  });
}
