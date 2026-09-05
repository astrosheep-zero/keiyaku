import { decodeDeliverData } from "../core/facts/codec.js";
import type { SnapshotId } from "../core/facts/types.js";
import type { DeliverValue as ProtocolDeliverValue } from "../protocol/deliver.js";
import { decodeCompletionEvidence } from "../protocol/result-codec.js";
import { decodeContinuationReport, type ContinuationReport } from "./continuation.js";
import { ownerSchema } from "./result-codec.js";
import { z } from "zod";

export type DeliveryValue = ProtocolDeliverValue & Readonly<{ continuation?: ContinuationReport }>;

export function decodeDeliveryValue(value: unknown): DeliveryValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed delivery value");
  const object = value as Record<string, unknown>;
  const allowed = new Set([
    "tenderSnapshot",
    "integration",
    "method",
    "policy",
    "completion",
    "verification",
    "verificationReuse",
    "verificationSummary",
    "placement",
    "continuation",
  ]);
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error("malformed delivery value");
  const identity = decodeDeliverData({
    tenderSnapshot: object.tenderSnapshot,
    integration: object.integration,
    method: object.method,
    policy: object.policy,
  });
  const evidence = decodeCompletionEvidence({
    ...(object.completion === undefined ? {} : { completion: object.completion }),
    ...(object.verification === undefined ? {} : { verification: object.verification }),
    ...(object.verificationReuse === undefined ? {} : { verificationReuse: object.verificationReuse }),
    ...(object.verificationSummary === undefined ? {} : { verificationSummary: object.verificationSummary }),
    ...(object.placement === undefined ? {} : { placement: object.placement }),
  });
  return {
    ...identity,
    ...evidence,
    ...(object.continuation === undefined ? {} : { continuation: decodeContinuationReport(object.continuation) }),
  };
}

export const deliveryValueSchema = ownerSchema(
  decodeDeliveryValue,
  "expected delivery value",
) satisfies z.ZodType<DeliveryValue>;

class DeliveryHandle {
  declare readonly completion?: DeliveryValue["completion"];
  declare readonly verification?: DeliveryValue["verification"];
  declare readonly verificationReuse?: DeliveryValue["verificationReuse"];
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
        "completion" | "verification" | "verificationReuse" | "verificationSummary" | "placement" | "continuation"
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
