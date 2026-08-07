import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  DELIVERY_REF_NAMESPACE,
  readRef,
  registeredWorktreePaths,
  runGit,
  type GitOid,
  type GitRepository,
} from "./repository.js";
import { contractId, type ContractId, type ContractState, type SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot } from "./identity.js";

const WORKTREE_DIRECTORY = [".keiyaku-v4", "worktrees"] as const;
export type Effect =
  | Readonly<{
      kind: "worktree";
      path: string;
      action: "created" | "removed" | "unchanged";
    }>
  | Readonly<{
      kind: "ref";
      name: string;
      before: GitOid | null;
      after: GitOid | null;
      action: "created" | "updated" | "removed" | "unchanged";
    }>;
type ReconcileInput = Readonly<{ repository: GitRepository; state: ContractState | null }>;
export type ReconcileLag = Readonly<{
  kind: "worktree-retained";
  path: string;
}>;
export type ReconcileResult = Readonly<{
  effects: readonly Effect[];
  lag: readonly ReconcileLag[];
}>;
type ReconcileBatchContract = Readonly<{ id: ContractId; state: ContractState | null }>;
type ReconcileBatchItem =
  | Readonly<{ kind: "reconciled"; contract: ContractId; result: ReconcileResult }>
  | Readonly<{ kind: "failed"; contract: ContractId; error: unknown }>;

type WorktreeTopology = Readonly<{ paths: Set<string> }>;

function payload(contract: ContractId): string { return contractId(contract).slice(4); }
function deliveryRefFor(contract: ContractId): string { return `${DELIVERY_REF_NAMESPACE}/${payload(contract)}`; }
function candidatePinRefFor(contract: ContractId): string { return `${CANDIDATE_PIN_REF_NAMESPACE}/${payload(contract)}`; }
export function deliveryWorktreePath(repository: GitRepository, contract: ContractId): string { return resolve(realpathSync(repository.primaryWorktree), ...WORKTREE_DIRECTORY, payload(contract)); }
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
  expected: readonly SnapshotId[],
): Readonly<{ effect: Effect; retained: boolean }> {
  const registered = topology.paths.has(path);
  if (!registered) return { effect: { kind: "worktree", path, action: "unchanged" }, retained: false };
  if (!existsSync(path)) {
    runGit(repository, ["worktree", "remove", path]);
    topology.paths.delete(path);
    return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
  }
  if (!canRemoveWorktree(repository, path, expected)) {
    return { effect: { kind: "worktree", path, action: "unchanged" }, retained: true };
  }
  runGit(repository, ["worktree", "remove", path]);
  topology.paths.delete(path);
  return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
}

function reconcileWithTopology({ repository, state }: ReconcileInput, topology: WorktreeTopology): ReconcileResult {
  if (!state) return { effects: [], lag: [] };
  const ref = deliveryRefFor(state.id), pin = candidatePinRefFor(state.id), path = deliveryWorktreePath(repository, state.id);
  if (state.coordinates.workspace === "here") {
    if (state.terminal) {
      const effects = [removeRef(repository, pin)];
      return { effects, lag: [] };
    }
    if (!state.bound) return { effects: [], lag: [] };
    const effects = [state.delivery === null ? removeRef(repository, pin) : updateRef(repository, pin, state.delivery.data.candidate)];
    return { effects, lag: [] };
  }
  if (state.terminal) {
    const expected = state.delivery === null
      ? [state.coordinates.start]
      : [state.delivery.data.candidate, state.coordinates.start];
    const primary = fromPrimaryWorktree(repository);
    const removal = removeWorktree(primary, topology, path, expected);
    if (removal.retained) {
      return {
        effects: [
          updateRef(primary, ref, state.delivery?.data.candidate ?? state.coordinates.start),
          state.delivery === null ? removeRef(primary, pin) : updateRef(primary, pin, state.delivery.data.candidate),
          removal.effect,
        ],
        lag: [{ kind: "worktree-retained", path }],
      };
    }
    const effects = [removal.effect, removeRef(primary, ref), removeRef(primary, pin)];
    return { effects, lag: [] };
  }
  if (!state.bound) return { effects: [], lag: [] };
  const desired = state.delivery?.data.candidate ?? state.coordinates.start;
  const effects = [updateRef(repository, ref, desired), worktree(repository, topology, path, desired)];
  if (state.delivery) effects.push(updateRef(repository, pin, state.delivery.data.candidate)); else effects.push(removeRef(repository, pin));
  return { effects, lag: [] };
}

function needsWorktreeTopology(state: ContractState | null): boolean {
  return state !== null && state.coordinates.workspace === "worktree" && (state.terminal !== null || state.bound !== null);
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const topology = needsWorktreeTopology(input.state)
    ? acquireWorktreeTopology(input.repository)
    : { paths: new Set<string>() };
  return reconcileWithTopology(input, topology);
}

function reconcileBatchItem(
  repository: GitRepository,
  topology: WorktreeTopology,
  contract: ReconcileBatchContract,
): ReconcileBatchItem {
  try {
    return { kind: "reconciled", contract: contract.id, result: reconcileWithTopology({ repository, state: contract.state }, topology) };
  } catch (error) {
    return { kind: "failed", contract: contract.id, error };
  }
}

/** Reconcile one carrier observation against one mutable, process-local worktree topology. */
export function reconcileBatch(
  repository: GitRepository,
  contracts: Iterable<ReconcileBatchContract>,
): readonly ReconcileBatchItem[] {
  const observed = [...contracts];
  if (!observed.some((contract) => needsWorktreeTopology(contract.state))) {
    const emptyTopology: WorktreeTopology = { paths: new Set<string>() };
    return observed.map((contract) => reconcileBatchItem(repository, emptyTopology, contract));
  }
  try {
    const topology = acquireWorktreeTopology(repository);
    return observed.map((contract) => reconcileBatchItem(repository, topology, contract));
  } catch (error) {
    const emptyTopology: WorktreeTopology = { paths: new Set<string>() };
    return observed.map((contract) => needsWorktreeTopology(contract.state)
      ? { kind: "failed", contract: contract.id, error }
      : reconcileBatchItem(repository, emptyTopology, contract));
  }
}
