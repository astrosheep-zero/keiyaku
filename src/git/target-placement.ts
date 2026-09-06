import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  acquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import type { ContractId, ContractState, SnapshotId } from "../core/facts/types.js";
import type { RefOperation } from "../core/facts/offer.js";
import { gitObjectId, gitObjectIdForSnapshot, gitRefLocator, mintSnapshotId, type GitObjectId } from "./identity.js";
import { commonGitDirectory, decodeGitNameOnly, readRef, registeredWorktrees } from "./repository.js";
import { consumeGitStdout, GitPlumbingError, runGit, type GitRepository } from "./process.js";
import { captureWorkspaceTree } from "./workspace.js";

export type CheckoutNotFollowableRefusal = Readonly<{
  kind: "checkout-not-followable";
  contractId: ContractId;
  target: string;
  path: string;
  reason: "staged" | "dirty-tracked" | "unmerged" | "untracked";
  paths: readonly string[];
}>;

export type TargetPlacementRefusal = CheckoutNotFollowableRefusal;

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

type FollowArm = Readonly<{ kind: "ordinary"; path: string }>;

export type PreparedTargetPlacement = Readonly<{
  target: RefOperation;
  arms: readonly FollowArm[];
}>;

export type TargetPlacementPreparation =
  | Readonly<{ kind: "prepared"; placement: PreparedTargetPlacement }>
  | Readonly<{ kind: "refused"; refusal: TargetPlacementRefusal }>;

export async function observeTargetHead(repository: GitRepository, target: string): Promise<SnapshotId | null> {
  const value = await readRef(repository, target);
  return value === null ? null : mintSnapshotId(value);
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function gitPaths(repository: GitRepository, path: string, args: readonly string[]): Promise<readonly string[]> {
  return [...new Set(decodeGitNameOnly(await runGit(repository, ["-C", path, ...args])))].sort();
}

function literalPath(path: string): string {
  return `:(literal)${path}`;
}

async function commitTree(repository: GitRepository, snapshot: SnapshotId): Promise<GitObjectId> {
  return gitObjectId(
    (await runGit(repository, ["show", "-s", "--format=%T", gitObjectIdForSnapshot(snapshot)])).toString("utf8").trim(),
    "commit tree",
  );
}

export async function observedTreeEqualsCandidate(
  repository: GitRepository,
  observed: SnapshotId | null,
  snapshot: SnapshotId,
) {
  if (observed === null) return false;
  return (await commitTree(repository, observed)) === (await commitTree(repository, snapshot));
}

function checkoutRefusal(
  contractId: ContractId,
  target: RefOperation,
  path: string,
  reason: CheckoutNotFollowableRefusal["reason"],
  paths: readonly string[],
): CheckoutNotFollowableRefusal {
  return { kind: "checkout-not-followable", contractId, target: target.target, path, reason, paths };
}

type CheckoutObservation = Readonly<{
  repository: GitRepository;
  contractId: ContractId;
  target: RefOperation;
  path: string;
  predecessor: GitObjectId;
  candidate: GitObjectId;
}>;

async function changedPaths(
  repository: GitRepository,
  path: string,
  predecessor: GitObjectId,
  candidate: GitObjectId,
  filter?: string,
): Promise<readonly string[]> {
  return await gitPaths(repository, path, [
    "diff",
    "--name-only",
    "--no-renames",
    ...(filter === undefined ? [] : [`--diff-filter=${filter}`]),
    "-z",
    predecessor,
    candidate,
  ]);
}

async function dryRunRefusal(
  input: CheckoutObservation,
  scopes: readonly PhysicalScope[],
): Promise<CheckoutNotFollowableRefusal | null> {
  const { repository, contractId, target, path, predecessor, candidate } = input;
  const changed = await changedPaths(repository, path, predecessor, candidate);
  const pathspecs = changed.map(literalPath);
  if (pathspecs.length === 0) return null;

  const unmerged = await gitPaths(repository, path, [
    "diff",
    "--name-only",
    "--diff-filter=U",
    "-z",
    "--",
    ...pathspecs,
  ]);
  if (unmerged.length > 0) return checkoutRefusal(contractId, target, path, "unmerged", unmerged);

  const staged = await gitPaths(repository, path, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    predecessor,
    "--",
    ...pathspecs,
  ]);
  if (staged.length > 0) return checkoutRefusal(contractId, target, path, "staged", staged);

  const dirty = await gitPaths(repository, path, ["diff-files", "--name-only", "-z", "--", ...pathspecs]);
  if (dirty.length > 0) return checkoutRefusal(contractId, target, path, "dirty-tracked", dirty);

  return await untrackedRefusalWithinScopes(input, scopes, false);
}

