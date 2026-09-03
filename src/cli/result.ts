import type {
  AuditReport,
  ContractHistory,
  ContractId,
  ContinuationReport,
  Delivery,
  Fact,
  IntegrationConflictMaterialized,
  MutationResult,
  PlacementStop,
  ReconcileReport,
  Review,
  VerificationReuse,
  VerificationStop,
} from "../index.js";
import type { KanshiReport } from "../kanshi/index.js";
import type { AkumaObservation } from "../index.js";
import type { RegionRead, Section } from "../kanshi/index.js";
import type { Catalog } from "../index.js";
import type { AmendRegionObservation, RegionObservation } from "../library/region.js";
import type { NukeResult } from "../index.js";

export type BindDraftReceipt = Readonly<{ path: string; warning?: string } | { path?: never; warning: string }>;

export type Effect = ReconcileReport["effects"][number];

type AcceptedFactEnvelope = Readonly<{
  contract: ContractId;
  entry: string;
}>;

export type AcceptedFact =
  | (AcceptedFactEnvelope &
      Readonly<{
        kind: Exclude<Fact["kind"], "reintegrated">;
        data?: never;
      }>)
  | (AcceptedFactEnvelope &
      Readonly<{
        kind: "reintegrated";
        data: Extract<Fact, { kind: "reintegrated" }>["data"];
      }>);

export type Lag = ReconcileReport["lag"][number];

type MutationEnvelope = Pick<MutationResult<unknown>, "head" | "settlementLags" | "recoverySnapshot" | "seatClose">;

export type AcceptedEnvelope = Readonly<{
  kind: "accepted";
  contract: ContractId;
  head: MutationEnvelope["head"];
  facts: readonly AcceptedFact[];
  settlementLags: MutationEnvelope["settlementLags"];
  recoverySnapshot?: MutationEnvelope["recoverySnapshot"];
  lag?: readonly [Lag, ...Lag[]];
  seatClose?: MutationEnvelope["seatClose"];
}>;

export type AcceptedBindResult = AcceptedEnvelope &
  Readonly<{
    verb: "bind";
    workspace?: Readonly<{ kind: "worktree"; path: string }>;
    target: string | null;
    completion?: never;
    verification?: never;
    verificationReuse?: never;
    verificationSummary?: never;
    placement?: never;
    continuation?: never;
    cleanup?: never;
    leak?: never;
    report?: never;
    diff?: never;
    verificationVerdict?: never;
    verdict?: never;
    chapter?: never;
    note?: never;
  }> &
  RegionObservation;

export type AcceptedAmendResult = AcceptedEnvelope &
  Readonly<{
    verb: "amend";
    diff: string;
    target?: never;
    completion?: never;
    verification?: never;
    verificationReuse?: never;
    verificationSummary?: never;
    placement?: never;
    continuation?: never;
    cleanup?: never;
    leak?: never;
    report?: never;
    workspace?: never;
    verificationVerdict?: never;
    verdict?: never;
    chapter?: never;
    note?: never;
  }> &
  AmendRegionObservation;

export type AcceptedDeliverResult = AcceptedEnvelope &
  Readonly<{
    verb: "deliver";
    tenderSnapshot?: Delivery["tenderSnapshot"];
    integration?: Readonly<Pick<Delivery["integration"], "changeId">>;
    completion?: Delivery["completion"];
    verificationVerdict?: "satisfied" | "unsatisfied";
    verification?: VerificationStop;
    verificationReuse?: VerificationReuse;
    verificationSummary?: string;
    placement?: PlacementStop;
    continuation?: ContinuationReport;
    cleanup?: MutationResult<unknown>["cleanup"];
    leak?: MutationResult<unknown>["leak"];
    target?: never;
    overlaps?: never;
    overlapFailure?: never;
    report?: never;
    workspace?: never;
    diff?: never;
    verdict?: never;
    chapter?: never;
    note?: never;
  }>;

export type AcceptedReviewResult = AcceptedEnvelope &
  Readonly<{
    verb: "review";
    verdict: "satisfied" | "unsatisfied";
    completion?: Delivery["completion"];
    verificationVerdict?: "satisfied" | "unsatisfied";
    verification?: VerificationStop;
    verificationReuse?: VerificationReuse;
    verificationSummary?: string;
    placement?: PlacementStop;
    continuation?: ContinuationReport;
    workspace?: Review["workspace"];
    cleanup?: MutationResult<unknown>["cleanup"];
    leak?: MutationResult<unknown>["leak"];
    target?: never;
    overlaps?: never;
    overlapFailure?: never;
    report?: never;
    diff?: never;
    chapter?: never;
    note?: never;
  }>;

export type AcceptedArcResult = AcceptedEnvelope &
  Readonly<{
    verb: "arc";
    chapter: Readonly<{ seq: number; title: string }>;
    target?: never;
    completion?: never;
    verification?: never;
    verificationReuse?: never;
    verificationSummary?: never;
    placement?: never;
    continuation?: never;
    cleanup?: never;
    leak?: never;
    overlaps?: never;
    overlapFailure?: never;
    report?: never;
    workspace?: never;
    diff?: never;
    verificationVerdict?: never;
    verdict?: never;
    note?: never;
  }>;

export type AcceptedAbandonResult = AcceptedEnvelope &
  Readonly<{
    verb: "abandon";
    note?: string;
    target?: never;
    completion?: never;
    verification?: never;
    verificationReuse?: never;
    verificationSummary?: never;
    placement?: never;
    continuation?: never;
    cleanup?: never;
    leak?: never;
    overlaps?: never;
    overlapFailure?: never;
    report?: never;
    workspace?: never;
    diff?: never;
    verificationVerdict?: never;
    verdict?: never;
    chapter?: never;
  }>;

export type AcceptedAuditResult = AcceptedEnvelope &
  Readonly<{
    verb: "audit";
    report: AuditReport;
    cleanup?: MutationResult<unknown>["cleanup"];
    leak?: MutationResult<unknown>["leak"];
    target?: never;
    completion?: never;
    verification?: never;
    verificationReuse?: never;
    verificationSummary?: never;
    placement?: never;
    continuation?: never;
    overlaps?: never;
    overlapFailure?: never;
    workspace?: never;
    diff?: never;
    verificationVerdict?: never;
    verdict?: never;
    chapter?: never;
    note?: never;
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

export type StatusSetResult = Readonly<{
  kind: "status-set";
  entries: readonly (
    | Readonly<{ selector: string; kind: "contract"; report: KanshiReport }>
    | Readonly<{ selector: string; kind: "akuma"; status: AkumaObservation; alias?: string }>
  )[];
}>;

export type RegionResult = Readonly<{ kind: "region"; region: Section<RegionRead> }>;

export type CatalogResult = Readonly<{ kind: "catalog"; catalog: Catalog }>;

export type ContractHistoryResult = Readonly<{ kind: "contract-history"; history: ContractHistory }>;
export type NukeInvocationResult = Readonly<{ kind: "nuke"; result: NukeResult }>;

export type InvocationResult =
  | AcceptedResult
  | RefusedResult
  | RetryResult
  | ObservationResult
  | GuidanceResult
  | StatusResult
  | StatusSetResult
  | RegionResult
  | CatalogResult
  | ContractHistoryResult
  | NukeInvocationResult
  | IntegrationConflictMaterialized;
