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
import {
  contractJournalPath,
  contractJournalPaths,
  mintContractHead,
  mintSnapshotId,
  type ContractJournalClass,
} from "./identity.js";
import {
  GitPlumbingError,
  isKeiyakuOwnedRef,
  runGit,
  type GitSnapshot,
  type GitOid,
  type GitRepository,
} from "./repository.js";
import {
  readGitTreeSelection,
  withGitTargetedReadObservation,
  type GitBlobResult,
  type GitDecodeChannel,
  type GitReadObservation,
  type GitTreeSelection,
} from "./read-observation.js";

export type TargetObservation = Readonly<{ head: SnapshotId | null; drift: boolean }>;

export async function observeDeliveryTargetAt(
  observation: GitReadObservation,
  state: ContractState,
): Promise<TargetObservation | null> {
  const target = state.coordinates.target;
  if (target === undefined) return null;
  const value = await observation.resolveRef(target);
  const head = value === null ? null : mintSnapshotId(value);
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

export type ContractWorldObservation = Readonly<{
  snapshot: SnapshotId | null;
  contracts: ReadonlyMap<ContractId, GitJournalRecord>;
}>;

export type ActiveContractWorldObservation = ContractWorldObservation & Readonly<{
  eligibility: ContractsObservation;
}>;

type FrozenGitObservation = Readonly<{
  contracts: ReadonlyMap<ContractId, GitJournalRecord>;
  frozenJournalBytes: ReadonlyMap<GitOid, Buffer>;
}>;

export type GitAdmissionSnapshot = Readonly<{
  snapshot: GitSnapshot;
  frozenJournalBytes: ReadonlyMap<GitOid, Buffer>;
  treeDirectories: ReadonlyMap<string, ReadonlyMap<string, import("./tree.js").TreeEntry>>;
}>;

export type GitDecisionObservation = Readonly<{
  admission: GitAdmissionSnapshot;
  decision: ContractsObservation;
  journals: ReadonlyMap<ContractId, GitJournalRecord>;
}>;

export type BindCoordinatesObservation = Readonly<{
  start: SnapshotId;
  target?: string;
  branch: string | null;
}>;

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
      return {
        start: mintSnapshotId(runGit(repository, ["rev-parse", "--verify", "HEAD"]).toString("utf8").trim()),
        branch: currentBranch(repository),
      };
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
    return { target, start: mintSnapshotId(start), branch: currentBranch(repository) };
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
  if (!contractJournalPaths(id).includes(path)) {
    throw new AuthorityCorruptionError(`journal path does not match canonical contract identity: ${path}`);
  }
  return { id, entries, oid: journal.oid };
}

function journalClass(state: ContractState): ContractJournalClass {
  return state.terminal === null ? "active" : "terminal";
}

function observeDecodedJournal(id: ContractId, decoded: DecodedJournal, path?: string): GitJournalRecord {
  const state = foldJournal(id, decoded.entries, mintContractHead(decoded.oid));
  if (path !== undefined && contractJournalPath(id, journalClass(state)) !== path) {
    throw new AuthorityCorruptionError(`journal path class does not match folded state: ${path}`);
  }
  return {
    entries: decoded.entries,
    state,
  };
}

function observeFromGit(
  git: GitSnapshot,
  id: ContractId,
  blobs: ReadonlyMap<GitOid, Buffer>,
): GitJournalRecord {
  const matches = contractJournalPaths(id)
    .flatMap((path) => git.paths.has(path) ? [path] : []);
  if (matches.length > 1) throw new AuthorityCorruptionError(`duplicate contract journal identity: ${id}`);
  const path = matches[0];
  if (path === undefined) return { entries: [], state: null };
  const journal = git.paths.get(path)!;
  if (journal.type !== "blob") throw new AuthorityCorruptionError(`journal path is not a blob: ${path}`);
  const bytes = blobs.get(journal.oid);
  if (bytes === undefined) throw new Error(`missing batched journal bytes: ${path}`);
  const decoded = decodeGitJournal(path, git, bytes, id);
  return observeDecodedJournal(id, decoded, path);
}

