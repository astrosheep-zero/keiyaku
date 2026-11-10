/** @architectureCompositionRoot */
import { z } from "zod";
import { contractFileLagSchema } from "../contract-worktree.js";
import type { ContractId, JournalEntry, SnapshotId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { reconcileEffectSchema, gitReconcileLagSchema } from "../git/reconcile.js";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { compactPlacement, placedSchema, placementSchema, type CompletionEvidence } from "../protocol/completion.js";
import { type VerifyValue } from "../protocol/verify.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { ReviewAdmissionValue } from "../protocol/review.js";
import { settlementActionSchema } from "../settlement/settle.js";
import { worldRootSchema, type WorldRoot } from "../world.js";
import type { ContinuationReport } from "./continuation.js";
import { compactDelivery, type RawDeliveryValue } from "./delivery.js";
import type { SpawnResult } from "./akuma-creation.js";
import type { InvocationSnapshot, CandidateConclusion } from "./invocation.js";
import { compactRetry, retrySchema, executionIssueSchema, type Retry } from "../protocol/result-reasons.js";
export { executionIssueSchema } from "../protocol/result-reasons.js";
import type { IntentRetry } from "../protocol/operations.js";

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
export const reconcileIssueSchema = z.union([
  gitReconcileLagSchema.options[0].unwrap().extend(scoped).readonly(),
  gitReconcileLagSchema.options[1].unwrap().extend(scoped).readonly(),
  gitReconcileLagSchema.options[2].unwrap().extend(scoped).readonly(),
  gitReconcileLagSchema.options[3].unwrap().extend(scoped).readonly(),
  gitReconcileLagSchema.options[4].unwrap().extend(scoped).readonly(),
  gitReconcileLagSchema.options[5].unwrap().extend(scoped).readonly(),
  gitReconcileLagSchema.options[6].unwrap().extend(scoped).readonly(),
  contractFileLagSchema.unwrap().extend(scoped).readonly(),
]);
const checkResource = {
  snapshot: snapshotIdSchema.exactOptional(),
  requirement: z.string().min(1).exactOptional(),
  index: z.number().int().positive().exactOptional(),
};
export const cleanupIssueSchema = z.union([
  z.strictObject({ ...scoped, kind: z.literal("decode-channel-retirement"), diagnostic }).readonly(),
  z
    .strictObject({
      ...scoped,
      kind: z.literal("verification-cleanup"),
      ...checkResource,
      name: z.string().min(1),
      diagnostic,
    })
    .readonly(),
  z
    .strictObject({
      ...scoped,
      kind: z.literal("worktree-leak"),
      ...checkResource,
      path: path.exactOptional(),
      diagnostic,
    })
    .readonly(),
  z.strictObject({ ...scoped, kind: z.literal("private-state-seat-close"), diagnostic }).readonly(),
]);

const settlementIssueSchema = z
  .strictObject({
    ...scoped,
    kind: z.literal("settlement-failed"),
    debtId: z.string().min(1).exactOptional(),
    diagnostic,
  })
  .readonly();
const issueLeaves = [
  ...reconcileIssueSchema.options,
  ...cleanupIssueSchema.options,
  executionIssueSchema.unwrap().extend(scoped).readonly(),
  settlementIssueSchema,
] as const;
export const invocationIssueSchema = z.union(issueLeaves);
export type InvocationIssue = z.output<typeof invocationIssueSchema>;
export type Issue = InvocationIssue;
const localLeaves = [
  reconcileIssueSchema.options[0],
  reconcileIssueSchema.options[2],
  reconcileIssueSchema.options[3],
  reconcileIssueSchema.options[4],
  reconcileIssueSchema.options[5],
  reconcileIssueSchema.options[6],
  reconcileIssueSchema.options[7],
  cleanupIssueSchema.options[0],
  cleanupIssueSchema.options[3],
  issueLeaves[12],
  settlementIssueSchema,
] as const;
export const localIssueSchema = z.union(localLeaves);
export const completionIssueSchema = z.union([
  ...reconcileIssueSchema.options,
  cleanupIssueSchema.options[0],
  cleanupIssueSchema.options[3],
  issueLeaves[12],
  settlementIssueSchema,
]);
export const previewIssueSchema = cleanupIssueSchema.options[0].unwrap().omit({ contractId: true }).readonly();
export const reconcilePublicIssueSchema = z.union([
  reconcileIssueSchema.options[0],
  reconcileIssueSchema.options[2],
  reconcileIssueSchema.options[3],
  reconcileIssueSchema.options[4],
  reconcileIssueSchema.options[5],
  reconcileIssueSchema.options[6],
  reconcileIssueSchema.options[7],
  cleanupIssueSchema.options[3],
  settlementIssueSchema,
]);

/** An issue before its containing receipt supplies the owning Contract. */
type LocalInvocationIssue = InvocationIssue;

export function invocationIssueIsFailure(issue: InvocationIssue): boolean {
  switch (issue.kind) {
    case "worktree-retained":
    case "unsealed-bytes":
    case "worktree-follow-retained":
    case "verification-cleanup":
    case "worktree-leak":
    case "decode-channel-retirement":
      return false;
    default:
      return true;
  }
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
): "accepted" | "refused" | "retryable" | "failed" {
  if (result.kind === "refused") return "refused";
  if (result.kind === "retry") return "retryable";
  let retry = false;
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
    if (check.kind !== "terminal" || check.verdict === "unsatisfied") return "failed";
    if (typeof check.admission === "object" && stopped(check.admission)) return "failed";
  }
  for (const stop of result.continuation?.stopped ?? []) if (stopped(stop)) return "failed";
  return retry ? "retryable" : "accepted";
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
  | Readonly<{ kind: "issue"; contract: ContractId; issue: LocalInvocationIssue }>
  | ResetEffect
  | Readonly<{ kind: "movement"; contract: ContractId; effect: MovementEffect }>
  | Readonly<{ kind: "settlement-action"; contract: ContractId; action: z.output<typeof settlementActionSchema> }>;

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
export type MovementEffect = Exclude<z.output<typeof meaningfulEffectSchema>, { kind: "debt-settled" }>;
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
export type StopOutcome<Refusal> =
  | Readonly<{ kind: "refused"; contractId: ContractId; reason: Refusal }>
  | (Readonly<{ contractId: ContractId }> & Retry);
type OperationIssue<Operation extends ContractVerb> = Operation extends "bind" | "amend" | "arc" | "abandon"
  ? z.output<typeof localIssueSchema>
  : Operation extends "deliver" | "review"
    ? z.output<typeof completionIssueSchema>
    : InvocationIssue;
type OperationRecovery<Operation extends ContractVerb> = Operation extends "bind" | "amend" | "arc" | "abandon"
  ? SnapshotId
  : z.output<typeof recoverySnapshotSchema>;
export type OperationOutcome<Operation extends ContractVerb, Value, Refusal> =
  | (Readonly<{
      kind: "accepted";
      contractId: ContractId;
      issues?: readonly OperationIssue<Operation>[];
      recoverySnapshots?: readonly OperationRecovery<Operation>[];
    }> &
      Value)
  | (Operation extends "bind"
      ? Readonly<{ kind: "refused"; reason: Refusal }> | Retry
      : Operation extends "verify" | "deliver-preview"
        ? Readonly<{ kind: "refused"; contractId: ContractId; reason: Refusal }>
        : StopOutcome<Refusal>);

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
export type ProjectedOutcome<Operation extends ContractVerb, Value, Refusal> = Operation extends "deliver-preview"
  ?
      | (Value & Readonly<{ issues?: readonly z.output<typeof previewIssueSchema>[] }>)
      | Readonly<{ kind: "refused"; contractId: ContractId; reason: Refusal }>
  : OperationOutcome<Operation, Value, Refusal> | (Operation extends "deliver" ? HandoffOutcome : never);

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

export type Verify = VerifyValue & Readonly<{ continuation?: ContinuationReport }>;
export type Review = Readonly<{
  placement?: z.output<typeof placementSchema>;
  worktreeChanges?: Readonly<{
    staged?: readonly string[];
    unstaged?: readonly string[];
    untracked?: readonly string[];
    unmergedPaths?: readonly string[];
  }>;
  continuation?: ContinuationReport;
}>;
type PartialContractEnvelope = ReceiptFields &
  PartialEvidence &
  Readonly<{
    kind: "contract";
    worktreePath?: string;
    target?: string;
    changedSections?: readonly string[];
    gatesChanged?: true;
    afterChanged?: true;
    candidate?: string;
    integration?: string;
    contentId?: string;
    admission?: "reused";
    previousContentId?: string;
    snapshot?: string;
    checks?: readonly import("../protocol/verify.js").VerificationCheck[];
    worktreeChanges?: Review["worktreeChanges"];
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

/** Internal execution conclusion before the final, independently awaited resource retirement. */
export type OutcomeProjection<Operation extends ContractVerb, Value, Refusal> =
  | Readonly<{ kind: "accepted"; contract: ContractId; value: Value }>
  | Readonly<{ kind: "refused"; contract?: ContractId; refusal: Refusal }>
  | Readonly<{ kind: "retry"; contract?: ContractId; reason: IntentRetry }>
  | Readonly<{ kind: "failed"; contract?: ContractId; error: unknown }>
  | (Operation extends "deliver"
      ? Readonly<{ kind: "handoff"; contract: ContractId; value: IntegrationConflictMaterialized }>
      : never);
export type Projected<Operation extends ContractVerb, Value, Refusal> =
  | Readonly<{ kind: "returned"; outcome: ProjectedOutcome<Operation, Value, Refusal> }>
  | Readonly<{ kind: "failed"; error: KeiyakuError }>;

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
      (issue.kind === "verification-cleanup" || issue.kind === "worktree-leak") &&
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

function admissionEvidence(
  fact: JournalEntry,
  primary: ContractId | undefined,
): z.output<typeof admittedEvidenceSchema> {
  const base = fact.contract === primary ? {} : { contractId: fact.contract };
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

function physicalEvidence(
  snapshot: InvocationSnapshot,
  primary: ContractId | undefined,
): NonNullable<PartialEvidence["effects"]> {
  const effects: NonNullable<PartialEvidence["effects"]>[number][] = [];
  for (const record of snapshot.effects) {
    if (record.kind !== "settlement-action" && record.kind !== "movement") continue;
    const owner = record.contract === primary ? {} : { contractId: record.contract };
    if (record.kind === "settlement-action") {
      effects.push({ ...owner, kind: "debt-settled", debtId: record.action.debtId });
      continue;
    }
    effects.push({ ...record.effect, ...owner });
  }
  return [...new Map(effects.map((effect) => [JSON.stringify(effect), effect])).values()];
}

/** Retain witnessed irreversible effects even when the operation never produced a complete value. */
function partialEvidence(snapshot: InvocationSnapshot, primary: ContractId | undefined): PartialEvidence {
  const admitted = snapshot.facts.map((fact) => admissionEvidence(fact, primary));
  const effects = [...physicalEvidence(snapshot, primary)];
  let placement: z.output<typeof placementSchema> | undefined;
  for (const [contractId, value] of snapshot.conclusions) {
    const observed = compactPlacement(value as CompletionEvidence);
    if (observed === undefined) continue;
    if (contractId === primary) placement = observed;
    else if (observed.kind === "placed") effects.push({ ...observed, contractId });
  }
  return {
    ...(admitted.length === 0 ? {} : { admitted }),
    ...(effects.length === 0 ? {} : { effects }),
    ...(placement === undefined ? {} : { placement }),
  };
}

function acceptedRecoveries(operation: ContractVerb, snapshot: InvocationSnapshot, contract: ContractId) {
  const recoveries = physicalEvidence(snapshot, contract).flatMap((effect) =>
    effect.kind === "recovery-snapshot"
      ? [{ snapshot: effect.snapshot, ...(effect.contractId === undefined ? {} : { contractId: effect.contractId }) }]
      : [],
  );
  if (recoveries.length === 0) return {};
  const local = operation === "bind" || operation === "amend" || operation === "arc" || operation === "abandon";
  return { recoverySnapshots: local ? recoveries.map((recovery) => recovery.snapshot) : recoveries };
}

export function compactReview(
  value: CompletionEvidence & ReviewAdmissionValue & Readonly<{ continuation?: ContinuationReport }>,
): Review {
  const placement = compactPlacement(value);
  return {
    ...(placement === undefined ? {} : { placement }),
    ...(value.worktreeChanges === undefined ? {} : { worktreeChanges: value.worktreeChanges }),
    ...(value.continuation === undefined || Object.keys(value.continuation).length === 0
      ? {}
      : { continuation: value.continuation }),
  };
}

function partialConclusion(
  operation: ContractVerb,
  value: CandidateConclusion | undefined,
): Partial<PartialContractEnvelope> {
  if (value === undefined) return {};
  switch (operation) {
    case "bind":
      return {
        ...(typeof value.worktreePath === "string" ? { worktreePath: value.worktreePath } : {}),
        ...(value.target === undefined
          ? {}
          : { target: value.target as NonNullable<PartialContractEnvelope["target"]> }),
      };
    case "amend":
      return {
        ...(value.changedSections === undefined ? {} : { changedSections: value.changedSections as readonly string[] }),
        ...(value.gatesChanged === true ? { gatesChanged: true as const } : {}),
        ...(value.afterChanged === true ? { afterChanged: true as const } : {}),
      };
    case "deliver":
      return value.tenderSnapshot === undefined || value.integration === undefined
        ? {}
        : (() => {
            const compact = compactDelivery(value as RawDeliveryValue);
            const placement = compactPlacement(value as CompletionEvidence);
            const { placement: _placement, ...rest } = compact;
            return { ...rest, ...(placement === undefined ? {} : { placement }) };
          })();
    case "verify":
      return {
        ...(typeof value.snapshot === "string" ? { snapshot: value.snapshot } : {}),
        ...(value.checks === undefined ? {} : { checks: value.checks }),
        ...(value.continuation === undefined ? {} : { continuation: value.continuation as ContinuationReport }),
      };
    case "review":
      return compactReview(value as CompletionEvidence & ReviewAdmissionValue);
    case "arc":
      return {
        ...(value.chapter === undefined ? {} : { chapter: value.chapter as number }),
      };
    case "deliver-preview":
      return { preview: value as Partial<import("../protocol/delivery-preview.js").DeliveryPreviewReport> };
    case "abandon":
      return {};
  }
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
    return projectReset(snapshot, projection);
  }
  if (operation === "nuke") throw new Error("nuke requires a World projection");
  const contract = projection.contract ?? snapshot.facts.find((fact) => fact.kind === "bind")?.contract;
  const captured = contract === undefined ? undefined : snapshot.conclusions.get(contract)?.snapshot;
  const issues = invocationIssues(snapshot.effects, contract, typeof captured === "string" ? captured : undefined);
  const base = {
    ...(contract === undefined ? {} : { contractId: contract }),
    ...(issues.length === 0 ? {} : { issues }),
  };
  switch (projection.kind) {
    case "accepted": {
      if (operation === "deliver-preview")
        return {
          kind: "returned",
          outcome: { ...projection.value, ...base } as ProjectedOutcome<ContractVerb, Value, Refusal>,
        };
      const receipt = {
        kind: "accepted" as const,
        contractId: projection.contract,
        ...(issues.length === 0 ? {} : { issues }),
        ...acceptedRecoveries(operation, snapshot, projection.contract),
      };
      const outcome = { ...receipt, ...projection.value };
      if (operation === "bind")
        Object.defineProperty(outcome, "kei", {
          value: (projection.value as import("./contract-outcomes.js").BindValue).kei,
          enumerable: false,
        });
      return { kind: "returned", outcome: outcome as ProjectedOutcome<ContractVerb, Value, Refusal> };
    }
    case "handoff":
      return {
        kind: "returned",
        outcome: {
          kind: "handoff",
          contractId: projection.contract,
          worktreePath: projection.value.workspace.path,
          targetHead: projection.value.targetHead,
          conflictPaths: projection.value.conflictPaths,
          handoffBase: projection.value.handoffBase,
        },
      };
    case "refused":
    case "retry": {
      const evidence = partialEvidence(snapshot, contract);
      if (Object.keys(evidence).length > 0 || issues.length > 0)
        throw withOutcomeReceipt(new Error("non-admission followed confirmed invocation effects"), {
          kind: "contract",
          ...base,
          ...evidence,
        });
      const addressed = operation === "bind" ? {} : { contractId: contract! };
      return {
        kind: "returned",
        outcome: (projection.kind === "refused"
          ? { kind: "refused", ...addressed, reason: projection.refusal }
          : { ...addressed, ...compactRetry(projection.reason) }) as ProjectedOutcome<ContractVerb, Value, Refusal>,
      };
    }
    case "failed":
      return {
        kind: "failed",
        error: withOutcomeReceipt(projection.error, {
          kind: "contract",
          ...base,
          ...partialConclusion(operation, contract === undefined ? undefined : snapshot.conclusions.get(contract)),
          ...partialEvidence(snapshot, contract),
        }),
      };
  }
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
}>;
export function projectFailure(error: unknown): FailureProjection {
  const cause = error instanceof KeiyakuError ? error.cause : error;
  const spawn = spawnFailureReceipt(error) ?? spawnFailureReceipt(cause);
  return {
    kind: "failed",
    category: error instanceof KeiyakuError ? error.category : errorCategory(error),
    diagnostic: errorDiagnostic(error),
    ...(cause instanceof Error ? { causeClass: cause.name, causeDiagnostic: cause.message } : {}),
    ...(spawn === undefined ? {} : { spawn }),
    ...(error instanceof KeiyakuError && error.outcome !== undefined ? { outcome: error.outcome } : {}),
  };
}
