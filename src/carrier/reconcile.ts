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
import { contractId, contractSegment, type ContractId, type ContractState, type SnapshotId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { gitObjectIdForSnapshot } from "./identity.js";
import { repairNamespaceContext } from "../namespace-context.js";

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
    }>
  | Readonly<{
      kind: "namespace-context";
      path: string;
      action: "installed" | "kept";
    }>;
type ReconcileInput = Readonly<{ repository: GitRepository; state: ContractState | null }>;
export type ReconcileLag = Readonly<{
  kind: "worktree-retained";
  path: string;
}>;
type ReconcileObservation = Readonly<{
  effects: readonly Effect[];
  lag: readonly ReconcileLag[];
}>;
export type ReconcileFailure = Readonly<{
  kind: "reconcile-failed";
  stage: "observation" | "effect";
  diagnostic: string;
}>;
export type ReconcileResult = ReconcileObservation & Readonly<
  | { kind: "complete" }
  | { kind: "failed"; failure: ReconcileFailure }
>;
type ReconcileBatchContract = Readonly<{ id: ContractId; state: ContractState | null }>;
type ReconcileBatchItem = Readonly<{ contract: ContractId; result: ReconcileResult }>;

type WorktreeTopology = Readonly<{ paths: Set<string> }>;

function materializedName(contract: ContractId): string { return contractId(contract).replace("/", "-"); }
function deliveryRefFor(contract: ContractId): string { return `${DELIVERY_REF_NAMESPACE}/${materializedName(contract)}`; }
function candidatePinRefFor(contract: ContractId): string { return `${CANDIDATE_PIN_REF_NAMESPACE}/${materializedName(contract)}`; }
export function deliveryWorktreePath(repository: GitRepository, contract: ContractId): string { return resolve(realpathSync(repository.primaryWorktree), ...WORKTREE_DIRECTORY, materializedName(contract)); }
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

function rethrowNonReconcileFailure(error: unknown): void {
  if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
}

function complete(effects: readonly Effect[] = [], lag: readonly ReconcileLag[] = []): ReconcileResult {
  return { kind: "complete", effects, lag };
}

function failed(
  stage: ReconcileFailure["stage"],
  error: unknown,
  effects: readonly Effect[] = [],
  lag: readonly ReconcileLag[] = [],
): ReconcileResult {
  rethrowNonReconcileFailure(error);
  return { kind: "failed", effects, lag, failure: { kind: "reconcile-failed", stage, diagnostic: diagnostic(error) } };
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
  try {
    runGit(repository, ["worktree", "remove", path]);
  } catch {
    return { effect: { kind: "worktree", path, action: "unchanged" }, retained: true };
  }
  topology.paths.delete(path);
  return { effect: { kind: "worktree", path, action: "removed" }, retained: false };
}

function reconcileWithTopology({ repository, state }: ReconcileInput, topology: WorktreeTopology): ReconcileResult {
  const effects: Effect[] = [];
  const lag: ReconcileLag[] = [];
  try {
    if (!state) return complete(effects, lag);
    const ref = deliveryRefFor(state.id), pin = candidatePinRefFor(state.id), path = deliveryWorktreePath(repository, state.id);
    if (state.coordinates.workspace === "here") {
      if (state.terminal) effects.push(removeRef(repository, pin));
      else if (state.bound) effects.push(state.delivery === null
        ? removeRef(repository, pin)
        : updateRef(repository, pin, state.delivery.data.candidate));
      return complete(effects, lag);
    }
    if (state.terminal) {
      const expected = state.delivery === null
        ? [state.coordinates.start]
        : [state.delivery.data.candidate, state.coordinates.start];
      const primary = fromPrimaryWorktree(repository);
      const removal = removeWorktree(primary, topology, path, expected);
      if (removal.retained) {
        effects.push(updateRef(primary, ref, state.delivery?.data.candidate ?? state.coordinates.start));
        effects.push(state.delivery === null ? removeRef(primary, pin) : updateRef(primary, pin, state.delivery.data.candidate));
        effects.push(removal.effect);
        lag.push({ kind: "worktree-retained", path });
        return complete(effects, lag);
      }
      effects.push(removal.effect);
      effects.push(removeRef(primary, ref));
      effects.push(removeRef(primary, pin));
      return complete(effects, lag);
    }
    if (!state.bound) return complete(effects, lag);
    const desired = state.delivery?.data.candidate ?? state.coordinates.start;
    effects.push(updateRef(repository, ref, desired));
    effects.push(worktree(repository, topology, path, desired));
    effects.push(state.delivery ? updateRef(repository, pin, state.delivery.data.candidate) : removeRef(repository, pin));
    effects.push({
      kind: "namespace-context",
      path,
      action: repairNamespaceContext(path, [contractSegment(state.id)]),
    });
    return complete(effects, lag);
  } catch (error) {
    return failed("effect", error, effects, lag);
  }
}

function needsWorktreeTopology(state: ContractState | null): boolean {
  return state !== null && state.coordinates.workspace === "worktree" && (state.terminal !== null || state.bound !== null);
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  try {
    const topology = needsWorktreeTopology(input.state)
      ? acquireWorktreeTopology(input.repository)
      : { paths: new Set<string>() };
    return reconcileWithTopology(input, topology);
  } catch (error) {
    return failed("observation", error);
  }
}

export function reconcileObservationFailure(error: unknown): ReconcileResult {
  return failed("observation", error);
}

function reconcileBatchItem(
  repository: GitRepository,
  topology: WorktreeTopology,
  contract: ReconcileBatchContract,
): ReconcileBatchItem {
  return { contract: contract.id, result: reconcileWithTopology({ repository, state: contract.state }, topology) };
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
    const failure = reconcileObservationFailure(error);
    const emptyTopology: WorktreeTopology = { paths: new Set<string>() };
    return observed.map((contract) => needsWorktreeTopology(contract.state)
      ? { contract: contract.id, result: failure }
      : reconcileBatchItem(repository, emptyTopology, contract));
  }
}
