import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireSqliteTransactionLock, type HeldSqliteTransactionLock } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  commonGitDirectory,
  DELIVERY_REF_NAMESPACE,
  GitPlumbingError,
  isKeiyakuOwnedRef,
  readRef,
  registeredWorktreePaths,
  runGit,
  worktreeGitDirectory,
  type GitOid,
  type GitRepository,
} from "./repository.js";
import type { ContractId, ContractState, SnapshotId } from "../core/facts/types.js";
import {
  contractLocator,
  contractPhysicalName,
  gitObjectIdForSnapshot,
  mintSnapshotId,
} from "./identity.js";
import { observeContractAt } from "./observe.js";
import type { GitDecodeChannel } from "./read-observation.js";
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
import { orphanedScratchWorktrees } from "./verification.js";
import {
  terminalSealExpectations as decodeTerminalSealExpectations,
  terminalSealSnapshots,
  unsealedBytes,
  type TerminalSealExpectations,
  type UnsealedBytes,
} from "./terminal-seal.js";

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
  channel: GitDecodeChannel;
  contractId: ContractId;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  retainTerminalWorktree?: boolean;
}>;
type ReconcileEffectsInput = ReconcileInput;
type WorktreeRetained = Readonly<{
  kind: "worktree-retained";
  path: string;
}>;
export type ReconcileFailure = Readonly<{
  kind: "reconcile-failed";
  stage: "observation" | "effect";
  diagnostic: string;
}>;
export type ReconcileLag = WorktreeRetained | UnsealedBytes | TargetCheckoutLag | WorktreeHookLag | ReconcileFailure;
export type ReconcileResult = Readonly<{
  effects: readonly Effect[];
  lag: readonly ReconcileLag[];
}>;
type ReconcileBatchItem = Readonly<{ contract: ContractId; state: ContractState | null; result: ReconcileResult }>;
export type GitReconcileObservation = Readonly<{ state: ContractState | null; result: ReconcileResult }>;

