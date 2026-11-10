import { lstat } from "node:fs/promises";
import { CANDIDATE_PIN_REF_NAMESPACE, isKeiyakuOwnedRef, readRef, writeCommit, type GitOid } from "./repository.js";
import { contractPhysicalName, gitObjectIdForSnapshot, mintSnapshotId } from "./identity.js";
import type { ContractState, SnapshotId } from "../core/facts/types.js";
import { withGitReadObservation, type GitDecodeChannel } from "./read-observation.js";
import { observeContractWorld } from "./observe.js";
import { resolveContractTarget } from "./target.js";
import { runDestroyHooks, type WorktreeHooks } from "./hooks.js";
import {
  terminalSealExpectations as decodeTerminalSealExpectations,
  terminalSealSnapshots,
  observeTerminalWorkspace,
  type TerminalSealExpectations,
  type TerminalWorkspace,
} from "./terminal-seal.js";
import { GitPlumbingError, executeGit, type GitRepository } from "./process.js";
import { worktreePath } from "./workspace.js";
import type { Effect, ReconcileAccumulation, ReconcileLag, ReconcileResult, WorktreeTopology } from "./reconcile.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type TerminalReconcileInput = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  retainTerminalWorktree?: boolean;
  place?: string;
}>;

type EphemeralRecovery = Readonly<{ snapshot: SnapshotId; workspace: TerminalWorkspace }>;
type TerminalWorktreeCleanup = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  topology: WorktreeTopology;
  path: string;
  state: ContractState;
  expected: TerminalSealExpectations;
  hooks: WorktreeHooks;
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
type TerminalCustodyRefs = Readonly<{ ref: string; pin: string }>;

type TerminalWorktreeRemoval = Readonly<{ effect?: Effect; retainedLag?: ReconcileLag }>;

/** Attempt removal once. Retention is a lag carrying its reason; no effect claims the worktree state after it. */
async function removeTerminalWorktree(
  repository: GitRepository,
  topology: WorktreeTopology,
  path: string,
): Promise<TerminalWorktreeRemoval> {
  const registered = topology.paths.has(path);
  if (!registered) {
    return (await pathExists(path)) ? { retainedLag: { kind: "worktree-retained", path } } : {};
  }
  const present = await pathExists(path);
  try {
    await executeGit(repository, ["worktree", "remove", ...(present ? ["--force"] : []), path]);
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    return { retainedLag: { kind: "worktree-retained", path, diagnostic: error.message } };
  }
  topology.paths.delete(path);
  if (await pathExists(path)) {
    return {
      retainedLag: {
        kind: "worktree-retained",
        path,
        diagnostic: `Git reported worktree removal but the path remains: ${path}`,
      },
    };
  }
  return { effect: { kind: "worktree", path, action: "removed" } };
}

export async function updateRef(repository: GitRepository, ref: string, desired: SnapshotId): Promise<Effect> {
  const before = await readRef(repository, ref);
  if (before === desired) return { kind: "ref", name: ref, before, after: desired };
  await executeGit(repository, [
    "update-ref",
    "--no-deref",
    ref,
    gitObjectIdForSnapshot(desired),
    before ?? "0".repeat(desired.length),
  ]);
  return { kind: "ref", name: ref, before, after: desired };
}

export async function removeRef(repository: GitRepository, ref: string): Promise<Effect> {
  const before = await readRef(repository, ref);
  if (before === null) return { kind: "ref", name: ref, before: null, after: null };
  await executeGit(repository, ["update-ref", "--no-deref", "-d", ref, before]);
  return { kind: "ref", name: ref, before, after: null };
}

