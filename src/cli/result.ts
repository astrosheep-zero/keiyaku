import type {
  AuditReport,
  ChangeId,
  ContractId,
  Fact,
  MutationResult,
  PlacementStop,
  ReconcileReport,
  RegionOverlap,
  Review,
  SettlementReport,
  SnapshotId,
  VerificationReuse,
  VerificationStop,
} from "../index.js";
import type { KanshiReport } from "../kanshi/index.js";
import type { RegionRead, Section } from "../kanshi/index.js";
import type { Catalog } from "../index.js";

export type BindDraftReceipt = Readonly<
  | { path: string; warning?: string }
  | { path?: never; warning: string }
>;

export type Effect = ReconcileReport["effects"][number];

export type AcceptedFact = Readonly<{
  contract: ContractId;
  entry: string;
  kind: Fact["kind"];
}>;

export type Lag = ReconcileReport["lag"][number];

export type DiffUnavailable = Readonly<{
  reason: "git-unavailable";
  integrationSnapshot: SnapshotId;
  changeId: ChangeId;
}>;

export type AcceptedResult = Readonly<{
  kind: "accepted";
  verb: string;
  contract: ContractId;
  head: string | null;
  facts: readonly AcceptedFact[];
  effects: readonly Effect[];
  settlement: SettlementReport;
  target?: string | null;
  verification?: VerificationStop;
  verificationReuse?: VerificationReuse;
  placement?: PlacementStop;
  cleanup?: MutationResult<unknown>["cleanup"];
  leak?: MutationResult<unknown>["leak"];
  overlaps?: readonly RegionOverlap[];
  overlapFailure?: string;
  report?: AuditReport;
  workspace?: Review["workspace"];
  diff?: string | DiffUnavailable;
  lag?: readonly Lag[];
}>;

export type RefusedResult = Readonly<{
  kind: "refused";
  verb: string;
  contract?: ContractId;
  refusal: unknown;
  draft?: BindDraftReceipt;
}>;

export type RetryResult = Readonly<{
  kind: "retry";
  verb: string;
  contract?: ContractId;
  detail: unknown;
}>;

export type ObservationResult = Readonly<{
  kind: "observation";
  command: string;
  [key: string]: unknown;
}>;

export type GuidanceResult = Readonly<{
  kind: "guidance";
  contract: ContractId;
  guidance: string;
}>;

export type StatusResult = Readonly<{
  kind: "status";
  report: KanshiReport;
  selection: "world" | "contract";
}>;

export type RegionResult = Readonly<{ kind: "region"; region: Section<RegionRead> }>;

export type CatalogResult = Readonly<{ kind: "catalog"; catalog: Catalog }>;

export type InvocationResult = AcceptedResult | RefusedResult | RetryResult | ObservationResult | GuidanceResult | StatusResult | RegionResult | CatalogResult;
