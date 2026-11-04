/** @architectureCompositionRoot */
import { z } from "zod";
import { contractFileEffectSchema } from "../contract-worktree.js";
import type { ContractHead, ContractId, JournalEntry } from "../core/facts/types.js";
import { reconcileEffectSchema } from "../git/reconcile.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { CompletionEvidence } from "../protocol/completion.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import { contractIdSchema } from "../protocol/operations.js";
import { executionCleanupSchema, executionStageSchema, type ExecutionStage } from "../protocol/progress.js";
import type { ReviewAdmissionValue } from "../protocol/review.js";
import { settlementActionSchema, settlementLagSchema } from "../settlement/settle.js";
import type { WorldRoot } from "../world.js";
import type { ContinuationReport } from "./continuation.js";
import type { AmendValue, BindValue } from "./contract-outcomes.js";
import type { DeliveryValue } from "./delivery.js";
import type { DeliveryPreviewReport } from "../protocol/delivery-preview.js";
import type { InvocationSnapshot } from "./invocation.js";
import { reconcileLagScope, reconciliationLagSchema } from "./reconcile.js";
import {
  nukeConfirmationRefusalSchema,
  nukeConfirmationRequiredRefusalSchema,
  type OperationRetries,
} from "./refusal.js";

/** Contract operation tags, including preview, sharing the invocation envelope with World reset. */
export type ContractVerb = "bind" | "amend" | "deliver" | "verify" | "review" | "deliver-preview" | "arc" | "abandon";
type OutcomeOperation = ContractVerb | "nuke";

// ---------------------------------------------------------------------------
// One invocation-wide tagged Effect carrier
// ---------------------------------------------------------------------------

