import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SnapshotId } from "../core/facts/types.js";
import { gitObjectId, mintSnapshotId, type GitObjectId } from "./identity.js";
import { GitPlumbingError, runGit, runGitWithEnvironment, type GitRepository } from "./process.js";
import { worktreeGitDirectory } from "./repository.js";

const WORKTREE_DIRECTORY = [".keiyaku", "wt"] as const;

export type WorkspaceChanges = Readonly<{
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  submodules: readonly string[];
}>;

export type WorkspaceTree = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  at: string;
  dirty: boolean;
  changes: WorkspaceChanges;
}>;

export function worktreePath(repository: GitRepository, place: string): string {
  return resolve(repository.primaryWorktree, ...WORKTREE_DIRECTORY, place);
}

export type ManagedWorktreeFollow =
  | Readonly<{ kind: "followed"; before: SnapshotId; after: SnapshotId }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{
      kind: "retained";
      head: SnapshotId;
      reason: "head-moved" | "head-attached" | "operation-in-progress" | "unsupported-parent-shape";
    }>;

export type DependentWorktreeFollow =
  | Readonly<{ kind: "followed"; before: SnapshotId; after: SnapshotId }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{
      kind: "retained";
      head: SnapshotId;
      reason: "head-moved" | "head-attached" | "operation-in-progress";
      paths: readonly string[];
    }>;

async function workspaceRevision(
  repository: GitRepository,
  workspace: string,
  revision: string,
): Promise<SnapshotId | null> {
  try {
    const value = (await runGit(repository, ["-C", workspace, "rev-parse", "--verify", "--quiet", revision]))
      .toString("utf8")
      .trim();
    return value.length === 0 ? null : mintSnapshotId(value);
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return null;
    throw error;
  }
}

async function workspaceOperationState(
  repository: GitRepository,
  workspace: string,
  gitDirectory: string,
): Promise<Readonly<{ other: boolean; unmerged: boolean }>> {
  const paths = ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
  const other = await Promise.all(
    paths.map(async (path) => {
      try {
        await access(join(gitDirectory, path));
        return true;
      } catch {
        return false;
      }
    }),
  );
  const unmerged = (await runGit(repository, ["-C", workspace, "ls-files", "--unmerged", "-z"])).length > 0;
  return { other: other.some(Boolean), unmerged };
}

/** Follow an accepted tender only through the native index-and-HEAD transition. */
export async function followManagedWorktree(
  repository: GitRepository,
  workspace: string,
  tender: SnapshotId,
): Promise<ManagedWorktreeFollow> {
  const head = await workspaceRevision(repository, workspace, "HEAD");
  if (head === null) throw new Error("managed worktree HEAD is missing");
  const attached = await runGit(repository, ["-C", workspace, "symbolic-ref", "--quiet", "HEAD"]).then(
    () => true,
    (error: unknown) => {
      if (error instanceof GitPlumbingError && error.status === 1) return false;
      throw error;
    },
  );
  if (attached) return { kind: "retained", head, reason: "head-attached" };
  if (head === tender) return { kind: "unchanged" };
  const parents = (await runGit(repository, ["show", "-s", "--format=%P", gitObjectId(tender)]))
    .toString("utf8")
    .trim()
    .split(" ")
    .filter((parent) => parent.length > 0)
    .map((parent) => mintSnapshotId(parent));
  if (parents.length > 0 && head !== parents[0]) return { kind: "retained", head, reason: "head-moved" };
  if (parents.length !== 1 && parents.length !== 2)
    return { kind: "retained", head, reason: "unsupported-parent-shape" };
  const gitDirectory = await worktreeGitDirectory(repository, workspace);
  const mergeHead = await workspaceRevision(repository, workspace, "MERGE_HEAD");
  const operation = await workspaceOperationState(repository, workspace, gitDirectory);
  const admitted =
    parents.length === 1
      ? mergeHead === null && !operation.other && !operation.unmerged
      : mergeHead === parents[1] && !operation.other && !operation.unmerged;
  if (!admitted) return { kind: "retained", head, reason: "operation-in-progress" };
  await runGit(repository, ["-C", workspace, "reset", "--mixed", gitObjectId(tender)]);
  return { kind: "followed", before: head, after: tender };
}

