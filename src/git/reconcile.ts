import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireSqliteTransactionLock, type HeldSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  commonGitDirectory,
  DELIVERY_REF_NAMESPACE,
  readRef,
  registeredWorktreePaths,
  runGit,
  worktreeGitDirectory,
  type GitOid,
  type GitRepository,
} from "./repository.js";
import type { ContractId, ContractState, SnapshotId } from "../core/facts/types.js";
import { contractLocator, contractPhysicalName, gitObjectIdForSnapshot } from "./identity.js";
import { observeContract } from "./observe.js";
import {
  acquireTargetPlacementFence,
  recoverTargetPlacement,
  type TargetCheckoutEffect,
  type TargetCheckoutLag,
} from "./target-placement.js";
import {
  runCreateHooks,
  runDestroyHooks,
  type WorktreeHookLag,
  type WorktreeHooks,
} from "./hooks.js";
import { deliveryWorktreePath } from "./workspace.js";

export type Effect =
  | Readonly<{
      kind: "worktree";
      path: string;
      action: "created" | "removed" | "unchanged";
    }>
  | TargetCheckoutEffect
  | Readonly<{
      kind: "ref";
      name: string;
      before: GitOid | null;
      after: GitOid | null;
      action: "created" | "updated" | "removed" | "unchanged";
    }>;
type ReconcileInput = Readonly<{
  repository: GitRepository;
  contractId: ContractId;
  hooks: WorktreeHooks;
  retryHooks: boolean;
}>;
type WorktreeRetained = Readonly<{
  kind: "worktree-retained";
  path: string;
}>;
export type ReconcileFailure = Readonly<{
  kind: "reconcile-failed";
  stage: "observation" | "effect";
  diagnostic: string;
}>;
export type ReconcileLag = WorktreeRetained | TargetCheckoutLag | WorktreeHookLag | ReconcileFailure;
export type ReconcileResult = Readonly<{
  effects: readonly Effect[];
  lag: readonly ReconcileLag[];
}>;
type ReconcileBatchItem = Readonly<{ contract: ContractId; state: ContractState | null; result: ReconcileResult }>;
export type GitReconcileObservation = Readonly<{ state: ContractState | null; result: ReconcileResult }>;

type WorktreeTopology = Readonly<{ paths: Set<string> }>;

function deliveryRefFor(contract: ContractId): string { return `${DELIVERY_REF_NAMESPACE}/${contractPhysicalName(contract)}`; }
function candidatePinRefFor(contract: ContractId): string { return `${CANDIDATE_PIN_REF_NAMESPACE}/${contractPhysicalName(contract)}`; }
function updateRef(repository: GitRepository, ref: string, desired: SnapshotId): Effect {
  const before = readRef(repository, ref);
  if (before === desired) return { kind: "ref", name: ref, action: "unchanged", before, after: desired };
  runGit(repository, ["update-ref", "--no-deref", ref, gitObjectIdForSnapshot(desired), before ?? "0".repeat(desired.length)]);
  return { kind: "ref", name: ref, action: before === null ? "created" : "updated", before, after: desired };
}
function removeRef(repository: GitRepository, ref: string): Effect {
  const before = readRef(repository, ref);
  if (before === null) return { kind: "ref", name: ref, action: "unchanged", before: null, after: null };
  runGit(repository, ["update-ref", "--no-deref", "-d", ref, before]);
  return { kind: "ref", name: ref, action: "removed", before, after: null };
}
function acquireWorktreeTopology(repository: GitRepository): WorktreeTopology {
  return { paths: new Set(registeredWorktreePaths(repository)) };
}
function fromPrimaryWorktree(repository: GitRepository): GitRepository {
  return { ...repository, effectiveCwd: repository.primaryWorktree };
}
function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function complete(effects: readonly Effect[] = [], lag: readonly ReconcileLag[] = []): ReconcileResult {
  return { effects, lag };
}

function failed(
  stage: ReconcileFailure["stage"],
  error: unknown,
  effects: readonly Effect[] = [],
  lag: readonly ReconcileLag[] = [],
): ReconcileResult {
  if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
  return { effects, lag: [...lag, { kind: "reconcile-failed", stage, diagnostic: diagnostic(error) }] };
}

function reconcileLockPath(repository: GitRepository, contract: ContractId): string {
  const locator = contractLocator(contract);
  return join(commonGitDirectory(repository), "keiyaku", "locks", "reconcile", locator.slice(0, 2), `${locator.slice(2)}.sqlite`);
}