function enumerateContractObservations(
  git: GitSnapshot,
  blobs: ReadonlyMap<GitOid, Buffer>,
  journalClass?: ContractJournalClass,
): ReadonlyMap<ContractId, GitJournalRecord> {
  const observations = new Map<ContractId, GitJournalRecord>();
  const seen = new Set<ContractId>();
  for (const [path, journal] of git.paths) {
    const match = /^contracts\/(active|terminal)\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}\.jsonl$/u.exec(path);
    if (match === null || (journalClass !== undefined && match[1] !== journalClass)) continue;
    if (journal.type !== "blob") throw new AuthorityCorruptionError(`journal path is not a blob: ${path}`);
    const bytes = blobs.get(journal.oid);
    if (bytes === undefined) throw new Error(`missing batched journal bytes: ${path}`);
    const decoded = decodeGitJournal(path, git, bytes);
    const id = decoded.id;
    if (seen.has(id)) throw new AuthorityCorruptionError(`duplicate contract journal identity: ${id}`);
    seen.add(id);
    observations.set(id, observeDecodedJournal(id, decoded, path));
  }
  return observations;
}

export async function observeActiveContractWorld(
  observation: GitReadObservation,
): Promise<ActiveContractWorldObservation> {
  const git = observation.snapshot;
  const journals = [...git.paths]
    .filter(([path, entry]) => path.startsWith("contracts/active/") && path.endsWith(".jsonl") && entry.type === "blob");
  const results = await observation.readBlobs(journals.map(([, entry]) => entry.oid));
  const blobs = new Map<GitOid, Buffer>();
  for (const [path, entry] of journals) {
    const result = results.get(entry.oid);
    if (result?.kind !== "present") throw new AuthorityCorruptionError(`missing Git journal object: ${path}`);
    blobs.set(entry.oid, result.bytes);
  }
  const contracts = new Map(enumerateContractObservations(git, blobs, "active"));
  const prerequisites = [...new Set(
    [...contracts.values()].flatMap((record) => record.state?.terms.after ?? []),
  )];
  const dependencyRecords = await observeTargetedContractsAt(observation, prerequisites);
  return {
    snapshot: git.commit === null ? null : mintSnapshotId(git.commit),
    contracts,
    eligibility: decisionProjection({
      contracts: new Map([...contracts, ...dependencyRecords.contracts]),
    }),
  };
}

export async function observeContractWorld(
  observation: GitReadObservation,
  requested: readonly ContractId[] = [],
): Promise<ContractWorldObservation> {
  const git = observation.snapshot;
  const journals = [...git.paths]
    .filter(([path, entry]) => /^contracts\/(?:active|terminal)\//u.test(path) && path.endsWith(".jsonl") && entry.type === "blob");
  const results = await observation.readBlobs(journals.map(([, entry]) => entry.oid));
  const blobs = new Map<GitOid, Buffer>();
  for (const [path, entry] of journals) {
    const result = results.get(entry.oid);
    if (result?.kind !== "present") throw new AuthorityCorruptionError(`missing Git journal object: ${path}`);
    blobs.set(entry.oid, result.bytes);
  }
  const contracts = new Map(enumerateContractObservations(git, blobs));
  for (const id of requested) {
    if (!contracts.has(id)) contracts.set(id, observeFromGit(git, id, blobs));
  }
  return {
    snapshot: git.commit === null ? null : mintSnapshotId(git.commit),
    contracts,
  };
}

async function observeTargetedContractsAt(
  observation: GitReadObservation,
  ids: readonly ContractId[],
): Promise<FrozenGitObservation> {
  return observeTargetedContractsFromSnapshotAt(
    observation.snapshot,
    observation.readBlobs,
    ids,
  );
}

async function observeTargetedContractsFromSnapshotAt(
  snapshot: GitSnapshot,
  readBlobsAt: GitReadObservation["readBlobs"],
  ids: readonly ContractId[],
): Promise<FrozenGitObservation> {
  const paths = ids.flatMap(contractJournalPaths);
  const entries = paths.flatMap((path) => {
    const journal = snapshot.paths.get(path);
    return journal?.type === "blob" ? [[path, journal] as const] : [];
  });
  const results = await readBlobsAt(entries.map(([, entry]) => entry.oid));
  const blobs = new Map<GitOid, Buffer>();
  for (const [path, entry] of entries) {
    const result = results.get(entry.oid);
    if (result?.kind !== "present") throw new AuthorityCorruptionError(`missing Git journal object: ${path}`);
    blobs.set(entry.oid, result.bytes);
  }
  const contracts = new Map<ContractId, GitJournalRecord>();
  for (const id of ids) contracts.set(id, observeFromGit(snapshot, id, blobs));
  return { contracts, frozenJournalBytes: blobs };
}

export async function observeContractsForAdmissionAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  ids: readonly ContractId[],
  selection: GitTreeSelection = {},
): Promise<GitDecisionObservation> {
  return withGitTargetedReadObservation(repository, channel, {
    paths: [...ids.flatMap(contractJournalPaths), ...(selection.paths ?? [])],
    ...(selection.subtrees === undefined ? {} : { subtrees: selection.subtrees }),
  }, (observation) => observeContractsForAdmissionInObservationAt(observation, ids));
}

