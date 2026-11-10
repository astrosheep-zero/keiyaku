import { z } from "zod";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { targetWorkspaceRefusalSchema } from "../git/target.js";
import type { IntentOutcome } from "./operations.js";
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
    reason: targetWorkspaceRefusalSchema.unwrap().shape.reason,
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
export const preparationReasonSchema = z.union([
  targetWorkspaceReasonSchema,
  z.strictObject({ kind: z.enum(["target-missing", "worktree-missing"]) }).readonly(),
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
type PreparationReason = z.output<typeof preparationReasonSchema>;

type RawReason =
  | Extract<IntentOutcome<unknown>, { kind: "refused" }>["refusal"]
  | z.output<typeof checkoutCollisionSchema>
  | Readonly<{ kind: "fork-source-missing" | "fork-source-unavailable" }>;
export type CompactReason<R> = R extends { kind: infer Kind }
  ? Kind extends string
    ? CompactReasonKind<R & { kind: Kind }, Kind>
    : never
  : never;
type CompactReasonKind<R, Kind extends string> = Kind extends "target-workspace-unavailable"
  ? Omit<R, "contractId"> & Readonly<{ targetContractId: R extends { contractId: infer Id } ? Id : never }>
  : Kind extends "integration-failed"
    ? Exclude<z.output<typeof integrationProblemSchema>, { kind: "integration-unsupported" }>
    : R;

/** Project a reason once at the native owner, retaining only independent subjects. */
export function compactReason<R extends RawReason>(reason: R): CompactReason<R>;
export function compactReason(reason: RawReason): CompactReason<RawReason> {
  switch (reason.kind) {
    case "target-workspace-unavailable":
      return { kind: reason.kind, targetContractId: reason.contractId, reason: reason.reason };
    case "integration-failed":
      if (reason.reason === "conflict") {
        if (reason.conflictPaths === undefined) throw new Error("integration conflict requires its witnessed paths");
        return { kind: "integration-conflict", targetHead: reason.targetHead, conflictPaths: reason.conflictPaths };
      }
      return { kind: reason.reason, targetHead: reason.targetHead };
    default:
      return reason;
  }
}

/** Delivery preparation judges only mechanical refusal; conflicts and checkout judgement never reach it. */
export function compactPreparationReason(
  reason: import("./operations.js").MechanicalPreparationRefusal,
): PreparationReason {
  return compactReason(reason);
}
