import { decodeJournalEntry } from "../core/facts/codec.js";
import { changeId, contractHead, contractId, entryUlid, gate, snapshotId } from "../core/facts/types.js";
import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { ReviewValue } from "../protocol/review.js";
import { decodeSettlementLag } from "../settlement/settle.js";
import type { ContinuationReport } from "./continuation.js";
import type { DeliveryValue } from "./delivery.js";
import type { MutationResult } from "./mutation.js";
import { KeiyakuRefused, KeiyakuRetry, type KeiyakuRefusal, type KeiyakuRetryReason } from "./refusal.js";
import { reconciliationLagSchema } from "./contract-forwarding-reconciliation-result.js";
import { z } from "zod";

export type Review = ReviewValue & Readonly<{ continuation?: ContinuationReport }>;

function canonical<Value>(
  decode: (value: string) => Value,
  message: string,
): z.ZodPipe<z.ZodString, z.ZodTransform<Value, string>> {
  return z.string().transform((value, context) => {
    try {
      return decode(value);
    } catch {
      context.addIssue({ code: "custom", message });
      return z.NEVER;
    }
  });
}

type WithoutUndefined<Value> = {
  [Key in keyof Value as undefined extends Value[Key] ? never : Key]: Value[Key];
} & {
  [Key in keyof Value as undefined extends Value[Key] ? Key : never]?: Exclude<Value[Key], undefined>;
};

function withoutUndefined<Value extends Record<string, unknown>>(
  value: Value,
  optional: readonly (keyof Value & string)[],
): WithoutUndefined<Value> {
  const result: Record<string, unknown> = { ...value };
  for (const key of optional) {
    const field = result[key];
    delete result[key];
    if (field !== undefined) result[key] = field;
  }
  return result as WithoutUndefined<Value>;
}

