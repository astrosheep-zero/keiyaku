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
  isKeiyakuOwnedRef,
  readRef,
  registeredWorktreePaths,
  writeCommit,
  worktreeGitDirectory,
  type GitOid,
} from "./repository.js";
import { GitPlumbingError, runGit, type GitRepository } from "./process.js";
import type { ContractId, ContractState, SnapshotId } from "../core/facts/types.js";
import { contractLocator, contractPhysicalName, gitObjectIdForSnapshot, mintSnapshotId } from "./identity.js";
import { observeContractAt } from "./observe.js";
import type { GitDecodeChannel } from "./read-observation.js";
import {
  acquireTargetPlacementFence,
  recoverTargetPlacement,
  type TargetCheckoutEffect,
  type TargetCheckoutLag,
} from "./target-placement.js";
import { runCreateHooks, runDestroyHooks, type WorktreeHookLag, type WorktreeHooks } from "./hooks.js";
import { followManagedWorktree, worktreePath } from "./workspace.js";
import { collectableScratchWorktrees } from "./scratch.js";
import {
  terminalSealExpectations as decodeTerminalSealExpectations,
  terminalSealSnapshots,
  observeTerminalWorkspace,
  type TerminalSealExpectations,
  type TerminalWorkspace,
  type UnsealedBytes,
} from "./terminal-seal.js";

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
type WorktreeTopology = Readonly<{ paths: Set<string> }>;
type ReconcileAccumulation = Readonly<{ effects: Effect[]; lag: ReconcileLag[] }>;
type EphemeralRecovery = Readonly<{ snapshot: SnapshotId; workspace: TerminalWorkspace }>;
type TerminalWorktreeCleanup = Readonly<{
  repository: GitRepository;
  topology: WorktreeTopology;
  path: string;
  state: ContractState;
  expected: TerminalSealExpectations;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  acc: ReconcileAccumulation;
}>;
type TerminalCustody = Readonly<{
  repository: GitRepository;
  state: ContractState;
  resolveSeal: () => Promise<TerminalSealExpectations>;
  ref: string;
  pin: string;
  acc: ReconcileAccumulation;
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
async function updateRef(repository: GitRepository, ref: string, desired: SnapshotId): Promise<Effect> {
  const before = await readRef(repository, ref);
  if (before === desired) return { kind: "ref", name: ref, action: "unchanged", before, after: desired };
  await runGit(repository, [
    "update-ref",
    "--no-deref",
    ref,
    gitObjectIdForSnapshot(desired),
    before ?? "0".repeat(desired.length),
  ]);
  return { kind: "ref", name: ref, action: before === null ? "created" : "updated", before, after: desired };
}
async function removeRef(repository: GitRepository, ref: string): Promise<Effect> {
  const before = await readRef(repository, ref);
  if (before === null) return { kind: "ref", name: ref, action: "unchanged", before: null, after: null };
  await runGit(repository, ["update-ref", "--no-deref", "-d", ref, before]);
  return { kind: "ref", name: ref, action: "removed", before, after: null };
}
async function removeRefWithCustody(
  repository: GitRepository,
  ref: string,
  custodian: string,
  expectedCustodian: SnapshotId,
): Promise<Effect> {
  const before = await readRef(repository, ref);
  if (before === null) return { kind: "ref", name: ref, action: "unchanged", before: null, after: null };
  if ((await readRef(repository, custodian)) !== expectedCustodian) {
    return { kind: "ref", name: ref, action: "unchanged", before, after: before };
  }
  await runGit(
    repository,
    ["update-ref", "--stdin", "--no-deref"],
    [
      "start",
      `verify ${custodian} ${gitObjectIdForSnapshot(expectedCustodian)}`,
      `delete ${ref} ${before}`,
      "prepare",
      "commit",
      "",
    ].join("\n"),
  );
  return { kind: "ref", name: ref, action: "removed", before, after: null };
}
async function acquireWorktreeTopology(repository: GitRepository): Promise<WorktreeTopology> {
  return { paths: new Set(await registeredWorktreePaths(repository)) };
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
async function removeWorktree(
  repository: GitRepository,
  topology: WorktreeTopology,
  path: string,
  force = false,
): Promise<Readonly<{ effect: Effect; retained: boolean }>> {
  const registered = topology.paths.has(path);
  if (!registered) {
    return {
      effect: { kind: "worktree", path, action: "unchanged" },
      retained: await pathExists(path),
    };
  }
  if (!(await pathExists(path))) {
    await runGit(repository, ["worktree", "remove", path]);
    topology.paths.delete(path);
    return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
  }
  try {
    await runGit(repository, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  } catch {
    return { effect: { kind: "worktree", path, action: "unchanged" }, retained: true };
  }
  topology.paths.delete(path);
  return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
}

async function removeCollectableScratch(
  repository: GitRepository,
  topology: WorktreeTopology,
  effects: Effect[],
  lag: ReconcileLag[],
): Promise<void> {
  for (const scratch of await collectableScratchWorktrees(topology.paths)) {
    try {
      const removal = await removeWorktree(repository, topology, scratch.path, true);
      effects.push(removal.effect);
      if (removal.retained) lag.push({ kind: "worktree-retained", path: scratch.path });
    } finally {
      scratch.release();
    }
  }
}

async function refRows(repository: GitRepository): Promise<readonly Readonly<{ ref: string; oid: string }>[]> {
  const output = (await runGit(repository, ["for-each-ref", "--format=%(refname)%00%(objectname)"])).toString("utf8");
  if (output.length === 0) return [];
  return output
    .trimEnd()
    .split("\n")
    .map((row) => {
      const [ref, oid, extra] = row.split("\0");
      if (ref === undefined || oid === undefined || extra !== undefined) throw new Error("Git ref row is malformed");
      return { ref, oid };
    });
}
async function snapshotCustodian(
  repository: GitRepository,
  snapshot: SnapshotId,
): Promise<Readonly<{ ref: string; oid: SnapshotId }> | null> {
  for (const row of await refRows(repository)) {
    if (isKeiyakuOwnedRef(row.ref)) continue;
    try {
      await runGit(repository, ["merge-base", "--is-ancestor", gitObjectIdForSnapshot(snapshot), row.oid]);
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

async function reconcileHereWorkspaceRefs(
  { repository }: ReconcileInput,
  state: ContractState,
  { effects, lag }: ReconcileAccumulation,
): Promise<ReconcileResult> {
  const pin = candidatePinRefFor(state.id);
  if (state.terminal) {
    if (state.delivery === null) effects.push(await removeRef(repository, pin));
    else {
      const integration = state.currentIntegration?.snapshot;
      if (integration === undefined) return complete();
      const custodian = await snapshotCustodian(repository, integration);
      effects.push(
        await (custodian === null
          ? await updateRef(repository, pin, integration)
          : await removeRefWithCustody(repository, pin, custodian.ref, custodian.oid)),
      );
    }
  } else if (state.bound) {
    effects.push(
      await (state.delivery === null
        ? await removeRef(repository, pin)
        : await updateRef(
            repository,
            pin,
            state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot,
          )),
    );
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

async function removeSealedTerminalWorktree({
  repository,
  topology,
  path,
  state,
  expected,
  hooks,
  retryHooks,
  acc,
}: TerminalWorktreeCleanup): Promise<ReconcileResult | null> {
  if (topology.paths.has(path) && (await pathExists(path))) {
    const terminal = state.terminal;
    if (terminal === null) throw new Error(`terminal worktree cleanup received active Contract ${state.id}`);
    const canRecover = terminal.kind === "abandoned";
    let recovery: EphemeralRecovery | null = null;

    const recordRecovery = async (workspace: TerminalWorkspace): Promise<EphemeralRecovery> => {
      const snapshot = mintSnapshotId(
        await writeCommit({
          repository,
          tree: workspace.tree,
          parent: gitObjectIdForSnapshot(recovery?.snapshot ?? workspace.head),
          message: `${state.id}: ephemeral abandoned-workspace recovery\n\nKeiyaku-Contract: ${state.id}`,
          actor: "Keiyaku Recovery",
          at: terminal.at,
        }),
      );
      const effect = {
        kind: "recovery-snapshot" as const,
        action: "created" as const,
        snapshot,
        retention: "ephemeral" as const,
      };
      const existing = acc.effects.findIndex((item) => item.kind === "recovery-snapshot");
      if (existing < 0) acc.effects.push(effect);
      else acc.effects[existing] = effect;
      return { snapshot, workspace };
    };

    const before = await observeTerminalWorkspace(repository, path, expected);
    const beforeWorkspace = before.workspace;
    const beforeHooks = before.unsealed;
    if (beforeHooks !== null) {
      if (!canRecover || beforeWorkspace.submodules.length > 0) {
        return retainTerminalWorktree(path, beforeHooks, acc);
      }
      recovery = await recordRecovery(beforeWorkspace);
    }
    const hookLag = await runDestroyHooks(path, await worktreeGitDirectory(repository, path), hooks, retryHooks);
    if (hookLag !== null) return retainTerminalWorktree(path, hookLag, acc);
    const after = await observeTerminalWorkspace(repository, path, expected);
    const afterWorkspace = after.workspace;
    const afterHooks = after.unsealed;
    if (afterHooks !== null) {
      if (!canRecover || afterWorkspace.submodules.length > 0) {
        return retainTerminalWorktree(path, afterHooks, acc);
      }
    }
    if (
      canRecover &&
      (recovery === null ||
        recovery.workspace.head !== afterWorkspace.head ||
        recovery.workspace.tree !== afterWorkspace.tree) &&
      (recovery !== null ||
        beforeWorkspace.head !== afterWorkspace.head ||
        beforeWorkspace.tree !== afterWorkspace.tree)
    ) {
      recovery = await recordRecovery(afterWorkspace);
    }
  }
  const removal = await removeWorktree(repository, topology, path, true);
  if (removal.retained) return retainTerminalWorktree(path, { kind: "worktree-retained", path }, acc);
  acc.effects.push(removal.effect);
  return null;
}

async function targetCustodyForClaimedIntegration(
  repository: GitRepository,
  state: ContractState,
  integration: SnapshotId,
): Promise<Readonly<{ ref: string; oid: SnapshotId }> | null> {
  return state.terminal?.kind === "claimed" &&
    state.coordinates.target !== undefined &&
    (await readRef(repository, state.coordinates.target)) === integration
    ? { ref: state.coordinates.target, oid: integration }
    : null;
}

function sealedTree(expected: TerminalSealExpectations, snapshot: SnapshotId): GitOid {
  const tree = expected.treeBySnapshot.get(snapshot);
  if (tree === undefined) throw new Error(`terminal seal tree was not resolved: ${snapshot}`);
  return tree;
}

async function releaseTerminalCustody({
  repository,
  state,
  resolveSeal,
  ref,
  pin,
  acc: { effects },
}: TerminalCustody): Promise<void> {
  const [deliveryRef, candidatePin] = await Promise.all([readRef(repository, ref), readRef(repository, pin)]);
  if (deliveryRef === null && candidatePin === null) return;
  if (state.delivery === null) {
    const custodian = await snapshotCustodian(repository, state.coordinates.start);
    if (deliveryRef !== null && custodian !== null)
      effects.push(await removeRefWithCustody(repository, ref, custodian.ref, custodian.oid));
    if (candidatePin !== null) effects.push(await removeRef(repository, pin));
    return;
  }
  const tender = state.delivery.data.tenderSnapshot;
  const integration = state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot;
  const target = await targetCustodyForClaimedIntegration(repository, state, integration);
  if (deliveryRef !== null && target !== null) {
    if (tender === integration) {
      effects.push(await removeRefWithCustody(repository, ref, target.ref, target.oid));
    } else {
      const expected = await resolveSeal();
      if (sealedTree(expected, tender) === sealedTree(expected, integration)) {
        effects.push(await removeRefWithCustody(repository, ref, target.ref, target.oid));
      }
    }
  }
  if (candidatePin !== null) {
    if (target !== null) {
      effects.push(await removeRefWithCustody(repository, pin, target.ref, target.oid));
    } else if (tender === integration && deliveryRef !== null) {
      effects.push(await removeRefWithCustody(repository, pin, ref, tender));
    }
  }
}

async function reconcileTerminalManagedWorktree(
  { repository, channel, hooks, retryHooks, retainTerminalWorktree, place }: ReconcileInput,
  state: ContractState,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
): Promise<ReconcileResult> {
  const primary = fromPrimaryWorktree(repository);
  const ref = deliveryRefFor(state.id);
  const pin = candidatePinRefFor(state.id);
  const path = place === undefined ? undefined : worktreePath(repository, place);
  if (path === undefined) {
    if (retainTerminalWorktree === true) return complete(acc.effects, acc.lag);
    await releaseTerminalCustody({
      repository: primary,
      state,
      resolveSeal: async () => await terminalSealExpectations(channel, state),
      ref,
      pin,
      acc,
    });
    return complete(acc.effects, acc.lag);
  }
  const expected = await terminalSealExpectations(channel, state);
  acc.effects.push(await updateRef(primary, ref, state.delivery?.data.tenderSnapshot ?? state.coordinates.start));
  if (state.delivery !== null) {
    acc.effects.push(
      await updateRef(primary, pin, state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot),
    );
  }
  if (retainTerminalWorktree === true) return complete(acc.effects, acc.lag);
  const retained = await removeSealedTerminalWorktree({
    repository: primary,
    topology,
    path,
    state,
    expected,
    hooks,
    retryHooks,
    acc,
  });
  if (retained !== null) return retained;
  await releaseTerminalCustody({
    repository: primary,
    state,
    resolveSeal: async () => expected,
    ref,
    pin,
    acc,
  });
  return complete(acc.effects, acc.lag);
}

async function reconcileActiveManagedWorktree(
  { repository, hooks, retryHooks, place }: ReconcileInput,
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
  input: ReconcileInput,
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
    if (state.coordinates.workspace === "here") return await reconcileHereWorkspaceRefs(input, state, { effects, lag });
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
