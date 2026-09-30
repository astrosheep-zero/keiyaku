import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acquireSqliteTransactionLock,
  SqliteTransactionLockError,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  commonGitDirectory,
  DELIVERY_REF_NAMESPACE,
  registeredWorktreePaths,
  type GitOid,
} from "./repository.js";
import { runGit, GitPlumbingError, type GitRepository } from "./process.js";
import type { ContractId, ContractState, SnapshotId } from "../core/facts/types.js";
import { contractLocator, contractPhysicalName, gitObjectIdForSnapshot } from "./identity.js";
import { observeContractAt } from "./observe.js";
import type { GitDecodeChannel } from "./read-observation.js";
import {
  acquireTargetPlacementFence,
  recoverTargetPlacement,
  type TargetCheckoutEffect,
  type TargetCheckoutLag,
} from "./target-placement.js";
import { runCreateHooks, type WorktreeHookLag, type WorktreeHooks } from "./hooks.js";
import { followDependentManagedWorktree, retireConflictHandoff, worktreePath } from "./workspace.js";
import { removeCollectableScratchWorktrees } from "./scratch.js";
import { reconcileTerminalManagedWorktree, removeRef, updateRef } from "./terminal-reconcile.js";
import type { UnsealedBytes } from "./terminal-seal.js";

class WorktreeCustodyError extends Error {}

const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export type Effect =
  | Readonly<{ kind: "worktree"; path: string; action: "created" | "removed" | "unchanged" }>
  | Readonly<{ kind: "worktree"; path: string; action: "followed"; before: SnapshotId; after: SnapshotId }>
  | Readonly<{
      kind: "recovery-snapshot";
      action: "created";
      snapshot: SnapshotId;
      retention: "ephemeral";
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
  channel: GitDecodeChannel;
  contractId: ContractId;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  retainTerminalWorktree?: boolean;
  place?: string;
  onPhysical?: (report: ReconcileResult) => void;
}>;
type ReconcileEffectsInput = ReconcileInput;
type WorktreeRetained = Readonly<{ kind: "worktree-retained"; path: string; diagnostic?: string }>;
type WorktreeFollowRetained = Readonly<{
  kind: "worktree-follow-retained";
  path: string;
  tender: SnapshotId;
  head: SnapshotId;
  reason: "head-moved" | "head-attached" | "operation-in-progress" | "unsupported-parent-shape";
  paths?: readonly string[];
}>;
export type ReconcileFailure = Readonly<{
  kind: "reconcile-failed";
  stage: "observation" | "effect";
  diagnostic: string;
}>;
export type ReconcileLag =
  | WorktreeRetained
  | WorktreeFollowRetained
  | UnsealedBytes
  | TargetCheckoutLag
  | WorktreeHookLag
  | ReconcileFailure;
export type ReconcileResult = Readonly<{
  effects: readonly Effect[];
  lag: readonly ReconcileLag[];
  hookRuns?: readonly { phase: "create" | "destroy"; name: string }[];
}>;
type ReconcileBatchItem = Readonly<{
  contract: ContractId;
  state: ContractState | null;
  result: ReconcileResult;
}>;
export type GitReconcileObservation = Readonly<{
  state: ContractState | null;
  result: ReconcileResult;
}>;
export type WorktreeTopology = Readonly<{ paths: Set<string> }>;
export type ReconcileAccumulation = Readonly<{
  effects: Effect[];
  lag: ReconcileLag[];
  hookRuns: { phase: "create" | "destroy"; name: string }[];
  recordEffect(...effects: readonly Effect[]): void;
  recordLag(...lag: readonly ReconcileLag[]): void;
}>;

function deliveryRefFor(contract: ContractId): string {
  return `${DELIVERY_REF_NAMESPACE}/${contractPhysicalName(contract)}`;
}
function candidatePinRefFor(contract: ContractId): string {
  return `${CANDIDATE_PIN_REF_NAMESPACE}/${contractPhysicalName(contract)}`;
}