/** Follow a dependency baseline only through a clean, detached fast-forward. */
export async function followDependentManagedWorktree(
  repository: GitRepository,
  workspace: string,
  target: SnapshotId,
): Promise<DependentWorktreeFollow> {
  const head = await workspaceRevision(repository, workspace, "HEAD");
  if (head === null) throw new Error("managed worktree HEAD is missing");
  const status = await workspaceStatus(repository, workspace);
  const gitDirectory = await worktreeGitDirectory(repository, workspace);
  const operation = await workspaceOperationState(repository, workspace, gitDirectory);
  const mergeHead = await workspaceRevision(repository, workspace, "MERGE_HEAD");
  const paths = [
    ...new Set([
      ...status.staged,
      ...status.unstaged,
      ...status.untracked,
      ...status.submodules,
      ...status.unmergedPaths,
    ]),
  ].sort();
  const attached = await runGit(repository, ["-C", workspace, "symbolic-ref", "--quiet", "HEAD"]).then(
    () => true,
    (error: unknown) => {
      if (error instanceof GitPlumbingError && error.status === 1) return false;
      throw error;
    },
  );
  if (attached) return { kind: "retained", head, reason: "head-attached", paths };
  if (mergeHead !== null || operation.other || operation.unmerged || paths.length > 0) {
    return { kind: "retained", head, reason: "operation-in-progress", paths };
  }
  if (head === target) return { kind: "unchanged" };
  let ancestor = false;
  try {
    await runGit(repository, ["merge-base", "--is-ancestor", gitObjectId(head), gitObjectId(target)]);
    ancestor = true;
  } catch (error) {
    if (!(error instanceof GitPlumbingError) || error.status !== 1) throw error;
  }
  if (!ancestor) return { kind: "retained", head, reason: "head-moved", paths };
  await runGit(repository, ["-C", workspace, "checkout", "--quiet", "--detach", gitObjectId(target)]);
  return { kind: "followed", before: head, after: target };
}

