import { access } from "node:fs/promises";
import type { Preparation } from "../core/decide.js";
import type { ContractCoordinates, ContractId, SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot, mintSnapshotId, type GitObjectId } from "./identity.js";
import { registeredWorktreePaths, runGit, runGitWithEnvironment, type GitRepository } from "./repository.js";
import { captureWorkspaceTree, worktreePath } from "./workspace.js";

export type TenderCaptureCoordinates = Readonly<{
  contractId: ContractId;
  coordinates: ContractCoordinates;
  place?: string;
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
  changes: Awaited<ReturnType<typeof captureWorkspaceTree>>["changes"];
}>;

async function workspaceExists(repository: GitRepository, workspace: "worktree" | "here", path: string): Promise<boolean> {
  const exists = await access(path).then(() => true, () => false);
  return workspace === "here"
    || (exists && (await registeredWorktreePaths(repository)).includes(path));
}

function workspaceFor(repository: GitRepository, input: TenderCaptureCoordinates): string | undefined {
  if (input.coordinates.workspace === "here") return repository.effectiveCwd;
  return input.place === undefined ? undefined : worktreePath(repository, input.place);
}

/** Capture the complete workspace tree through Git's private index mechanics. */
export async function captureTender(
  repository: GitRepository,
  input: TenderCaptureCoordinates,
): Promise<Preparation<TenderCapture, TenderCaptureRefusal>> {
  const workspace = workspaceFor(repository, input);
  if (workspace === undefined || !(await workspaceExists(repository, input.coordinates.workspace, workspace))) {
    return { kind: "refused", refusal: { kind: "worktree-missing", contractId: input.contractId } };
  }
  return { kind: "prepared", data: await captureWorkspaceTree(repository, workspace) };
}

async function dirtyShortStat(repository: GitRepository, tender: TenderCapture): Promise<WorkspaceDirtyDelta["shortStat"]> {
  const fields = (await runGit(repository, [
    "diff",
    "--numstat",
    "-z",
    gitObjectIdForSnapshot(tender.head),
    tender.tree,
  ])).toString("utf8").split("\0");
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

export async function dirtyTenderRefusal(
  repository: GitRepository,
  contractId: ContractId,
  tender: TenderCapture,
): Promise<DirtyWorkspaceRefusal> {
  return {
    kind: "dirty-workspace",
    contractId,
    ...tender.changes,
    shortStat: await dirtyShortStat(repository, tender),
  };
}

export async function dirtyTenderDelta(repository: GitRepository, tender: TenderCapture): Promise<WorkspaceDirtyDelta | undefined> {
  if (!tender.dirty) return undefined;
  const { staged, unstaged, untracked } = tender.changes;
  return { staged, unstaged, untracked, shortStat: await dirtyShortStat(repository, tender) };
}

function commitMessage(contractId: ContractId, title: string, message?: string): string {
  const subject = message ?? `${contractId}: ${title}`;
  return `${subject}\n\nKeiyaku-Contract: ${contractId}\n`;
}

/** Materialize the tender tree when it contains admitted dirty workspace bytes. */
export async function materializeTenderSnapshot(
  repository: GitRepository,
  tender: TenderCapture,
  input: Readonly<{ contractId: ContractId; title: string; message?: string }>,
): Promise<SnapshotId> {
  if (!tender.dirty) return tender.head;
  const commit = (await runGitWithEnvironment(
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
  )).toString("utf8").trim();
  return mintSnapshotId(commit);
}
