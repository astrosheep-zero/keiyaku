import { CANDIDATE_PIN_REF_NAMESPACE, isKeiyakuOwnedRef, pathExists, readRef, writeCommit } from "./repository.js";
import { contractPhysicalName, gitObjectIdForSnapshot, mintSnapshotId } from "./identity.js";
import type { ContractState, SnapshotId } from "../core/facts/types.js";
import { withGitReadObservation, type GitDecodeChannel } from "./read-observation.js";
import { observeContractJournals } from "./observe.js";
import { resolveContractTarget } from "./target.js";
import { runDestroyHooks, type WorktreeHooks } from "./hooks.js";
import {
  terminalSealExpectations as decodeTerminalSealExpectations,
  terminalSealSnapshots,
  observeTerminalWorkspace,
  observedSnapshotTree,
  type TerminalSealExpectations,
  type TerminalWorkspace,
} from "./terminal-seal.js";
import { GitPlumbingError, executeGit, type GitRepository } from "./process.js";
import type { ReconcileAccumulation } from "./reconcile.js";

type Custodian = Readonly<{ ref: string; oid: SnapshotId }>;

type TerminalWorktreeCleanup = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  paths: ReadonlySet<string>;
  path: string;
  state: ContractState;
  hooks: WorktreeHooks;
  acc: ReconcileAccumulation;
}>;

/** Attempt removal once, and report it only after observing absence. */
export async function removeSealedTerminalWorktree({
  repository,
  channel,
  paths,
  path,
  state,
  hooks,
  acc,
}: TerminalWorktreeCleanup): Promise<boolean> {
  const registered = paths.has(path);
  const present = await pathExists(path);
  const retain = (diagnostic?: string): false => {
    acc.recordLag({ kind: "worktree-retained", path, ...(diagnostic === undefined ? {} : { diagnostic }) });
    return false;
  };
  if (!registered) return !present || retain();
  if (present && !(await sealThroughDestroyHook({ repository, channel, path, state, hooks, acc }))) return false;
  try {
    await executeGit(repository, ["worktree", "remove", ...(present ? ["--force"] : []), path]);
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    return retain(error.message);
  }
  if (await pathExists(path)) return retain(`Git reported worktree removal but the path remains: ${path}`);
  acc.recordEffect({ kind: "worktree", path, action: "removed" });
  return true;
}

export async function updateRef(
  repository: GitRepository,
  ref: string,
  desired: SnapshotId | null,
  acc: ReconcileAccumulation,
): Promise<void> {
  const before = await readRef(repository, ref);
  if (before === desired) return;
  if (desired === null) {
    await executeGit(repository, ["update-ref", "--no-deref", "-d", ref, before!]);
  } else {
    await executeGit(repository, [
      "update-ref",
      "--no-deref",
      ref,
      gitObjectIdForSnapshot(desired),
      before ?? "0".repeat(desired.length),
    ]);
  }
  acc.recordEffect({ kind: "ref", name: ref, before, after: desired });
}

