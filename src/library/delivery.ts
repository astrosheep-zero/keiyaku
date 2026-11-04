import type { z } from "zod";
import type { DeliverData, SnapshotId } from "../core/facts/types.js";
import type { CompletionEvidence } from "../protocol/completion.js";
import type { deliverLeadingSchema } from "../protocol/deliver.js";
import type { candidateContentChangeSchema } from "../protocol/operations.js";
import { deliveryDiffOperation, type RepositoryScope } from "../protocol/operations.js";
import type { ContinuationReport } from "./continuation.js";

export type DeliveryValue = DeliverData &
  CompletionEvidence &
  Readonly<{
    leading: z.infer<typeof deliverLeadingSchema>;
    contentChange?: z.infer<typeof candidateContentChangeSchema> | undefined;
    continuation?: ContinuationReport | undefined;
  }>;

class DeliveryHandle {
  declare readonly leading?: DeliveryValue["leading"];
  declare readonly contentChange?: DeliveryValue["contentChange"];
  declare readonly completion?: DeliveryValue["completion"];
  declare readonly gates?: DeliveryValue["gates"];
  declare readonly placement?: DeliveryValue["placement"];
  declare readonly continuation?: DeliveryValue["continuation"];
  declare readonly tenderSnapshot: SnapshotId;
  declare readonly note?: string;
  declare readonly integration: DeliveryValue["integration"];
  declare readonly method: DeliveryValue["method"];
  declare readonly policy: DeliveryValue["policy"];

  constructor(
    identity: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy">,
    private readonly readDiff: () => Promise<string | null>,
    outcomes: Partial<
      Pick<DeliveryValue, "leading" | "contentChange" | "completion" | "gates" | "placement" | "continuation">
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

export function deliveryForContract(scope: RepositoryScope, delivery: DeliveryValue): Delivery & DeliveryValue;
export function deliveryForContract(
  scope: RepositoryScope,
  delivery: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy">,
): Delivery;
export function deliveryForContract(
  scope: RepositoryScope,
  delivery: Pick<DeliveryValue, "tenderSnapshot" | "integration" | "method" | "policy"> &
    Partial<Pick<DeliveryValue, "leading" | "contentChange" | "completion" | "gates" | "placement" | "continuation">>,
): Delivery {
  return new DeliveryHandle(
    delivery,
    () =>
      deliveryDiffOperation({
        scope,
        integrationPredecessor: delivery.integration.predecessor,
        integrationSnapshot: delivery.integration.snapshot,
      }),
    delivery,
  );
}
