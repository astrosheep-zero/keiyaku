import { z } from "zod";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import type { IntegrationPreparationRefusal } from "../git/integration.js";
import { targetWorkspaceCauseSchema, type TargetWorkspaceRefusal } from "../git/target.js";
import type { MechanicalPreparationRefusal } from "./deliver.js";
import type { ProtocolTerminal } from "./run.js";

const paths = z.array(z.string().min(1)).min(1).readonly();
export const executionIssueSchema = z
  .strictObject({
    kind: z.literal("execution-stopped"),
    reason: z.enum(["cancelled", "failed"]),
    diagnostic: z.string().min(1),
  })
  .readonly();
export const activeReasonSchema = z.strictObject({ kind: z.enum(["contract-missing", "terminal"]) }).readonly();
export const declarationReasonSchema = z
  .strictObject({ kind: z.literal("verification-declaration-invalid") })
  .readonly();
export const targetLifecycleReasonSchema = z
  .strictObject({
    kind: z.enum(["target-contract-missing", "target-contract-terminal"]),
    targetContractId: contractIdSchema,
  })
  .readonly();
export const targetWorkspaceReasonSchema = z
  .strictObject({
    kind: z.literal("target-workspace-unavailable"),
    targetContractId: contractIdSchema,
    reason: targetWorkspaceCauseSchema,
  })
  .readonly();
export const retrySchema = z.union([
  z.strictObject({ kind: z.literal("retry"), reason: z.enum(["exhausted", "collision"]) }).readonly(),
  z
    .strictObject({ kind: z.literal("retry"), reason: z.literal("publication-failed"), diagnostic: z.string().min(1) })
    .readonly(),
]);
export type Retry = z.output<typeof retrySchema>;
export function compactRetry(reason: ProtocolTerminal): Retry {
  return reason.kind === "publication-failed"
    ? { kind: "retry", reason: reason.kind, diagnostic: reason.diagnostic }
    : { kind: "retry", reason: reason.kind };
}
export const integrationProblemSchema = z.union([
  z
    .strictObject({ kind: z.enum(["not-based-on-target", "unrelated-histories"]), targetHead: snapshotIdSchema })
    .readonly(),
  z
    .strictObject({ kind: z.literal("integration-conflict"), targetHead: snapshotIdSchema, conflictPaths: paths })
    .readonly(),
  z.strictObject({ kind: z.literal("integration-unsupported") }).readonly(),
]);
export const worktreeMissingReasonSchema = z.strictObject({ kind: z.literal("worktree-missing") }).readonly();
export const preparationReasonSchema = z.union([
  targetWorkspaceReasonSchema,
  z.strictObject({ kind: z.literal("target-missing") }).readonly(),
  worktreeMissingReasonSchema,
  z
    .strictObject({
      kind: z.literal("dirty-workspace"),
      paths: paths.exactOptional(),
      submodules: paths.exactOptional(),
    })
    .readonly(),
  integrationProblemSchema,
]);
export const checkoutCollisionSchema = z
  .strictObject({
    kind: z.literal("checkout-not-followable"),
    target: z.string().min(1),
    path: z.string().min(1),
    paths,
  })
  .readonly();

type IntegrationFailure = Extract<IntegrationPreparationRefusal, { kind: "integration-failed" }>;
type TargetWorkspaceReason = z.output<typeof targetWorkspaceReasonSchema>;
type IntegrationReason = Exclude<z.output<typeof integrationProblemSchema>, { kind: "integration-unsupported" }>;

/** Only the two reasons whose evidence changes at the public boundary. */
export function compactReason(reason: TargetWorkspaceRefusal): TargetWorkspaceReason;
export function compactReason(
  reason: TargetWorkspaceRefusal | IntegrationFailure,
): TargetWorkspaceReason | IntegrationReason;
export function compactReason(
  reason: TargetWorkspaceRefusal | IntegrationFailure,
): TargetWorkspaceReason | IntegrationReason {
  if (reason.kind === "target-workspace-unavailable")
    return { kind: reason.kind, targetContractId: reason.contractId, reason: reason.reason };
  if (reason.reason === "conflict")
    return { kind: "integration-conflict", targetHead: reason.targetHead, conflictPaths: reason.conflictPaths };
  return { kind: reason.reason, targetHead: reason.targetHead };
}

export function compactPreparationReason(
  reason: MechanicalPreparationRefusal,
): z.output<typeof preparationReasonSchema> {
  return reason.kind === "target-workspace-unavailable" || reason.kind === "integration-failed"
    ? compactReason(reason)
    : reason;
}
