import { resolve } from "node:path";
import { acquireSqliteTransactionLock, type HeldSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import type { ContractId, ContractState, SnapshotId } from "../core/facts/types.js";
import type { RefOperation } from "../core/facts/offer.js";
import { gitObjectId, gitObjectIdForSnapshot, gitRefLocator, type GitObjectId } from "./identity.js";
import { currentBranch } from "./observe.js";
import {
  commonGitDirectory,
  readRef,
  registeredWorktrees,
  runGit,
  type GitRepository,
} from "./repository.js";
import { captureWorkspaceTree } from "./workspace.js";

export type WorkspaceNotOnTargetRefusal = Readonly<{
  kind: "workspace-not-on-target";
  contractId: ContractId;
  target: string;
  branch: string | null;
}>;

export type CheckoutNotFollowableRefusal = Readonly<{
  kind: "checkout-not-followable";
  contractId: ContractId;
  target: string;
  path: string;
  reason: "staged" | "conflict" | "untracked";
  paths: readonly string[];
}>;

export type TargetPlacementRefusal = CheckoutNotFollowableRefusal | WorkspaceNotOnTargetRefusal;

export type TargetCheckoutEffect = Readonly<{
  kind: "target-checkout";
  path: string;
  target: string;
  action: "followed" | "recovered";
}>;

export type TargetCheckoutLag = Readonly<{
  kind: "target-checkout-retained";
  path: string;
  target: string;
  diagnostic: string;
}>;

export type TargetPlacementPhysicalResult = Readonly<{
  effects: readonly TargetCheckoutEffect[];
  lag: readonly TargetCheckoutLag[];
}>;

type FollowArm = Readonly<{
  kind: "ordinary" | "here";
  path: string;
}>;

export type PreparedTargetPlacement = Readonly<{
  target: RefOperation;
  arms: readonly FollowArm[];
}>;

export type TargetPlacementPreparation =
  | Readonly<{ kind: "prepared"; placement: PreparedTargetPlacement }>
  | Readonly<{ kind: "refused"; refusal: TargetPlacementRefusal }>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nulPaths(bytes: Buffer): readonly string[] {
  const fields = bytes.toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("Git path output is not NUL terminated");
  return [...new Set(fields.slice(0, -1))].sort();
}

function gitPaths(repository: GitRepository, path: string, args: readonly string[]): readonly string[] {
  return nulPaths(runGit(repository, ["-C", path, ...args]));
}

function commitTree(repository: GitRepository, snapshot: SnapshotId): GitObjectId {
  return gitObjectId(
    runGit(repository, ["rev-parse", "--verify", `${gitObjectIdForSnapshot(snapshot)}^{tree}`])
      .toString("utf8")
      .trim(),
    "commit tree",
  );
}

function indexTree(repository: GitRepository, path: string): GitObjectId {
  return gitObjectId(runGit(repository, ["-C", path, "write-tree"]).toString("utf8").trim(), "index tree");
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function intersection(left: readonly string[], right: readonly string[]): readonly string[] {
  return left.filter((candidate) => right.some((path) => pathsOverlap(candidate, path))).sort();
}

function sourceWorktree(repository: GitRepository): string {
  return resolve(runGit(repository, ["rev-parse", "--show-toplevel"]).toString("utf8").trim());
}

function ordinaryPrecheck(
  repository: GitRepository,
  contractId: ContractId,
  target: RefOperation,
  path: string,
): CheckoutNotFollowableRefusal | null {
  const predecessor = gitObjectIdForSnapshot(target.expectedOid);
  const candidate = gitObjectIdForSnapshot(target.newOid);
  const staged = gitPaths(repository, path, ["diff", "--cached", "--name-only", "-z", predecessor]);
  if (staged.length > 0) {
    return {
      kind: "checkout-not-followable",
      contractId,
      target: target.target,
      path,
      reason: "staged",
      paths: staged,
    };
  }

  const changed = gitPaths(repository, path, ["diff", "--name-only", "-z", predecessor, candidate]);
  const dirty = gitPaths(repository, path, ["diff-files", "--name-only", "-z"]);
  const conflicts = intersection(changed, dirty);
  if (conflicts.length > 0) {
    return {
      kind: "checkout-not-followable",
      contractId,
      target: target.target,
      path,
      reason: "conflict",
      paths: conflicts,
    };
  }

  const additions = gitPaths(repository, path, ["diff", "--name-only", "--diff-filter=A", "-z", predecessor, candidate]);
  const untracked = gitPaths(repository, path, ["ls-files", "--others", "-z"]);
  const collisions = intersection(additions, untracked);
  if (collisions.length > 0) {
    return {
      kind: "checkout-not-followable",
      contractId,
      target: target.target,
      path,
      reason: "untracked",
      paths: collisions,
    };
  }

  runGit(repository, ["-C", path, "read-tree", "--dry-run", "-m", "-u", predecessor, candidate]);
  return null;
}

export async function acquireTargetPlacementFence(
  repository: GitRepository,
  target: string,
): Promise<HeldSqliteTransactionLock> {
  const locator = gitRefLocator(target);
  return acquireSqliteTransactionLock({
    path: resolve(commonGitDirectory(repository), "keiyaku", "locks", "target-placement", `${locator}.sqlite`),
    mode: "immediate",
  });
}

export function prepareTargetPlacement(
  repository: GitRepository,
  state: ContractState,
  target: RefOperation,
): TargetPlacementPreparation {
  if (state.coordinates.target !== target.target || state.delivery?.data.candidate !== target.newOid) {
    throw new Error("placement state does not match its offered target movement");
  }
  const worktrees = registeredWorktrees(repository)
    .filter((worktree) => worktree.branch === target.target)
    .sort((left, right) => left.path.localeCompare(right.path));
  const hereSource = state.coordinates.workspace === "here" ? sourceWorktree(repository) : null;
  if (hereSource !== null) {
    const branch = currentBranch(repository, hereSource);
    if (branch !== target.target) {
      return {
        kind: "refused",
        refusal: {
          kind: "workspace-not-on-target",
          contractId: state.id,
          target: target.target,
          branch,
        },
      };
    }
  }

  const arms: FollowArm[] = [];
  for (const worktree of worktrees) {
    const kind = hereSource !== null && resolve(worktree.path) === hereSource ? "here" : "ordinary";
    if (kind === "ordinary") {
      const refusal = ordinaryPrecheck(repository, state.id, target, worktree.path);
      if (refusal !== null) return { kind: "refused", refusal };
    }
    arms.push({ kind, path: worktree.path });
  }
  if (hereSource !== null && !arms.some((arm) => arm.kind === "here")) {
    throw new Error("targeted here workspace is not a registered checkout of its target");
  }
  return { kind: "prepared", placement: { target, arms } };
}

export function followTargetPlacement(
  repository: GitRepository,
  prepared: PreparedTargetPlacement,
): TargetPlacementPhysicalResult {
  const effects: TargetCheckoutEffect[] = [];
  const lag: TargetCheckoutLag[] = [];
  const predecessor = gitObjectIdForSnapshot(prepared.target.expectedOid);
  const candidate = gitObjectIdForSnapshot(prepared.target.newOid);
  for (const arm of prepared.arms) {
    try {
      if (arm.kind === "here") runGit(repository, ["-C", arm.path, "read-tree", candidate]);
      else runGit(repository, ["-C", arm.path, "read-tree", "-m", "-u", predecessor, candidate]);
      effects.push({ kind: "target-checkout", path: arm.path, target: prepared.target.target, action: "followed" });
    } catch (error) {
      lag.push({
        kind: "target-checkout-retained",
        path: arm.path,
        target: prepared.target.target,
        diagnostic: diagnostic(error),
      });
    }
  }
  return { effects, lag };
}

function recoveryLag(path: string, target: string, detail: string): TargetCheckoutLag {
  return { kind: "target-checkout-retained", path, target, diagnostic: detail };
}

export function recoverTargetPlacement(
  repository: GitRepository,
  state: ContractState,
): TargetPlacementPhysicalResult {
  const target = state.coordinates.target;
  const delivery = state.delivery;
  if (state.terminal?.kind !== "claimed" || target === undefined || delivery === null) return { effects: [], lag: [] };
  if (readRef(repository, target) !== delivery.data.candidate) return { effects: [], lag: [] };

  const candidateTree = commitTree(repository, delivery.data.candidate);
  const predecessorTree = commitTree(repository, delivery.data.expectedPredecessor);
  const worktrees = registeredWorktrees(repository)
    .filter((worktree) => worktree.branch === target)
    .sort((left, right) => left.path.localeCompare(right.path));
  const effects: TargetCheckoutEffect[] = [];
  const lag: TargetCheckoutLag[] = [];
  for (const worktree of worktrees) {
    let currentIndex: GitObjectId;
    try {
      currentIndex = indexTree(repository, worktree.path);
    } catch (error) {
      lag.push(recoveryLag(worktree.path, target, diagnostic(error)));
      continue;
    }
    if (currentIndex === candidateTree) {
      continue;
    }

    try {
      if (captureWorkspaceTree(repository, worktree.path).tree === candidateTree) {
        runGit(repository, ["-C", worktree.path, "read-tree", gitObjectIdForSnapshot(delivery.data.candidate)]);
      } else {
        if (currentIndex !== predecessorTree) {
          lag.push(recoveryLag(worktree.path, target, "target checkout index is neither predecessor nor candidate"));
          continue;
        }
        runGit(repository, [
          "-C",
          worktree.path,
          "read-tree",
          "-m",
          "-u",
          gitObjectIdForSnapshot(delivery.data.expectedPredecessor),
          gitObjectIdForSnapshot(delivery.data.candidate),
        ]);
      }
      effects.push({ kind: "target-checkout", path: worktree.path, target, action: "recovered" });
    } catch (error) {
      lag.push(recoveryLag(worktree.path, target, diagnostic(error)));
    }
  }
  return { effects, lag };
}
