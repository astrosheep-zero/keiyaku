import { z } from "zod";
import {
  activeReasonSchema,
  declarationReasonSchema,
  targetLifecycleReasonSchema,
  targetWorkspaceReasonSchema,
  preparationReasonSchema,
  type Retry,
  compactReason,
} from "../protocol/result-reasons.js";
import { placementReasonSchema } from "../protocol/completion.js";
import type {
  deliveryPreparationRefusalSchema,
  deliverRefusalSchema,
  deliverConflictRefusalSchema,
  verificationDeclarationRefusalSchema,
} from "../protocol/operations.js";

export const nukeConfirmationRefusalSchema = z.strictObject({
  kind: z.literal("nuke-confirmation-mismatch"),
  world: z.string().min(1),
  confirmation: z.string(),
});
export type NukeConfirmationRefusal = z.output<typeof nukeConfirmationRefusalSchema>;
export const nukeConfirmationRequiredRefusalSchema = z.strictObject({
  kind: z.literal("nuke-confirmation-required"),
  world: z.string().min(1),
});
export type NukeConfirmationRequiredRefusal = z.output<typeof nukeConfirmationRequiredRefusalSchema>;
export type KeiyakuRetryReason = Retry;
export type OperationRetries = {
  readonly bind: KeiyakuRetryReason;
  readonly amend: KeiyakuRetryReason;
  readonly deliver: KeiyakuRetryReason;
  readonly verify: never;
  readonly review: KeiyakuRetryReason;
  readonly "deliver-preview": never;
  readonly arc: KeiyakuRetryReason;
  readonly abandon: KeiyakuRetryReason;
};
const previewRefusalSchema = z.union([activeReasonSchema, targetLifecycleReasonSchema, declarationReasonSchema]);
export const operationRefusalSchemas = {
  bind: z.union([
    z
      .strictObject({
        kind: z.enum([
          "contract-exists",
          "invalid-after",
          "unknown-prerequisite",
          "invalid-target",
          "target-missing",
          "unborn-head",
          "target-contract-self",
          "fork-source-missing",
          "fork-source-unavailable",
          "fork-source-moved",
        ]),
      })
      .readonly(),
    targetLifecycleReasonSchema,
    targetWorkspaceReasonSchema,
    declarationReasonSchema,
  ]),
  amend: z.union([
    z
      .strictObject({
        kind: z.enum(["contract-missing", "terminal", "terms-moved", "unknown-prerequisite", "cyclic-prerequisite"]),
      })
      .readonly(),
    declarationReasonSchema,
  ]),
  deliver: z.union([
    previewRefusalSchema,
    preparationReasonSchema,
    z.strictObject({ kind: z.literal("merge-state-present"), worktreePath: z.string().min(1) }).readonly(),
  ]),
  verify: z.union([
    previewRefusalSchema,
    preparationReasonSchema,
    z.strictObject({ kind: z.literal("verification-not-selected") }).readonly(),
    z
      .strictObject({ kind: z.literal("verification-index-out-of-range"), total: z.number().int().nonnegative() })
      .readonly(),
  ]),
  review: z.union([
    activeReasonSchema,
    z.strictObject({ kind: z.literal("worktree-missing") }).readonly(),
    z
      .strictObject({ kind: z.literal("dirty-submodules"), paths: z.array(z.string().min(1)).min(1).readonly() })
      .readonly(),
  ]),
  "deliver-preview": previewRefusalSchema,
  arc: activeReasonSchema,
  abandon: activeReasonSchema,
} as const;
export type OperationRefusals = {
  readonly [K in keyof typeof operationRefusalSchemas]: z.output<(typeof operationRefusalSchemas)[K]>;
};
export type ForkSourceRefusal = Readonly<{
  kind: "fork-source-missing" | "fork-source-unavailable" | "fork-source-moved";
}>;
export type KeiyakuRefusal =
  | OperationRefusals[keyof OperationRefusals]
  | NukeConfirmationRefusal
  | NukeConfirmationRequiredRefusal
  | z.output<typeof placementReasonSchema>;
type RawDeliverRefusal =
  | z.output<typeof deliverRefusalSchema>
  | z.output<typeof deliveryPreparationRefusalSchema>
  | z.output<typeof deliverConflictRefusalSchema>
  | z.output<typeof verificationDeclarationRefusalSchema>;
export function compactDeliverRefusal(reason: RawDeliverRefusal): OperationRefusals["deliver"] {
  return compactReason(reason);
}
export function compactPreviewRefusal(
  reason: z.output<typeof deliverRefusalSchema> | z.output<typeof verificationDeclarationRefusalSchema>,
): OperationRefusals["deliver-preview"] {
  return compactReason(reason);
}
export function compactVerifyRefusal(
  reason:
    | z.output<typeof deliverRefusalSchema>
    | import("../protocol/operations.js").MechanicalPreparationRefusal
    | z.output<typeof verificationDeclarationRefusalSchema>
    | z.output<typeof import("../protocol/operations.js").verifyRefusalSchema>,
): OperationRefusals["verify"] {
  return compactReason(reason);
}
