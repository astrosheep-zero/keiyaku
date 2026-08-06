import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContractState, SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot, gitObjectId, type GitObjectId } from "./identity.js";
import { GitPlumbingError, runGit, type GitRepository } from "./repository.js";

export type StoredVerificationPreparation = Readonly<{
  candidate: SnapshotId;
  candidateTree: GitObjectId;
  cwd: string;
  dispose: () => void;
}>;

/** Materialize a temporary candidate worktree for verification and own its cleanup. */
export function prepareStoredVerification(repository: GitRepository, state: ContractState): StoredVerificationPreparation | null {
  if (state.terminal || state.delivery === null || state.body === null || state.body.verification.length === 0) return null;
  const candidate = state.delivery.data.candidate;
  const candidateTree = gitObjectId(runGit(repository, ["rev-parse", `${candidate}^{tree}`]).toString("utf8").trim(), "candidate tree");
  const cwd = join(tmpdir(), `keiyaku-v4-verify-${randomBytes(12).toString("hex")}`);
  runGit(repository, ["worktree", "add", "--detach", cwd, gitObjectIdForSnapshot(candidate)]);
  return { candidate, candidateTree, cwd, dispose: () => { runGit(repository, ["worktree", "remove", "--force", cwd]); } };
}

function deliverySnapshotAvailability(repository: GitRepository, snapshot: SnapshotId): "available" | "unavailable" {
  const object = gitObjectIdForSnapshot(snapshot);
  if (deliverySnapshotUnavailable(repository, object)) return "unavailable";
  let type: string;
  try {
    type = runGit(repository, ["cat-file", "-t", object]).toString("utf8").trim();
  } catch (error) {
    if (deliverySnapshotUnavailable(repository, object)) return "unavailable";
    throw error;
  }
  if (type !== "commit") throw new TypeError("recorded delivery snapshot is not a Git commit");
  return "available";
}

/** `cat-file -e <oid>` reserves exit status 1 for a physically absent object. */
function deliverySnapshotUnavailable(repository: GitRepository, object: GitObjectId): boolean {
  try {
    runGit(repository, ["cat-file", "-e", object]);
    return false;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return true;
    throw error;
  }
}

export function readDeliveryDiff(repository: GitRepository, predecessor: SnapshotId, candidate: SnapshotId): string | null {
  if (deliverySnapshotAvailability(repository, predecessor) === "unavailable") return null;
  if (deliverySnapshotAvailability(repository, candidate) === "unavailable") return null;
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
    if (deliverySnapshotAvailability(repository, predecessor) === "unavailable") return null;
    if (deliverySnapshotAvailability(repository, candidate) === "unavailable") return null;
    throw error;
  }
}
