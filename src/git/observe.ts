import { decodeJournal } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { foldJournal } from "../core/facts/fold.js";
import {
  type ContractId,
  type ContractState,
  type JournalEntry,
  type SnapshotId,
} from "../core/facts/types.js";
import type { ContractsObservation } from "../core/facts/observation.js";
import { contractJournalPath, mintContractHead, mintSnapshotId } from "./identity.js";
import {
  GitPlumbingError,
  isKeiyakuOwnedRef,
  extendGitPaths,
  readBlobs,
  readRef,
  readGit,
  readGitPaths,
  runGit,
  type GitSnapshot,
  type GitOid,
  type GitRepository,
} from "./repository.js";

/** Observe a target ref as a branded snapshot without changing Git state. */
export function observeTargetHead(repository: GitRepository, target: string): SnapshotId | null {
  const value = readRef(repository, target);
  return value === null ? null : mintSnapshotId(value);
}

export type TargetObservation = Readonly<{ head: SnapshotId | null; drift: boolean }>;

export function observeDeliveryTarget(repository: GitRepository, state: ContractState): TargetObservation | null {
  const target = state.coordinates.target;
  if (target === undefined) return null;
  const head = observeTargetHead(repository, target);
  const delivery = state.delivery?.data;
  if (delivery === undefined) return { head, drift: false };
  const expected = state.terminal?.kind === "claimed"
    ? delivery.integration.snapshot
    : delivery.integration.predecessor;
  return { head, drift: head !== expected };
}

type GitJournalRecord = Readonly<{
  entries: readonly JournalEntry[];
  state: ContractState | null;
}>;

type GitObservation = Readonly<{
  contracts: ReadonlyMap<ContractId, GitJournalRecord>;
}>;

type FrozenGitObservation = Readonly<{
  contracts: ReadonlyMap<ContractId, GitJournalRecord>;
  frozenJournalBytes: ReadonlyMap<GitOid, Buffer>;
}>;

export type GitAdmissionSnapshot = Readonly<{
  snapshot: GitSnapshot;
  frozenJournalBytes: ReadonlyMap<GitOid, Buffer>;
}>;

export type GitDecisionObservation = Readonly<{
  admission: GitAdmissionSnapshot;
  decision: ContractsObservation;
  journals: ReadonlyMap<ContractId, GitJournalRecord>;
}>;

type BindCoordinatesObservation = Readonly<{ start: SnapshotId; target?: string }>;

const TARGET_COORDINATES_FORMAT = "%(refname)%00%(objectname)%00";

export function normalizeTargetBranch(repository: GitRepository, input: string): string | null {
  if (input.includes("\0")) return null;
  const prefix = "refs/heads/";
  if (input.startsWith("refs/") && !input.startsWith(prefix)) return null;
  const branch = input.startsWith(prefix) ? input.slice(prefix.length) : input;
  const target = `${prefix}${branch}`;
  if (branch.length === 0 || branch.startsWith("-") || isKeiyakuOwnedRef(target)) return null;
  try {
    const checked = runGit(repository, ["check-ref-format", "--branch", branch]).toString("utf8").trim();
    return checked === branch ? target : null;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status !== null) return null;
    throw error;
  }
}

/** Read one worktree's attached branch, or null for detached HEAD. */
export function currentBranch(repository: GitRepository, path?: string): string | null {
  try {
    const ref = runGit(repository, [
      ...(path === undefined ? [] : ["-C", path]),
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]).toString("utf8").trim();
    return ref.startsWith("refs/heads/") ? ref : null;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return null;
    throw error;
  }
}

function malformedBindCoordinatesOutput(): never {
  throw new Error("malformed structured Git output while observing bind coordinates");
}

function structuredFields(output: Buffer, fieldCount: number): readonly string[] {
  const fields = output.toString("utf8").split("\0");
  if (fields.length !== fieldCount + 1 || fields.at(-1) !== "\n") malformedBindCoordinatesOutput();
  return fields.slice(0, -1);
}

