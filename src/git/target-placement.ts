import { resolve } from "node:path";
import { acquireSqliteTransactionLock, type HeldSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import type { ContractId, ContractState, SnapshotId } from "../core/facts/types.js";
import type { RefOperation } from "../core/facts/offer.js";
import { gitObjectId, gitObjectIdForSnapshot, gitRefLocator, type GitObjectId } from "./identity.js";
import { currentBranch } from "./observe.js";
import {
  commonGitDirectory,
  GitPlumbingError,
  readRef,
  registeredWorktrees,
  runGit,
  type GitRepository,
} from "./repository.js";
import { captureWorkspaceTree, withPrivateGitIndex } from "./workspace.js";

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

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function intersection(left: readonly string[], right: readonly string[]): readonly string[] {
  return left.filter((candidate) => right.some((path) => pathsOverlap(candidate, path))).sort();
}

function failurePaths(error: unknown): readonly string[] {
  if (!(error instanceof GitPlumbingError)) return [];
  const paths = new Set<string>();
  for (const match of error.stderr.toString("utf8").matchAll(/(?:Entry|Untracked working tree file) '([^']+)'/gu)) {
    paths.add(match[1]!);
  }
  return [...paths].sort();
}

function checkoutRefusal(
  contractId: ContractId,
  target: RefOperation,
  path: string,
  reason: CheckoutNotFollowableRefusal["reason"],
  error: unknown,
): CheckoutNotFollowableRefusal {
  const paths = failurePaths(error);
  if (paths.length === 0) throw error;
  return { kind: "checkout-not-followable", contractId, target: target.target, path, reason, paths };
}

function indexMatchesTreeOnPaths(
  repository: GitRepository,
  path: string,
  tree: GitObjectId,
  paths: readonly string[],
): boolean {
  return gitPaths(repository, path, ["diff-index", "--cached", "--name-only", "-z", tree, "--", ...paths]).length === 0;
}

function workspaceMatchesTreeOnPaths(
  repository: GitRepository,
  path: string,
  tree: GitObjectId,
  workspaceTree: GitObjectId,
  paths: readonly string[],
): boolean {
  return gitPaths(repository, path, ["diff", "--name-only", "-z", tree, workspaceTree, "--", ...paths]).length === 0;
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
  try {
    withPrivateGitIndex((environment) => {
      runGit(repository, ["-C", path, "read-tree", "-i", `--index-output=${environment.GIT_INDEX_FILE}`, "-m", predecessor, candidate]);
    });
  } catch (error) {
    return checkoutRefusal(contractId, target, path, "staged", error);
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

  try {
    runGit(repository, ["-C", path, "read-tree", "--dry-run", "-m", "-u", predecessor, candidate]);
  } catch (error) {
    const reason = error instanceof GitPlumbingError && /untracked working tree file/iu.test(error.stderr.toString("utf8"))
      ? "untracked"
      : "conflict";
    return checkoutRefusal(contractId, target, path, reason, error);
  }
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

function recoverCheckout(input: Readonly<{
  repository: GitRepository;
  path: string;
  predecessor: SnapshotId;
  candidate: SnapshotId;
  predecessorTree: GitObjectId;
  candidateTree: GitObjectId;
}>): "complete" | "recovered" | "retained" {
  const { repository, path, predecessor, candidate, predecessorTree, candidateTree } = input;
  const changedPaths = gitPaths(repository, path, ["diff", "--name-only", "-z", predecessorTree, candidateTree]);
  if (changedPaths.length === 0) return "complete";
  const workspaceTree = captureWorkspaceTree(repository, path).tree;
  const candidateIndex = indexMatchesTreeOnPaths(repository, path, candidateTree, changedPaths);
  const candidateWorkspace = workspaceMatchesTreeOnPaths(repository, path, candidateTree, workspaceTree, changedPaths);
  if (candidateIndex && candidateWorkspace) return "complete";

  if (workspaceTree === candidateTree) {
    runGit(repository, ["-C", path, "read-tree", gitObjectIdForSnapshot(candidate)]);
    return "recovered";
  }

  const predecessorIndex = indexMatchesTreeOnPaths(repository, path, predecessorTree, changedPaths);
  if (predecessorIndex && candidateWorkspace) {
    runGit(repository, [
      "-C",
      path,
      "read-tree",
      "-i",
      "-m",
      gitObjectIdForSnapshot(predecessor),
      gitObjectIdForSnapshot(candidate),
    ]);
    return "recovered";
  }

  const predecessorWorkspace = workspaceMatchesTreeOnPaths(repository, path, predecessorTree, workspaceTree, changedPaths);
  if (!predecessorIndex || !predecessorWorkspace) return "retained";
  runGit(repository, [
    "-C",
    path,
    "read-tree",
    "-m",
    "-u",
    gitObjectIdForSnapshot(predecessor),
    gitObjectIdForSnapshot(candidate),
  ]);
  return "recovered";
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
    try {
      const recovery = recoverCheckout({
        repository,
        path: worktree.path,
        predecessor: delivery.data.expectedPredecessor,
        candidate: delivery.data.candidate,
        predecessorTree,
        candidateTree,
      });
      if (recovery === "retained") {
        lag.push(recoveryLag(worktree.path, target, "target checkout entries are neither predecessor nor candidate"));
        continue;
      }
      if (recovery === "recovered") {
        effects.push({ kind: "target-checkout", path: worktree.path, target, action: "recovered" });
      }
    } catch (error) {
      lag.push(recoveryLag(worktree.path, target, diagnostic(error)));
    }
  }
  return { effects, lag };
}
