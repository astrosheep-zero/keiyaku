import { existsSync } from "node:fs";
import type { Preparation } from "../core/decide.js";
import type { ContractCoordinates, ContractId, SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot, mintSnapshotId, type GitObjectId } from "./identity.js";
import { registeredWorktreePaths, runGit, runGitWithEnvironment, type GitRepository } from "./repository.js";
import { captureWorkspaceTree, deliveryWorktreePath } from "./workspace.js";

export type TenderCaptureCoordinates = Readonly<{
  contractId: ContractId;
  coordinates: ContractCoordinates;
}>;

export type TenderCaptureRefusal = Readonly<{
  kind: "worktree-missing";
  contractId: ContractId;
}>;

export type WorkspaceDirtyDelta = Readonly<{
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  shortStat: Readonly<{ filesChanged: number; insertions: number; deletions: number }>;
}>;

export type DirtyWorkspaceRefusal = Readonly<{
  kind: "dirty-workspace";
  contractId: ContractId;
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  submodules: readonly string[];
  shortStat: WorkspaceDirtyDelta["shortStat"];
}>;

export type TenderCapture = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  dirty: boolean;
  changes: ReturnType<typeof captureWorkspaceTree>["changes"];
}>;

function workspaceExists(repository: GitRepository, workspace: "worktree" | "here", path: string): boolean {
  return workspace === "here"
    || (existsSync(path) && registeredWorktreePaths(repository).includes(path));
}

function workspaceFor(repository: GitRepository, id: ContractId, workspace: "worktree" | "here"): string {
  return workspace === "worktree" ? deliveryWorktreePath(repository, id) : repository.effectiveCwd;
}

/** Capture the complete workspace tree through Git's private index mechanics. */
export function captureTender(
  repository: GitRepository,
  input: TenderCaptureCoordinates,
): Preparation<TenderCapture, TenderCaptureRefusal> {
  const workspace = workspaceFor(repository, input.contractId, input.coordinates.workspace);
  if (!workspaceExists(repository, input.coordinates.workspace, workspace)) {
    return { kind: "refused", refusal: { kind: "worktree-missing", contractId: input.contractId } };
  }
  return { kind: "prepared", data: captureWorkspaceTree(repository, workspace) };
}

function dirtyShortStat(repository: GitRepository, tender: TenderCapture): WorkspaceDirtyDelta["shortStat"] {
  const fields = runGit(repository, [
    "diff",
    "--numstat",
    "-z",
    gitObjectIdForSnapshot(tender.head),
    tender.tree,
  ]).toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("Git numstat output is not NUL terminated");
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (let index = 0; index < fields.length - 1; index += 1) {
    const field = fields[index]!;
    const [added, deleted, path, extra] = field.split("\t");
    if (added === undefined || deleted === undefined || path === undefined || extra !== undefined) {
      throw new Error("Git numstat output is malformed");
    }
    if (path.length === 0) {
      if (fields[index + 1] === undefined || fields[index + 2] === undefined) {
        throw new Error("Git rename numstat output is missing paths");
      }
      index += 2;
    }
    filesChanged += 1;
    insertions += added === "-" ? 0 : Number.parseInt(added, 10);
    deletions += deleted === "-" ? 0 : Number.parseInt(deleted, 10);
  }
  return { filesChanged, insertions, deletions };
}

export function dirtyTenderRefusal(
  repository: GitRepository,
  contractId: ContractId,
  tender: TenderCapture,
): DirtyWorkspaceRefusal {
  return {
    kind: "dirty-workspace",
    contractId,
    ...tender.changes,
    shortStat: dirtyShortStat(repository, tender),
  };
}

export function dirtyTenderDelta(repository: GitRepository, tender: TenderCapture): WorkspaceDirtyDelta | undefined {
  if (!tender.dirty) return undefined;
  const { staged, unstaged, untracked } = tender.changes;
  return { staged, unstaged, untracked, shortStat: dirtyShortStat(repository, tender) };
}

function commitMessage(contractId: ContractId, title: string, message?: string): string {
  const subject = message ?? `${contractId}: ${title}`;
  return `${subject}\n\nKeiyaku-Contract: ${contractId}\n`;
}

/** Materialize the tender tree when it contains admitted dirty workspace bytes. */
export function materializeTenderSnapshot(
  repository: GitRepository,
  tender: TenderCapture,
  input: Readonly<{ contractId: ContractId; title: string; message?: string }>,
): SnapshotId {
  if (!tender.dirty) return tender.head;
  const commit = runGitWithEnvironment(
    repository,
    ["commit-tree", tender.tree, "-p", gitObjectIdForSnapshot(tender.head)],
    commitMessage(input.contractId, input.title, input.message),
    {
      GIT_AUTHOR_NAME: "Keiyaku",
      GIT_AUTHOR_EMAIL: "keiyaku@localhost",
      GIT_COMMITTER_NAME: "Keiyaku",
      GIT_COMMITTER_EMAIL: "keiyaku@localhost",
      GIT_AUTHOR_DATE: "Thu, 01 Jan 1970 00:00:00 +0000",
      GIT_COMMITTER_DATE: "Thu, 01 Jan 1970 00:00:00 +0000",
    },
  ).toString("utf8").trim();
  return mintSnapshotId(commit);
}