/** Observe bind's tender start and optional reward target without creating persistent state. */
export function observeBindCoordinates(
  repository: GitRepository,
  requestedTarget?: string,
): BindCoordinatesObservation | null {
  if (requestedTarget === undefined) {
    try {
      return { start: mintSnapshotId(runGit(repository, ["rev-parse", "--verify", "HEAD"]).toString("utf8").trim()) };
    } catch {
      malformedBindCoordinatesOutput();
    }
  }

  if (isKeiyakuOwnedRef(requestedTarget)) {
    throw new Error(`bind target names a Keiyaku-owned ref: ${requestedTarget}`);
  }

  const output = runGit(repository, [
    "for-each-ref",
    `--format=${TARGET_COORDINATES_FORMAT}`,
    "--",
    requestedTarget,
  ]);
  if (output.length === 0) return null;
  const [target, start] = structuredFields(output, 2);
  if (target !== requestedTarget || start === undefined) malformedBindCoordinatesOutput();
  try {
    return { target, start: mintSnapshotId(start) };
  } catch {
    malformedBindCoordinatesOutput();
  }
}

type DecodedJournal = Readonly<{
  id: ContractId;
  entries: ReturnType<typeof decodeJournal>;
  oid: string;
}>;

function decodeGitJournal(
  path: string,
  git: GitSnapshot,
  bytes: Buffer,
  expectedId?: ContractId,
): DecodedJournal {
  const journal = git.paths.get(path);
  if (journal === undefined) throw new AuthorityCorruptionError(`missing Git journal: ${path}`);
  if (journal.type !== "blob") throw new AuthorityCorruptionError(`journal path is not a blob: ${path}`);

  const entries = decodeJournal(bytes.toString("utf8"));
  const first = entries[0];
  if (
    first === undefined
    || (expectedId !== undefined && first.contract !== expectedId)
    || entries.some((entry) => entry.contract !== (expectedId ?? first.contract))
  ) {
    if (expectedId !== undefined) {
      throw new AuthorityCorruptionError(`journal content does not canonically identify ${expectedId}: ${path}`);
    }
    throw new AuthorityCorruptionError(`journal content does not canonically identify ${path}`);
  }
  const id = first.contract;
  if (contractJournalPath(id) !== path) {
    throw new AuthorityCorruptionError(`journal path does not match canonical contract identity: ${path}`);
  }
  return { id, entries, oid: journal.oid };
}

function observeDecodedJournal(id: ContractId, decoded: DecodedJournal): GitJournalRecord {
  return {
    entries: decoded.entries,
    state: foldJournal(id, decoded.entries, mintContractHead(decoded.oid)),
  };
}

function observeFromGit(
  git: GitSnapshot,
  id: ContractId,
  blobs: ReadonlyMap<GitOid, Buffer>,
): GitJournalRecord {
  const path = contractJournalPath(id);
  const journal = git.paths.get(path);
  if (journal === undefined) return { entries: [], state: null };
  if (journal.type !== "blob") throw new AuthorityCorruptionError(`journal path is not a blob: ${path}`);
  const bytes = blobs.get(journal.oid);
  if (bytes === undefined) throw new Error(`missing batched journal bytes: ${path}`);
  const decoded = decodeGitJournal(path, git, bytes, id);
  return observeDecodedJournal(id, decoded);
}

function enumerateContractObservations(
  git: GitSnapshot,
  blobs: ReadonlyMap<GitOid, Buffer>,
): ReadonlyMap<ContractId, GitJournalRecord> {
  const observations = new Map<ContractId, GitJournalRecord>();
  const seen = new Set<ContractId>();
  for (const [path, journal] of git.paths) {
    if (!path.startsWith("contracts/") || !path.endsWith(".jsonl")) continue;
    if (journal.type !== "blob") throw new AuthorityCorruptionError(`journal path is not a blob: ${path}`);
    const bytes = blobs.get(journal.oid);
    if (bytes === undefined) throw new Error(`missing batched journal bytes: ${path}`);
    const decoded = decodeGitJournal(path, git, bytes);
    const id = decoded.id;
    if (seen.has(id)) throw new AuthorityCorruptionError(`duplicate contract journal identity: ${id}`);
    seen.add(id);
    observations.set(id, observeDecodedJournal(id, decoded));
  }
  return observations;
}

