import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  GitPlumbingError,
  readRef,
  runGit,
  type GitOid,
  type GitRepository,
} from "./facts/repository.js";
import type {
  CommitOid,
  ContractId,
  ContractState,
  JournalEntry,
} from "./facts/types.js";

const DELIVERY_REF_PREFIX = "refs/heads/keiyaku-delivery/";
const WORKTREE_DIRECTORY = [".keiyaku-v4", "worktrees"] as const;

export type ReconcileInput = Readonly<{
  repository: GitRepository;
  state: ContractState | ReconcileObservation | null;
  /** The accepted journal entries, when available. Handoffs are disposable. */
  entries?: readonly JournalEntry[];
  handoff?: unknown | null;
}>;

/** Structural shape returned by the facts observer, kept local to avoid a protocol dependency. */
export type ReconcileObservation = Readonly<{
  state: ContractState | null;
  entries: readonly JournalEntry[];
}>;

export type ReconcileResult = Readonly<{
  kind: "aligned" | "cleaned" | "noop";
  deliveryRef: string | null;
  worktreePath: string | null;
  changed: boolean;
}>;

type WorktreeObservation = Readonly<{
  path: string;
  head: GitOid | null;
}>;

/** The delivery ref is private projection state, never a journal coordinate. */
export function deliveryRefFor(contractId: ContractId): string {
  return `${DELIVERY_REF_PREFIX}${contractPayload(contractId)}`;
}

/** The delivery worktree is private projection state, never a journal coordinate. */
export function deliveryWorktreePath(repository: GitRepository, contractId: ContractId): string {
  return resolve(realpathSync(repository.cwd), ...WORKTREE_DIRECTORY, contractPayload(contractId));
}

function contractPayload(contractId: ContractId): string {
  if (!contractId.startsWith("kei/") || contractId.length <= 4 || contractId.slice(4).includes("/")) {
    throw new TypeError(`invalid contract identity: ${contractId}`);
  }
  return contractId.slice(4);
}

function isAncestor(repository: GitRepository, ancestor: GitOid, descendant: GitOid): boolean {
  try {
    runGit(repository, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return false;
    throw error;
  }
}

function observeWorktree(repository: GitRepository, expectedPath: string): WorktreeObservation | null {
  const output = runGit(repository, ["worktree", "list", "--porcelain"]).toString("utf8");
  let currentPath: string | null = null;
  let currentHead: GitOid | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath !== null && resolve(currentPath) === expectedPath) {
        return { path: currentPath, head: currentHead };
      }
      currentPath = line.slice("worktree ".length);
      currentHead = null;
      continue;
    }
    if (line.startsWith("HEAD ")) currentHead = line.slice("HEAD ".length).trim() || null;
  }
  if (currentPath !== null && resolve(currentPath) === expectedPath) {
    return { path: currentPath, head: currentHead };
  }
  return null;
}

function updateDeliveryRef(repository: GitRepository, ref: string, desired: CommitOid): boolean {
  const observed = readRef(repository, ref);
  if (observed === desired) return true;
  if (observed !== null && !isAncestor(repository, observed, desired)) {
    // A newer or divergent world is evidence, not permission to move it back.
    return false;
  }

  const expected = observed ?? "0".repeat(desired.length);
  try {
    runGit(repository, ["update-ref", "--no-deref", ref, desired, expected]);
  } catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    const after = readRef(repository, ref);
    if (after === desired) return true;
    if (after !== null && isAncestor(repository, desired, after)) return false;
    throw error;
  }
  return readRef(repository, ref) === desired;
}

function materializeWorktree(repository: GitRepository, path: string, desired: CommitOid): boolean {
  const observed = observeWorktree(repository, path);
  if (observed !== null) {
    if (observed.head === desired) return false;
    if (observed.head !== null && !isAncestor(repository, observed.head, desired)) return false;
    runGit(repository, ["-C", path, "reset", "--hard", desired]);
    return true;
  }

  if (existsSync(path)) {
    // Never replace an unregistered path that happens to collide with our convention.
    throw new Error(`delivery worktree path is occupied: ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  runGit(repository, ["worktree", "add", "--detach", path, desired]);
  return true;
}

function removeWorktree(repository: GitRepository, path: string): boolean {
  const observed = observeWorktree(repository, path);
  if (observed === null) return false;
  runGit(repository, ["worktree", "remove", "--force", path]);
  return true;
}

function removeDeliveryRef(repository: GitRepository, ref: string): boolean {
  const observed = readRef(repository, ref);
  if (observed === null) return false;
  runGit(repository, ["update-ref", "--no-deref", "-d", ref, observed]);
  return true;
}

function effectFor(state: ContractState, entries: readonly JournalEntry[] | undefined): "align" | "cleanup" | "noop" {
  const relevant = entries?.findLast((entry) => entry.kind === "open" || entry.kind === "renew" || entry.kind === "petition" || entry.kind === "claim" || entry.kind === "forfeit");
  if (relevant?.kind === "petition") return "noop";
  if (relevant?.kind === "claim" || relevant?.kind === "forfeit") return state.delivery === null ? "noop" : "cleanup";
  if (relevant?.kind === "open" || relevant?.kind === "renew") return state.delivery === null ? "noop" : "align";
  if (state.phase === "claimed" || state.phase === "forfeited") return state.delivery === null ? "noop" : "cleanup";
  return state.delivery === null || state.phase === "awaiting-verdict" ? "noop" : "align";
}

function reconcileInput(repository: GitRepository, state: ContractState | ReconcileObservation | null, entries?: readonly JournalEntry[]): ReconcileResult {
  if (state !== null && "entries" in state) {
    return reconcileInput(repository, state.state, entries ?? state.entries);
  }
  if (state === null) return { kind: "noop", deliveryRef: null, worktreePath: null, changed: false };
  const ref = deliveryRefFor(state.id);
  const path = deliveryWorktreePath(repository, state.id);
  const effect = effectFor(state, entries);
  if (effect === "noop") return { kind: "noop", deliveryRef: ref, worktreePath: path, changed: false };
  if (effect === "cleanup") {
    const worktreeChanged = removeWorktree(repository, path);
    const refChanged = removeDeliveryRef(repository, ref);
    return { kind: "cleaned", deliveryRef: ref, worktreePath: path, changed: worktreeChanged || refChanged };
  }

  const desired = state.delivery!.head;
  const beforeRef = readRef(repository, ref);
  const refAligned = updateDeliveryRef(repository, ref, desired);
  if (!refAligned || readRef(repository, ref) !== desired) {
    return { kind: "aligned", deliveryRef: ref, worktreePath: path, changed: false };
  }
  const worktreeChanged = materializeWorktree(repository, path, desired);
  return { kind: "aligned", deliveryRef: ref, worktreePath: path, changed: beforeRef !== desired || worktreeChanged };
}

export function reconcile(input: ReconcileInput): ReconcileResult;
export function reconcile(repository: GitRepository, state: ContractState | ReconcileObservation | null, handoff?: unknown | null): ReconcileResult;
export function reconcile(
  inputOrRepository: ReconcileInput | GitRepository,
  state?: ContractState | ReconcileObservation | null,
  _handoff?: unknown | null,
): ReconcileResult {
  if ("repository" in inputOrRepository) {
    return reconcileInput(inputOrRepository.repository, inputOrRepository.state, inputOrRepository.entries);
  }
  return reconcileInput(inputOrRepository, state ?? null);
}

export const reconcileContract = reconcile;
