import type { ContractId, JournalEntry, SnapshotId } from "../core/facts/types.js";
import type { ContractFileEffect, ContractFileLag } from "../contract-worktree.js";
import type { ReconcileReport as ProtocolReconcileReport } from "../protocol/reconcile.js";
import type { Dispatch } from "../dispatch/index.js";
import type { Gate, WorktreeHooks } from "./configuration.js";
import type { AmendRegionObservation, RegionObservation } from "./region.js";
import type { Repo } from "./repo.js";
import type { MutationResult } from "./mutation.js";
import type { SettlementReport } from "../settlement/settle.js";
import type { Keiyaku, AttestationVerdict } from "./contract.js";
import type { TaskId } from "../task/identity.js";
import type { ContractWorkspaceLocation } from "../workspace-place.js";

export type BindResult = Readonly<
  Omit<MutationResult<Keiyaku>, "value"> & {
    keiyaku: Keiyaku;
    workspace?: ContractWorkspaceLocation;
  } & RegionObservation
>;
export type Fact = JournalEntry;
export type ContractHistoryEvent =
  | Readonly<{ source: "journal"; fact: Fact }>
  | Readonly<{ source: "dispatch"; dispatch: Dispatch }>;
export type ContractHistory = Readonly<{
  id: ContractId;
  state: SnapshotId;
  events: readonly ContractHistoryEvent[];
}>;
export type TopologyEffect = ProtocolReconcileReport["effects"][number] | ContractFileEffect;
export type Lag = ProtocolReconcileReport["lag"][number] | ContractFileLag;
export type AmendResult = Readonly<MutationResult<void> & { documentDiff: string }> & AmendRegionObservation;
export type ReconcileReport = Readonly<{
  effects: readonly (ProtocolReconcileReport["effects"][number] | ContractFileEffect)[];
  lag: readonly (ProtocolReconcileReport["lag"][number] | ContractFileLag)[];
  settlement: SettlementReport;
}>;

export type MarkdownBindInput = Readonly<{
  repo: Repo;
  markdown: string;
  task?: TaskId;
  target?: string;
  workspace?: "worktree";
  actor?: string;
  after?: readonly ContractId[];
  gates?: readonly Gate[];
  hooks?: WorktreeHooks;
}>;
export type ForkBindInput = Readonly<{
  repo: Repo;
  forkOf: ContractId;
  target?: string;
  workspace?: "worktree";
  actor?: string;
  hooks?: WorktreeHooks;
}>;
export type BindInput = MarkdownBindInput | ForkBindInput;
type ActorOptions = Readonly<{ actor?: string; hooks?: WorktreeHooks }>;
export type LocalContractComposition = Readonly<{
  actor?: string;
  hooks?: WorktreeHooks;
  requireBranchesToBeUpToDate?: boolean;
}>;

export type AmendInput = ActorOptions &
  Readonly<{
    markdown?: string;
    after?: readonly ContractId[];
    gates?: readonly Gate[];
  }>;
export type ArcInput = ActorOptions & Readonly<{ markdown: string }>;
export type ContractListInput = Readonly<{ repo: Repo }>;
export type ContractObservationInput = Readonly<{ repo: Repo; id: ContractId }>;
export type KeiyakuOfInput = Readonly<{ repo: Repo; id: ContractId }>;
export type ReviewInput = Readonly<{ verdict: AttestationVerdict; summary?: string }>;
export type AbandonInput = ActorOptions & Readonly<{ note?: string }>;
export type DeliverInput = Readonly<{
  message?: string;
  includeDirty?: boolean;
  materializeConflict?: boolean;
  signal?: AbortSignal;
}>;