const reconciliationEffectSchema = z.union([reconcileEffectSchema, contractFileEffectSchema]);
export type ReconciliationEffect = z.infer<typeof reconciliationEffectSchema>;
export type ReconciliationLag = z.infer<typeof reconciliationLagSchema>;
const resetOwnerSchema = z.enum(["akuma", "git", "debt", "world"]);
export type ResetOwner = z.infer<typeof resetOwnerSchema>;
const resetEffectFields = { world: z.string().min(1), owner: resetOwnerSchema, diagnostic: z.string().min(1) };
const resetEffectSchema = z.union([
  z.object({ kind: z.literal("reset-owner-stopped"), ...resetEffectFields }).strict(),
  z.object({ kind: z.literal("reset-residue"), ...resetEffectFields }).strict(),
]);
type ResetEffect = z.infer<typeof resetEffectSchema>;
const contractEffectSchema = z.union([
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
const invocationEffectSchema = z.union([contractEffectSchema, resetEffectSchema]);
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
type PendingAction = z.infer<typeof pendingActionSchema>;
const pendingSurfaceSchema = z.object({ surface: pendingActionSchema, required: z.boolean() }).strict();
export type PendingSurface = z.infer<typeof pendingSurfaceSchema>;

// ---------------------------------------------------------------------------
// The public envelope
// ---------------------------------------------------------------------------

type EnvelopeFields = Readonly<{
  operation: ContractVerb;
  contract?: ContractId;
  facts: readonly JournalEntry[];
  effects: readonly z.infer<typeof contractEffectSchema>[];
  pending: readonly PendingSurface[];
}>;
type AcceptedOutcome<Operation extends ContractVerb, Value> = EnvelopeFields &
  Readonly<{
    operation: Operation;
    kind: "accepted";
    contract: ContractId;
    head: ContractHead;
    value: Value;
  }>;
type RefusedOutcome<Operation extends ContractVerb, Refusal> = EnvelopeFields &
  Readonly<{
    operation: Operation;
    kind: "refused";
    refusal: Refusal;
  }>;
type RetryOutcome<Operation extends ContractVerb> = EnvelopeFields &
  Readonly<{
    operation: Operation;
    kind: "retry";
    reason: OperationRetries[Operation];
  }>;
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
export type ProjectedOutcome<Operation extends ContractVerb, Value, Refusal> =
  | OperationOutcome<Operation, Value, Refusal>
  | (Operation extends "deliver" ? HandoffOutcome : never);
export type ResetCounts = Readonly<{ refs: number; worktrees: number; debts: number }>;
export type ResetRefusal =
  | z.infer<typeof nukeConfirmationRefusalSchema>
  | z.infer<typeof nukeConfirmationRequiredRefusalSchema>;
type ResetEnvelope = Readonly<{
  operation: "nuke";
  world: WorldRoot;
  effects: readonly ResetEffect[];
  pending: readonly PendingSurface[];
}>;
export type ResetOutcome = ResetEnvelope &
  (
    | Readonly<{ kind: "accepted"; value: { removed: ResetCounts } }>
    | Readonly<{ kind: "refused"; refusal: ResetRefusal }>
  );

type ResetProjection = Readonly<{ world: WorldRoot }> &
  (
    | Readonly<{ kind: "accepted" }>
    | Readonly<{ kind: "refused"; refusal: ResetRefusal }>
    | Readonly<{ kind: "failed"; error: unknown }>
  );

type PartialValues = {
  bind: Partial<BindValue>;
  amend: Partial<AmendValue>;
  deliver: Partial<DeliveryValue>;
  verify: Partial<Verify>;
  review: Review;
  "deliver-preview": Partial<DeliveryPreviewReport>;
  arc: Record<string, never>;
  abandon: Record<string, never>;
};
type PartialContractEnvelope = {
  [Operation in ContractVerb]: EnvelopeFields &
    Readonly<{
      operation: Operation;
      head?: ContractHead;
      value?: PartialValues[Operation];
    }>;
}[ContractVerb];
export type PartialOutcomeEnvelope =
  | PartialContractEnvelope
  | (ResetEnvelope & Readonly<{ value?: { removed: ResetCounts } }>);

function surface(surface: PendingAction, required: boolean): PendingSurface {
  return { surface, required };
}

function phasePending(operation: OutcomeOperation, value: unknown): readonly PendingSurface[] {
  if (operation !== "review" && operation !== "deliver" && operation !== "verify") return [];
  const concluded = value as
    | {
        checks?: readonly import("../protocol/verify.js").VerificationCheck[];
        placement?: unknown;
        continuation?: ContinuationReport;
      }
    | undefined;
  if (concluded === undefined) return [];
  const pending: PendingSurface[] = [];
  if (
    concluded.checks?.some(
      (check) => check.kind === "stopped" || check.admission.kind === "stopped" || check.verdict === "unsatisfied",
    )
  )
    pending.push(surface("verification", true));
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
 * effects.
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
    const value = { removed: snapshot.reset?.removed ?? { refs: 0, worktrees: 0, debts: 0 } };
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

export type KeiyakuErrorCategory = "invalid-input" | "authority-corruption" | "aborted" | "internal";

type KeiyakuErrorOptions = Readonly<{ cause?: unknown; outcome?: PartialOutcomeEnvelope }>;

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

export async function readContractValue<Value>(operation: () => Promise<Value>): Promise<Value> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof KeiyakuError) throw error;
    throw new KeiyakuError(errorCategory(error), errorDiagnostic(error), { cause: error });
  }
}

function errorDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Attach this invocation's partial envelope without changing the error's own identity or category. */
export function withOutcomeReceipt(error: unknown, outcome: PartialOutcomeEnvelope): KeiyakuError {
  if (error instanceof KeiyakuError) {
    return new KeiyakuError(error.category, error.message, { cause: error.cause, outcome });
  }
  return new KeiyakuError(errorCategory(error), errorDiagnostic(error), { cause: error, outcome });
}

export type Verify = import("../protocol/verify.js").VerifyValue &
  Readonly<{ continuation?: ContinuationReport | undefined }>;

export type Review = CompletionEvidence &
  ReviewAdmissionValue &
  Readonly<{ continuation?: ContinuationReport | undefined }>;

/** Native diagnostic projection for JSON callers; process custody stays on the original error. */
export type FailureProjection = Readonly<{
  kind: "failed";
  category: KeiyakuErrorCategory;
  diagnostic: string;
  causeClass?: string;
  causeDiagnostic?: string;
  outcome?: PartialOutcomeEnvelope;
}>;

export function projectFailure(error: unknown): FailureProjection {
  const cause = error instanceof KeiyakuError ? error.cause : error;
  return {
    kind: "failed",
    category: error instanceof KeiyakuError ? error.category : errorCategory(error),
    diagnostic: errorDiagnostic(error),
    ...(cause instanceof Error ? { causeClass: cause.name, causeDiagnostic: cause.message } : {}),
    ...(error instanceof KeiyakuError && error.outcome !== undefined ? { outcome: error.outcome } : {}),
  };
}