async function removeRefWithCustody(
  repository: GitRepository,
  ref: string,
  custodian: Custodian,
  acc: ReconcileAccumulation,
): Promise<void> {
  const before = await readRef(repository, ref);
  if (before === null || (await readRef(repository, custodian.ref)) !== custodian.oid) return;
  await executeGit(
    repository,
    ["update-ref", "--stdin", "--no-deref"],
    [
      "start",
      `verify ${custodian.ref} ${gitObjectIdForSnapshot(custodian.oid)}`,
      `delete ${ref} ${before}`,
      "prepare",
      "commit",
      "",
    ].join("\n"),
  );
  acc.recordEffect({ kind: "ref", name: ref, before, after: null });
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

async function snapshotCustodian(repository: GitRepository, snapshot: SnapshotId): Promise<Custodian | null> {
  const output = (await executeGit(repository, ["for-each-ref", "--format=%(refname)%00%(objectname)"])).toString(
    "utf8",
  );
  for (const row of output.trimEnd().split("\n")) {
    if (row === "") continue;
    const [ref, oid, extra] = row.split("\0");
    if (ref === undefined || oid === undefined || extra !== undefined) throw new Error("Git ref row is malformed");
    if (isKeiyakuOwnedRef(ref)) continue;
    if (await commitIsAncestor(repository, snapshot, oid)) return { ref, oid: mintSnapshotId(oid) };
  }
  return null;
}

async function hasIncomingLanding(
  repository: GitRepository,
  channel: GitDecodeChannel,
  state: ContractState,
  head: SnapshotId,
): Promise<boolean> {
  const journals = await withGitReadObservation(repository, channel, observeContractJournals);
  for (const { state: child } of journals.values()) {
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

async function terminalSealExpectations(
  channel: GitDecodeChannel,
  state: ContractState,
): Promise<TerminalSealExpectations> {
  const objects = await channel.readObjects(terminalSealSnapshots(state).map(gitObjectIdForSnapshot));
  return decodeTerminalSealExpectations(state, objects);
}

async function sealThroughDestroyHook({
  repository,
  channel,
  path,
  state,
  hooks,
  acc,
}: Omit<TerminalWorktreeCleanup, "paths">): Promise<boolean> {
  const terminal = state.terminal;
  if (terminal === null) throw new Error(`terminal worktree cleanup received active Contract ${state.id}`);
  const canRecover = terminal.kind === "abandoned";
  const expected = await terminalSealExpectations(channel, state);
  const mustRetain = (workspace: TerminalWorkspace): boolean | Promise<boolean> =>
    !canRecover || workspace.submodules.length > 0 || hasIncomingLanding(repository, channel, state, workspace.head);
  let recovery: SnapshotId | undefined;
  const recordRecovery = async (workspace: TerminalWorkspace): Promise<void> => {
    recovery = mintSnapshotId(
      await writeCommit({
        repository,
        tree: workspace.tree,
        parent: gitObjectIdForSnapshot(recovery ?? workspace.head),
        message: `${state.id}: ephemeral abandoned-workspace recovery\n\nKeiyaku-Contract: ${state.id}`,
        actor: "Keiyaku Recovery",
        at: terminal.at,
      }),
    );
    acc.recordEffect({ kind: "recovery-snapshot", snapshot: recovery });
  };

  const before = await observeTerminalWorkspace(repository, path, expected);
  if (before.unsealed !== null) {
    if (await mustRetain(before.workspace)) {
      acc.recordLag(before.unsealed);
      return false;
    }
    await recordRecovery(before.workspace);
  }
  const hook = await runDestroyHooks(path, hooks);
  if (hook.lag !== null) {
    acc.recordLag(hook.lag);
    return false;
  }
  const after = await observeTerminalWorkspace(repository, path, expected);
  if (after.unsealed !== null && (await mustRetain(after.workspace))) {
    acc.recordLag(after.unsealed);
    return false;
  }
  if (
    canRecover &&
    (before.workspace.head !== after.workspace.head || before.workspace.tree !== after.workspace.tree)
  ) {
    await recordRecovery(after.workspace);
  }
  return true;
}

async function targetCustodyForClaimedIntegration(
  repository: GitRepository,
  channel: GitDecodeChannel,
  state: ContractState,
  integration: SnapshotId,
): Promise<Custodian | null> {
  if (state.terminal?.kind !== "claimed" || typeof state.coordinates.target !== "string") return null;
  const target = await readRef(repository, state.coordinates.target);
  if (target === null) return null;
  const exact = gitObjectIdForSnapshot(integration);
  if ((await channel.readObjects([exact])).get(exact)?.kind === "missing") return null;
  const oid = mintSnapshotId(target);
  return (await commitIsAncestor(repository, integration, oid)) ? { ref: state.coordinates.target, oid } : null;
}

type TerminalCustody = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  state: ContractState;
  ref: string;
  pin: string;
  acc: ReconcileAccumulation;
}>;

async function provesSameTenderBytes(
  channel: GitDecodeChannel,
  tender: SnapshotId,
  integration: SnapshotId,
): Promise<boolean> {
  if (tender === integration) return true;
  const tenderOid = gitObjectIdForSnapshot(tender);
  const integrationOid = gitObjectIdForSnapshot(integration);
  const objects = await channel.readObjects([tenderOid, integrationOid]);
  const tenderTree = observedSnapshotTree(tender, objects.get(tenderOid));
  const integrationTree = observedSnapshotTree(integration, objects.get(integrationOid));
  return tenderTree !== null && tenderTree === integrationTree;
}

/** A retained Place alone does not renew custody already carried elsewhere. */
export async function repairDetachedTerminalCustody({ repository, channel, state, ref, pin, acc }: TerminalCustody) {
  if (state.delivery === null) return;
  const tender = state.delivery.data.tenderSnapshot;
  const integration = state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot;
  const [deliveryRef, candidatePin] = await Promise.all([readRef(repository, ref), readRef(repository, pin)]);
  if (deliveryRef === tender && candidatePin === integration) return;
  const target = await targetCustodyForClaimedIntegration(repository, channel, state, integration);
  const carriesTender =
    deliveryRef !== tender && target !== null && (await provesSameTenderBytes(channel, tender, integration));
  const carriesIntegration = target !== null && (await readRef(repository, target.ref)) === target.oid;
  if (deliveryRef !== tender && !(carriesIntegration && carriesTender))
    await updateRef(repository, ref, tender, acc).catch(acc.recordFailure);
  if (candidatePin !== integration && !carriesIntegration && integration !== tender)
    await updateRef(repository, pin, integration, acc);
}

export async function releaseTerminalCustody({
  repository,
  channel,
  state,
  ref,
  pin,
  acc,
}: TerminalCustody): Promise<void> {
  const [deliveryRef, candidatePin] = await Promise.all([readRef(repository, ref), readRef(repository, pin)]);
  if (deliveryRef === null && candidatePin === null) return;
  if (state.delivery === null) {
    if (deliveryRef !== null) {
      const custodian = await snapshotCustodian(repository, state.coordinates.start);
      if (custodian !== null) await removeRefWithCustody(repository, ref, custodian, acc);
    }
    if (candidatePin !== null) await updateRef(repository, pin, null, acc);
    return;
  }
  const tender = state.delivery.data.tenderSnapshot;
  const integration = state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot;
  const target = await targetCustodyForClaimedIntegration(repository, channel, state, integration);
  if (deliveryRef !== null && target !== null && (await provesSameTenderBytes(channel, tender, integration)))
    await removeRefWithCustody(repository, ref, target, acc);
  if (candidatePin !== null) {
    const custodian = target ?? (tender === integration && deliveryRef !== null ? { ref, oid: tender } : null);
    if (custodian !== null) await removeRefWithCustody(repository, pin, custodian, acc);
  }
}
