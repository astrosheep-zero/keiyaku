import { z } from "zod";
import type { SnapshotId } from "../core/facts/types.js";
import { completionEvidenceSchema } from "../protocol/completion.js";
import { deliverLeadingSchema } from "../protocol/deliver.js";
import { deliverDataSchema, deliveryDiffOperation, type RepositoryScope } from "../protocol/operations.js";
import { continuationReportSchema } from "./continuation.js";

export const deliveryValueSchema = completionEvidenceSchema
  .extend({
    ...deliverDataSchema.shape,
    leading: deliverLeadingSchema,
    continuation: continuationReportSchema.optional(),
  })
  .strict();
export type DeliveryValue = z.infer<typeof deliveryValueSchema>;

class DeliveryHandle {
  declare readonly leading?: DeliveryValue["leading"];
  declare readonly completion?: DeliveryValue["completion"];
  declare readonly verification?: DeliveryValue["verification"];
  declare readonly verificationReuse?: DeliveryValue["verificationReuse"];
  declare readonly verificationSubject?: DeliveryValue["verificationSubject"];
  declare readonly verificationSummary?: DeliveryValue["verificationSummary"];
  declare readonly placement?: DeliveryValue["placement"];
  declare readonly continuation?: DeliveryValue["continuation"];
  declare readonly tenderSnapshot: SnapshotId;
  declare readonly integration: DeliveryValue["integration"];
  declare readonly method: DeliveryValue["method"];
  declare readonly policy: DeliveryValue["policy"];

  constructor(
    identity: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy">,
    private readonly readDiff: () => Promise<string | null>,
    outcomes: Partial<
      Pick<
        DeliveryValue,
        | "leading"
        | "completion"
        | "verification"
        | "verificationReuse"
        | "verificationSubject"
        | "verificationSummary"
        | "placement"
        | "continuation"
      >
    > = {},
  ) {
    this.tenderSnapshot = identity.tenderSnapshot;
    this.integration = identity.integration;
    this.method = identity.method;
    this.policy = identity.policy;
    Object.assign(this, outcomes);
    Object.defineProperty(this, "readDiff", { value: readDiff, enumerable: false });
    Object.freeze(this);
  }

  diff(): Promise<string | null> {
    return this.readDiff();
  }
}

export type Delivery = DeliveryHandle;
type HandleType<T extends object> = Readonly<{
  prototype: T;
  [Symbol.hasInstance](value: unknown): boolean;
}>;

export const Delivery: HandleType<DeliveryHandle> = Object.freeze({
  prototype: DeliveryHandle.prototype,
  [Symbol.hasInstance]: (value: unknown) => value instanceof DeliveryHandle,
});

export function deliveryHandle(
  delivery: DeliveryValue,
  readDiff: () => Promise<string | null>,
): Delivery & DeliveryValue;
export function deliveryHandle(
  delivery: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy"> & Partial<DeliveryValue>,
  readDiff: () => Promise<string | null>,
): Delivery;
export function deliveryHandle(
  delivery: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy"> &
    Partial<
      Pick<
        DeliveryValue,
        | "leading"
        | "completion"
        | "verification"
        | "verificationReuse"
        | "verificationSubject"
        | "verificationSummary"
        | "placement"
        | "continuation"
      >
    >,
  readDiff: () => Promise<string | null>,
): Delivery {
  return new DeliveryHandle(delivery, readDiff, delivery);
}

export function deliveryForContract(scope: RepositoryScope, delivery: DeliveryValue): Delivery & DeliveryValue;
export function deliveryForContract(
  scope: RepositoryScope,
  delivery: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy">,
): Delivery;
export function deliveryForContract(
  scope: RepositoryScope,
  delivery: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy">,
): Delivery {
  return deliveryHandle(delivery, () =>
    deliveryDiffOperation({
      scope,
      integrationPredecessor: delivery.integration.predecessor,
      integrationSnapshot: delivery.integration.snapshot,
    }),
  );
}
