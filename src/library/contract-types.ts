import type { AttestationData, ContractId, JournalEntry, SnapshotId } from "../core/facts/types.js";
import type { Dispatch } from "../dispatch/index.js";
import type { ContractBoard, ContractRow } from "../protocol/read/status.js";
import type { Settings } from "../settings.js";
import type { TaskId } from "../task/identity.js";
import type { Repo } from "./repo.js";

export type ContractHistoryEvent =
  | Readonly<{ source: "journal"; fact: JournalEntry }>
  | Readonly<{ source: "dispatch"; dispatch: Dispatch }>;
export type ContractHistory = Readonly<{
  id: ContractId;
  state: SnapshotId;
  workspace?: Readonly<{ kind: "worktree"; path: string }>;
  events: readonly ContractHistoryEvent[];
}>;

type MarkdownBindInput = Readonly<{
  repo: Repo;
  markdown: string;
  task?: TaskId;
  target?: string;
  workspace?: "worktree";
  actor?: string;
  after?: readonly ContractId[];
  gates?: readonly string[];
}>;
type ForkBindInput = Readonly<{
  repo: Repo;
  forkOf: ContractId;
  target?: string;
  workspace?: "worktree";
  actor?: string;
}>;
export type BindInput = MarkdownBindInput | ForkBindInput;
type ActorOptions = Readonly<{ actor?: string }>;
/** Contract-local composition: one captured Settings selection and the operation actor. */
export type LocalContractComposition = Readonly<{
  settings?: Settings;
  actor?: string;
}>;

export type AmendInput = ActorOptions &
  Readonly<{
    markdown?: string;
    after?: readonly ContractId[];
    gates?: readonly string[];
  }>;
export type ArcInput = ActorOptions & Readonly<{ markdown: string }>;
export type ContractListInput = Readonly<{ repo: Repo; limit?: number }>;
export type ContractList = Omit<ContractBoard, "rows"> & Readonly<{ rows: readonly ContractRow[]; hasMore: boolean }>;
export type ContractObservationInput = Readonly<{ repo: Repo; id: ContractId }>;
export type KeiyakuSelectInput = Readonly<{ repo: Repo; id: ContractId }>;
export type ReviewInput = Readonly<{ verdict: AttestationData["verdict"]; summary?: string; signal?: AbortSignal }>;
export type AbandonInput = ActorOptions & Readonly<{ note?: string }>;
export type DeliverInput = Readonly<{
  message?: string;
  includeDirty?: boolean;
  materializeConflict?: boolean;
  overwrite?: boolean;
  signal?: AbortSignal;
}>;