function worktree(repository: GitRepository, topology: WorktreeTopology, path: string, desired: SnapshotId): Effect {
  const registered = topology.paths.has(path);
  if (registered && existsSync(path)) return { kind: "worktree", path, action: "unchanged" };
  if (registered) {
    runGit(repository, ["worktree", "remove", path]);
    topology.paths.delete(path);
  }
  if (existsSync(path)) throw new Error(`delivery worktree path is occupied: ${path}`);
  mkdirSync(dirname(path), { recursive: true }); runGit(repository, ["worktree", "add", "--detach", path, gitObjectIdForSnapshot(desired)]);
  topology.paths.add(path);
  return { kind: "worktree", path, action: "created" };
}
function canRemoveWorktree(repository: GitRepository, path: string, expected: readonly SnapshotId[]): boolean {
  if (runGit(repository, ["-C", path, "status", "--porcelain", "--untracked-files=all"]).length !== 0) return false;
  const [head, headTree] = runGit(repository, ["-C", path, "rev-parse", "HEAD", "HEAD^{tree}"])
    .toString("utf8").trim().split("\n");
  const matched = expected.find((snapshot) => head === gitObjectIdForSnapshot(snapshot));
  if (matched === undefined) return false;
  const expectedTree = runGit(repository, ["-C", path, "rev-parse", `${gitObjectIdForSnapshot(matched)}^{tree}`])
    .toString("utf8").trim();
  return headTree === expectedTree;
}
function removeWorktree(
  repository: GitRepository,
  topology: WorktreeTopology,
  path: string,
): Readonly<{ effect: Effect; retained: boolean }> {
  const registered = topology.paths.has(path);
  if (!registered) return { effect: { kind: "worktree", path, action: "unchanged" }, retained: false };
  if (!existsSync(path)) {
    runGit(repository, ["worktree", "remove", path]);
    topology.paths.delete(path);
    return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
  }
  try {
    runGit(repository, ["worktree", "remove", path]);
  } catch {
    return { effect: { kind: "worktree", path, action: "unchanged" }, retained: true };
  }
  topology.paths.delete(path);
  return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
}

async function reconcileTargetCheckouts(repository: GitRepository, state: ContractState): Promise<ReconcileResult> {
  if (state.terminal?.kind !== "claimed" || state.coordinates.target === undefined || state.delivery === null) {
    return complete();
  }
  let held: HeldSqliteTransactionLock;
  try {
    held = await acquireTargetPlacementFence(repository, state.coordinates.target);
  } catch (error) {
    return failed("effect", error);
  }
  let result: ReconcileResult | undefined;
  let exceptional: unknown;
  try {
    const recovered = recoverTargetPlacement(repository, state);
    result = complete(recovered.effects, recovered.lag);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) exceptional = error;
    else result = failed("effect", error);
  }
  let releaseFailure: unknown;
  try {
    held.close();
  } catch (error) {
    releaseFailure = error;
  }
  if (exceptional !== undefined) throw exceptional;
  if (result === undefined) throw new Error("target checkout reconcile produced no result");
  if (releaseFailure !== undefined) result = failed("effect", releaseFailure, result.effects, result.lag);
  return result;
}

