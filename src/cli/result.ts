import type {
  AuditReport,
  ContractId,
  Fact,
  MutationResult,
  PlacementStop,
  ReconcileReport,
  Review,
  VerificationReuse,
  VerificationStop,
} from "../index.js";
import type { KanshiReport } from "../kanshi/index.js";
import type { RegionRead, Section } from "../kanshi/index.js";
import type { Catalog } from "../index.js";
import type { RegionObservation } from "../library/region.js";

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

type MutationEnvelope = Pick<MutationResult<unknown>, "head" | "effects" | "settlement">;

export type AcceptedEnvelope = Readonly<{
  kind: "accepted";
  contract: ContractId;
  head: MutationEnvelope["head"];
  facts: readonly AcceptedFact[];
  effects: MutationEnvelope["effects"];
  settlement: MutationEnvelope["settlement"];
  lag?: readonly [Lag, ...Lag[]];
}>;

export type AcceptedBindResult = AcceptedEnvelope & Readonly<{
  verb: "bind";
  target: string | null;
  verification?: never;
  verificationReuse?: never;
  placement?: never;
  cleanup?: never;
  leak?: never;
  report?: never;
  workspace?: never;
  diff?: never;
}> & RegionObservation;

export type AcceptedAmendResult = AcceptedEnvelope & Readonly<{
  verb: "amend";
  diff: string;
  target?: never;
  verification?: never;
  verificationReuse?: never;
  placement?: never;
  cleanup?: never;
  leak?: never;
  report?: never;
  workspace?: never;
}> & RegionObservation;

export type AcceptedDeliverResult = AcceptedEnvelope & Readonly<{
  verb: "deliver";
  verification?: VerificationStop;
  verificationReuse?: VerificationReuse;
  placement?: PlacementStop;
  cleanup?: MutationResult<unknown>["cleanup"];
  leak?: MutationResult<unknown>["leak"];
  target?: never;
  overlaps?: never;
  overlapFailure?: never;
  report?: never;
  workspace?: never;
  diff?: never;
}>;

export type AcceptedReviewResult = AcceptedEnvelope & Readonly<{
  verb: "review";
  placement?: PlacementStop;
  workspace?: Review["workspace"];
  target?: never;
  verification?: never;
  verificationReuse?: never;
  cleanup?: never;
  leak?: never;
  overlaps?: never;
  overlapFailure?: never;
  report?: never;
  diff?: never;
}>;

export type AcceptedArcResult = AcceptedEnvelope & Readonly<{
  verb: "arc";
  target?: never;
  verification?: never;
  verificationReuse?: never;
  placement?: never;
  cleanup?: never;
  leak?: never;
  overlaps?: never;
  overlapFailure?: never;
  report?: never;
  workspace?: never;
  diff?: never;
}>;

export type AcceptedAbandonResult = AcceptedEnvelope & Readonly<{
  verb: "abandon";
  target?: never;
  verification?: never;
  verificationReuse?: never;
  placement?: never;
  cleanup?: never;
  leak?: never;
  overlaps?: never;
  overlapFailure?: never;
  report?: never;
  workspace?: never;
  diff?: never;
}>;

export type AcceptedAuditResult = AcceptedEnvelope & Readonly<{
  verb: "audit";
  report: AuditReport;
  cleanup?: MutationResult<unknown>["cleanup"];
  leak?: MutationResult<unknown>["leak"];
  target?: never;
  verification?: never;
  verificationReuse?: never;
  placement?: never;
  overlaps?: never;
  overlapFailure?: never;
  workspace?: never;
  diff?: never;
}>;

export type AcceptedResult =
  | AcceptedBindResult
  | AcceptedAmendResult
  | AcceptedDeliverResult
  | AcceptedReviewResult
  | AcceptedArcResult
  | AcceptedAbandonResult
  | AcceptedAuditResult;

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
