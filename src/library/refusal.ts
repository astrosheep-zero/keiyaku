import { z } from "zod";
import type { Retry } from "../protocol/result-reasons.js";
import type { placementReasonSchema } from "../protocol/completion.js";
import type {
  AbandonOutcome,
  AmendOutcome,
  ArcOutcome,
  BindOutcome,
  DeliverOutcome,
  DeliveryPreviewOutcome,
  ReviewOutcome,
  VerifyOutcome,
} from "./contract-outcomes.js";

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
type ContractRefusal = Extract<
  | BindOutcome
  | AmendOutcome
  | DeliverOutcome
  | VerifyOutcome
  | ReviewOutcome
  | DeliveryPreviewOutcome
  | ArcOutcome
  | AbandonOutcome,
  { kind: "refused" }
>["reason"];
export type KeiyakuRefusal =
  | ContractRefusal
  | NukeConfirmationRefusal
  | NukeConfirmationRequiredRefusal
  | z.output<typeof placementReasonSchema>;
