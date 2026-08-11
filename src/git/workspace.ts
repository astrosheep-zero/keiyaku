import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ContractId, SnapshotId } from "../core/facts/types.js";
import { contractPhysicalName, gitObjectId, mintSnapshotId, type GitObjectId } from "./identity.js";
import { runGit, runGitWithEnvironment, type GitRepository } from "./repository.js";

const WORKTREE_DIRECTORY = [".keiyaku-v4", "worktrees"] as const;

export type WorkspaceTree = Readonly<{ tree: GitObjectId; head: SnapshotId; dirty: boolean }>;

export function deliveryWorktreePath(repository: GitRepository, contract: ContractId): string {
  return resolve(realpathSync(repository.primaryWorktree), ...WORKTREE_DIRECTORY, contractPhysicalName(contract));
}

function withPrivateGitIndex<Value>(action: (environment: Readonly<{ GIT_INDEX_FILE: string }>) => Value): Value {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-index-"));
  try {
    return action({ GIT_INDEX_FILE: join(directory, "index") });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  const dirty = runGit(repository, ["-C", workspace, "status", "--porcelain=v1", "--untracked-files=all"]).length > 0;
  if (!dirty) return { tree, head, dirty };

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
    };
  });
}
