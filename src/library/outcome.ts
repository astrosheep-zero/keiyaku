/** @architectureCompositionRoot */
import { z } from "zod";
import { contractFileEffectSchema } from "../contract-worktree.js";
import { decodeJournalEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractHead, ContractId } from "../core/facts/types.js";
import { contractHeadSchema } from "../git/identity.js";
import { reconcileEffectSchema } from "../git/reconcile.js";
import { worktreeWorkspaceSchema } from "../git/workspace.js";
import { auditReportSchema, type AuditReport } from "../protocol/audit.js";
import { completionEvidenceSchema } from "../protocol/completion.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import { materializedConflictSchema } from "../protocol/deliver.js";
import { contractIdSchema, deliverDataSchema, gateSchema } from "../protocol/operations.js";
import { executionCleanupSchema, executionStageSchema, type ExecutionStage } from "../protocol/progress.js";
import { reviewAdmissionValueSchema } from "../protocol/review.js";
import { settlementActionSchema, settlementLagSchema } from "../settlement/settle.js";
import type { WorldRoot } from "../world.js";
import { continuationReportSchema, type ContinuationReport } from "./continuation.js";
import { deliveryValueSchema } from "./delivery.js";
import type { InvocationSnapshot } from "./invocation.js";
import { reconcileLagScope, reconciliationLagSchema } from "./reconcile.js";
import {
  nukeConfirmationRefusalSchema,
  nukeConfirmationRequiredRefusalSchema,
  operationRefusalSchemas,
  operationRetrySchemas,
  type OperationRefusals,
  type OperationRetries,
} from "./refusal.js";
import { regionOverlapSchema } from "./region.js";

/** The seven Contract verbs, plus the World reset that shares the same envelope shape. */
export type ContractVerb = "bind" | "amend" | "deliver" | "review" | "audit" | "arc" | "abandon";
type OutcomeOperation = ContractVerb | "nuke";

// ---------------------------------------------------------------------------
// One invocation-wide tagged Effect carrier
// ---------------------------------------------------------------------------

const reconciliationEffectSchema = z.union([reconcileEffectSchema, contractFileEffectSchema]);
export type ReconciliationEffect = z.infer<typeof reconciliationEffectSchema>;
export type ReconciliationLag = z.infer<typeof reconciliationLagSchema>;
const resetOwnerSchema = z.enum(["akuma", "git", "task", "world"]);
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

type EnvelopeFields = Omit<z.infer<typeof envelopeFieldsSchema>, "contract"> & {
  readonly contract?: ContractId;
};
type AcceptedOutcome<Operation extends ContractVerb, Value> = Omit<
  z.infer<ReturnType<typeof acceptedOutcomeSchema<Operation, Value>>>,
  "value"
> & { readonly value: Value };
type RefusedOutcome<Operation extends ContractVerb, Refusal> = z.infer<
  ReturnType<typeof refusedOutcomeSchema<Operation, Refusal>>
>;
type RetryOutcome<Operation extends ContractVerb> = z.infer<ReturnType<typeof retryOutcomeSchema<Operation>>>;
export type HandoffOutcome = z.infer<typeof handoffOutcomeSchema>;
export type OperationOutcome<Operation extends ContractVerb, Value, Refusal> =
  | AcceptedOutcome<Operation, Value>
  | RefusedOutcome<Operation, Refusal>
  | RetryOutcome<Operation>;
export type ProjectedOutcome<Operation extends ContractVerb, Value, Refusal> =
  | OperationOutcome<Operation, Value, Refusal>
  | (Operation extends "deliver" ? HandoffOutcome : never);
export type ResetCounts = z.infer<typeof resetCountsSchema>;
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
const partialOutcomeEnvelopeSchema = z.union([
  partialContractEnvelopeSchema,
  resetBaseSchema.extend({ value: resetValueSchema.optional() }).strict(),
]);

// ---------------------------------------------------------------------------
// Wire failure: category, diagnostic, and the same-envelope receipt
// ---------------------------------------------------------------------------

const errorCategorySchema = z.enum(["invalid-input", "authority-corruption", "unknown-outcome", "aborted", "internal"]);
const failureWireSchema = z
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
type FailureWire = z.infer<typeof failureWireSchema>;

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