/** Observe selected Contract journals and their current direct prerequisites in one Git epoch. */
export async function observeGitForAdmissionAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  ids: readonly ContractId[],
  selection: GitTreeSelection = {},
): Promise<GitDecisionObservation> {
  const observation = await observeContractsForAdmissionAt(repository, channel, ids, selection);
  const prerequisites = [...new Set(ids.flatMap((id) => observation.decision.get(id)?.terms.after ?? []))];
  return extendContractsForAdmissionAt(channel, observation, prerequisites);
}

export function withContractReadObservationAt<Value>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  id: ContractId,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  return withGitTargetedReadObservation(repository, channel, {
    paths: contractJournalPaths(id),
  }, consume);
}

/** Observe targeted Contract journals within an already frozen Git epoch. */
export async function observeContractsForAdmissionInObservationAt(
  observation: GitReadObservation,
  ids: readonly ContractId[],
): Promise<GitDecisionObservation> {
  const contracts = await observeTargetedContractsAt(observation, ids);
  return {
    admission: {
      snapshot: observation.snapshot,
      frozenJournalBytes: contracts.frozenJournalBytes,
      treeDirectories: observation.treeDirectories,
    },
    decision: decisionProjection(contracts),
    journals: contracts.contracts,
  };
}

export async function observeContractAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  id: ContractId,
): Promise<GitJournalRecord> {
  const observation = await observeContractsForAdmissionAt(repository, channel, [id]);
  const record = observation.journals.get(id);
  if (record === undefined) throw new Error(`missing requested contract observation: ${id}`);
  return record;
}

export async function extendContractsForAdmissionAt(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  ids: readonly ContractId[],
): Promise<GitDecisionObservation> {
  const missing = ids.filter((id) => !observation.decision.has(id));
  if (missing.length === 0) return observation;
  const readBlobsAt: GitReadObservation["readBlobs"] = async (oids) => {
    const objects = await channel.readObjects(oids);
    const blobs = new Map<GitOid, GitBlobResult>();
    for (const [oid, object] of objects) {
      if (object.kind === "missing") blobs.set(oid, object);
      else {
        if (object.type !== "blob") throw new AuthorityCorruptionError(`Git object is not a blob: ${oid}`);
        blobs.set(oid, { kind: "present", bytes: object.bytes });
      }
    }
    return blobs;
  };
  const snapshot = observation.admission.snapshot;
  if (snapshot.tree === null) return observation;
  const selected = await readGitTreeSelection(channel, snapshot.tree, {
    paths: missing.flatMap(contractJournalPaths),
  });
  const extendedSnapshot = {
    ...snapshot,
    paths: new Map([...snapshot.paths, ...selected.paths]),
  };
  const added = await observeTargetedContractsFromSnapshotAt(
    extendedSnapshot,
    readBlobsAt,
    missing,
  );
  return {
    admission: {
      snapshot: extendedSnapshot,
      frozenJournalBytes: new Map([...observation.admission.frozenJournalBytes, ...added.frozenJournalBytes]),
      treeDirectories: new Map([...observation.admission.treeDirectories, ...selected.directories]),
    },
    decision: new Map([...observation.decision, ...decisionProjection(added)]),
    journals: new Map([...observation.journals, ...added.contracts]),
  };
}

export async function extendAdmissionPathsAt(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  paths: readonly string[],
): Promise<GitDecisionObservation> {
  if (paths.length === 0 || observation.admission.snapshot.tree === null) return observation;
  const selected = await readGitTreeSelection(channel, observation.admission.snapshot.tree, { paths });
  return {
    ...observation,
    admission: {
      ...observation.admission,
      snapshot: {
        ...observation.admission.snapshot,
        paths: new Map([...observation.admission.snapshot.paths, ...selected.paths]),
      },
      treeDirectories: new Map([...observation.admission.treeDirectories, ...selected.directories]),
    },
  };
}

function decisionProjection(observation: Pick<ContractWorldObservation, "contracts">): ContractsObservation {
  return new Map([...observation.contracts].map(([id, record]) => [id, record.state]));
}
