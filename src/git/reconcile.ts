import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  commonGitDirectory,
  DELIVERY_REF_NAMESPACE,
  registeredWorktreePaths,
  worktreeGitDirectory,
  type GitOid,
} from "./repository.js";
import { runGit, type GitRepository } from "./process.js";
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
import { followManagedWorktree, worktreePath } from "./workspace.js";
import { removeCollectableScratchWorktrees } from "./scratch.js";
import { reconcileTerminalManagedWorktree, removeRef, updateRef } from "./terminal-reconcile.js";
import type { UnsealedBytes } from "./terminal-seal.js";

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
}>;
type ReconcileEffectsInput = ReconcileInput;
type WorktreeRetained = Readonly<{ kind: "worktree-retained"; path: string }>;
type WorktreeFollowRetained = Readonly<{
  kind: "worktree-follow-retained";
  path: string;
  tender: SnapshotId;
  head: SnapshotId;
  reason: "head-moved" | "head-attached" | "operation-in-progress" | "unsupported-parent-shape";
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
export type ReconcileResult = Readonly<{ effects: readonly Effect[]; lag: readonly ReconcileLag[] }>;
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
export type ReconcileAccumulation = Readonly<{ effects: Effect[]; lag: ReconcileLag[] }>;

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
  if (await pathExists(path)) throw new Error(`delivery worktree path is occupied: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await runGit(repository, ["worktree", "add", "--detach", path, gitObjectIdForSnapshot(desired)]);
  topology.paths.add(path);
  return { kind: "worktree", path, action: "created" };
}
async function removeCollectableScratch(
  repository: GitRepository,
  topology: WorktreeTopology,
  effects: Effect[],
  lag: ReconcileLag[],
): Promise<void> {
  for (const removal of await removeCollectableScratchWorktrees(repository, topology.paths)) {
    effects.push({ kind: "worktree", path: removal.path, action: removal.action });
    if (removal.retained) lag.push({ kind: "worktree-retained", path: removal.path });
  }
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
    const recovered = await recoverTargetPlacement(repository, state);
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

async function reconcileActiveManagedWorktree(
  { repository, hooks, retryHooks, place }: ReconcileEffectsInput,
  state: ContractState,
  topology: WorktreeTopology,
  { effects, lag }: ReconcileAccumulation,
): Promise<ReconcileResult> {
  if (place === undefined) return complete(effects, [...lag, missingPlaceLag(repository)]);
  const path = worktreePath(repository, place);
  const desired = state.delivery?.data.tenderSnapshot ?? state.coordinates.start;
  effects.push(await updateRef(repository, deliveryRefFor(state.id), desired));
  const projection = await worktree(repository, topology, path, desired);
  if (projection.kind === "worktree" && projection.action === "unchanged" && state.delivery !== null) {
    const follow = await followManagedWorktree(repository, path, state.delivery.data.tenderSnapshot);
    if (follow.kind === "followed") {
      effects.push({ kind: "worktree", path, action: "followed", before: follow.before, after: follow.after });
    } else {
      effects.push(projection);
      if (follow.kind === "retained") {
        lag.push({
          kind: "worktree-follow-retained",
          path,
          tender: state.delivery.data.tenderSnapshot,
          head: follow.head,
          reason: follow.reason,
        });
      }
    }
  } else {
    effects.push(projection);
  }
  const hookLag = await runCreateHooks(path, await worktreeGitDirectory(repository, path), hooks, retryHooks);
  if (hookLag !== null) lag.push(hookLag);
  effects.push(
    await (state.delivery
      ? await updateRef(
          repository,
          candidatePinRefFor(state.id),
          state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot,
        )
      : await removeRef(repository, candidatePinRefFor(state.id))),
  );
  return complete(effects, lag);
}

async function reconcileWithTopology(
  input: ReconcileEffectsInput,
  state: ContractState | null,
  topology: WorktreeTopology,
): Promise<ReconcileResult> {
  const { repository } = input;
  const effects: Effect[] = [];
  const lag: ReconcileLag[] = [];
  try {
    await removeCollectableScratch(repository, topology, effects, lag);
    if (!state) return complete(effects, lag);
    const targetCheckouts = await reconcileTargetCheckouts(repository, state);
    effects.push(...targetCheckouts.effects);
    lag.push(...targetCheckouts.lag);
    if (state.terminal) {
      return await reconcileTerminalManagedWorktree(
        input,
        state,
        topology,
        { effects, lag },
        { ref: deliveryRefFor(state.id), pin: candidatePinRefFor(state.id) },
      );
    }
    return await reconcileActiveManagedWorktree(input, state, topology, { effects, lag });
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
  let exceptional: unknown;
  try {
    const state = (await observeContractAt(input.repository, input.channel, input.contractId)).state;
    const topology = await acquireWorktreeTopology(input.repository);
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
