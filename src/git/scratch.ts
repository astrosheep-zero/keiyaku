import { z } from "zod";
import { randomBytes } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  acquireSqliteTransactionLock,
  tryAcquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import type { ContractId, SnapshotId } from "../core/facts/types.js";
import { contractLocator, gitRefLocator, gitObjectIdForSnapshot } from "./identity.js";
import { executeGit, type GitRepository } from "./process.js";

const SCRATCH_PREFIX = "keiyaku-v4-verify-";
const SCRATCH_ROOT = await realpath(tmpdir());
const SCRATCH_PATTERN = /^keiyaku-v4-verify-([0-9a-f]{24}|[0-9a-f]{64}-[0-9a-f]{64})$/;
/** One bounded removal attempt per scratch; expiry is reported, never retried inside this call. */
const SCRATCH_REMOVAL_TIMEOUT_MS = 120_000;

export type MaterializedScratchCandidate = Readonly<{
  cwd: string;
  dispose: (retain?: boolean) => Promise<WorktreeLeak | null>;
}>;

type CollectableScratchWorktree = Readonly<{
  path: string;
  lockPath: string;
  release(): void;
}>;

export const worktreeLeakSchema = z.object({ path: z.string().optional(), diagnostic: z.string() }).strict();
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

function retainedScratchPath(repository: GitRepository, contract: ContractId): string {
  return join(
    SCRATCH_ROOT,
    `${SCRATCH_PREFIX}${gitRefLocator(repository.commonDirectory)}-${contractLocator(contract)}`,
  );
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

async function collectableScratchWorktrees(
  paths: Iterable<string>,
  terminalScratch?: string,
): Promise<readonly CollectableScratchWorktree[]> {
  const collectable: CollectableScratchWorktree[] = [];
  for (const path of paths) {
    const lockPath = ownershipLockPath(path);
    if (lockPath === null) continue;
    if (basename(path).length !== SCRATCH_PREFIX.length + 24 && path !== terminalScratch) continue;
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

async function removeScratch(repository: GitRepository, path: string): Promise<WorktreeLeak | null> {
  const removal = AbortSignal.timeout(SCRATCH_REMOVAL_TIMEOUT_MS);
  try {
    const present = await pathExists(path);
    await executeGit({ ...repository, signal: removal }, ["worktree", "remove", ...(present ? ["--force"] : []), path]);
    return (await pathExists(path))
      ? { path, diagnostic: `Git reported scratch worktree removal but the path remains: ${path}` }
      : null;
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    return {
      path,
      diagnostic: removal.aborted
        ? `scratch worktree removal timed out after ${SCRATCH_REMOVAL_TIMEOUT_MS}ms: ${original}`
        : original,
    };
  }
}

/** Remove only abandoned Verification scratch worktrees whose ownership locks are held. */
export async function removeCollectableScratchWorktrees(
  repository: GitRepository,
  paths: Set<string>,
  terminalContract?: ContractId,
): Promise<readonly CollectableScratchRemoval[]> {
  const removals: CollectableScratchRemoval[] = [];
  const terminalScratch =
    terminalContract === undefined ? undefined : retainedScratchPath(repository, terminalContract);
  for (const scratch of await collectableScratchWorktrees(paths, terminalScratch)) {
    let removed = false;
    try {
      const leak = await removeScratch(repository, scratch.path);
      if (leak !== null) {
        removals.push({ path: scratch.path, retained: true, diagnostic: leak.diagnostic });
        continue;
      }
      paths.delete(scratch.path);
      removed = true;
      removals.push({ path: scratch.path, retained: false });
    } finally {
      scratch.release();
      if (removed && scratch.path !== terminalScratch) await removeOwnershipLock(scratch.lockPath);
    }
  }
  return removals;
}

async function retainScratch(repository: GitRepository, cwd: string, contract: ContractId): Promise<WorktreeLeak> {
  const retained = retainedScratchPath(repository, contract);
  const lockPath = ownershipLockPath(retained);
  if (lockPath === null) throw new Error("scratch ownership lock path is invalid");
  const { signal: _signal, ...retirementRepository } = repository;
  const fallback = async (reason: string): Promise<WorktreeLeak> => {
    const ownLeak = await removeScratch(retirementRepository, cwd);
    const path = ownLeak?.path ?? ((await pathExists(retained)) ? retained : undefined);
    return {
      ...(path === undefined ? {} : { path }),
      diagnostic: `failed Verification scratch could not be retained: ${reason}${
        ownLeak === null ? "" : `; ${ownLeak.diagnostic}`
      }`,
    };
  };
  let lock: HeldSqliteTransactionLock;
  try {
    lock = await acquireSqliteTransactionLock({
      path: lockPath,
      mode: "exclusive",
      timeoutMs: SCRATCH_REMOVAL_TIMEOUT_MS,
    });
  } catch (error) {
    return await fallback(`retained scratch busy: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const replaced = await pathExists(retained);
    if (replaced) {
      const leak = await removeScratch(retirementRepository, retained);
      if (leak !== null) return await fallback(leak.diagnostic);
    }
    await executeGit(retirementRepository, ["worktree", "move", cwd, retained]);
    return {
      path: retained,
      diagnostic: `failed Verification scratch retained for diagnosis${replaced ? " (replaced the previous retained scratch)" : ""}`,
    };
  } catch (error) {
    return await fallback(error instanceof Error ? error.message : String(error));
  } finally {
    lock.close();
  }
}

/** Materialize a disposable candidate worktree and own only its removal. */
export async function materializeScratchCandidate(
  repository: GitRepository,
  candidate: SnapshotId,
  contract?: ContractId,
): Promise<MaterializedScratchCandidate> {
  const cwd = scratchPath();
  const lockPath = ownershipLockPath(cwd);
  if (lockPath === null) throw new Error("scratch ownership lock path is invalid");
  const ownership: HeldSqliteTransactionLock = await acquireSqliteTransactionLock({
    path: lockPath,
    mode: "exclusive",
    ...(repository.signal === undefined ? {} : { signal: repository.signal }),
  });
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
    dispose: async (retain = false) => {
      if (disposed) return null;
      disposed = true;
      try {
        if (!retain) return await removeScratch(repository, cwd);
        if (contract === undefined)
          return { path: cwd, diagnostic: "failed Verification scratch retained for diagnosis" };
        return await retainScratch(repository, cwd, contract);
      } finally {
        ownership.close();
        if (!(await pathExists(cwd))) await removeOwnershipLock(lockPath);
      }
    },
  };
}