type PhysicalScope = Readonly<{
  path: string;
  kind: "leaf" | "directory";
}>;

async function physicalScope(worktree: string, candidatePath: string): Promise<PhysicalScope | null> {
  const components = candidatePath.split("/");
  for (let index = 0; index < components.length; index += 1) {
    const scope = components.slice(0, index + 1).join("/");
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(resolve(worktree, ...components.slice(0, index + 1)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    if (!stat.isDirectory()) return { path: scope, kind: "leaf" };
    if (index + 1 === components.length) return { path: scope, kind: "directory" };
  }
  return null;
}

async function candidateEntryIsBlob(
  repository: GitRepository,
  path: string,
  snapshot: GitObjectId,
  candidatePath: string,
): Promise<boolean> {
  const output = await runGit(repository, ["-C", path, "ls-tree", "-z", snapshot, "--", literalPath(candidatePath)]);
  const records = output
    .toString("utf8")
    .split("\0")
    .filter((record) => record.length > 0);
  if (records.length !== 1) throw new Error(`candidate path has no unique Git entry: ${candidatePath}`);
  const separator = records[0]!.indexOf("\t");
  if (separator < 0) throw new Error(`candidate path has a malformed Git entry: ${candidatePath}`);
  const fields = records[0]!.slice(0, separator).split(" ");
  return fields[1] === "blob";
}

async function destructionScopes(
  repository: GitRepository,
  path: string,
  snapshot: GitObjectId,
  writes: readonly string[],
): Promise<readonly PhysicalScope[]> {
  const scopes = new Map<string, PhysicalScope>();
  for (const write of writes) {
    const scope = await physicalScope(path, write);
    if (scope === null) continue;
    if (scope.kind === "directory" && !(await candidateEntryIsBlob(repository, path, snapshot, write))) continue;
    scopes.set(scope.path, scope);
  }
  return [...scopes.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function untrackedArgs(ignored: boolean): readonly string[] {
  return [
    "ls-files",
    "--others",
    ...(ignored ? ["--ignored"] : []),
    "--exclude-standard",
    "--directory",
    "--no-empty",
    "-z",
  ];
}

async function untrackedRefusalWithinScopes(
  input: CheckoutObservation,
  scopes: readonly PhysicalScope[],
  ignored: boolean,
): Promise<CheckoutNotFollowableRefusal | null> {
  const { repository, contractId, target, path } = input;
  const args = untrackedArgs(ignored);
  const leaves = scopes.filter((scope) => scope.kind === "leaf");
  if (leaves.length > 0) {
    const collisions = await gitPaths(repository, path, [
      ...args,
      "--",
      ...leaves.map((scope) => literalPath(scope.path)),
    ]);
    if (collisions.length > 0) return checkoutRefusal(contractId, target, path, "untracked", collisions);
  }

  for (const scope of scopes) {
    if (scope.kind !== "directory") continue;
    let found = false;
    await consumeGitStdout(repository, ["-C", path, ...args, "--", literalPath(scope.path)], (chunk) => {
      if (chunk.length > 0) found = true;
    });
    if (found) return checkoutRefusal(contractId, target, path, "untracked", [scope.path]);
  }
  return null;
}

async function indexMatchesTreeOnPaths(
  repository: GitRepository,
  path: string,
  tree: GitObjectId,
  paths: readonly string[],
): Promise<boolean> {
  return (
    (await gitPaths(repository, path, ["diff-index", "--cached", "--name-only", "-z", tree, "--", ...paths])).length ===
    0
  );
}

async function workspaceMatchesTreeOnPaths(
  repository: GitRepository,
  path: string,
  tree: GitObjectId,
  workspaceTree: GitObjectId,
  paths: readonly string[],
): Promise<boolean> {
  return (
    (await gitPaths(repository, path, ["diff", "--name-only", "-z", tree, workspaceTree, "--", ...paths])).length === 0
  );
}

async function ordinaryPrecheck(
  repository: GitRepository,
  contractId: ContractId,
  target: RefOperation,
  path: string,
): Promise<CheckoutNotFollowableRefusal | null> {
  const predecessor = gitObjectIdForSnapshot(target.expectedOid);
  const candidate = gitObjectIdForSnapshot(target.newOid);
  const observation = { repository, contractId, target, path, predecessor, candidate };
  let dryRunFailed = false;
  try {
    await runGit(repository, ["-C", path, "read-tree", "--dry-run", "-m", "-u", predecessor, candidate]);
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    dryRunFailed = true;
  }
  const writes = await changedPaths(repository, path, predecessor, candidate, "ACMRT");
  const scopes = await destructionScopes(repository, path, candidate, writes);
  if (dryRunFailed) return await dryRunRefusal(observation, scopes);
  return await untrackedRefusalWithinScopes(observation, scopes, true);
}

export async function acquireTargetPlacementFence(
  repository: GitRepository,
  target: string,
): Promise<HeldSqliteTransactionLock> {
  const locator = gitRefLocator(target);
  return await acquireSqliteTransactionLock({
    path: resolve(commonGitDirectory(repository), "keiyaku", "locks", "target-placement", `${locator}.sqlite`),
    mode: "immediate",
    timeoutMs: 5_000,
    ...(repository.signal === undefined ? {} : { signal: repository.signal }),
  });
}

export type TargetedContractCoordinates = ContractState["coordinates"] & Readonly<{ target: string }>;

export type TargetPlacementObservationInput = Readonly<{
  contractId: ContractId;
  coordinates: TargetedContractCoordinates;
  predecessor: SnapshotId;
  candidate: SnapshotId;
}>;

export type TargetPlacementObservation =
  | Readonly<{ kind: "ready"; arms: readonly FollowArm[] }>
  | Readonly<{ kind: "refused"; refusal: TargetPlacementRefusal }>;

/** Observe whether registered target checkouts can follow a predecessor-to-candidate movement. */
export async function observeTargetPlacement(
  repository: GitRepository,
  input: TargetPlacementObservationInput,
): Promise<TargetPlacementObservation> {
  const target: RefOperation = {
    target: input.coordinates.target,
    expectedOid: input.predecessor,
    newOid: input.candidate,
  };
  const worktrees = (await registeredWorktrees(repository))
    .filter((worktree) => worktree.branch === target.target)
    .sort((left, right) => left.path.localeCompare(right.path));
  const arms: FollowArm[] = [];
  for (const worktree of worktrees) {
    const refusal = await ordinaryPrecheck(repository, input.contractId, target, worktree.path);
    if (refusal !== null) return { kind: "refused", refusal };
    arms.push({ kind: "ordinary", path: worktree.path });
  }
  return { kind: "ready", arms };
}

export type AuditTargetAnswer =
  | Readonly<{ kind: "placeable"; ref: string; head: SnapshotId }>
  | Readonly<{ kind: "moved"; ref: string; expected: SnapshotId; observed: SnapshotId | null }>
  | Readonly<{ kind: "refused"; refusal: TargetPlacementRefusal }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

/** Adjudicate the complete post-Verification audit target answer without placing. */
export async function adjudicateAuditTarget(
  repository: GitRepository,
  input: TargetPlacementObservationInput,
): Promise<AuditTargetAnswer> {
  const ref = input.coordinates.target;
  const expected = input.predecessor;
  try {
    const head = await observeTargetHead(repository, ref);
    if (head !== expected) return { kind: "moved", ref, expected, observed: head };
    const follow = await observeTargetPlacement(repository, input);
    const observed = await observeTargetHead(repository, ref);
    if (observed !== expected) return { kind: "moved", ref, expected, observed };
    return follow.kind === "refused"
      ? { kind: "refused", refusal: follow.refusal }
      : { kind: "placeable", ref, head: expected };
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    return { kind: "failed", diagnostic: error.message };
  }
}

export async function prepareTargetPlacement(
  repository: GitRepository,
  state: ContractState,
  target: RefOperation,
): Promise<TargetPlacementPreparation> {
  if (state.coordinates.target !== target.target || state.currentIntegration?.snapshot !== target.newOid) {
    throw new Error("placement state does not match its offered target movement");
  }
  const observation = await observeTargetPlacement(repository, {
    contractId: state.id,
    coordinates: { ...state.coordinates, target: target.target },
    predecessor: target.expectedOid,
    candidate: target.newOid,
  });
  return observation.kind === "refused"
    ? observation
    : { kind: "prepared", placement: { target, arms: observation.arms } };
}

export async function followTargetPlacement(
  repository: GitRepository,
  prepared: PreparedTargetPlacement,
): Promise<TargetPlacementPhysicalResult> {
  const effects: TargetCheckoutEffect[] = [];
  const lag: TargetCheckoutLag[] = [];
  const predecessor = gitObjectIdForSnapshot(prepared.target.expectedOid);
  const candidate = gitObjectIdForSnapshot(prepared.target.newOid);
  for (const arm of prepared.arms) {
    try {
      await runGit(repository, ["-C", arm.path, "read-tree", "-m", "-u", predecessor, candidate]);
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

type CheckoutInput = Readonly<{
  repository: GitRepository;
  path: string;
  predecessor: SnapshotId;
  candidate: SnapshotId;
  predecessorTree: GitObjectId;
  candidateTree: GitObjectId;
}>;
type CheckoutClassification =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "retained" }>
  | Readonly<{ kind: "recoverable"; action: "index-merge" | "worktree-merge" }>;

async function classifyCheckout(input: CheckoutInput): Promise<CheckoutClassification> {
  const { repository, path, predecessorTree, candidateTree } = input;
  const changedPaths = await gitPaths(repository, path, ["diff", "--name-only", "-z", predecessorTree, candidateTree]);
  if (changedPaths.length === 0) return { kind: "complete" };
  const workspaceTree = (await captureWorkspaceTree(repository, path)).tree;
  const candidateIndex = await indexMatchesTreeOnPaths(repository, path, candidateTree, changedPaths);
  const candidateWorkspace = await workspaceMatchesTreeOnPaths(
    repository,
    path,
    candidateTree,
    workspaceTree,
    changedPaths,
  );
  if (candidateIndex && candidateWorkspace) return { kind: "complete" };
  const predecessorIndex = await indexMatchesTreeOnPaths(repository, path, predecessorTree, changedPaths);
  if (predecessorIndex && candidateWorkspace) return { kind: "recoverable", action: "index-merge" };
  return !predecessorIndex ||
    !(await workspaceMatchesTreeOnPaths(repository, path, predecessorTree, workspaceTree, changedPaths))
    ? { kind: "retained" }
    : { kind: "recoverable", action: "worktree-merge" };
}

/** Judge the target-checkout shape without mutating refs, worktrees, or indexes. */
export async function observeTargetCheckoutShape(
  repository: GitRepository,
  input: Readonly<{ path: string; predecessor: SnapshotId; candidate: SnapshotId }>,
): Promise<"complete" | "recoverable" | "retained"> {
  const [predecessorTree, candidateTree] = await Promise.all([
    commitTree(repository, input.predecessor),
    commitTree(repository, input.candidate),
  ]);
  return (await classifyCheckout({ repository, ...input, predecessorTree, candidateTree })).kind;
}

async function recoverCheckout(input: CheckoutInput): Promise<"complete" | "recovered" | "retained"> {
  const classified = await classifyCheckout(input);
  if (classified.kind === "complete") return "complete";
  if (classified.kind === "retained") return "retained";
  const { repository, path, predecessor, candidate } = input;
  if (classified.action === "index-merge") {
    await runGit(repository, [
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
  await runGit(repository, [
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

export async function recoverTargetPlacement(
  repository: GitRepository,
  state: ContractState,
): Promise<TargetPlacementPhysicalResult> {
  const target = state.coordinates.target;
  const delivery = state.delivery;
  if (state.terminal?.kind !== "claimed" || target === undefined || delivery === null) return { effects: [], lag: [] };
  const integration = state.currentIntegration;
  if (integration === null || (await readRef(repository, target)) !== integration.snapshot)
    return { effects: [], lag: [] };

  const candidateTree = await commitTree(repository, integration.snapshot);
  const predecessorTree = await commitTree(repository, integration.predecessor);
  const worktrees = (await registeredWorktrees(repository))
    .filter((worktree) => worktree.branch === target)
    .sort((left, right) => left.path.localeCompare(right.path));
  const effects: TargetCheckoutEffect[] = [];
  const lag: TargetCheckoutLag[] = [];
  for (const worktree of worktrees) {
    try {
      const recovery = await recoverCheckout({
        repository,
        path: worktree.path,
        predecessor: integration.predecessor,
        candidate: integration.snapshot,
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
