import type { ContractHead, JournalEntry, SnapshotId } from "../core/facts/types.js";
import type {
  DeliverValue,
  IntentRefusal,
  IntentRetry,
  PlacementStop,
  ReconcileReport as ProtocolReconcileReport,
  ReviewValue,
  VerificationStop,
} from "../protocol/operations.js";
import type { SettlementReport } from "../settlement/settle.js";

export type Fact = JournalEntry;
export type ActorId = string;
export type AttestationVerdict = "satisfied" | "unsatisfied";
export type Review = ReviewValue;
export type KeiyakuRefusal = IntentRefusal;
export type KeiyakuRetryReason = IntentRetry;
export type { PlacementStop, VerificationStop };

export type TopologyEffect = ProtocolReconcileReport["effects"][number];
export type Lag = ProtocolReconcileReport["lag"][number];
export type MutationResult<Value> = Readonly<{
  facts: readonly Fact[];
  head: ContractHead;
  value: Value;
  effects: readonly TopologyEffect[];
  lags: readonly Lag[];
  settlement: SettlementReport;
}>;

export class KeiyakuRefused extends Error {
  constructor(readonly refusal: KeiyakuRefusal) {
    super(`Keiyaku refused: ${refusal.kind}`);
    this.name = "KeiyakuRefused";
  }

  get code(): KeiyakuRefusal["kind"] {
    return this.refusal.kind;
  }
}

export class KeiyakuRetry extends Error {
  constructor(readonly reason: KeiyakuRetryReason) {
    super(reason.kind === "publication-failed" ? reason.diagnostic : `Keiyaku retry required: ${reason.kind}`);
    this.name = "KeiyakuRetry";
  }

  get code(): KeiyakuRetryReason["kind"] {
    return this.reason.kind;
  }
}

class DeliveryHandle {
  declare readonly verification?: DeliverValue["verification"];
  declare readonly placement?: DeliverValue["placement"];
  declare readonly leak?: DeliverValue["leak"];

  constructor(
    identity: Pick<DeliverValue, "tenderSnapshot" | "integration" | "method" | "policy">,
    private readonly readDiff: () => Promise<string | null>,
    outcomes: Partial<Pick<DeliverValue, "verification" | "placement" | "leak">> = {},
  ) {
    this.tenderSnapshot = identity.tenderSnapshot;
    this.integration = identity.integration;
    this.method = identity.method;
    this.policy = identity.policy;
    Object.assign(this, outcomes);
  }

  declare readonly tenderSnapshot: SnapshotId;
  declare readonly integration: DeliverValue["integration"];
  declare readonly method: DeliverValue["method"];
  declare readonly policy: DeliverValue["policy"];

  diff(): Promise<string | null> {
    return this.readDiff();
  }
}

export type Delivery = DeliveryHandle;
type HandleType<T extends object> = Readonly<{
  prototype: T;
  [Symbol.hasInstance](value: unknown): boolean;
}>;
function handleType<T extends object>(prototype: T, hasInstance: (value: unknown) => boolean): HandleType<T> {
  return Object.freeze({ prototype, [Symbol.hasInstance]: hasInstance });
}
export const Delivery = handleType(DeliveryHandle.prototype, (value) => value instanceof DeliveryHandle);

export function deliveryHandle(
  identity: Pick<DeliverValue, "tenderSnapshot" | "integration" | "method" | "policy">,
  readDiff: () => Promise<string | null>,
  outcomes: Partial<Pick<DeliverValue, "verification" | "placement" | "leak">> = {},
): Delivery {
  return new DeliveryHandle(identity, readDiff, outcomes);
}
