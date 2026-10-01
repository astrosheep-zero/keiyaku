import { z } from "zod";
import {
  contractIdSchema,
  intentRefusalSchema,
  activeContractRefusalSchema,
  bindRefusalSchema,
  amendRefusalSchema,
  deliverRefusalSchema,
  deliveryPreparationRefusalSchema,
  deliverConflictRefusalSchema,
  verificationDeclarationRefusalSchema,
} from "../protocol/operations.js";
import { targetInputRefusalSchema, forkSourceMovedRefusalSchema } from "../protocol/bind.js";
import { protocolTerminalSchema } from "../protocol/run.js";
import { worktreeMissingRefusalSchema, dirtyWorkspaceRefusalSchema } from "../git/tender.js";

const forkSourceUnavailableSchema = z
  .object({ kind: z.enum(["fork-source-missing", "fork-source-unavailable"]), contractId: contractIdSchema })
  .strict();
export const forkSourceRefusalSchema = z.union([forkSourceUnavailableSchema, forkSourceMovedRefusalSchema]);
export type ForkSourceRefusal = z.infer<typeof forkSourceRefusalSchema>;
export const nukeConfirmationRefusalSchema = z
  .object({
    kind: z.literal("nuke-confirmation-mismatch"),
    world: z.string().refine((value) => value.trim() !== ""),
    confirmation: z.string(),
  })
  .strict();
export type NukeConfirmationRefusal = z.infer<typeof nukeConfirmationRefusalSchema>;
export const nukeConfirmationRequiredRefusalSchema = z
  .object({ kind: z.literal("nuke-confirmation-required"), world: z.string().refine((value) => value.trim() !== "") })
  .strict();
export type NukeConfirmationRequiredRefusal = z.infer<typeof nukeConfirmationRequiredRefusalSchema>;
export const keiyakuRefusalSchema = z.union([
  intentRefusalSchema,
  forkSourceRefusalSchema,
  nukeConfirmationRefusalSchema,
  nukeConfirmationRequiredRefusalSchema,
]);
export type KeiyakuRefusal = z.infer<typeof keiyakuRefusalSchema>;
export const forwardingRetrySchema = z
  .object({ kind: z.literal("owner-reason-unavailable"), diagnostic: z.string() })
  .strict();
export const keiyakuRetryReasonSchema = z.union([protocolTerminalSchema, forwardingRetrySchema]);
export type KeiyakuRetryReason = z.infer<typeof keiyakuRetryReasonSchema>;
export const operationRetrySchemas = {
  bind: protocolTerminalSchema,
  amend: protocolTerminalSchema,
  deliver: keiyakuRetryReasonSchema,
  review: keiyakuRetryReasonSchema,
  audit: keiyakuRetryReasonSchema,
  arc: protocolTerminalSchema,
  abandon: protocolTerminalSchema,
} as const;
export type OperationRetries = {
  readonly [Operation in keyof typeof operationRetrySchemas]: z.infer<(typeof operationRetrySchemas)[Operation]>;
};
export const operationRefusalSchemas = {
  bind: z.union([
    bindRefusalSchema,
    targetInputRefusalSchema,
    forkSourceRefusalSchema,
    verificationDeclarationRefusalSchema,
  ]),
  amend: z.union([amendRefusalSchema, verificationDeclarationRefusalSchema]),
  deliver: z.union([
    deliverRefusalSchema,
    deliveryPreparationRefusalSchema,
    deliverConflictRefusalSchema,
    verificationDeclarationRefusalSchema,
  ]),
  review: z.union([activeContractRefusalSchema, worktreeMissingRefusalSchema, dirtyWorkspaceRefusalSchema]),
  audit: z.union([deliverRefusalSchema, verificationDeclarationRefusalSchema]),
  arc: activeContractRefusalSchema,
  abandon: activeContractRefusalSchema,
} as const;
export type OperationRefusals = {
  readonly [Operation in keyof typeof operationRefusalSchemas]: z.infer<(typeof operationRefusalSchemas)[Operation]>;
};