const nonblankStringSchema = z.string().refine((value) => value.trim() !== "");
const contractIdSchema = canonical(contractId, "expected ContractId");
const contractHeadSchema = canonical(contractHead, "expected ContractHead");
const snapshotIdSchema = canonical(snapshotId, "expected SnapshotId");
const changeIdSchema = canonical(changeId, "expected ChangeId");
const journalFactSchema = z.unknown().transform((value, context) => {
  try {
    return decodeJournalEntry(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected journal entry" });
    return z.NEVER;
  }
});

const settlementLagSchema = z.unknown().transform((value, context) => {
  try {
    return decodeSettlementLag(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected settlement lag" });
    return z.NEVER;
  }
});
const completionSchema = z
  .object({
    integration: snapshotIdSchema,
    verification: z
      .object({ mode: z.enum(["ran", "reused"]), verdict: z.enum(["satisfied", "unsatisfied"]) })
      .strict()
      .optional(),
  })
  .strict()
  .transform((completion) => withoutUndefined(completion, ["verification"]));
const integrationSchema = z
  .object({ predecessor: snapshotIdSchema, snapshot: snapshotIdSchema, changeId: changeIdSchema })
  .strict();
const policySchema = z.object({ requireBranchesToBeUpToDate: z.boolean() }).strict();

const gateSchema = canonical(gate, "expected Gate");
const contractIdentityRefusalSchema = z
  .object({
    kind: z.enum([
      "terminal",
      "terms-moved",
      "unknown-prerequisite",
      "cyclic-prerequisite",
      "document-moved",
      "contract-exists",
      "invalid-after",
      "fork-source-moved",
      "worktree-missing",
      "target-missing",
      "delivery-missing",
    ]),
    contractId: contractIdSchema,
  })
  .strict();
const contractMissingRefusalSchema = z
  .object({ kind: z.literal("contract-missing"), contractId: contractIdSchema })
  .strict();
const targetInputRefusalSchema = z.union([
  z.object({ kind: z.literal("invalid-target") }).strict(),
  z.object({ kind: z.literal("target-missing") }).strict(),
  z.object({ kind: z.literal("unborn-head") }).strict(),
]);
const verificationDeclarationRefusalSchema = z
  .object({ kind: z.literal("verification-declaration-invalid"), contractId: contractIdSchema.optional() })
  .strict()
  .transform((refusal) => withoutUndefined(refusal, ["contractId"]));
const workspaceSchema = z.object({ kind: z.literal("worktree"), path: nonblankStringSchema }).strict();
const mergeStateRefusalSchema = z
  .object({ kind: z.literal("merge-state-present"), contractId: contractIdSchema, workspace: workspaceSchema })
  .strict();
const unmergedPathsRefusalSchema = z
  .object({ kind: z.literal("unmerged-paths"), contractId: contractIdSchema, paths: z.array(nonblankStringSchema) })
  .strict();
const dirtyWorkspaceRefusalSchema = z
  .object({
    kind: z.literal("dirty-workspace"),
    contractId: contractIdSchema,
    staged: z.array(nonblankStringSchema),
    unstaged: z.array(nonblankStringSchema),
    untracked: z.array(nonblankStringSchema),
    submodules: z.array(nonblankStringSchema),
    shortStat: z
      .object({
        filesChanged: z.number().int().nonnegative(),
        insertions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const integrationFailureSchema = z
  .object({
    kind: z.literal("integration-failed"),
    contractId: contractIdSchema,
    reason: z.enum(["not-based-on-target", "unrelated-histories", "conflict"]),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(nonblankStringSchema).optional(),
  })
  .strict()
  .transform((failure) => withoutUndefined(failure, ["conflictPaths"]));
const integrationPreparationRefusalSchema = z.union([
  integrationFailureSchema,
  z
    .object({
      kind: z.literal("integration-unsupported"),
      contractId: contractIdSchema,
      requiredGit: z.literal("2.38"),
    })
    .strict(),
]);
const integrationRefusalSchema = z.union([
  integrationPreparationRefusalSchema,
  z
    .object({
      kind: z.literal("integration-failed"),
      contractId: contractIdSchema,
      reason: z.literal("conflict"),
      targetHead: snapshotIdSchema,
      conflictPaths: z.array(nonblankStringSchema),
      recovery: z
        .object({
          materialize: z.literal("deliver --materialize-conflict --include-dirty"),
          continue: z.literal("deliver --include-dirty"),
        })
        .strict(),
    })
    .strict(),
]);
const checkoutRefusalSchema = z
  .object({
    kind: z.literal("checkout-not-followable"),
    contractId: contractIdSchema,
    target: nonblankStringSchema,
    path: nonblankStringSchema,
    reason: z.enum(["staged", "conflict", "untracked"]),
    paths: z.array(nonblankStringSchema),
  })
  .strict();
const gateCurrentSchema = z.union([
  z
    .object({
      kind: z.literal("attested"),
      verdict: z.enum(["satisfied", "unsatisfied"]),
      summary: z.string().optional(),
      at: z.string(),
    })
    .strict()
    .transform((current) => withoutUndefined(current, ["summary"])),
  z.object({ kind: z.literal("stale"), priorVerdict: z.enum(["satisfied", "unsatisfied"]) }).strict(),
  z.object({ kind: z.literal("missing") }).strict(),
]);
const placementRefusalSchema = z.union([
  z
    .object({
      kind: z.literal("gates-unsatisfied"),
      contractId: contractIdSchema,
      unmet: z.array(z.object({ gate: gateSchema, current: gateCurrentSchema }).strict()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("prerequisites-unsatisfied"),
      contractId: contractIdSchema,
      unmet: z.array(
        z.object({ contractId: contractIdSchema, state: z.enum(["missing", "active", "abandoned"]) }).strict(),
      ),
    })
    .strict(),
]);
const nukeRefusalSchema = z.union([
  z.object({ kind: z.literal("nuke-confirmation-required"), world: nonblankStringSchema }).strict(),
  z
    .object({ kind: z.literal("nuke-confirmation-mismatch"), world: nonblankStringSchema, confirmation: z.string() })
    .strict(),
]);
const forkSourceRefusalSchema = z
  .object({
    kind: z.enum(["fork-source-missing", "fork-source-unavailable", "fork-source-invalid", "fork-source-moved"]),
    contractId: contractIdSchema,
  })
  .strict();
const refusalSchema = z.union([
  contractMissingRefusalSchema,
  contractIdentityRefusalSchema,
  targetInputRefusalSchema,
  verificationDeclarationRefusalSchema,
  mergeStateRefusalSchema,
  unmergedPathsRefusalSchema,
  dirtyWorkspaceRefusalSchema,
  integrationRefusalSchema,
  checkoutRefusalSchema,
  placementRefusalSchema,
  nukeRefusalSchema,
  forkSourceRefusalSchema,
]) satisfies z.ZodType<KeiyakuRefusal>;
const retrySchema = z.union([
  z.object({ kind: z.literal("exhausted") }).strict(),
  z.object({ kind: z.literal("collision") }).strict(),
  z.object({ kind: z.literal("publication-failed"), diagnostic: z.string() }).strict(),
]) satisfies z.ZodType<KeiyakuRetryReason>;
const materializedConflictSchema = z
  .object({
    kind: z.literal("integration-conflict-materialized"),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(nonblankStringSchema),
    workspace: z.object({ kind: z.literal("worktree"), path: nonblankStringSchema }).strict(),
  })
  .strict() satisfies z.ZodType<IntegrationConflictMaterialized>;

const hookFailureSchema = z.union([
  z
    .object({
      kind: z.literal("exit"),
      code: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("timeout") }).strict(),
  z.object({ kind: z.literal("spawn-error"), diagnostic: z.string() }).strict(),
  z.object({ kind: z.literal("unknown-exit") }).strict(),
]);
const attestationRefusalSchema = z
  .object({ kind: z.enum(["contract-missing", "terminal"]), contractId: contractIdSchema })
  .strict();
const verificationStopSchema = z.union([
  z.object({ refusal: z.union([attestationRefusalSchema, verificationDeclarationRefusalSchema]) }).strict(),
  z.object({ retry: retrySchema }).strict(),
  z.object({ failure: z.enum(["unknown-exit", "cancelled"]) }).strict(),
  z.object({ failure: z.enum(["candidate-unavailable", "spawn-error"]), diagnostic: z.string() }).strict(),
  z.object({ failure: z.literal("environment-failure"), diagnostic: z.string() }).strict(),
  z
    .object({ failure: z.literal("environment-failure"), command: z.number().int(), detail: hookFailureSchema })
    .strict(),
]) satisfies z.ZodType<NonNullable<DeliveryValue["verification"]>>;
const verificationReuseSchema = z
  .object({
    entry: canonical(entryUlid, "expected EntryUlid"),
    verdict: z.enum(["satisfied", "unsatisfied"]),
    summary: z.string().optional(),
  })
  .strict()
  .transform((reuse) => withoutUndefined(reuse, ["summary"])) satisfies z.ZodType<
  NonNullable<DeliveryValue["verificationReuse"]>
>;
const placementStepRefusalSchema = z.union([
  z
    .object({ kind: z.enum(["contract-missing", "delivery-missing", "terminal"]), contractId: contractIdSchema })
    .strict(),
  placementRefusalSchema,
  checkoutRefusalSchema,
  integrationPreparationRefusalSchema,
  z.object({ kind: z.literal("target-missing"), contractId: contractIdSchema }).strict(),
]);
const placementStopSchema = z.union([
  z.object({ refusal: placementStepRefusalSchema }).strict(),
  z.object({ retry: retrySchema }).strict(),
  z
    .object({
      failure: z.literal("target-moved"),
      contractId: contractIdSchema,
      target: nonblankStringSchema,
      expected: snapshotIdSchema,
      observed: snapshotIdSchema.nullable(),
      observedTreeEqualsCandidate: z.boolean(),
    })
    .strict(),
  z
    .object({
      failure: z.literal("target-moved"),
      contractId: contractIdSchema,
      target: nonblankStringSchema,
      integratedAt: snapshotIdSchema,
      observed: snapshotIdSchema.nullable(),
      attempts: z.number().int(),
      observedTreeEqualsCandidate: z.boolean(),
    })
    .strict(),
  z.object({ failure: z.literal("target-placement-failed"), diagnostic: z.string() }).strict(),
]) satisfies z.ZodType<NonNullable<DeliveryValue["placement"]>>;
const cleanupSchema = z
  .object({ phase: z.literal("destroy"), command: z.number().int(), detail: hookFailureSchema })
  .strict() satisfies z.ZodType<NonNullable<DeliveryValue["cleanup"]>>;
const leakSchema = z.object({ path: z.string(), diagnostic: z.string() }).strict() satisfies z.ZodType<
  NonNullable<DeliveryValue["leak"]>
>;
const continuationSchema = z
  .object({
    claimed: z.array(contractIdSchema),
    stopped: z.array(
      z
        .object({
          contractId: contractIdSchema,
          stop: z.union([placementStopSchema, z.object({ kind: z.literal("already-terminal") }).strict()]),
        })
        .strict(),
    ),
  })
  .strict() satisfies z.ZodType<NonNullable<DeliveryValue["continuation"]>>;
const workspaceDeltaSchema = z
  .object({
    staged: z.array(z.string()),
    unstaged: z.array(z.string()),
    untracked: z.array(z.string()),
    shortStat: z
      .object({ filesChanged: z.number().int(), insertions: z.number().int(), deletions: z.number().int() })
      .strict(),
  })
  .strict() satisfies z.ZodType<NonNullable<Review["workspace"]>>;
const deliveryValueSchema = z
  .object({
    tenderSnapshot: snapshotIdSchema,
    integration: integrationSchema,
    method: z.literal("squash"),
    policy: policySchema,
    completion: completionSchema.optional(),
    verification: verificationStopSchema.optional(),
    verificationReuse: verificationReuseSchema.optional(),
    verificationSummary: nonblankStringSchema.optional(),
    placement: placementStopSchema.optional(),
    cleanup: cleanupSchema.optional(),
    leak: leakSchema.optional(),
    continuation: continuationSchema.optional(),
  })
  .strict()
  .transform((value) =>
    withoutUndefined(value, [
      "completion",
      "verification",
      "verificationReuse",
      "verificationSummary",
      "placement",
      "cleanup",
      "leak",
      "continuation",
    ]),
  ) satisfies z.ZodType<DeliveryValue>;
const reviewValueSchema = z
  .object({
    completion: completionSchema.optional(),
    verification: verificationStopSchema.optional(),
    verificationReuse: verificationReuseSchema.optional(),
    verificationSummary: nonblankStringSchema.optional(),
    placement: placementStopSchema.optional(),
    cleanup: cleanupSchema.optional(),
    leak: leakSchema.optional(),
    continuation: continuationSchema.optional(),
    workspace: workspaceDeltaSchema.optional(),
  })
  .strict()
  .transform((value) =>
    withoutUndefined(value, [
      "completion",
      "verification",
      "verificationReuse",
      "verificationSummary",
      "placement",
      "cleanup",
      "leak",
      "continuation",
      "workspace",
    ]),
  ) satisfies z.ZodType<Review>;
const deliveryPreparationRefusalSchema = z.union([
  z.object({ kind: z.enum(["target-missing", "worktree-missing"]), contractId: contractIdSchema }).strict(),
  dirtyWorkspaceRefusalSchema,
  unmergedPathsRefusalSchema,
  integrationPreparationRefusalSchema,
  mergeStateRefusalSchema,
  checkoutRefusalSchema,
]);
const auditReadyCandidateSchema = z
  .object({
    kind: z.literal("ready"),
    workspace: z.object({ kind: z.literal("worktree"), path: nonblankStringSchema }).strict(),
    identity: z
      .object({
        tenderSnapshot: snapshotIdSchema,
        integration: integrationSchema,
        method: z.literal("squash"),
        policy: policySchema,
      })
      .strict(),
    scope: z
      .object({
        filesChanged: z.number().int(),
        insertions: z.number().int(),
        deletions: z.number().int(),
        paths: z.array(z.string()).optional(),
      })
      .strict()
      .transform((scope) => withoutUndefined(scope, ["paths"])),
    diff: z.string().optional(),
  })
  .strict()
  .transform((candidate) => withoutUndefined(candidate, ["diff"]));
const auditCandidateSchema = z.union([
  z.object({ kind: z.literal("blocked"), refusal: deliveryPreparationRefusalSchema }).strict(),
  auditReadyCandidateSchema,
]);
const auditVerificationSchema = z.union([
  z.object({ kind: z.literal("not-run") }).strict(),
  z.object({ kind: z.literal("stopped"), stop: verificationStopSchema }).strict(),
  z
    .object({
      kind: z.enum(["satisfied", "unsatisfied"]),
      passed: z.number(),
      total: z.number(),
      summary: z.string().optional(),
    })
    .strict()
    .transform((verification) => withoutUndefined(verification, ["summary"])),
]);
const auditTargetSchema = z.union([
  z.object({ kind: z.literal("not-observed") }).strict(),
  z.object({ kind: z.literal("placeable"), ref: z.string(), head: snapshotIdSchema }).strict(),
  z
    .object({
      kind: z.literal("moved"),
      ref: z.string(),
      expected: snapshotIdSchema,
      observed: snapshotIdSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("refused"), refusal: checkoutRefusalSchema }).strict(),
  z.object({ kind: z.literal("failed"), diagnostic: z.string() }).strict(),
]);
export const auditReportSchema: z.ZodType<AuditReport> = z
  .object({
    candidate: auditCandidateSchema,
    verification: auditVerificationSchema,
    target: auditTargetSchema,
    delivery: z
      .object({ changeId: changeIdSchema, relation: z.enum(["identical", "differs"]) })
      .strict()
      .optional(),
  })
  .strict()
  .transform((report) => withoutUndefined(report, ["delivery"]));

const pendingSurfaceSchema = z
  .object({
    surface: z.enum(["verification", "placement", "continuation", "reconciliation", "settlement", "cleanup"]),
    required: z.boolean(),
  })
  .strict();
const seatCloseSchema = z
  .object({ kind: z.literal("private-state-seat-close-failed"), diagnostic: nonblankStringSchema })
  .strict();
const mutationResultSchema = <Value>(value: z.ZodType<Value>) =>
  z
    .object({
      kind: z.literal("accepted"),
      facts: z.array(journalFactSchema),
      head: contractHeadSchema,
      value,
      lags: z.array(reconciliationLagSchema),
      settlementLags: z.array(settlementLagSchema),
      pending: z.array(pendingSurfaceSchema),
      recoverySnapshot: snapshotIdSchema.optional(),
      cleanup: cleanupSchema.optional(),
      leak: leakSchema.optional(),
      seatClose: z.array(seatCloseSchema).optional(),
    })
    .strict()
    .transform((result) => withoutUndefined(result, ["recoverySnapshot", "cleanup", "leak", "seatClose"]));

const deliveryMutationResultSchema = mutationResultSchema(deliveryValueSchema);
const reviewMutationResultSchema = mutationResultSchema(reviewValueSchema);
const auditMutationResultSchema = mutationResultSchema(auditReportSchema);

export const deliveryResultSchema = z.union([
  deliveryMutationResultSchema,
  materializedConflictSchema,
]) satisfies z.ZodType<MutationResult<DeliveryValue> | IntegrationConflictMaterialized>;
export const reviewResultSchema = reviewMutationResultSchema satisfies z.ZodType<MutationResult<Review>>;
export const auditResultSchema = auditMutationResultSchema satisfies z.ZodType<MutationResult<AuditReport>>;

const contractLiveFailureSchema = z.union([
  z.object({ kind: z.literal("refused"), refusal: refusalSchema }).strict(),
  z.object({ kind: z.literal("retry"), reason: retrySchema }).strict(),
]);

export function encodeContractLiveFailure(error: unknown): unknown | null {
  if (error instanceof KeiyakuRefused) {
    return { kind: "refused", refusal: error.refusal };
  }
  if (error instanceof KeiyakuRetry) {
    return { kind: "retry", reason: error.reason };
  }
  return null;
}

export function decodeContractLiveFailure(value: unknown): Error | null {
  const parsed = contractLiveFailureSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.kind === "refused"
    ? new KeiyakuRefused(parsed.data.refusal)
    : new KeiyakuRetry(parsed.data.reason);
}
