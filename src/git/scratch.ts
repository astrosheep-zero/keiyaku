import { randomBytes } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  tryAcquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import type { SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot } from "./identity.js";
import { runGit, type GitRepository } from "./process.js";

const SCRATCH_PREFIX = "keiyaku-v4-verify-";
const SCRATCH_ROOT = await realpath(tmpdir());
const SCRATCH_PATTERN = /^keiyaku-v4-verify-([0-9a-f]{24})$/;

export type MaterializedScratchCandidate = Readonly<{
  cwd: string;
  dispose: () => Promise<WorktreeLeak | null>;
}>;

type CollectableScratchWorktree = Readonly<{
  path: string;
  release(): void;
}>;

export type WorktreeLeak = Readonly<{
  path: string;
  diagnostic: string;
}>;

type CollectableScratchRemoval = Readonly<{
  path: string;
  action: "removed" | "unchanged";
  retained: boolean;
}>;

function scratchPath(): string {
  return join(SCRATCH_ROOT, `${SCRATCH_PREFIX}${randomBytes(12).toString("hex")}`);
}

function ownershipLockPath(path: string): string | null {
  if (dirname(path) !== SCRATCH_ROOT) return null;
  const match = SCRATCH_PATTERN.exec(basename(path));
  return match === null ? null : join(SCRATCH_ROOT, `.${SCRATCH_PREFIX}${match[1]}.owner.sqlite`);
}

async function collectableScratchWorktrees(paths: Iterable<string>): Promise<readonly CollectableScratchWorktree[]> {
  const collectable: CollectableScratchWorktree[] = [];
  for (const path of paths) {
    const lockPath = ownershipLockPath(path);
    if (lockPath === null) continue;
    const lock = await tryAcquireSqliteTransactionLock({ path: lockPath, mode: "exclusive" });
    if (lock !== null) collectable.push({ path, release: () => lock.close() });
  }
  return collectable;
}

const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Remove only abandoned Verification scratch worktrees whose ownership locks are held. */
export async function removeCollectableScratchWorktrees(
  repository: GitRepository,
  paths: Set<string>,
): Promise<readonly CollectableScratchRemoval[]> {
  const removals: CollectableScratchRemoval[] = [];
  for (const scratch of await collectableScratchWorktrees(paths)) {
    try {
      if (!(await pathExists(scratch.path))) {
        await runGit(repository, ["worktree", "remove", scratch.path]);
        paths.delete(scratch.path);
        removals.push({ path: scratch.path, action: "removed", retained: false });
        continue;
      }
      try {
        await runGit(repository, ["worktree", "remove", "--force", scratch.path]);
        paths.delete(scratch.path);
        removals.push({ path: scratch.path, action: "removed", retained: false });
      } catch {
        removals.push({ path: scratch.path, action: "unchanged", retained: true });
      }
    } finally {
      scratch.release();
    }
  }
  return removals;
}

/** Materialize a disposable candidate worktree and own only its removal. */
export async function materializeScratchCandidate(
  repository: GitRepository,
  candidate: SnapshotId,
): Promise<MaterializedScratchCandidate> {
  const cwd = scratchPath();
  const lockPath = ownershipLockPath(cwd);
  if (lockPath === null) throw new Error("scratch ownership lock path is invalid");
  const ownership: HeldSqliteTransactionLock | null = await tryAcquireSqliteTransactionLock({
    path: lockPath,
    mode: "exclusive",
  });
  if (ownership === null) throw new Error("new scratch ownership lock is unexpectedly held");
  try {
    await runGit(repository, ["worktree", "add", "--detach", cwd, gitObjectIdForSnapshot(candidate)]);
  } catch (error) {
    ownership.close();
    throw error;
  }
  let disposed = false;
  return {
    cwd,
    dispose: async () => {
      if (disposed) return null;
      disposed = true;
      try {
        await runGit({ ...repository, signal: AbortSignal.timeout(5_000) }, ["worktree", "remove", "--force", cwd]);
        return null;
      } catch (error) {
        return {
          path: cwd,
          diagnostic: error instanceof Error ? error.message : String(error),
        };
      } finally {
        ownership.close();
      }
    },
  };
}
