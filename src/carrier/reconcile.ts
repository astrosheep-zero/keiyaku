import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readRef, registeredWorktreePaths, runGit, type GitOid, type GitRepository } from "./repository.js";
import { contractId, type ContractId, type ContractState, type SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot, mintSnapshotId } from "./identity.js";

const DELIVERY_REF_PREFIX = "refs/heads/keiyaku-delivery/";
const CANDIDATE_PIN_REF_PREFIX = "refs/heads/keiyaku-candidate/";
const WORKTREE_DIRECTORY = [".keiyaku-v4", "worktrees"] as const;
export type Effect = Readonly<{ kind: "worktree" | "ref"; path?: string; name?: string; action: "created" | "updated" | "removed" | "unchanged"; before?: GitOid | null; after?: GitOid | null }>;
export type ReconcileInput = Readonly<{ repository: GitRepository; state: ContractState | null }>;
export type ReconcileResult = Readonly<{ kind: "aligned" | "cleaned" | "noop"; deliveryRef: string | null; worktreePath: string | null; changed: boolean; effects: readonly Effect[] }>;
export type ReconcileBatchContract = Readonly<{ id: ContractId; state: ContractState | null }>;
export type ReconcileBatchItem =
  | Readonly<{ kind: "reconciled"; contract: ContractId; result: ReconcileResult }>
  | Readonly<{ kind: "failed"; contract: ContractId; error: unknown }>;

type WorktreeTopology = Readonly<{ paths: Set<string> }>;

function payload(contract: ContractId): string { return contractId(contract).slice(4); }
export function deliveryRefFor(contract: ContractId): string { return `${DELIVERY_REF_PREFIX}${payload(contract)}`; }
export function candidatePinRefFor(contract: ContractId): string { return `${CANDIDATE_PIN_REF_PREFIX}${payload(contract)}`; }
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

function worktree(repository: GitRepository, topology: WorktreeTopology, path: string, desired: SnapshotId): Effect {
  const registered = topology.paths.has(path);
  if (registered) {
    const actual = mintSnapshotId(runGit(repository, ["-C", path, "rev-parse", "HEAD"]).toString("utf8").trim());
    if (actual === desired) return { kind: "worktree", path, action: "unchanged" };
    runGit(repository, ["-C", path, "reset", "--hard", gitObjectIdForSnapshot(desired)]);
    return { kind: "worktree", path, action: "updated" };
  }
  if (existsSync(path)) throw new Error(`delivery worktree path is occupied: ${path}`);
  mkdirSync(dirname(path), { recursive: true }); runGit(repository, ["worktree", "add", "--detach", path, gitObjectIdForSnapshot(desired)]);
  topology.paths.add(path);
  return { kind: "worktree", path, action: "created" };
}
function removeWorktree(repository: GitRepository, topology: WorktreeTopology, path: string): Effect {
  const registered = topology.paths.has(path);
  if (!registered) return { kind: "worktree", path, action: "unchanged" };
  runGit(repository, ["worktree", "remove", "--force", path]);
  topology.paths.delete(path);
  return { kind: "worktree", path, action: "removed" };
}

function reconcileWithTopology({ repository, state }: ReconcileInput, topology: WorktreeTopology): ReconcileResult {
  if (!state || !state.coordinates) return { kind: "noop", deliveryRef: null, worktreePath: null, changed: false, effects: [] };
  const ref = deliveryRefFor(state.id), pin = candidatePinRefFor(state.id), path = deliveryWorktreePath(repository, state.id);
  if (state.coordinates.workspace === "here") {
    if (state.terminal) {
      const effects = [removeRef(repository, pin)];
      return { kind: "cleaned", deliveryRef: null, worktreePath: null, changed: effects.some((effect) => effect.action !== "unchanged"), effects };
    }
    if (!state.bound) return { kind: "noop", deliveryRef: null, worktreePath: null, changed: false, effects: [] };
    const effects = [state.delivery === null ? removeRef(repository, pin) : updateRef(repository, pin, state.delivery.data.candidate)];
    return { kind: "aligned", deliveryRef: null, worktreePath: null, changed: effects.some((effect) => effect.action !== "unchanged"), effects };
  }
  if (state.terminal) {
    const effects = [removeRef(repository, ref), removeRef(repository, pin), removeWorktree(repository, topology, path)];
    return { kind: "cleaned", deliveryRef: ref, worktreePath: path, changed: effects.some((effect) => effect.action !== "unchanged"), effects };
  }
  if (!state.bound) return { kind: "noop", deliveryRef: ref, worktreePath: path, changed: false, effects: [] };
  const desired = state.delivery?.data.candidate ?? state.coordinates.start;
  const effects = [updateRef(repository, ref, desired), worktree(repository, topology, path, desired)];
  if (state.delivery) effects.push(updateRef(repository, pin, state.delivery.data.candidate)); else effects.push(removeRef(repository, pin));
  return { kind: "aligned", deliveryRef: ref, worktreePath: path, changed: effects.some((effect) => effect.action !== "unchanged"), effects };
}

function needsWorktreeTopology(state: ContractState | null): boolean {
  return state?.coordinates?.workspace === "worktree" && (state.terminal !== null || state.bound !== null);
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