type WorktreeTopology = Readonly<{ paths: Set<string> }>;
type ReconcileAccumulation = Readonly<{ effects: Effect[]; lag: ReconcileLag[] }>;
type TerminalWorktreeCleanup = Readonly<{
  repository: GitRepository;
  topology: WorktreeTopology;
  path: string;
  expected: TerminalSealExpectations;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  acc: ReconcileAccumulation;
}>;
type TerminalCustody = Readonly<{
  repository: GitRepository;
  state: ContractState;
  expected: TerminalSealExpectations;
  ref: string;
  pin: string;
  acc: ReconcileAccumulation;
}>;

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
function removeRefWithCustody(
  repository: GitRepository,
  ref: string,
  custodian: string,
  expectedCustodian: SnapshotId,
): Effect {
  const before = readRef(repository, ref);
  if (before === null) return { kind: "ref", name: ref, action: "unchanged", before: null, after: null };
  if (readRef(repository, custodian) !== expectedCustodian) {
    return { kind: "ref", name: ref, action: "unchanged", before, after: before };
  }
  runGit(repository, ["update-ref", "--stdin", "--no-deref"], [
    "start",
    `verify ${custodian} ${gitObjectIdForSnapshot(expectedCustodian)}`,
    `delete ${ref} ${before}`,
    "prepare",
    "commit",
    "",
  ].join("\n"));
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
function removeWorktree(
  repository: GitRepository,
  topology: WorktreeTopology,
  path: string,
  force = false,
): Readonly<{ effect: Effect; retained: boolean }> {
  const registered = topology.paths.has(path);
  if (!registered) return { effect: { kind: "worktree", path, action: "unchanged" }, retained: false };
  if (!existsSync(path)) {
    runGit(repository, ["worktree", "remove", path]);
    topology.paths.delete(path);
    return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
  }
  try {
    runGit(repository, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  } catch {
    return { effect: { kind: "worktree", path, action: "unchanged" }, retained: true };
  }
  topology.paths.delete(path);
  return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
}

function removeOrphanedScratch(
  repository: GitRepository,
  topology: WorktreeTopology,
  effects: Effect[],
  lag: ReconcileLag[],
): void {
  for (const path of orphanedScratchWorktrees(topology.paths)) {
    const removal = removeWorktree(repository, topology, path, true);
    effects.push(removal.effect);
    if (removal.retained) lag.push({ kind: "worktree-retained", path });
  }
}

function refRows(repository: GitRepository): readonly Readonly<{ ref: string; oid: string }>[] {
  const output = runGit(repository, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
  ]).toString("utf8");
  if (output.length === 0) return [];
  return output.trimEnd().split("\n").map((row) => {
    const [ref, oid, extra] = row.split("\0");
    if (ref === undefined || oid === undefined || extra !== undefined) throw new Error("Git ref row is malformed");
    return { ref, oid };
  });
}
function snapshotCustodian(repository: GitRepository, snapshot: SnapshotId): Readonly<{ ref: string; oid: SnapshotId }> | null {
  for (const row of refRows(repository)) {
    if (isKeiyakuOwnedRef(row.ref)) continue;
    try {
      runGit(repository, ["merge-base", "--is-ancestor", gitObjectIdForSnapshot(snapshot), row.oid]);
      return { ref: row.ref, oid: mintSnapshotId(row.oid) };
    } catch (error) {
      if (error instanceof GitPlumbingError && error.status === 1) continue;
      throw error;
    }
  }
  return null;
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

function reconcileHereWorkspaceRefs(
  repository: GitRepository,
  state: ContractState,
  { effects, lag }: ReconcileAccumulation,
): ReconcileResult {
  const pin = candidatePinRefFor(state.id);
  if (state.terminal) {
    if (state.delivery === null) effects.push(removeRef(repository, pin));
    else {
      const integration = state.delivery.data.integration.snapshot;
      const custodian = snapshotCustodian(repository, integration);
      effects.push(custodian === null
        ? updateRef(repository, pin, integration)
        : removeRefWithCustody(repository, pin, custodian.ref, custodian.oid));
    }
  } else if (state.bound) {
    effects.push(state.delivery === null
      ? removeRef(repository, pin)
      : updateRef(repository, pin, state.delivery.data.integration.snapshot));
  }
  return complete(effects, lag);
}

function retainTerminalWorktree(
  path: string,
  retainedLag: ReconcileLag,
  { effects, lag }: ReconcileAccumulation,
): ReconcileResult {
  effects.push({ kind: "worktree", path, action: "unchanged" });
  lag.push(retainedLag);
  return complete(effects, lag);
}

async function terminalSealExpectations(
  channel: GitDecodeChannel,
  state: ContractState,
): Promise<TerminalSealExpectations> {
  const snapshots = terminalSealSnapshots(state);
  const objects = await channel.readObjects(snapshots.map(gitObjectIdForSnapshot));
  return decodeTerminalSealExpectations(state, objects);
}

async function removeSealedTerminalWorktree(
  { repository, topology, path, expected, hooks, retryHooks, acc }: TerminalWorktreeCleanup,
): Promise<ReconcileResult | null> {
  if (topology.paths.has(path) && existsSync(path)) {
    const beforeHooks = unsealedBytes(repository, path, expected);
    if (beforeHooks !== null) return retainTerminalWorktree(path, beforeHooks, acc);
    const hookLag = await runDestroyHooks(path, worktreeGitDirectory(repository, path), hooks, retryHooks);
    if (hookLag !== null) return retainTerminalWorktree(path, hookLag, acc);
    const afterHooks = unsealedBytes(repository, path, expected);
    if (afterHooks !== null) return retainTerminalWorktree(path, afterHooks, acc);
  }
  const removal = removeWorktree(repository, topology, path, true);
  if (removal.retained) return retainTerminalWorktree(path, { kind: "worktree-retained", path }, acc);
  acc.effects.push(removal.effect);
  return null;
}

function targetCustodyForClaimedIntegration(
  repository: GitRepository,
  state: ContractState,
  integration: SnapshotId,
): Readonly<{ ref: string; oid: SnapshotId }> | null {
  return state.terminal?.kind === "claimed" && state.coordinates.target !== undefined
    && readRef(repository, state.coordinates.target) === integration
    ? { ref: state.coordinates.target, oid: integration }
    : null;
}

function sealedTree(expected: TerminalSealExpectations, snapshot: SnapshotId): GitOid {
  const tree = expected.treeBySnapshot.get(snapshot);
  if (tree === undefined) throw new Error(`terminal seal tree was not resolved: ${snapshot}`);
  return tree;
}

function releaseTerminalCustody(
  { repository, state, expected, ref, pin, acc: { effects } }: TerminalCustody,
): void {
  if (state.delivery === null) {
    const custodian = snapshotCustodian(repository, state.coordinates.start);
    if (custodian !== null) effects.push(removeRefWithCustody(repository, ref, custodian.ref, custodian.oid));
    effects.push(removeRef(repository, pin));
    return;
  }
  const tender = state.delivery.data.tenderSnapshot;
  const integration = state.delivery.data.integration.snapshot;
  const target = targetCustodyForClaimedIntegration(repository, state, integration);
  if (sealedTree(expected, tender) === sealedTree(expected, integration) && target !== null) {
    effects.push(removeRefWithCustody(repository, ref, target.ref, target.oid));
    effects.push(removeRefWithCustody(repository, pin, target.ref, target.oid));
  } else if (tender === integration) {
    effects.push(removeRefWithCustody(repository, pin, ref, tender));
  } else if (target !== null) {
    effects.push(removeRefWithCustody(repository, pin, target.ref, target.oid));
  }
}

async function reconcileTerminalManagedWorktree(
  { repository, channel, hooks, retryHooks, retainTerminalWorktree }: ReconcileEffectsInput,
  state: ContractState,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
): Promise<ReconcileResult> {
  const primary = fromPrimaryWorktree(repository);
  const ref = deliveryRefFor(state.id);
  const pin = candidatePinRefFor(state.id);
  const path = deliveryWorktreePath(repository, state.id);
  const expected = await terminalSealExpectations(channel, state);
  acc.effects.push(updateRef(primary, ref, state.delivery?.data.tenderSnapshot ?? state.coordinates.start));
  if (state.delivery !== null) acc.effects.push(updateRef(primary, pin, state.delivery.data.integration.snapshot));
  if (retainTerminalWorktree === true) return complete(acc.effects, acc.lag);

  const retained = await removeSealedTerminalWorktree({ repository: primary, topology, path, expected, hooks, retryHooks, acc });
  if (retained !== null) return retained;
  releaseTerminalCustody({ repository: primary, state, expected, ref, pin, acc });
  return complete(acc.effects, acc.lag);
}

async function reconcileActiveManagedWorktree(
  { repository, hooks, retryHooks }: ReconcileEffectsInput,
  state: ContractState,
  topology: WorktreeTopology,
  { effects, lag }: ReconcileAccumulation,
): Promise<ReconcileResult> {
  const path = deliveryWorktreePath(repository, state.id);
  const desired = state.delivery?.data.tenderSnapshot ?? state.coordinates.start;
  effects.push(updateRef(repository, deliveryRefFor(state.id), desired));
  effects.push(worktree(repository, topology, path, desired));
  const hookLag = await runCreateHooks(path, worktreeGitDirectory(repository, path), hooks, retryHooks);
  if (hookLag !== null) lag.push(hookLag);
  effects.push(state.delivery
    ? updateRef(repository, candidatePinRefFor(state.id), state.delivery.data.integration.snapshot)
    : removeRef(repository, candidatePinRefFor(state.id)));
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
    removeOrphanedScratch(repository, topology, effects, lag);
    if (!state) return complete(effects, lag);
    const targetCheckouts = await reconcileTargetCheckouts(repository, state);
    effects.push(...targetCheckouts.effects);
    lag.push(...targetCheckouts.lag);
    if (state.coordinates.workspace === "here") return reconcileHereWorkspaceRefs(repository, state, { effects, lag });
    if (state.terminal) return await reconcileTerminalManagedWorktree(input, state, topology, { effects, lag });
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
    const topology = acquireWorktreeTopology(input.repository);
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
}>;

async function reconcileBatchItem(
  repository: GitRepository,
  channel: GitDecodeChannel,
  contract: ContractId,
  options: ReconcileBatchOptions,
): Promise<ReconcileBatchItem> {
  const observation = await reconcile({ repository, channel, contractId: contract, ...options });
  return {
    contract,
    state: observation.state,
    result: observation.result,
  };
}

/** Reconcile each discovered Contract through its own serialized, fresh observation. */
export async function reconcileBatch(
  repository: GitRepository,
  channel: GitDecodeChannel,
  contracts: Iterable<ContractId>,
  options: ReconcileBatchOptions,
): Promise<readonly ReconcileBatchItem[]> {
  const items: ReconcileBatchItem[] = [];
  for (const contract of contracts) items.push(await reconcileBatchItem(repository, channel, contract, options));
  return items;
}
