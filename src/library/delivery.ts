import { z } from "zod";
import type { ChangeId, DeliverData } from "../core/facts/types.js";
import { snapshotIdSchema, changeIdSchema } from "../git/identity.js";
import {
  compactPlacement,
  placedSchema,
  placementStopSchema,
  type CompletionEvidence,
} from "../protocol/completion.js";
import type { DeliverLeading } from "../protocol/deliver.js";
import { continuationReportSchema, type ContinuationReport } from "./continuation.js";

export const deliverPlacementSchema = z.union([
  placedSchema.unwrap().omit({ integration: true }).readonly(),
  placementStopSchema,
]);
export const deliveredValueSchema = z
  .strictObject({
    candidate: snapshotIdSchema,
    integration: snapshotIdSchema,
    contentId: changeIdSchema,
    admission: z.literal("reused").exactOptional(),
    placement: deliverPlacementSchema.exactOptional(),
    previousContentId: changeIdSchema.exactOptional(),
    continuation: continuationReportSchema.exactOptional(),
  })
  .readonly();
export const deliverySchema = deliveredValueSchema.nullable();
export type DeliveryValue = z.output<typeof deliveredValueSchema>;
export type Delivery = DeliveryValue;

/** Protocol custody only; ordinary public delivery results never expose this carrier. */
export type RawDeliveryValue = DeliverData &
  CompletionEvidence &
  Readonly<{
    leading: DeliverLeading;
    previousContentId?: ChangeId;
    continuation?: ContinuationReport;
  }>;
export function compactDelivery(
  delivery: DeliverData &
    CompletionEvidence &
    Partial<Pick<RawDeliveryValue, "leading" | "previousContentId" | "continuation">>,
): DeliveryValue {
  const observed = compactPlacement(delivery);
  const placement =
    observed?.kind === "placed" ? (({ integration: _integration, ...rest }) => rest)(observed) : observed;
  const continuation = delivery.continuation;
  return {
    candidate: delivery.tenderSnapshot,
    integration: delivery.completion?.integration ?? delivery.integration.snapshot,
    contentId: delivery.integration.changeId,
    ...(delivery.leading?.kind === "already-admitted" ? { admission: "reused" as const } : {}),
    ...(placement === undefined ? {} : { placement }),
    ...(delivery.previousContentId === undefined ? {} : { previousContentId: delivery.previousContentId }),
    ...(continuation === undefined || (continuation.claimed === undefined && continuation.stopped === undefined)
      ? {}
      : { continuation }),
  };
}
