/** @architectureCompositionRoot */
import { z } from "zod";
import { contractFileLagSchema } from "../contract-worktree.js";
import type { ChangeId, ContractId, SnapshotId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { reconcileEffectSchema, gitReconcileLagSchema } from "../git/reconcile.js";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { placementSchema, placedSchema } from "../protocol/completion.js";

import { worldRootSchema, type WorldRoot } from "../world.js";
import type { ContinuationReport } from "./continuation.js";
import type { ReviewOutcome, VerifyOutcome } from "./contract-outcomes.js";
import type { SpawnResult } from "./akuma-creation.js";
import { tellFailure } from "../akuma/akuma-errors.js";
import type { AkumaTellResult } from "../akuma/selection-observation.js";
import type { InvocationSnapshot } from "./invocation.js";
import { retrySchema, executionIssueSchema } from "../protocol/result-reasons.js";
export { executionIssueSchema } from "../protocol/result-reasons.js";

export type ContractVerb = "bind" | "amend" | "deliver" | "verify" | "review" | "deliver-preview" | "arc" | "abandon";
type OutcomeOperation = ContractVerb | "nuke";

// Raw physical reports stay in the invocation's private custody. Only actionable leaves cross
// the result boundary; the same owner classification is used by reconcile and mutation results.
export type ReconciliationEffect = z.output<typeof reconcileEffectSchema>;
export const reconciliationLagSchema = z.union([gitReconcileLagSchema, contractFileLagSchema]);
export type ReconciliationLag = z.output<typeof reconciliationLagSchema>;
export type ReconcileLagScope = "none" | "reconciliation" | "placement" | "continuation";
function classifyReconcileLag(
  kind: ReconciliationLag["kind"],
): Readonly<{ scope: ReconcileLagScope; failure: boolean }> {
  switch (kind) {
    case "worktree-retained":
    case "unsealed-bytes":
      return { scope: "none", failure: false };
    case "worktree-follow-retained":
      return { scope: "continuation", failure: false };
    case "target-checkout-retained":
    case "target-workspace-retained":
      return { scope: "placement", failure: true };
    case "worktree-hook-failed":
    case "reconcile-failed":
    case "contract-file-failed":
      return { scope: "reconciliation", failure: true };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
export function reconcileLagScope(lag: ReconciliationLag): ReconcileLagScope {
  return classifyReconcileLag(lag.kind).scope;
}
export function reconcileLagIsFailure(lag: ReconciliationLag): boolean {
  return classifyReconcileLag(lag.kind).failure;
}

const scoped = { contractId: contractIdSchema.exactOptional() };
const diagnostic = z.string().min(1);
const path = z.string().min(1);
const severity = z.enum(["required", "optional"]);
export const reconcileIssueSchema = z.union([
  ...gitReconcileLagSchema.options.map((schema) =>
    schema
      .unwrap()
      .extend({ ...scoped, severity })
      .readonly(),
  ),
  contractFileLagSchema
    .unwrap()
    .extend({ ...scoped, severity })
    .readonly(),
]);
const resourceDiagnosticSchema = z
  .strictObject({
    ...scoped,
    kind: z.literal("diagnostic"),
    severity,
    diagnostic,
    snapshot: snapshotIdSchema.exactOptional(),
    requirement: z.string().min(1).exactOptional(),
    index: z.number().int().positive().exactOptional(),
    name: diagnostic.exactOptional(),
    path: path.exactOptional(),
  })
  .readonly();

const settlementIssueSchema = z
  .strictObject({
    ...scoped,
    kind: z.literal("settlement-failed"),
    severity: z.literal("required"),
    debtId: z.string().min(1).exactOptional(),
    diagnostic,
  })
  .readonly();
const executionIssue = executionIssueSchema
  .unwrap()
  .extend({ ...scoped, severity: z.literal("required") })
  .readonly();
const localReconcileLeaves = reconcileIssueSchema.options.filter(
  (schema): schema is Exclude<typeof schema, z.ZodType<{ kind: "worktree-follow-retained" }>> =>
    schema.unwrap().shape.kind.value !== "worktree-follow-retained",
);
export const invocationIssueSchema = z
  .union([...reconcileIssueSchema.options, resourceDiagnosticSchema, executionIssue, settlementIssueSchema])
  .meta({ id: "contractIssue" });
export type InvocationIssue = z.output<typeof invocationIssueSchema>;
export const localIssueSchema = z.union([
  ...localReconcileLeaves,
  resourceDiagnosticSchema,
  executionIssue,
  settlementIssueSchema,
]);
export const previewIssueSchema = resourceDiagnosticSchema.unwrap().omit({ contractId: true }).readonly();
export const reconcilePublicIssueSchema = z
  .union([...localReconcileLeaves, resourceDiagnosticSchema, settlementIssueSchema])
  .meta({ id: "reconcileIssue" });

export function invocationIssueIsFailure(issue: InvocationIssue): boolean {
  return issue.severity === "required";
}

/** Invocation classification consumes owner conclusions, never a fresh authority read. */
export function contractOutcomeDisposition(
  result: Readonly<{
    kind: string;
    issues?: readonly InvocationIssue[];
    placement?:
      | import("../protocol/completion.js").Placement
      | Omit<import("../protocol/completion.js").Placed, "integration">;
    checks?: readonly import("../protocol/verify.js").VerificationCheck[];
    continuation?: ContinuationReport;
  }>,
): "accepted" | "unsatisfied" | "refused" | "retryable" | "failed" {
  if (result.kind === "refused") return "refused";
  if (result.kind === "retry") return "retryable";
  let retry = false;
  let unsatisfied = false;
  const stopped = (stop: Readonly<{ kind: string }>): boolean => {
    if (stop.kind === "retry") {
      retry = true;
      return false;
    }
    return !["placed", "gates-unsatisfied", "prerequisites-unsatisfied", "delivery-missing", "physical-lag"].includes(
      stop.kind,
    );
  };
  if (result.issues?.some(invocationIssueIsFailure)) return "failed";
  if (result.placement !== undefined && stopped(result.placement)) return "failed";
  for (const check of result.checks ?? []) {
    if (check.kind !== "terminal") return "failed";
    if (typeof check.admission === "object" && stopped(check.admission)) return "failed";
    if (check.verdict === "unsatisfied") unsatisfied = true;
  }
  for (const { stop } of result.continuation?.stopped ?? []) if (stopped(stop)) return "failed";
  return retry ? "retryable" : unsatisfied ? "unsatisfied" : "accepted";
}

const resetOwnerSchema = z.enum(["akuma", "git", "debt", "world"]);
export type ResetOwner = z.output<typeof resetOwnerSchema>;
export const resetIssueSchema = z.union([
  z
    .strictObject({ kind: z.literal("reset-owner-stopped"), owner: resetOwnerSchema, diagnostic: z.string().min(1) })
    .readonly(),
  z.strictObject({ kind: z.literal("reset-residue"), diagnostic: z.string().min(1) }).readonly(),
]);
export type ResetIssue = z.output<typeof resetIssueSchema>;
export function resetIssueIsRequired(issue: ResetIssue): boolean {
  switch (issue.kind) {
    case "reset-owner-stopped":
      return true;
    case "reset-residue":
      return false;
    default: {
      return issue;
    }
  }
}
type ResetEffect = (Readonly<{ kind: "reset-owner-stopped" }> | Readonly<{ kind: "reset-residue" }>) &
  Readonly<{ owner: ResetOwner; diagnostic: string; world: string }>;
/** Internal accumulator carrier, not a published operation answer. */
export type InvocationEffect =
  | Readonly<{ kind: "issue"; contract: ContractId; issue: InvocationIssue }>
  | ResetEffect
  | Readonly<{ kind: "movement"; contract: ContractId; effect: MovementEffect }>;

const admittedFields = scoped;
export const admittedEvidenceSchema = z.union([
  z.strictObject({ kind: z.enum(["bind", "amend", "claimed", "abandoned"]), ...admittedFields }).readonly(),
  z
    .strictObject({
      kind: z.literal("deliver"),
      ...admittedFields,
      candidate: snapshotIdSchema,
      integration: snapshotIdSchema,
      contentId: z.string().min(1),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("reintegrated"),
      ...admittedFields,
      integration: snapshotIdSchema,
      predecessor: snapshotIdSchema,
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("attestation"),
      ...admittedFields,
      requirement: z.string().exactOptional(),
      verdict: z.enum(["satisfied", "unsatisfied"]).exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("arc"),
      ...admittedFields,
      chapter: z.number().int().positive(),
    })
    .readonly(),
]);
export const meaningfulEffectSchema = z.union([
  z.strictObject({ kind: z.enum(["worktree-created", "worktree-removed"]), path }).readonly(),
  z
    .strictObject({ kind: z.literal("worktree-followed"), path, before: snapshotIdSchema, after: snapshotIdSchema })
    .readonly(),
  z.strictObject({ kind: z.literal("recovery-snapshot"), snapshot: snapshotIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("target-checkout"), path, target: z.string().min(1) }).readonly(),
  z
    .strictObject({
      kind: z.literal("ref"),
      name: z.string().min(1),
      before: z.string().nullable(),
      after: z.string().nullable(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("debt-settled"), debtId: z.string().min(1) }).readonly(),
]);
export type MovementEffect = z.output<typeof meaningfulEffectSchema>;
export function compactEffect(effect: ReconciliationEffect): MovementEffect | undefined {
  switch (effect.kind) {
    case "worktree":
      if (effect.action === "unchanged") return undefined;
      if (effect.action === "followed")
        return { kind: "worktree-followed", path: effect.path, before: effect.before, after: effect.after };
      return { kind: effect.action === "created" ? "worktree-created" : "worktree-removed", path: effect.path };
    case "ref":
      return effect.before === effect.after
        ? undefined
        : { kind: "ref", name: effect.name, before: effect.before, after: effect.after };
    case "target-checkout":
      return { kind: effect.kind, path: effect.path, target: effect.target };
    case "recovery-snapshot":
      return { kind: effect.kind, snapshot: effect.snapshot };
  }
}
export const recoverySnapshotSchema = z.strictObject({ ...scoped, snapshot: snapshotIdSchema }).readonly();
const exceptionalEffectSchema = z.union([
  ...meaningfulEffectSchema.options.map((schema) => schema.unwrap().extend(scoped).readonly()),
  placedSchema.unwrap().extend(scoped).readonly(),
]);
type PartialEvidence = Readonly<{
  admitted?: readonly z.output<typeof admittedEvidenceSchema>[];
  placement?: z.output<typeof placementSchema>;
  effects?: readonly z.output<typeof exceptionalEffectSchema>[];
}>;
type ReceiptFields = Readonly<{ contractId?: ContractId; issues?: readonly InvocationIssue[] }>;

export function operationOutcomeSchema<
  Fields extends z.ZodRawShape,
  Refusal extends z.ZodType,
  Issues extends z.ZodType,
>(fields: Fields, refusal: Refusal, issues: Issues) {
  return z.union([
    z
      .strictObject({
        kind: z.literal("accepted"),
        contractId: contractIdSchema,
        issues: z.array(issues).min(1).readonly().exactOptional(),
        recoverySnapshots: z.array(recoverySnapshotSchema).min(1).readonly().exactOptional(),
        ...fields,
      })
      .readonly(),
    z.strictObject({ kind: z.literal("refused"), contractId: contractIdSchema, reason: refusal }).readonly(),
    retrySchema.options[0].unwrap().extend({ contractId: contractIdSchema }).readonly(),
    retrySchema.options[1].unwrap().extend({ contractId: contractIdSchema }).readonly(),
  ]);
}

export const handoffOutcomeSchema = z
  .strictObject({
    kind: z.literal("handoff"),
    contractId: contractIdSchema,
    worktreePath: z.string().min(1),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(z.string().min(1)).min(1).readonly(),
    handoffBase: snapshotIdSchema,
  })
  .readonly();
export type HandoffOutcome = z.output<typeof handoffOutcomeSchema>;

export type ResetCounts = Readonly<{ refs: number; worktrees: number; debts: number }>;
export type ResetRefusal =
  | import("./refusal.js").NukeConfirmationRefusal
  | import("./refusal.js").NukeConfirmationRequiredRefusal;
export const resetOutcomeSchema = z.union([
  z
    .strictObject({
      kind: z.literal("accepted"),
      refsRemoved: z.number().int().nonnegative().exactOptional(),
      worktreesRemoved: z.number().int().nonnegative().exactOptional(),
      debtsRemoved: z.number().int().nonnegative().exactOptional(),
      issues: z.array(resetIssueSchema).min(1).readonly().exactOptional(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("refused"), world: worldRootSchema }).readonly(),
]);
export type ResetOutcome = z.output<typeof resetOutcomeSchema>;
type ResetProjection = Readonly<{ world: WorldRoot }> &
  (
    | Readonly<{ kind: "accepted" }>
    | Readonly<{ kind: "refused"; refusal: ResetRefusal }>
    | Readonly<{ kind: "failed"; error: unknown }>
  );

export type Verify = Omit<
  Extract<VerifyOutcome, { kind: "accepted" }>,
  "kind" | "contractId" | "issues" | "recoverySnapshots"
>;
export type Review = Omit<
  Extract<ReviewOutcome, { kind: "accepted" }>,
  "kind" | "contractId" | "issues" | "recoverySnapshots"
>;
type PartialContractEnvelope = ReceiptFields &
  PartialEvidence &
  Readonly<{
    kind: "contract";
    worktreePath?: string;
    target?: string;
    changedSections?: readonly string[];
    gatesChanged?: true;
    afterChanged?: true;
    candidate?: SnapshotId;
    integration?: SnapshotId;
    contentId?: ChangeId;
    admission?: "reused";
    previousContentId?: ChangeId;
    snapshot?: SnapshotId;
    checks?: readonly import("../protocol/verify.js").VerificationCheck[];
    worktreeChanges?: NonNullable<Review["worktreeChanges"]>;
    continuation?: ContinuationReport;
    chapter?: number;
    preview?: Partial<import("../protocol/delivery-preview.js").DeliveryPreviewReport>;
  }>;
export type PartialOutcomeEnvelope =
  | PartialContractEnvelope
  | Readonly<{
      kind: "world";
      world?: WorldRoot;
      removed?: Partial<ResetCounts>;
      issues?: readonly ResetIssue[];
      contracts?: readonly import("./reconcile.js").RepoContractReconcileReport[];
    }>;

export type ContractConclusion = Omit<
  PartialContractEnvelope,
  "kind" | "contractId" | "issues" | "admitted" | "effects"
>;
export type InvocationFailure = Readonly<{ kind: "failed"; contract?: ContractId; error: unknown }>;

export function invocationIssues(
  effects: readonly InvocationEffect[],
  primary?: ContractId,
  snapshot?: string,
): readonly InvocationIssue[] {
  const issues: InvocationIssue[] = [];
  for (const effect of effects) {
    if (effect.kind !== "issue") continue;
    const owner = effect.contract === primary ? {} : { contractId: effect.contract };
    const issue = effect.issue;
    if (
      issue.kind === "diagnostic" &&
      effect.contract === primary &&
      issue.snapshot !== undefined &&
      issue.snapshot === snapshot
    ) {
      const { snapshot: _snapshot, ...rest } = issue;
      issues.push({ ...rest, ...owner });
    } else issues.push({ ...issue, ...owner });
  }
  return uniqueIssues(issues);
}

function uniqueIssues(issues: readonly InvocationIssue[]): readonly InvocationIssue[] {
  const diagnosedRetentions = new Set(
    issues.flatMap((issue) =>
      issue.kind === "worktree-retained" && issue.diagnostic !== undefined
        ? [JSON.stringify([issue.contractId, issue.path])]
        : [],
    ),
  );
  return [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()].filter(
    (issue) =>
      issue.kind !== "worktree-retained" ||
      issue.diagnostic !== undefined ||
      !diagnosedRetentions.has(JSON.stringify([issue.contractId, issue.path])),
  );
}

/** Retain compact observations with their invocation-local owner and order. */
function partialEvidence(snapshot: InvocationSnapshot, primary: ContractId | undefined): PartialEvidence {
  const admitted = snapshot.admitted.map(({ contractId, ...fact }) =>
    contractId === primary || contractId === undefined ? fact : { ...fact, contractId },
  );
  const effects: NonNullable<PartialEvidence["effects"]>[number][] = snapshot.effects.flatMap((record) =>
    record.kind === "movement"
      ? [{ ...record.effect, ...(record.contract === primary ? {} : { contractId: record.contract }) }]
      : [],
  );
  let placement: z.output<typeof placementSchema> | undefined;
  for (const [contractId, value] of snapshot.conclusions) {
    if (value.placement === undefined) continue;
    if (contractId === primary) placement = value.placement;
    else if (value.placement.kind === "placed") effects.push({ ...value.placement, contractId });
  }
  return {
    ...(admitted.length === 0 ? {} : { admitted }),
    ...(effects.length === 0
      ? {}
      : { effects: [...new Map(effects.map((effect) => [JSON.stringify(effect), effect])).values()] }),
    ...(placement === undefined ? {} : { placement }),
  };
}

function acceptedRecoveries(operation: ContractVerb, snapshot: InvocationSnapshot, contract: ContractId) {
  const recoveries = snapshot.effects.flatMap((record) =>
    record.kind === "movement" && record.effect.kind === "recovery-snapshot"
      ? [{ snapshot: record.effect.snapshot, ...(record.contract === contract ? {} : { contractId: record.contract }) }]
      : [],
  );
  if (recoveries.length === 0) return {};
  const unique = [...new Map(recoveries.map((recovery) => [JSON.stringify(recovery), recovery])).values()];
  const local = operation === "bind" || operation === "amend" || operation === "arc" || operation === "abandon";
  return { recoverySnapshots: local ? unique.map((recovery) => recovery.snapshot) : unique };
}

function projectReset(
  snapshot: InvocationSnapshot,
  projection: ResetProjection,
): Readonly<{ kind: "returned"; outcome: ResetOutcome }> | Readonly<{ kind: "failed"; error: KeiyakuError }> {
  const issues = snapshot.effects
    .filter((effect): effect is ResetEffect => effect.kind === "reset-owner-stopped" || effect.kind === "reset-residue")
    .map(
      ({ world: _world, owner, ...issue }): ResetIssue =>
        issue.kind === "reset-residue" ? issue : { ...issue, owner },
    );
  const partial = projection.kind === "failed" || issues.some(resetIssueIsRequired);
  const removed: { refs?: number; worktrees?: number; debts?: number } = {};
  const counts = snapshot.reset?.removed;
  if (counts !== undefined)
    for (const key of ["refs", "worktrees", "debts"] as const) {
      const owner = key === "debts" ? "debt" : "git";
      if (counts[key] > 0 || (partial && snapshot.reset?.attempted.includes(owner))) removed[key] = counts[key];
    }
  const evidence = {
    ...(Object.keys(removed).length === 0 ? {} : { removed }),
    ...(issues.length === 0 ? {} : { issues }),
  };
  if (projection.kind === "failed")
    return {
      kind: "failed",
      error: withOutcomeReceipt(projection.error, { kind: "world", world: projection.world, ...evidence }),
    };
  return {
    kind: "returned",
    outcome:
      projection.kind === "refused"
        ? { kind: "refused", world: projection.world }
        : {
            kind: "accepted",
            ...(removed.refs === undefined ? {} : { refsRemoved: removed.refs }),
            ...(removed.worktrees === undefined ? {} : { worktreesRemoved: removed.worktrees }),
            ...(removed.debts === undefined ? {} : { debtsRemoved: removed.debts }),
            ...(issues.length === 0 ? {} : { issues }),
          },
  };
}

export function project(
  operation: "nuke",
  snapshot: InvocationSnapshot,
  conclusion: ResetProjection,
): Readonly<{ kind: "returned"; outcome: ResetOutcome }> | Readonly<{ kind: "failed"; error: KeiyakuError }>;
export function project<Answer extends Readonly<{ kind: string; contractId?: ContractId }>>(
  operation: ContractVerb,
  snapshot: InvocationSnapshot,
  conclusion: Answer | InvocationFailure,
): Readonly<{ kind: "returned"; outcome: Answer }> | Readonly<{ kind: "failed"; error: KeiyakuError }>;
export function project<Answer extends Readonly<{ kind: string; contractId?: ContractId }>>(
  operation: OutcomeOperation,
  snapshot: InvocationSnapshot,
  conclusion: Answer | InvocationFailure | ResetProjection,
): Readonly<{ kind: "returned"; outcome: Answer | ResetOutcome }> | Readonly<{ kind: "failed"; error: KeiyakuError }> {
  if ("world" in conclusion) {
    if (operation !== "nuke") throw new Error("reset projection requires nuke");
    return projectReset(snapshot, conclusion);
  }
  if (operation === "nuke") throw new Error("nuke requires a World projection");
  const contract =
    "contract" in conclusion ? conclusion.contract : "contractId" in conclusion ? conclusion.contractId : undefined;
  const current = contract === undefined ? undefined : snapshot.conclusions.get(contract);
  const issues = invocationIssues(snapshot.effects, contract, current?.snapshot);
  const base = {
    ...(contract === undefined ? {} : { contractId: contract }),
    ...(issues.length === 0 ? {} : { issues }),
  };
  if ("error" in conclusion)
    return {
      kind: "failed",
      error: withOutcomeReceipt(conclusion.error, {
        kind: "contract",
        ...base,
        ...current,
        ...partialEvidence(snapshot, contract),
      }),
    };
  if (conclusion.kind === "refused" || conclusion.kind === "retry") {
    const evidence = partialEvidence(snapshot, contract);
    if (Object.keys(evidence).length > 0 || issues.length > 0)
      throw withOutcomeReceipt(new Error("non-admission followed confirmed invocation effects"), {
        kind: "contract",
        ...base,
        ...evidence,
      });
  }
  const { kind, ...value } = conclusion;
  const outcome = {
    kind,
    ...base,
    ...(conclusion.kind === "accepted" && contract !== undefined
      ? acceptedRecoveries(operation, snapshot, contract)
      : {}),
    ...value,
  };
  if (operation === "bind" && "kei" in conclusion)
    Object.defineProperty(outcome, "kei", {
      value: conclusion.kei,
      enumerable: false,
    });
  return { kind: "returned", outcome: outcome as Answer };
}

export type KeiyakuErrorCategory = "invalid-input" | "authority-corruption" | "aborted" | "internal";
type KeiyakuErrorOptions = Readonly<{ cause?: unknown; outcome?: PartialOutcomeEnvelope }>;
const errorOutcomes = new WeakMap<KeiyakuError, PartialOutcomeEnvelope>();
export class KeiyakuError extends Error {
  readonly category: KeiyakuErrorCategory;
  get outcome(): PartialOutcomeEnvelope | undefined {
    return errorOutcomes.get(this);
  }
  constructor(category: KeiyakuErrorCategory, message: string, options: KeiyakuErrorOptions = {}) {
    super(message);
    this.name = "KeiyakuError";
    this.category = category;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.outcome !== undefined) errorOutcomes.set(this, options.outcome);
  }
}
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
export function withOutcomeReceipt(error: unknown, outcome: PartialOutcomeEnvelope): KeiyakuError {
  if (error instanceof KeiyakuError) {
    const previous = error.outcome;
    if (previous?.kind === "contract" && outcome.kind === "contract") {
      const merged = { ...previous, ...outcome };
      for (const key of ["admitted", "effects", "issues"] as const) {
        const values = [...(previous[key] ?? []), ...(outcome[key] ?? [])];
        if (values.length > 0)
          Object.assign(merged, {
            [key]: [...new Map(values.map((value) => [JSON.stringify(value), value])).values()],
          });
      }
      outcome = merged;
    }
    errorOutcomes.set(error, outcome);
    return error;
  }
  return new KeiyakuError(errorCategory(error), errorDiagnostic(error), { cause: error, outcome });
}
const confirmedSpawnFailures = new WeakMap<Error, SpawnResult>();

/** Native creation evidence cannot be supplied by an arbitrary error property. */
export function spawnFailureReceipt(error: unknown): SpawnResult | undefined {
  return error instanceof Error ? confirmedSpawnFailures.get(error) : undefined;
}

/** Retain the native error, including frozen failures, without losing confirmed birth. */
export function withSpawnFailureReceipt(reason: unknown, result: SpawnResult): Error {
  const cause = reason instanceof Error ? reason : new Error(reason === undefined ? "spawn aborted" : String(reason));
  // A shared cancellation reason cannot carry two different invocations' births.
  const error = confirmedSpawnFailures.has(cause) ? new Error(cause.message, { cause }) : cause;
  if (error !== cause) error.name = cause.name;
  confirmedSpawnFailures.set(error, result);
  return error;
}

export type FailureProjection = Readonly<{
  kind: "failed";
  category: KeiyakuErrorCategory;
  diagnostic: string;
  causeClass?: string;
  causeDiagnostic?: string;
  outcome?: PartialOutcomeEnvelope;
  spawn?: SpawnResult;
  tell?: AkumaTellResult;
}>;
export function projectFailure(error: unknown): FailureProjection {
  const thrown = error instanceof KeiyakuError ? error.cause : error;
  const spawn = spawnFailureReceipt(error) ?? spawnFailureReceipt(thrown);
  const tell = tellFailure(error) ?? tellFailure(thrown);
  const classified = tell?.cause ?? error;
  const cause = classified instanceof KeiyakuError ? classified.cause : classified;
  return {
    kind: "failed",
    category: classified instanceof KeiyakuError ? classified.category : errorCategory(classified),
    diagnostic: errorDiagnostic(error),
    ...(cause instanceof Error ? { causeClass: cause.name, causeDiagnostic: cause.message } : {}),
    ...(spawn === undefined ? {} : { spawn }),
    ...(tell === undefined ? {} : { tell: tell.receipt }),
    ...(error instanceof KeiyakuError && error.outcome !== undefined ? { outcome: error.outcome } : {}),
  };
}
