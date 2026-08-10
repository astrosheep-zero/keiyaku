import type {
  AuditReport,
  ChangeId,
  ContractId,
  Fact,
  FailedReconcileReport,
  PlacementStop,
  ReconcileReport,
  RegionOverlap,
  SnapshotId,
  VerificationStop,
} from "../index.js";
import type { KanshiReport } from "../kanshi/index.js";

export type Effect = ReconcileReport["effects"][number];

export type AcceptedFact = Readonly<{
  contract: ContractId;
  entry: string;
  kind: Fact["kind"];
}>;

export type Lag = ReconcileReport["lag"][number];

export type DiffUnavailable = Readonly<{
  reason: "transport-unavailable";
  snapshotId: SnapshotId;
  changeId: ChangeId;
}>;

export type AcceptedResult = Readonly<{
  kind: "accepted";
  verb: string;
  contract: ContractId;
  head: string | null;
  facts: readonly AcceptedFact[];
  effects: readonly Effect[];
  verification?: VerificationStop;
  placement?: PlacementStop;
  leak?: NonNullable<AuditReport["leak"]>;
  overlaps?: readonly RegionOverlap[];
  overlapFailure?: string;
  report?: AuditReport;
  diff?: string | DiffUnavailable;
  lag?: readonly Lag[];
}>;

export type RefusedResult = Readonly<{
  kind: "refused";
  verb: string;
  contract?: ContractId;
  refusal: unknown;
}>;

export type RetryResult = Readonly<{
  kind: "retry";
  verb: string;
  contract?: ContractId;
  detail: unknown;
}>;

export type FailedResult = Readonly<{
  kind: "failed";
  verb: string;
  contract: ContractId;
  head: string | null;
  facts: readonly AcceptedFact[];
  effects: readonly Effect[];
  lag?: readonly Lag[];
  failure: FailedReconcileReport["failure"];
}>;

export type ObservationResult = Readonly<{
  kind: "observation";
  command: string;
  [key: string]: unknown;
}>;

export type StatusResult = Readonly<{ kind: "status"; report: KanshiReport }>;

export type InvocationResult = AcceptedResult | RefusedResult | RetryResult | FailedResult | ObservationResult | StatusResult;
