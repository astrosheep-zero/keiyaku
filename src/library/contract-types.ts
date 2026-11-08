import type { ActorId, AttestationData, ContractId, JournalEntry, SnapshotId } from "../core/facts/types.js";
import type { Dispatch } from "../dispatch/index.js";
import type { ContractBoard, ContractRow } from "../protocol/read/status.js";
import type { Settings } from "../settings.js";
import type { DebtId } from "../debt/identity.js";

/** Public gate words remain ordinary strings; private policy interprets them. */
export type Gate = string;

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
  markdown: string;
  debt?: DebtId;
  /** A literal target branch; `null` is deliberately targetless; omitted is the Repo worktree's current branch. */
  target?: string | null;
  workspace?: "worktree";
  actor?: string;
  after?: readonly ContractId[];
  gates?: readonly string[];
}>;
type ForkBindInput = Readonly<{
  forkOf: ContractId;
  /** A literal target branch; `null` clears the source target; omitted inherits it. */
  target?: string | null;
  workspace?: "worktree";
  actor?: string;
}>;
export type BindInput = MarkdownBindInput | ForkBindInput;
type ActorOptions = Readonly<{ actor?: string }>;
/** Contract-local composition: one captured Settings selection and the operation actor. */
export type KeisOptions = Readonly<{
  settings?: Settings;
  actor?: ActorId;
}>;

export type AmendInput = ActorOptions &
  Readonly<{
    markdown?: string;
    after?: readonly ContractId[];
    gates?: readonly string[];
  }>;
export type ArcInput = ActorOptions & Readonly<{ markdown: string }>;
export type ContractListInput = Readonly<{ limit?: number }>;
export type ContractList = Omit<ContractBoard, "rows"> & Readonly<{ rows: readonly ContractRow[]; hasMore: boolean }>;
export type ContractObservationInput = Readonly<{ id: ContractId }>;
export type ContractResolveInput = Readonly<{ selector?: string; cwd?: string }>;
export type ContractSelectorRefusal =
  | Readonly<{ kind: "invalid-selector"; selector: string; diagnostic: string }>
  | Readonly<{ kind: "redundant-short-selector"; selector: string }>
  | Readonly<{ kind: "unknown-short-selector"; selector: string }>
  | Readonly<{ kind: "ambiguous-selector"; selector: string }>
  | Readonly<{ kind: "ambiguous-selector"; cwd: string }>
  | Readonly<{ kind: "no-contextual-match"; cwd: string }>;
export type ContractResolution =
  | Readonly<{ kind: "resolved"; id: ContractId }>
  | Readonly<{ kind: "refused"; refusal: ContractSelectorRefusal }>;
export type ReviewInput = ActorOptions &
  Readonly<{ verdict: AttestationData["verdict"]; summary?: string; signal?: AbortSignal }>;
export type AbandonInput = ActorOptions & Readonly<{ note?: string }>;
export type VerifyInput = Readonly<{ index?: number; includeDirty?: boolean; signal?: AbortSignal }>;
export type DeliverInput = Readonly<{
  message?: string;
  includeDirty?: boolean;
  materializeConflict?: boolean;
  overwrite?: boolean;
  signal?: AbortSignal;
}>;