export async function withPrivateGitIndex<Value>(
  action: (environment: Readonly<{ GIT_INDEX_FILE: string }>) => Value | PromiseLike<Value>,
): Promise<Value> {
  const directory = await mkdtemp(join(tmpdir(), "keiyaku-v4-index-"));
  try {
    return await action({ GIT_INDEX_FILE: join(directory, "index") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fields(record: string, count: number): readonly string[] {
  const result: string[] = [];
  let start = 0;
  while (result.length < count - 1) {
    const separator = record.indexOf(" ", start);
    if (separator < 0) throw new Error(`malformed workspace status record: ${record}`);
    result.push(record.slice(start, separator));
    start = separator + 1;
  }
  result.push(record.slice(start));
  return result;
}

type WorkspaceStatus = WorkspaceChanges & Readonly<{ unmergedPaths: readonly string[] }>;

async function workspaceStatus(repository: GitRepository, workspace: string): Promise<WorkspaceStatus> {
  const records = (
    await runGit(repository, [
      "-C",
      workspace,
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ])
  )
    .toString("utf8")
    .split("\0");
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  const submodules = new Set<string>();
  const unmerged = new Set<string>();

  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index]!;
    const kind = record[0];
    if (kind === "?") {
      untracked.add(fields(record, 2)[1]!);
      continue;
    }
    if (kind === "1" || kind === "2" || kind === "u") {
      const parts = fields(record, kind === "1" ? 9 : kind === "2" ? 10 : 11);
      const xy = parts[1]!;
      const sub = parts[2]!;
      const path = parts.at(-1)!;
      if (kind === "u") unmerged.add(path);
      if (xy[0] !== ".") staged.add(path);
      if (xy[1] !== ".") unstaged.add(path);
      if (sub.startsWith("S") && (sub[2] !== "." || sub[3] !== ".")) submodules.add(path);
      if (kind === "2") {
        const origin = records[index + 1];
        if (origin === undefined) throw new Error("renamed workspace status record is missing its origin path");
        if (xy[0] !== ".") staged.add(origin);
        if (xy[1] !== ".") unstaged.add(origin);
        index += 1;
      }
      continue;
    }
    throw new Error(`unknown workspace status record: ${record}`);
  }

  return {
    staged: [...staged].sort(),
    unstaged: [...unstaged].sort(),
    untracked: [...untracked].sort(),
    submodules: [...submodules].sort(),
    unmergedPaths: [...unmerged].sort(),
  };
}

async function workspaceChanges(repository: GitRepository, workspace: string): Promise<WorkspaceChanges> {
  const { unmergedPaths: _unmergedPaths, ...changes } = await workspaceStatus(repository, workspace);
  return changes;
}

/** Observe MERGE_HEAD in an appointed workspace, or undefined when absent. */
export async function workspaceMergeHead(
  repository: GitRepository,
  workspace: string,
): Promise<SnapshotId | undefined> {
  try {
    return mintSnapshotId(
      (await runGit(repository, ["-C", workspace, "rev-parse", "-q", "--verify", "MERGE_HEAD"]))
        .toString("utf8")
        .trim(),
    );
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return undefined;
    throw error;
  }
}

/** True when the appointed workspace already has Git MERGE_HEAD. */
export async function workspaceMergeStatePresent(repository: GitRepository, workspace: string): Promise<boolean> {
  return (await workspaceMergeHead(repository, workspace)) !== undefined;
}

/** Sorted unique unmerged index paths from porcelain status. */
export async function unmergedWorkspacePaths(repository: GitRepository, workspace: string): Promise<readonly string[]> {
  return (await workspaceStatus(repository, workspace)).unmergedPaths;
}

export type WorkspaceChangeCounts = Readonly<{
  staged: number;
  unstaged: number;
  untracked: number;
  submodules: number;
}>;

export type ContractWorkspaceLocation = Readonly<{ kind: "worktree"; path: string }>;

export type ContractWorkspaceMerge = Readonly<{
  head: SnapshotId;
  unmergedPaths: readonly string[];
}>;

export type ContractWorkspaceObservation =
  | Readonly<{
      kind: "clean" | "dirty";
      location: ContractWorkspaceLocation;
      counts: WorkspaceChangeCounts;
      merge: ContractWorkspaceMerge | null;
    }>
  | Readonly<{ kind: "unavailable"; location: ContractWorkspaceLocation }>
  | Readonly<{ kind: "unappointed" }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type ContractTargetLag =
  | Readonly<{ kind: "counted"; behind: number }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "none" }>;

function countsOf(changes: WorkspaceChanges): WorkspaceChangeCounts {
  return {
    staged: changes.staged.length,
    unstaged: changes.unstaged.length,
    untracked: changes.untracked.length,
    submodules: changes.submodules.length,
  };
}

export async function observeWorkspace(
  repository: GitRepository,
  location: ContractWorkspaceLocation,
  workspace: string,
): Promise<ContractWorkspaceObservation> {
  try {
    const status = await workspaceStatus(repository, workspace);
    const counts = countsOf(status);
    const dirty = counts.staged > 0 || counts.unstaged > 0 || counts.untracked > 0 || counts.submodules > 0;
    const head = await workspaceMergeHead(repository, workspace);
    const merge = head === undefined ? null : { head, unmergedPaths: status.unmergedPaths };
    return { kind: dirty ? "dirty" : "clean", location, counts, merge };
  } catch {
    return { kind: "unavailable", location };
  }
}

export async function observeTargetLag(
  repository: GitRepository,
  workspace: string,
  head: SnapshotId | null | undefined,
): Promise<ContractTargetLag> {
  if (head === undefined) return { kind: "none" };
  if (head === null) return { kind: "unknown" };
  try {
    const text = (await runGit(repository, ["-C", workspace, "rev-list", "--count", `HEAD..${head}`]))
      .toString("utf8")
      .trim();
    if (!/^[0-9]+$/u.test(text)) return { kind: "unknown" };
    return { kind: "counted", behind: Number(text) };
  } catch {
    return { kind: "unknown" };
  }
}

/** Capture tracked and untracked workspace bytes without changing its real index. */
export async function captureWorkspaceTree(repository: GitRepository, workspace: string): Promise<WorkspaceTree> {
  const identities = (await runGit(repository, ["-C", workspace, "show", "-s", "--format=%H%n%T%n%cI", "HEAD"]))
    .toString("utf8")
    .split("\n");
  if (
    identities.length !== 4 ||
    identities[0] === undefined ||
    identities[1] === undefined ||
    identities[2] === undefined ||
    identities[3] !== ""
  ) {
    throw new Error("workspace HEAD/tree/time resolution returned an unexpected shape");
  }
  const head = mintSnapshotId(identities[0]);
  const tree = gitObjectId(identities[1], "workspace tree");
  const at = identities[2];
  if (Number.isNaN(Date.parse(at))) throw new Error("workspace HEAD has an invalid committer timestamp");
  const changes = await workspaceChanges(repository, workspace);
  const dirty = changes.staged.length > 0 || changes.unstaged.length > 0 || changes.untracked.length > 0;
  if (!dirty) return { tree, head, at, dirty, changes };

  return await withPrivateGitIndex(async (environment) => {
    await runGitWithEnvironment(repository, ["-C", workspace, "read-tree", "HEAD"], undefined, environment);
    await runGitWithEnvironment(repository, ["-C", workspace, "add", "--all"], undefined, environment);
    return {
      tree: gitObjectId(
        (await runGitWithEnvironment(repository, ["-C", workspace, "write-tree"], undefined, environment))
          .toString("utf8")
          .trim(),
        "workspace tree",
      ),
      head,
      at,
      dirty,
      changes,
    };
  });
}