async function reconcileWithTopology(
  { repository, hooks, retryHooks }: ReconcileInput,
  state: ContractState | null,
  topology: WorktreeTopology,
): Promise<ReconcileResult> {
  const effects: Effect[] = [];
  const lag: ReconcileLag[] = [];
  try {
    if (!state) return complete(effects, lag);
    const targetCheckouts = await reconcileTargetCheckouts(repository, state);
    effects.push(...targetCheckouts.effects);
    lag.push(...targetCheckouts.lag);
    const ref = deliveryRefFor(state.id), pin = candidatePinRefFor(state.id), path = deliveryWorktreePath(repository, state.id);
    if (state.coordinates.workspace === "here") {
      if (state.terminal) effects.push(removeRef(repository, pin));
      else if (state.bound) effects.push(state.delivery === null
        ? removeRef(repository, pin)
        : updateRef(repository, pin, state.delivery.data.integration.snapshot));
      return complete(effects, lag);
    }
    if (state.terminal) {
      const expected = state.delivery === null
        ? [state.coordinates.start]
        : [state.delivery.data.tenderSnapshot, state.coordinates.start];
      const primary = fromPrimaryWorktree(repository);
      const retain = (retainedLag: ReconcileLag): ReconcileResult => {
        effects.push(updateRef(primary, ref, state.delivery?.data.tenderSnapshot ?? state.coordinates.start));
        effects.push(state.delivery === null ? removeRef(primary, pin) : updateRef(primary, pin, state.delivery.data.integration.snapshot));
        effects.push({ kind: "worktree", path, action: "unchanged" });
        lag.push(retainedLag);
        return complete(effects, lag);
      };
      const registered = topology.paths.has(path);
      if (registered && existsSync(path)) {
        if (!canRemoveWorktree(primary, path, expected)) return retain({ kind: "worktree-retained", path });
        const hookLag = await runDestroyHooks(path, worktreeGitDirectory(primary, path), hooks, retryHooks);
        if (hookLag !== null) return retain(hookLag);
      }
      const removal = removeWorktree(primary, topology, path);
      if (removal.retained) return retain({ kind: "worktree-retained", path });
      effects.push(removal.effect);
      effects.push(removeRef(primary, ref));
      effects.push(removeRef(primary, pin));
      return complete(effects, lag);
    }
    if (!state.bound) return complete(effects, lag);
    const desired = state.delivery?.data.tenderSnapshot ?? state.coordinates.start;
    effects.push(updateRef(repository, ref, desired));
    effects.push(worktree(repository, topology, path, desired));
    const hookLag = await runCreateHooks(path, worktreeGitDirectory(repository, path), hooks, retryHooks);
    if (hookLag !== null) lag.push(hookLag);
    effects.push(state.delivery ? updateRef(repository, pin, state.delivery.data.integration.snapshot) : removeRef(repository, pin));
    return complete(effects, lag);
  } catch (error) {
    return failed("effect", error, effects, lag);
  }
}

function needsWorktreeTopology(state: ContractState | null): boolean {
  return state !== null && state.coordinates.workspace === "worktree" && (state.terminal !== null || state.bound !== null);
}

function releaseFailure(
  held: HeldSqliteTransactionLock,
  observation: GitReconcileObservation | undefined,
): GitReconcileObservation | undefined {
  try {
    held.close();
    return observation;
  } catch (error) {
    const prior = observation?.result;
    return {
      state: observation?.state ?? null,
      result: failed("effect", error, prior?.effects, prior?.lag),
    };
  }
}

export async function reconcile(input: ReconcileInput): Promise<GitReconcileObservation> {
  let held: HeldSqliteTransactionLock;
  try {
    held = await acquireSqliteTransactionLock({
      path: reconcileLockPath(input.repository, input.contractId),
      mode: "immediate",
    });
  } catch (error) {
    return { state: null, result: failed("observation", error) };
  }

  let observation: GitReconcileObservation | undefined;
  let exceptional: unknown;
  try {
    const state = observeContract(input.repository, input.contractId).state;
    const topology = needsWorktreeTopology(state)
      ? acquireWorktreeTopology(input.repository)
      : { paths: new Set<string>() };
    observation = {
      state,
      result: await reconcileWithTopology(input, state, topology),
    };
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) exceptional = error;
    else observation = { state: null, result: failed("observation", error) };
  }

  observation = releaseFailure(held, observation);
  if (exceptional !== undefined) throw exceptional;
  if (observation === undefined) throw new Error("reconcile produced no observation");
  return observation;
}

export function reconcileObservationFailure(error: unknown): ReconcileResult {
  return failed("observation", error);
}

export function reconcileEffectFailure(error: unknown, prior?: ReconcileResult): ReconcileResult {
  return failed("effect", error, prior?.effects, prior?.lag);
}

async function reconcileBatchItem(
  repository: GitRepository,
  contract: ContractId,
  hooks: WorktreeHooks,
  retryHooks: boolean,
): Promise<ReconcileBatchItem> {
  const observation = await reconcile({ repository, contractId: contract, hooks, retryHooks });
  return {
    contract,
    state: observation.state,
    result: observation.result,
  };
}

/** Reconcile each discovered Contract through its own serialized, fresh observation. */
export async function reconcileBatch(
  repository: GitRepository,
  contracts: Iterable<ContractId>,
  hooks: WorktreeHooks,
  retryHooks: boolean,
): Promise<readonly ReconcileBatchItem[]> {
  const items: ReconcileBatchItem[] = [];
  for (const contract of contracts) items.push(await reconcileBatchItem(repository, contract, hooks, retryHooks));
  return items;
}