async function removeRefWithCustody(
  repository: GitRepository,
  ref: string,
  custodian: string,
  expectedCustodian: SnapshotId,
): Promise<Effect> {
  const before = await readRef(repository, ref);
  if (before === null) return { kind: "ref", name: ref, before: null, after: null };
  if ((await readRef(repository, custodian)) !== expectedCustodian) {
    return { kind: "ref", name: ref, before, after: before };
  }
  await executeGit(
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
  return { kind: "ref", name: ref, before, after: null };
}

function retainedRefEffect(ref: string, snapshot: GitOid): Effect {
  return { kind: "ref", name: ref, before: snapshot, after: snapshot };
}

async function refRows(repository: GitRepository): Promise<readonly Readonly<{ ref: string; oid: string }>[]> {
  const output = (await executeGit(repository, ["for-each-ref", "--format=%(refname)%00%(objectname)"])).toString(
    "utf8",
  );
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

async function commitIsAncestor(repository: GitRepository, ancestor: SnapshotId, descendant: string): Promise<boolean> {
  try {
    await executeGit(repository, ["merge-base", "--is-ancestor", gitObjectIdForSnapshot(ancestor), descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return false;
    throw error;
  }
}

async function snapshotCustodian(
  repository: GitRepository,
  snapshot: SnapshotId,
): Promise<Readonly<{ ref: string; oid: SnapshotId }> | null> {
  for (const row of await refRows(repository)) {
    if (isKeiyakuOwnedRef(row.ref)) continue;
    if (await commitIsAncestor(repository, snapshot, row.oid)) return { ref: row.ref, oid: mintSnapshotId(row.oid) };
  }
  return null;
}

async function hasIncomingLanding(
  repository: GitRepository,
  channel: GitDecodeChannel,
  state: ContractState,
  head: SnapshotId,
): Promise<boolean> {
  const world = await withGitReadObservation(repository, channel, async (read) => await observeContractWorld(read));
  for (const { state: child } of world.contracts.values()) {
    const target = child?.coordinates.target;
    const integration = child?.currentIntegration?.snapshot;
    if (
      child?.terminal?.kind !== "claimed" ||
      typeof target !== "object" ||
      target.contractId !== state.id ||
      !integration
    )
      continue;
    const pin = `${CANDIDATE_PIN_REF_NAMESPACE}/${contractPhysicalName(child.id)}`;
    if ((await readRef(repository, pin)) !== integration || !(await commitIsAncestor(repository, integration, head)))
      continue;
    const resolved = await resolveContractTarget(repository, state.id, target);
    if (resolved.kind === "resolved" || ["attached", "operation", "uncommitted"].includes(resolved.refusal.reason))
      return true;
  }
  return false;
}

function fromPrimaryWorktree(repository: GitRepository): GitRepository {
  return { ...repository, effectiveCwd: repository.primaryWorktree };
}

function complete(effects: readonly Effect[] = [], lag: readonly ReconcileLag[] = []): ReconcileResult {
  return { effects, lag };
}

function retainTerminalWorktree(path: string, retainedLag: ReconcileLag, acc: ReconcileAccumulation): ReconcileResult {
  acc.recordEffect({ kind: "worktree", path, action: "unchanged" });
  acc.recordLag(retainedLag);
  return complete(acc.effects, acc.lag);
}

async function terminalSealExpectations(
  channel: GitDecodeChannel,
  state: ContractState,
): Promise<TerminalSealExpectations> {
  const snapshots = terminalSealSnapshots(state);
  const objects = await channel.readObjects(snapshots.map(gitObjectIdForSnapshot));
  return decodeTerminalSealExpectations(state, objects);
}

async function mustRetainUnsealed(
  repository: GitRepository,
  channel: GitDecodeChannel,
  state: ContractState,
  canRecover: boolean,
  workspace: TerminalWorkspace,
): Promise<boolean> {
  return (
    !canRecover ||
    workspace.submodules.length > 0 ||
    (await hasIncomingLanding(repository, channel, state, workspace.head))
  );
}

async function removeSealedTerminalWorktree({
  repository,
  channel,
  topology,
  path,
  state,
  expected,
  hooks,
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
        snapshot,
      };
      acc.recordEffect(effect);
      return { snapshot, workspace };
    };

    const before = await observeTerminalWorkspace(repository, path, expected);
    const beforeWorkspace = before.workspace;
    const beforeHooks = before.unsealed;
    if (beforeHooks !== null) {
      if (await mustRetainUnsealed(repository, channel, state, canRecover, beforeWorkspace)) {
        return retainTerminalWorktree(path, beforeHooks, acc);
      }
      recovery = await recordRecovery(beforeWorkspace);
    }
    const hookRun = await runDestroyHooks(path, hooks);
    if (hookRun.lag !== null) return retainTerminalWorktree(path, hookRun.lag, acc);
    const after = await observeTerminalWorkspace(repository, path, expected);
    const afterWorkspace = after.workspace;
    const afterHooks = after.unsealed;
    if (afterHooks !== null) {
      if (await mustRetainUnsealed(repository, channel, state, canRecover, afterWorkspace)) {
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
  const removal = await removeTerminalWorktree(repository, topology, path);
  if (removal.retainedLag !== undefined) {
    acc.recordLag(removal.retainedLag);
    return complete(acc.effects, acc.lag);
  }
  if (removal.effect !== undefined) acc.recordEffect(removal.effect);
  return null;
}

async function targetCustodyForClaimedIntegration(
  repository: GitRepository,
  state: ContractState,
  integration: SnapshotId,
): Promise<Readonly<{ ref: string; oid: SnapshotId }> | null> {
  if (state.terminal?.kind !== "claimed" || typeof state.coordinates.target !== "string") return null;
  const target = await readRef(repository, state.coordinates.target);
  if (target === null) return null;
  const oid = mintSnapshotId(target);
  return (await commitIsAncestor(repository, integration, oid)) ? { ref: state.coordinates.target, oid } : null;
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
  acc,
}: TerminalCustody): Promise<void> {
  const [deliveryRef, candidatePin] = await Promise.all([readRef(repository, ref), readRef(repository, pin)]);
  if (deliveryRef === null && candidatePin === null) return;
  if (state.delivery === null) {
    const custodian = await snapshotCustodian(repository, state.coordinates.start);
    if (deliveryRef !== null) {
      acc.recordEffect(
        custodian === null
          ? retainedRefEffect(ref, deliveryRef)
          : await removeRefWithCustody(repository, ref, custodian.ref, custodian.oid),
      );
    }
    if (candidatePin !== null) acc.recordEffect(await removeRef(repository, pin));
    return;
  }
  const tender = state.delivery.data.tenderSnapshot;
  const integration = state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot;
  const target = await targetCustodyForClaimedIntegration(repository, state, integration);
  if (deliveryRef !== null && target !== null) {
    if (tender === integration) {
      acc.recordEffect(await removeRefWithCustody(repository, ref, target.ref, target.oid));
    } else {
      const expected = await resolveSeal();
      if (sealedTree(expected, tender) === sealedTree(expected, integration)) {
        acc.recordEffect(await removeRefWithCustody(repository, ref, target.ref, target.oid));
      } else {
        acc.recordEffect(retainedRefEffect(ref, deliveryRef));
      }
    }
  } else if (deliveryRef !== null) {
    acc.recordEffect(retainedRefEffect(ref, deliveryRef));
  }
  if (candidatePin !== null) {
    if (target !== null || (tender === integration && deliveryRef !== null)) {
      acc.recordEffect(
        target !== null
          ? await removeRefWithCustody(repository, pin, target.ref, target.oid)
          : await removeRefWithCustody(repository, pin, ref, tender),
      );
    } else {
      acc.recordEffect(retainedRefEffect(pin, candidatePin));
    }
  }
}

export async function reconcileTerminalManagedWorktree(
  { repository, channel, hooks, retainTerminalWorktree, place }: TerminalReconcileInput,
  state: ContractState,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
  { ref, pin }: TerminalCustodyRefs,
): Promise<ReconcileResult> {
  const primary = fromPrimaryWorktree(repository);
  const path = place === undefined ? undefined : worktreePath(repository, place);
  const resolveSeal = async () => await terminalSealExpectations(channel, state);
  if (path === undefined) {
    if (retainTerminalWorktree === true) return complete(acc.effects, acc.lag);
    await releaseTerminalCustody({ repository: primary, state, resolveSeal, ref, pin, acc });
    return complete(acc.effects, acc.lag);
  }
  const expected = await resolveSeal();
  acc.recordEffect(await updateRef(primary, ref, state.delivery?.data.tenderSnapshot ?? state.coordinates.start));
  if (state.delivery !== null) {
    acc.recordEffect(
      await updateRef(primary, pin, state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot),
    );
  }
  if (retainTerminalWorktree === true) {
    if (topology.paths.has(path) && (await pathExists(path))) {
      acc.recordEffect({ kind: "worktree", path, action: "unchanged" });
    }
    return complete(acc.effects, acc.lag);
  }
  const retained = await removeSealedTerminalWorktree({
    repository: primary,
    channel,
    topology,
    path,
    state,
    expected,
    hooks,
    acc,
  });
  if (retained !== null) return retained;
  await releaseTerminalCustody({ repository: primary, state, resolveSeal: async () => expected, ref, pin, acc });
  return complete(acc.effects, acc.lag);
}
