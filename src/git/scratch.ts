import { z } from "zod";
import { randomBytes } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  tryAcquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import type { SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot } from "./identity.js";
import { executeGit, type GitRepository } from "./process.js";

const SCRATCH_PREFIX = "keiyaku-v4-verify-";
const SCRATCH_ROOT = await realpath(tmpdir());
const SCRATCH_PATTERN = /^keiyaku-v4-verify-([0-9a-f]{24})$/;
/** One bounded removal attempt per scratch; expiry is reported, never retried inside this call. */
const SCRATCH_REMOVAL_TIMEOUT_MS = 120_000;

export type MaterializedScratchCandidate = Readonly<{
  cwd: string;
  dispose: () => Promise<WorktreeLeak | null>;
}>;

type CollectableScratchWorktree = Readonly<{
  path: string;
  lockPath: string;
  release(): void;
}>;

export const worktreeLeakSchema = z.object({ path: z.string(), diagnostic: z.string() }).strict();
export type WorktreeLeak = z.infer<typeof worktreeLeakSchema>;
type CollectableScratchRemoval = Readonly<{
  path: string;
  /** False only when Git removed the path and absence was confirmed; retained removals own a diagnostic. */
  retained: boolean;
  diagnostic?: string;
}>;

function scratchPath(): string {
  return join(SCRATCH_ROOT, `${SCRATCH_PREFIX}${randomBytes(12).toString("hex")}`);
}

function ownershipLockPath(path: string): string | null {
  if (dirname(path) !== SCRATCH_ROOT) return null;
  const match = SCRATCH_PATTERN.exec(basename(path));
  return match === null ? null : join(SCRATCH_ROOT, `.${SCRATCH_PREFIX}${match[1]}.owner.sqlite`);
}

async function removeOwnershipLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function collectableScratchWorktrees(paths: Iterable<string>): Promise<readonly CollectableScratchWorktree[]> {
  const collectable: CollectableScratchWorktree[] = [];
  for (const path of paths) {
    const lockPath = ownershipLockPath(path);
    if (lockPath === null) continue;
    const lock = await tryAcquireSqliteTransactionLock({ path: lockPath, mode: "exclusive" });
    if (lock !== null) collectable.push({ path, lockPath, release: () => lock.close() });
  }
  return collectable;
}

/** Absence is ENOENT on the path entry itself: a dangling symlink is present residue, not a missing path. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Remove only abandoned Verification scratch worktrees whose ownership locks are held. */
export async function removeCollectableScratchWorktrees(
  repository: GitRepository,
  paths: Set<string>,
): Promise<readonly CollectableScratchRemoval[]> {
  const removals: CollectableScratchRemoval[] = [];
  for (const scratch of await collectableScratchWorktrees(paths)) {
    let removed = false;
    try {
      let diagnostic: string | undefined;
      try {
        const present = await pathExists(scratch.path);
        await executeGit(repository, ["worktree", "remove", ...(present ? ["--force"] : []), scratch.path]);
        if (await pathExists(scratch.path)) {
          diagnostic = `Git reported scratch worktree removal but the path remains: ${scratch.path}`;
        }
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : String(error);
      }
      if (diagnostic !== undefined) {
        removals.push({ path: scratch.path, retained: true, diagnostic });
        continue;
      }
      paths.delete(scratch.path);
      removed = true;
      removals.push({ path: scratch.path, retained: false });
    } finally {
      scratch.release();
      if (removed) await removeOwnershipLock(scratch.lockPath);
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
    await executeGit(repository, ["worktree", "add", "--detach", cwd, gitObjectIdForSnapshot(candidate)]);
  } catch (error) {
    ownership.close();
    await removeOwnershipLock(lockPath);
    throw error;
  }
  let disposed = false;
  return {
    cwd,
    dispose: async () => {
      if (disposed) return null;
      disposed = true;
      const removal = AbortSignal.timeout(SCRATCH_REMOVAL_TIMEOUT_MS);
      let leak: WorktreeLeak | null = null;
      let removed = false;
      try {
        await executeGit({ ...repository, signal: removal }, ["worktree", "remove", "--force", cwd]);
        removed = !(await pathExists(cwd));
        if (!removed)
          leak = { path: cwd, diagnostic: `Git reported scratch worktree removal but the path remains: ${cwd}` };
      } catch (error) {
        const original = error instanceof Error ? error.message : String(error);
        leak = {
          path: cwd,
          diagnostic: removal.aborted
            ? `scratch worktree removal timed out after ${SCRATCH_REMOVAL_TIMEOUT_MS}ms: ${original}`
            : original,
        };
      } finally {
        ownership.close();
        if (removed) await removeOwnershipLock(lockPath);
      }
      return leak;
    },
  };
}
