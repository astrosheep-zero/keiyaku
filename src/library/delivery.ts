import type { SnapshotId } from "../core/facts/types.js";
import type { DeliverValue } from "../protocol/deliver.js";

class DeliveryHandle {
  declare readonly completion?: DeliverValue["completion"];
  declare readonly verification?: DeliverValue["verification"];
  declare readonly verificationReuse?: DeliverValue["verificationReuse"];
  declare readonly verificationSummary?: DeliverValue["verificationSummary"];
  declare readonly placement?: DeliverValue["placement"];
  declare readonly cleanup?: DeliverValue["cleanup"];
  declare readonly leak?: DeliverValue["leak"];
  declare readonly tenderSnapshot: SnapshotId;
  declare readonly integration: DeliverValue["integration"];
  declare readonly method: DeliverValue["method"];
  declare readonly policy: DeliverValue["policy"];

  constructor(
    identity: Pick<DeliverValue, "tenderSnapshot" | "integration" | "method" | "policy">,
    private readonly readDiff: () => Promise<string | null>,
    outcomes: Partial<Pick<DeliverValue, "completion" | "verification" | "verificationReuse" | "verificationSummary" | "placement" | "cleanup" | "leak">> = {},
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

export function deliveryHandle(delivery: DeliverValue, readDiff: () => Promise<string | null>): Delivery {
  return new DeliveryHandle(delivery, readDiff, delivery);
}
