import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { gitObjectIdForSnapshot } from "./identity.js";
import { runGit, type GitRepository } from "./repository.js";
import {
  currentProcessIdentity,
  probeProcessIdentity,
  type ProcessIdentity,
} from "../runtime/proc/run.js";

const SCRATCH_PREFIX = "keiyaku-v4-verify-";
const SCRATCH_ROOT = realpathSync(tmpdir());

export type MaterializedScratchCandidate = Readonly<{
  cwd: string;
  dispose: () => WorktreeLeak | null;
}>;

export type WorktreeLeak = Readonly<{
  path: string;
  diagnostic: string;
}>;

function scratchPath(): string {
  const owner = currentProcessIdentity();
  const identity = Buffer.from(owner.spawnedAt, "utf8").toString("base64url");
  return join(SCRATCH_ROOT, `${SCRATCH_PREFIX}${owner.pid}-${identity}-${randomBytes(12).toString("hex")}`);
}

function scratchOwner(path: string): ProcessIdentity | null {
  const prefix = join(SCRATCH_ROOT, SCRATCH_PREFIX);
  if (!path.startsWith(prefix)) return null;
  const suffix = path.slice(prefix.length);
  const match = /^([1-9][0-9]*)-([A-Za-z0-9_-]+)-([0-9a-f]{24})$/.exec(suffix);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid)) return null;
  let spawnedAt: string;
  try { spawnedAt = Buffer.from(match[2]!, "base64url").toString("utf8"); }
  catch { return null; }
  return spawnedAt.length === 0 ? null : { pid, spawnedAt };
}

export function orphanedScratchWorktrees(paths: Iterable<string>): readonly string[] {
  const orphaned: string[] = [];
  for (const path of paths) {
    const owner = scratchOwner(path);
    if (owner === null) continue;
    const state = probeProcessIdentity(owner);
    if (state.kind === "gone" || state.kind === "replaced") orphaned.push(path);
  }
  return orphaned;
}

/** Materialize a disposable candidate worktree and own only its removal. */
export function materializeScratchCandidate(
  repository: GitRepository,
  candidate: SnapshotId,
): MaterializedScratchCandidate {
  const cwd = scratchPath();
  runGit(repository, ["worktree", "add", "--detach", cwd, gitObjectIdForSnapshot(candidate)]);
  return {
    cwd,
    dispose: () => {
      try {
        runGit(repository, ["worktree", "remove", "--force", cwd]);
        return null;
      } catch (error) {
        return {
          path: cwd,
          diagnostic: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/** Resolve both pinned delivery objects through one structured Git batch. */
function deliverySnapshotAvailability(
  repository: GitRepository,
  predecessor: SnapshotId,
  candidate: SnapshotId,
): "available" | "unavailable" {
  const objects = [gitObjectIdForSnapshot(predecessor), gitObjectIdForSnapshot(candidate)] as const;
  const types = runGit(
    repository,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${objects.join("\n")}\n`,
  ).toString("ascii").trimEnd().split("\n").map((record) => record.split(" ")[1]);
  if (types.includes("missing")) return "unavailable";
  if (types.some((type) => type !== "commit")) {
    throw new AuthorityCorruptionError("recorded delivery snapshot is not a Git commit");
  }
  return "available";
}

export function readDeliveryDiff(repository: GitRepository, predecessor: SnapshotId, candidate: SnapshotId): string | null {
  if (deliverySnapshotAvailability(repository, predecessor, candidate) === "unavailable") return null;
  try {
    return runGit(repository, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      gitObjectIdForSnapshot(predecessor),
      gitObjectIdForSnapshot(candidate),
    ]).toString("utf8");
  } catch (error) {
    // A pruning race after the probes is still Git absence, not a Git error for callers.
    if (deliverySnapshotAvailability(repository, predecessor, candidate) === "unavailable") return null;
    throw error;
  }
}