function missingPlaceLag(repository: GitRepository): ReconcileFailure {
  return {
    kind: "reconcile-failed",
    stage: "effect",
    diagnostic: `managed Contract is unappointed: ${join(repository.commonDirectory, "keiyaku", "places.json")}`,
  };
}
async function acquireWorktreeTopology(repository: GitRepository): Promise<WorktreeTopology> {
  return { paths: new Set(await registeredWorktreePaths(repository)) };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function complete(
  effects: readonly Effect[] = [],
  lag: readonly ReconcileLag[] = [],
  hookRuns: readonly { phase: "create" | "destroy"; name: string }[] = [],
): ReconcileResult {
  return hookRuns.length === 0 ? { effects, lag } : { effects, lag, hookRuns };
}
/** Append owner observations and publish those same objects before the next await. */
function reconcileAccumulation(onPhysical: ReconcileInput["onPhysical"]): ReconcileAccumulation {
  const effects: Effect[] = [];
  const lag: ReconcileLag[] = [];
  return {
    effects,
    lag,
    hookRuns: [],
    recordEffect(...observed) {
      effects.push(...observed);
      if (observed.length > 0) onPhysical?.({ effects: observed, lag: [] });
    },
    recordLag(...observed) {
      lag.push(...observed);
      if (observed.length > 0) onPhysical?.({ effects: [], lag: observed });
    },
  };
}

function failed(
  stage: ReconcileFailure["stage"],
  error: unknown,
  effects: readonly Effect[] = [],
  lag: readonly ReconcileLag[] = [],
): ReconcileResult {
  if (
    !(
      error instanceof WorktreeCustodyError ||
      error instanceof GitPlumbingError ||
      error instanceof SqliteTransactionLockError ||
      (error instanceof Error &&
        !(error instanceof AuthorityCorruptionError) &&
        !(error instanceof TypeError) &&
        "code" in error &&
        typeof error.code === "string" &&
        /^E[A-Z0-9]+$/u.test(error.code))
    )
  )
    throw error;
  return { effects, lag: [...lag, { kind: "reconcile-failed", stage, diagnostic: diagnostic(error) }] };
}

function reconcileLockPath(repository: GitRepository, contract: ContractId): string {
  const locator = contractLocator(contract);
  return join(
    commonGitDirectory(repository),
    "keiyaku",
    "locks",
    "reconcile",
    locator.slice(0, 2),
    `${locator.slice(2)}.sqlite`,
  );
}

async function worktree(
  repository: GitRepository,
  topology: WorktreeTopology,
  path: string,
  desired: SnapshotId,
): Promise<Effect> {
  const registered = topology.paths.has(path);
  if (registered && (await pathExists(path))) return { kind: "worktree", path, action: "unchanged" };
  if (registered) {
    await runGit(repository, ["worktree", "remove", path]);
    topology.paths.delete(path);
  }
  if (await pathExists(path)) throw new WorktreeCustodyError(`delivery worktree path is occupied: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await runGit(repository, ["worktree", "add", "--detach", path, gitObjectIdForSnapshot(desired)]);
  topology.paths.add(path);
  return { kind: "worktree", path, action: "created" };
}
async function removeCollectableScratch(
  repository: GitRepository,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
): Promise<void> {
  for (const removal of await removeCollectableScratchWorktrees(repository, topology.paths)) {
    acc.recordEffect({ kind: "worktree", path: removal.path, action: removal.action });
    if (removal.retained)
      acc.recordLag({
        kind: "worktree-retained",
        path: removal.path,
        ...(removal.diagnostic === undefined ? {} : { diagnostic: removal.diagnostic }),
      });
  }
}

async function reconcileTargetCheckouts(
  repository: GitRepository,
  state: ContractState,
  onPhysical?: (report: ReconcileResult) => void,
): Promise<ReconcileResult> {
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
  let exceptional: { error: unknown } | undefined;
  try {
    const recovered = await recoverTargetPlacement(repository, state, onPhysical);
    result = complete(recovered.effects, recovered.lag);
  } catch (error) {
    try {
      result = failed("effect", error);
    } catch (unexpected) {
      exceptional = { error: unexpected };
    }
  }
  let releaseFailure: unknown;
  try {
    held.close();
  } catch (error) {
    releaseFailure = error;
  }
  if (exceptional !== undefined) throw exceptional.error;
  if (result === undefined) throw new Error("target checkout reconcile produced no result");
  if (releaseFailure !== undefined) result = failed("effect", releaseFailure, result.effects, result.lag);
  return result;
}

async function reconcileActiveManagedWorktree(
  { repository, hooks, retryHooks, place }: ReconcileEffectsInput,
  state: ContractState,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
): Promise<ReconcileResult> {
  const { effects, lag, hookRuns } = acc;
  if (place === undefined) {
    acc.recordLag(missingPlaceLag(repository));
    return complete(effects, lag);
  }
  const path = worktreePath(repository, place);
  const desired = state.delivery?.data.tenderSnapshot ?? state.coordinates.start;
  acc.recordEffect(await updateRef(repository, deliveryRefFor(state.id), desired));
  const projection = await worktree(repository, topology, path, desired);
  acc.recordEffect(projection);
  const handoff = await retireConflictHandoff(repository, {
    contractId: state.id,
    place,
    workspace: path,
    consume: state.delivery !== null,
  });
  if (state.delivery !== null && handoff.kind === "retained") {
    acc.recordLag({
      kind: "reconcile-failed",
      stage: "effect",
      diagnostic: `conflict handoff retirement retained: ${handoff.reason}`,
    });
  }
  if (projection.action === "created" || retryHooks) {
    const hookRun = await runCreateHooks(path, hooks);
    hookRuns.push(...hookRun.runs.map((name) => ({ phase: "create" as const, name })));
    if (hookRun.lag !== null) acc.recordLag(hookRun.lag);
  }
  acc.recordEffect(
    await (state.delivery
      ? await updateRef(
          repository,
          candidatePinRefFor(state.id),
          state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot,
        )
      : await removeRef(repository, candidatePinRefFor(state.id))),
  );
  return complete(effects, lag, hookRuns);
}

async function terminalHandoffRetained(
  input: ReconcileEffectsInput,
  state: ContractState,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
): Promise<boolean> {
  if (input.place === undefined) return false;
  const path = worktreePath(input.repository, input.place);
  if (!topology.paths.has(path) && !(await pathExists(path))) return false;
  const handoff = await retireConflictHandoff(input.repository, {
    contractId: state.id,
    place: input.place,
    workspace: path,
    consume: state.delivery !== null,
  });
  if (handoff.kind === "active") {
    acc.recordLag({
      kind: "reconcile-failed",
      stage: "effect",
      diagnostic: "conflict handoff retirement retained: active",
    });
    return true;
  }
  if (handoff.kind !== "retained") return false;
  acc.recordLag({
    kind: "reconcile-failed",
    stage: "effect",
    diagnostic: `conflict handoff retirement retained: ${handoff.reason}`,
  });
  return true;
}

async function reconcileWithTopology(
  input: ReconcileEffectsInput,
  state: ContractState | null,
  topology: WorktreeTopology,
): Promise<ReconcileResult> {
  const { repository } = input;
  const acc = reconcileAccumulation(input.onPhysical);
  const { effects, lag, hookRuns } = acc;
  try {
    await removeCollectableScratch(repository, topology, acc);
    if (!state) return complete(effects, lag);
    const targetCheckouts = await reconcileTargetCheckouts(repository, state, input.onPhysical);
    acc.recordEffect(...targetCheckouts.effects);
    acc.recordLag(...targetCheckouts.lag);
    if (state.terminal) {
      if (await terminalHandoffRetained(input, state, topology, acc)) return complete(effects, lag, hookRuns);
      return await reconcileTerminalManagedWorktree(input, state, topology, acc, {
        ref: deliveryRefFor(state.id),
        pin: candidatePinRefFor(state.id),
      });
    }
    const result = await reconcileActiveManagedWorktree(input, state, topology, acc);
    return hookRuns.length === 0 ? result : { ...result, hookRuns };
  } catch (error) {
    return failed("effect", error, effects, lag);
  }
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
  let exceptional: { error: unknown } | undefined;
  try {
    const state = (await observeContractAt(input.repository, input.channel, input.contractId)).state;
    const topology = await acquireWorktreeTopology(input.repository);
    observation = {
      state,
      result: await reconcileWithTopology(input, state, topology),
    };
    input.onPhysical?.(observation.result);
  } catch (error) {
    try {
      observation = { state: null, result: failed("observation", error) };
    } catch (unexpected) {
      exceptional = { error: unexpected };
    }
  }

  try {
    observation = releaseFailure(held, observation);
  } catch (error) {
    exceptional ??= { error };
  }
  if (exceptional !== undefined) throw exceptional.error;
  if (observation === undefined) throw new Error("reconcile produced no observation");
  return observation;
}

/** Reconcile one retained dependent worktree under its normal per-Contract lock. */
export async function reconcileDependentWorktree(
  repository: GitRepository,
  contractId: ContractId,
  path: string,
  target: SnapshotId,
): Promise<ReconcileResult> {
  let held: HeldSqliteTransactionLock;
  try {
    held = await acquireSqliteTransactionLock({ path: reconcileLockPath(repository, contractId), mode: "immediate" });
  } catch (error) {
    return failed("effect", error);
  }
  let result: ReconcileResult;
  try {
    const follow = await followDependentManagedWorktree(repository, path, target);
    if (follow.kind === "followed") {
      result = {
        effects: [{ kind: "worktree", path, action: "followed", before: follow.before, after: follow.after }],
        lag: [],
      };
    } else if (follow.kind === "unchanged") {
      result = { effects: [], lag: [] };
    } else {
      result = {
        effects: [{ kind: "worktree", path, action: "unchanged" }],
        lag: [
          {
            kind: "worktree-follow-retained",
            path,
            tender: target,
            head: follow.head,
            reason: follow.reason,
            ...(follow.paths.length === 0 ? {} : { paths: follow.paths }),
          },
        ],
      };
    }
  } catch (error) {
    result = failed("effect", error, [{ kind: "worktree", path, action: "unchanged" }]);
  }
  try {
    held.close();
  } catch (error) {
    result = failed("effect", error, result.effects, result.lag);
  }
  return result;
}

export function reconcileObservationFailure(error: unknown): ReconcileResult {
  return failed("observation", error);
}

export function reconcileEffectFailure(error: unknown, prior?: ReconcileResult): ReconcileResult {
  return failed("effect", error, prior?.effects, prior?.lag);
}

type ReconcileBatchOptions = Readonly<{
  hooks: WorktreeHooks;
  retryHooks: boolean;
  retainTerminalWorktree: boolean;
  places?: ReadonlyMap<ContractId, string>;
}>;

/** Reconcile each discovered Contract through its own serialized, fresh observation. */
export async function reconcileBatch(
  repository: GitRepository,
  channel: GitDecodeChannel,
  contracts: Iterable<ContractId>,
  options: ReconcileBatchOptions,
): Promise<readonly ReconcileBatchItem[]> {
  const items: ReconcileBatchItem[] = [];
  for (const contract of contracts) {
    const place = options.places?.get(contract);
    const observation = await reconcile({
      repository,
      channel,
      contractId: contract,
      hooks: options.hooks,
      retryHooks: options.retryHooks,
      retainTerminalWorktree: options.retainTerminalWorktree,
      ...(place === undefined ? {} : { place }),
    });
    items.push({ contract, state: observation.state, result: observation.result });
  }
  return items;
}
