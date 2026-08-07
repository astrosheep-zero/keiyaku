import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnapshotId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { gitObjectIdForSnapshot } from "./identity.js";
import { runGit, type GitRepository } from "./repository.js";

type MaterializedVerificationCandidate = Readonly<{
  cwd: string;
  dispose: () => WorktreeLeak | null;
}>;

export type WorktreeLeak = Readonly<{
  path: string;
  diagnostic: string;
}>;

/** Materialize a temporary candidate worktree for verification and own its cleanup. */
export function materializeVerificationCandidate(
  repository: GitRepository,
  candidate: SnapshotId,
): MaterializedVerificationCandidate {
  const cwd = join(tmpdir(), `keiyaku-v4-verify-${randomBytes(12).toString("hex")}`);
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
    // A pruning race after the probes is still transport absence, not a Git error for callers.
    if (deliverySnapshotAvailability(repository, predecessor, candidate) === "unavailable") return null;
    throw error;
  }
}
