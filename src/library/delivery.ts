import { z } from "zod";
import { placedSchema, placementStopSchema } from "../protocol/completion.js";
import { deliveryIdentitySchema } from "../protocol/deliver.js";
import { continuationReportSchema } from "./continuation.js";

export const deliverPlacementSchema = z.union([
  placedSchema.unwrap().omit({ integration: true }).readonly(),
  placementStopSchema,
]);
export const deliveredValueSchema = deliveryIdentitySchema
  .unwrap()
  .extend({
    placement: deliverPlacementSchema.exactOptional(),
    continuation: continuationReportSchema.exactOptional(),
  })
  .readonly();
export const deliverySchema = deliveredValueSchema.nullable();
export type DeliveryValue = z.output<typeof deliveredValueSchema>;
export type Delivery = DeliveryValue;
