import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContractId, SnapshotId } from "../core/facts/types.js";
import { contractPhysicalName, gitObjectId, mintSnapshotId, type GitObjectId } from "./identity.js";
import { runGit, runGitWithEnvironment, type GitRepository } from "./repository.js";

const WORKTREE_DIRECTORY = ["keiyaku", "wt"] as const;

export type WorkspaceChanges = Readonly<{
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  submodules: readonly string[];
}>;

export type WorkspaceTree = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  dirty: boolean;
  changes: WorkspaceChanges;
}>;

export function deliveryWorktreePath(repository: GitRepository, contract: ContractId): string {
  return resolve(repository.commonDirectory, ...WORKTREE_DIRECTORY, contractPhysicalName(contract));
}

export function withPrivateGitIndex<Value>(action: (environment: Readonly<{ GIT_INDEX_FILE: string }>) => Value): Value {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-index-"));
  try {
    return action({ GIT_INDEX_FILE: join(directory, "index") });
  } finally {
    rmSync(directory, { recursive: true, force: true });
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

function workspaceChanges(repository: GitRepository, workspace: string): WorkspaceChanges {
  const records = runGit(repository, [
    "-C", workspace,
    "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none",
  ]).toString("utf8").split("\0");
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  const submodules = new Set<string>();

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
  };
}

/** Capture tracked and untracked workspace bytes without changing its real index. */
export function captureWorkspaceTree(repository: GitRepository, workspace: string): WorkspaceTree {
  const identities = runGit(repository, ["-C", workspace, "rev-parse", "HEAD", "HEAD^{tree}"])
    .toString("utf8")
    .split("\n");
  if (identities.length !== 3 || identities[0] === undefined || identities[1] === undefined || identities[2] !== "") {
    throw new Error("workspace HEAD/tree resolution did not return exactly two object IDs");
  }
  const head = mintSnapshotId(identities[0]);
  const tree = gitObjectId(identities[1], "workspace tree");
  const changes = workspaceChanges(repository, workspace);
  const dirty = changes.staged.length > 0 || changes.unstaged.length > 0 || changes.untracked.length > 0;
  if (!dirty) return { tree, head, dirty, changes };

  return withPrivateGitIndex((environment) => {
    runGitWithEnvironment(repository, ["-C", workspace, "read-tree", "HEAD"], undefined, environment);
    runGitWithEnvironment(repository, ["-C", workspace, "add", "--all"], undefined, environment);
    return {
      tree: gitObjectId(
        runGitWithEnvironment(repository, ["-C", workspace, "write-tree"], undefined, environment).toString("utf8").trim(),
        "workspace tree",
      ),
      head,
      dirty,
      changes,
    };
  });
}