/** Read one immutable Git snapshot, enumerate its journals, and include requested absence. */
export function observeGit(
  repository: GitRepository,
  requested: readonly ContractId[] = [],
): GitObservation {
  const git = readGit(repository);
  const observed = observeFrozenGitSnapshot(repository, git, requested);
  return { contracts: observed.contracts };
}

function observeFrozenGitSnapshot(
  repository: GitRepository,
  git: GitSnapshot,
  requested: readonly ContractId[],
): FrozenGitObservation {
  const blobs = readBlobs(repository, [...git.paths]
    .filter(([path, entry]) => path.startsWith("contracts/") && path.endsWith(".jsonl") && entry.type === "blob")
    .map(([, entry]) => entry.oid));
  const contracts = new Map(enumerateContractObservations(git, blobs));
  for (const id of requested) {
    if (!contracts.has(id)) contracts.set(id, observeFromGit(git, id, blobs));
  }
  return {
    contracts,
    frozenJournalBytes: blobs,
  };
}

/** Read one Git tree and fold all requested contracts from that immutable snapshot. */
export function observeContracts(
  repository: GitRepository,
  ids: readonly ContractId[],
): GitObservation {
  const git = readGitPaths(repository, ids.map((id) => contractJournalPath(id)));
  const observed = observeFrozenContractsSnapshot(repository, git, ids);
  return { contracts: observed.contracts };
}

function observeFrozenContractsSnapshot(
  repository: GitRepository,
  git: GitSnapshot,
  ids: readonly ContractId[],
): FrozenGitObservation {
  const contracts = new Map<ContractId, GitJournalRecord>();
  const paths = ids.map((id) => contractJournalPath(id));
  const blobs = readBlobs(repository, paths.flatMap((path) => {
    const journal = git.paths.get(path);
    return journal?.type === "blob" ? [journal.oid] : [];
  }));
  for (const id of ids) {
    if (!contracts.has(id)) contracts.set(id, observeFromGit(git, id, blobs));
  }
  return {
    contracts,
    frozenJournalBytes: blobs,
  };
}

function decisionProjection(observation: GitObservation): ContractsObservation {
  return new Map([...observation.contracts].map(([id, record]) => [id, record.state]));
}

export function observeContractsForAdmission(
  repository: GitRepository,
  ids: readonly ContractId[],
): GitDecisionObservation {
  const git = readGitPaths(repository, ids.map((id) => contractJournalPath(id)));
  const contracts = observeFrozenContractsSnapshot(repository, git, ids);
  return {
    admission: { snapshot: git, frozenJournalBytes: contracts.frozenJournalBytes },
    decision: decisionProjection(contracts),
    journals: contracts.contracts,
  };
}

/** Extend one admission observation with contracts from its already-pinned tree. */
export function extendContractsForAdmission(
  repository: GitRepository,
  observation: GitDecisionObservation,
  ids: readonly ContractId[],
): GitDecisionObservation {
  const missing = ids.filter((id) => !observation.decision.has(id));
  if (missing.length === 0) return observation;
  const snapshot = extendGitPaths(
    repository,
    observation.admission.snapshot,
    missing.map((id) => contractJournalPath(id)),
  );
  const added = observeFrozenContractsSnapshot(repository, snapshot, missing);
  return {
    admission: {
      snapshot,
      frozenJournalBytes: new Map([
        ...observation.admission.frozenJournalBytes,
        ...added.frozenJournalBytes,
      ]),
    },
    decision: new Map([...observation.decision, ...decisionProjection(added)]),
    journals: new Map([...observation.journals, ...added.contracts]),
  };
}

export function observeGitForAdmission(
  repository: GitRepository,
  ids: readonly ContractId[],
): GitDecisionObservation {
  const git = readGit(repository);
  const contracts = observeFrozenGitSnapshot(repository, git, ids);
  return {
    admission: { snapshot: git, frozenJournalBytes: contracts.frozenJournalBytes },
    decision: decisionProjection(contracts),
    journals: contracts.contracts,
  };
}

export function observeContract(repository: GitRepository, id: ContractId): GitJournalRecord {
  const observation = observeContracts(repository, [id]).contracts.get(id);
  if (observation === undefined) throw new Error(`missing requested contract observation: ${id}`);
  return observation;
}
