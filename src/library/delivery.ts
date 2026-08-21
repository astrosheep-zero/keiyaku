import type { SnapshotId } from "../core/facts/types.js";
import type { DeliverValue as ProtocolDeliverValue } from "../protocol/deliver.js";
import type { ContinuationReport } from "./continuation.js";

export type DeliveryValue = ProtocolDeliverValue & Readonly<{ continuation?: ContinuationReport }>;

class DeliveryHandle {
  declare readonly completion?: DeliveryValue["completion"];
  declare readonly verification?: DeliveryValue["verification"];
  declare readonly verificationReuse?: DeliveryValue["verificationReuse"];
  declare readonly verificationSummary?: DeliveryValue["verificationSummary"];
  declare readonly placement?: DeliveryValue["placement"];
  declare readonly cleanup?: DeliveryValue["cleanup"];
  declare readonly leak?: DeliveryValue["leak"];
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
        | "completion"
        | "verification"
        | "verificationReuse"
        | "verificationSummary"
        | "placement"
        | "cleanup"
        | "leak"
        | "continuation"
      >
    > = {},
  ) {
    this.tenderSnapshot = identity.tenderSnapshot;
    this.integration = identity.integration;
    this.method = identity.method;
    this.policy = identity.policy;
    Object.assign(this, outcomes);
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

export function deliveryHandle(delivery: DeliveryValue, readDiff: () => Promise<string | null>): Delivery {
  return new DeliveryHandle(delivery, readDiff, delivery);
}
