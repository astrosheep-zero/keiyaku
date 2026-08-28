import { access } from "node:fs/promises";
import { isKeiyakuOwnedRef, readRef, writeCommit, type GitOid } from "./repository.js";
import { gitObjectIdForSnapshot, mintSnapshotId } from "./identity.js";
import type { ContractState, SnapshotId } from "../core/facts/types.js";
import type { GitDecodeChannel } from "./read-observation.js";
import { runDestroyHooks, type WorktreeHooks } from "./hooks.js";
import {
  terminalSealExpectations as decodeTerminalSealExpectations,
  terminalSealSnapshots,
  observeTerminalWorkspace,
  type TerminalSealExpectations,
  type TerminalWorkspace,
} from "./terminal-seal.js";
import { GitPlumbingError, runGit, type GitRepository } from "./process.js";
import { worktreePath } from "./workspace.js";
import type { Effect, ReconcileAccumulation, ReconcileLag, ReconcileResult, WorktreeTopology } from "./reconcile.js";

const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

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

async function removeTerminalWorktree(
  repository: GitRepository,
  topology: WorktreeTopology,
  path: string,
): Promise<Readonly<{ effect?: Effect; retained: boolean }>> {
  const registered = topology.paths.has(path);
  if (!registered) {
    return { retained: await pathExists(path) };
  }
  if (!(await pathExists(path))) {
    await runGit(repository, ["worktree", "remove", path]);
    topology.paths.delete(path);
    return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
  }
  try {
    await runGit(repository, ["worktree", "remove", "--force", path]);
  } catch {
    return { effect: { kind: "worktree", path, action: "unchanged" }, retained: true };
  }
  topology.paths.delete(path);
  return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
}

export async function updateRef(repository: GitRepository, ref: string, desired: SnapshotId): Promise<Effect> {
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

export async function removeRef(repository: GitRepository, ref: string): Promise<Effect> {
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

function retainedRefEffect(ref: string, snapshot: GitOid): Effect {
  return { kind: "ref", name: ref, action: "unchanged", before: snapshot, after: snapshot };
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

async function commitIsAncestor(repository: GitRepository, ancestor: SnapshotId, descendant: string): Promise<boolean> {
  try {
    await runGit(repository, ["merge-base", "--is-ancestor", gitObjectIdForSnapshot(ancestor), descendant]);
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

function fromPrimaryWorktree(repository: GitRepository): GitRepository {
  return { ...repository, effectiveCwd: repository.primaryWorktree };
}

function complete(
  effects: readonly Effect[] = [],
  lag: readonly ReconcileLag[] = [],
  hookRuns: readonly { phase: "create" | "destroy"; name: string }[] = [],
): ReconcileResult {
  return hookRuns.length === 0 ? { effects, lag } : { effects, lag, hookRuns };
}

function retainTerminalWorktree(
  path: string,
  retainedLag: ReconcileLag,
  { effects, lag, hookRuns }: ReconcileAccumulation,
): ReconcileResult {
  effects.push({ kind: "worktree", path, action: "unchanged" });
  lag.push(retainedLag);
  return complete(effects, lag, hookRuns);
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
    const hookRun = await runDestroyHooks(path, hooks);
    acc.hookRuns.push(...hookRun.runs.map((name) => ({ phase: "destroy" as const, name })));
    if (hookRun.lag !== null) return retainTerminalWorktree(path, hookRun.lag, acc);
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
  const removal = await removeTerminalWorktree(repository, topology, path);
  if (removal.retained) return retainTerminalWorktree(path, { kind: "worktree-retained", path }, acc);
  if (removal.effect !== undefined) acc.effects.push(removal.effect);
  return null;
}

async function targetCustodyForClaimedIntegration(
  repository: GitRepository,
  state: ContractState,
  integration: SnapshotId,
): Promise<Readonly<{ ref: string; oid: SnapshotId }> | null> {
  if (state.terminal?.kind !== "claimed" || state.coordinates.target === undefined) return null;
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
  acc: { effects },
}: TerminalCustody): Promise<void> {
  const [deliveryRef, candidatePin] = await Promise.all([readRef(repository, ref), readRef(repository, pin)]);
  if (deliveryRef === null && candidatePin === null) return;
  if (state.delivery === null) {
    const custodian = await snapshotCustodian(repository, state.coordinates.start);
    if (deliveryRef !== null) {
      effects.push(
        custodian === null
          ? retainedRefEffect(ref, deliveryRef)
          : await removeRefWithCustody(repository, ref, custodian.ref, custodian.oid),
      );
    }
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
      } else {
        effects.push(retainedRefEffect(ref, deliveryRef));
      }
    }
  } else if (deliveryRef !== null) {
    effects.push(retainedRefEffect(ref, deliveryRef));
  }
  if (candidatePin !== null) {
    if (target !== null || (tender === integration && deliveryRef !== null)) {
      effects.push(
        target !== null
          ? await removeRefWithCustody(repository, pin, target.ref, target.oid)
          : await removeRefWithCustody(repository, pin, ref, tender),
      );
    } else {
      effects.push(retainedRefEffect(pin, candidatePin));
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
    if (retainTerminalWorktree === true) return complete(acc.effects, acc.lag, acc.hookRuns);
    await releaseTerminalCustody({ repository: primary, state, resolveSeal, ref, pin, acc });
    return complete(acc.effects, acc.lag, acc.hookRuns);
  }
  const expected = await resolveSeal();
  acc.effects.push(await updateRef(primary, ref, state.delivery?.data.tenderSnapshot ?? state.coordinates.start));
  if (state.delivery !== null) {
    acc.effects.push(
      await updateRef(primary, pin, state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot),
    );
  }
  if (retainTerminalWorktree === true) {
    if (topology.paths.has(path) && (await pathExists(path))) {
      acc.effects.push({ kind: "worktree", path, action: "unchanged" });
    }
    return complete(acc.effects, acc.lag);
  }
  const retained = await removeSealedTerminalWorktree({
    repository: primary,
    topology,
    path,
    state,
    expected,
    hooks,
    acc,
  });
  if (retained !== null) return retained;
  await releaseTerminalCustody({ repository: primary, state, resolveSeal: async () => expected, ref, pin, acc });
  return complete(acc.effects, acc.lag, acc.hookRuns);
}
