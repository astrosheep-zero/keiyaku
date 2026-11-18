import { isUtf8 } from "node:buffer";
import { decodeJournal } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { foldJournal } from "../core/facts/fold.js";
import {
  contractId,
  type ContractId,
  type ContractState,
  type ContractTarget,
  type JournalEntry,
  type SnapshotId,
} from "../core/facts/types.js";
import { resolveContractTarget } from "./target.js";
import type { ContractsObservation } from "../core/facts/observation.js";
import {
  contractJournalPath,
  contractJournalPaths,
  mintContractHead,
  mintSnapshotId,
  type ContractJournalClass,
} from "./identity.js";
import { currentBranch, isKeiyakuOwnedRef, type GitSnapshot, type GitOid } from "./repository.js";
import { GitPlumbingError, executeGit, type GitRepository } from "./process.js";
import type { TreeEntry } from "./tree.js";
import {
  withGitTargetedReadObservation,
  type GitDecodeChannel,
  type GitReadObservation,
  type GitTreeSelection,
} from "./read-observation.js";

type TargetObservation = Readonly<{ head: SnapshotId | null; drift: boolean }>;

/** Reuse exact target evidence only within this read, while judging each Contract's own drift. */
export function deliveryTargetObserver(
  observation: GitReadObservation,
): (state: ContractState) => Promise<TargetObservation | null> {
  const targets = new Map<string, Promise<Readonly<{ head: SnapshotId | null; unavailable: boolean }>>>();
  return async (state) => {
    const target = state.coordinates.target;
    if (target === undefined) return null;
    const key =
      typeof target === "string" ? target : `${target.contractId}\0${target.worktree.id}\0${target.worktree.identity}`;
    let pending = targets.get(key);
    if (pending === undefined) {
      pending = (async () => {
        if (typeof target !== "string") {
          const resolved = await resolveContractTarget(observation.repository, target.contractId, target);
          return resolved.kind === "refused"
            ? { head: null, unavailable: true }
            : { head: resolved.head, unavailable: false };
        }
        const value = await observation.resolveRef(target);
        return { head: value === null ? null : mintSnapshotId(value), unavailable: false };
      })();
      targets.set(key, pending);
    }
    const { head, unavailable } = await pending;
    const integration = state.currentIntegration;
    const expected = state.terminal?.kind === "claimed" ? integration?.snapshot : integration?.predecessor;
    return { head, drift: unavailable || (integration !== null && head !== expected) };
  };
}

type PresentJournalRecord = Readonly<{
  path: string;
  oid: GitOid;
  bytes: Buffer;
  entries: readonly JournalEntry[];
  state: ContractState;
}>;

type GitJournalRecord = Readonly<{ entries: readonly []; state: null }> | PresentJournalRecord;

type ContractJournals = ReadonlyMap<ContractId, GitJournalRecord>;

export type ContractReadView = Readonly<{
  epoch: GitSnapshot;
  journals: ContractJournals;
  decision: ContractsObservation;
}>;

export type BindCoordinatesObservation = Readonly<{
  start: SnapshotId;
  target?: ContractTarget;
  branch: string | null;
}>;

type UnbornHeadObservation = Readonly<{
  kind: "unborn-head";
  branch: string | null;
}>;

export type BindTargetSelection =
  | Readonly<{ kind: "explicit"; target: string }>
  | Readonly<{ kind: "contract"; contractId: ContractId; inherited?: Exclude<ContractTarget, string> }>
  | Readonly<{ kind: "current-branch" }>
  | Readonly<{ kind: "targetless" }>;

export async function selectExplicitTarget(
  repository: GitRepository,
  input: string,
): Promise<Extract<BindTargetSelection, { kind: "explicit" | "contract" }> | null> {
  if (input.startsWith("kei/")) {
    try {
      return { kind: "contract", contractId: contractId(input) };
    } catch {
      return null;
    }
  }
  const target = await normalizeTargetBranch(repository, input);
  return target === null ? null : { kind: "explicit", target };
}

const TARGET_COORDINATES_FORMAT = "%(refname)%00%(objectname)%00";

export async function normalizeTargetBranch(repository: GitRepository, input: string): Promise<string | null> {
  if (input.includes("\0")) return null;
  const prefix = "refs/heads/";
  if (input.startsWith("refs/") && !input.startsWith(prefix)) return null;
  const branch = input.startsWith(prefix) ? input.slice(prefix.length) : input;
  const target = `${prefix}${branch}`;
  if (branch.length === 0 || branch.startsWith("-") || isKeiyakuOwnedRef(target)) return null;
  try {
    const checked = (await executeGit(repository, ["check-ref-format", "--branch", branch])).toString("utf8").trim();
    return checked === branch ? target : null;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status !== null) return null;
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

async function observeHeadCoordinates(
  repository: GitRepository,
): Promise<BindCoordinatesObservation | UnbornHeadObservation> {
  try {
    return {
      start: mintSnapshotId((await executeGit(repository, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim()),
      branch: await currentBranch(repository),
    };
  } catch (error) {
    if (
      error instanceof GitPlumbingError &&
      error.status === 128 &&
      error.stderr.toString("utf8").includes("Needed a single revision")
    ) {
      return { kind: "unborn-head", branch: await currentBranch(repository) };
    }
    throw error;
  }
}

/**
 * Observe bind's tender start and optional reward target without creating persistent state.
 * `current-branch` reads the observed worktree coordinate's own attached branch; the caller names
 * which coordinate it wants observed.
 */
export async function observeBindCoordinates(
  repository: GitRepository,
  selection: BindTargetSelection,
): Promise<BindCoordinatesObservation | UnbornHeadObservation | null> {
  if (selection.kind === "contract") throw new Error("contract targets require physical resolution");
  if (selection.kind === "explicit") {
    const requestedTarget = selection.target;
    if (isKeiyakuOwnedRef(requestedTarget)) {
      throw new Error(`bind target names a Keiyaku-owned ref: ${requestedTarget}`);
    }

    const output = await executeGit(repository, [
      "for-each-ref",
      `--format=${TARGET_COORDINATES_FORMAT}`,
      "--",
      requestedTarget,
    ]);
    if (output.length === 0) return null;
    const [target, start] = structuredFields(output, 2);
    if (target !== requestedTarget || start === undefined) malformedBindCoordinatesOutput();
    try {
      return { target, start: mintSnapshotId(start), branch: await currentBranch(repository) };
    } catch {
      malformedBindCoordinatesOutput();
    }
  }

  const observed = await observeHeadCoordinates(repository);
  if ("kind" in observed) return observed;
  if (selection.kind === "current-branch" && observed.branch !== null) {
    return { start: observed.start, target: observed.branch, branch: observed.branch };
  }
  return observed;
}

const CONTRACT_JOURNAL_PATH = /^contracts\/(active|terminal)\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}\.jsonl$/u;
type JournalSelection = ContractJournalClass | readonly ContractId[];
type PresentJournalBlob = Readonly<{ kind: "present"; bytes: Buffer }>;
type DecodedJournal = Readonly<{ id: ContractId; entries: readonly JournalEntry[] }>;

function journalSources(paths: GitSnapshot["paths"], journalClass?: ContractJournalClass) {
  return [...paths].filter(([path]) => {
    const matched = CONTRACT_JOURNAL_PATH.exec(path)?.[1];
    return matched !== undefined && (journalClass === undefined || matched === journalClass);
  });
}

function journalOid(path: string, entry: TreeEntry): GitOid {
  if (entry.type !== "blob") throw new AuthorityCorruptionError(`journal path is not a blob: ${path}`);
  return entry.oid;
}

function decodeJournalEntries(path: string, blob: PresentJournalBlob): DecodedJournal {
  if (!isUtf8(blob.bytes)) throw new AuthorityCorruptionError(`journal is not UTF-8: ${path}`);
  const entries = decodeJournal(blob.bytes.toString("utf8"));
  const id = entries[0]?.contract;
  if (id === undefined || !contractJournalPaths(id).includes(path)) {
    throw new AuthorityCorruptionError(`journal path does not match canonical contract identity: ${path}`);
  }
  return { id, entries };
}

function foldJournalRecord(
  path: string,
  oid: GitOid,
  blob: PresentJournalBlob,
  decoded: DecodedJournal,
): PresentJournalRecord {
  const state = foldJournal(decoded.id, decoded.entries, mintContractHead(oid));
  if (path !== contractJournalPath(decoded.id, state.terminal === null ? "active" : "terminal")) {
    throw new AuthorityCorruptionError(`journal path class does not match folded state: ${path}`);
  }
  return { path, oid, bytes: blob.bytes, entries: decoded.entries, state };
}

export function countActiveContractJournals(observation: GitReadObservation): number {
  const sources = journalSources(observation.snapshot.paths, "active");
  for (const [path, entry] of sources) journalOid(path, entry);
  return sources.length;
}

export function contractJournal(journals: ContractJournals, id: ContractId): GitJournalRecord {
  const record = journals.get(id);
  if (record === undefined) throw new Error(`missing requested Contract observation: ${id}`);
  return record;
}

async function collectJournals(
  read: GitReadObservation,
  journals: Map<ContractId, GitJournalRecord>,
  selection?: JournalSelection,
): Promise<ContractJournals> {
  const requested = typeof selection === "object" ? [...new Set(selection)] : undefined;
  if (requested?.length === 0) return journals;
  const paths =
    requested === undefined ? read.snapshot.paths : await read.selectPaths(requested.flatMap(contractJournalPaths));
  const sources =
    requested === undefined
      ? journalSources(paths, typeof selection === "string" ? selection : undefined)
      : requested.flatMap((id) => {
          const matches = contractJournalPaths(id).flatMap((path) => {
            const entry = paths.get(path);
            return entry === undefined ? [] : [[path, entry] as const];
          });
          if (matches.length > 1) throw new AuthorityCorruptionError(`duplicate contract journal identity: ${id}`);
          // A class-selected record proves its own path, not absence from the other class.
          return journals.has(id) ? [] : matches;
        });
  const selected = sources.map(([path, entry]) => [path, journalOid(path, entry)] as const);
  const blobs = await read.readBlobs(selected.map(([, oid]) => oid));
  for (const [path, oid] of selected) {
    const blob = blobs.get(oid);
    if (blob === undefined) throw new Error(`missing batched journal result: ${path}`);
    if (blob.kind === "missing") throw new AuthorityCorruptionError(`missing Git journal object: ${path}`);
    const decoded = decodeJournalEntries(path, blob);
    if (journals.has(decoded.id)) {
      throw new AuthorityCorruptionError(`duplicate contract journal identity: ${decoded.id}`);
    }
    journals.set(decoded.id, foldJournalRecord(path, oid, blob, decoded));
  }
  for (const id of requested ?? []) if (!journals.has(id)) journals.set(id, { entries: [], state: null });
  return journals;
}

/** Readable-only catalogue collection over one frozen batch read; only local journal corruption leaves no row. */
export async function observeReadableContractJournals(
  read: GitReadObservation,
  selection?: ContractJournalClass,
): Promise<Readonly<{ journals: ContractJournals; skipped: number }>> {
  const skippedPaths = new Set<string>();
  const selected: Array<readonly [string, GitOid]> = [];
  for (const [path, entry] of journalSources(read.snapshot.paths, selection)) {
    if (entry.type !== "blob") skippedPaths.add(path);
    else selected.push([path, entry.oid]);
  }
  const blobs = await read.readBlobs(selected.map(([, oid]) => oid));
  const journals = new Map<ContractId, GitJournalRecord>();
  for (const [path, oid] of selected) {
    const blob = blobs.get(oid);
    if (blob === undefined) throw new Error(`missing batched journal result: ${path}`);
    try {
      if (blob.kind === "missing") throw new AuthorityCorruptionError(`missing Git journal object: ${path}`);
      const decoded = decodeJournalEntries(path, blob);
      if (contractJournalPaths(decoded.id).some((other) => other !== path && read.snapshot.paths.has(other))) {
        skippedPaths.add(path);
        continue;
      }
      journals.set(decoded.id, foldJournalRecord(path, oid, blob, decoded));
    } catch (error) {
      if (!(error instanceof AuthorityCorruptionError)) throw error;
      skippedPaths.add(path);
    }
  }
  return { journals, skipped: skippedPaths.size };
}

export function observeContractJournals(
  read: GitReadObservation,
  selection?: JournalSelection,
): Promise<ContractJournals> {
  return collectJournals(read, new Map(), selection);
}

function sealView(epoch: GitSnapshot, journals: ContractJournals): ContractReadView {
  return { epoch, journals, decision: new Map([...journals].map(([id, record]) => [id, record.state])) };
}

export async function observeActiveContractWorld(read: GitReadObservation): Promise<ContractReadView> {
  const journals = new Map<ContractId, GitJournalRecord>();
  await collectJournals(read, journals, "active");
  await collectJournals(
    read,
    journals,
    [...journals.values()].flatMap(({ state }) => state?.terms.after ?? []),
  );
  return sealView(read.snapshot, journals);
}

export type CollectContracts = (ids: readonly ContractId[]) => Promise<ContractJournals>;
type Expansion = Readonly<{
  targets?: boolean;
  after?: boolean;
  expand?: (journals: ContractJournals, collect: CollectContracts) => Promise<void>;
}>;

export async function observeContractView(
  read: GitReadObservation,
  ids: readonly ContractId[],
  { targets, after, expand }: Expansion,
): Promise<ContractReadView> {
  const journals = new Map<ContractId, GitJournalRecord>();
  const collect: CollectContracts = (selected) => collectJournals(read, journals, selected);
  await collect(ids);
  const roots = ids.map((id) => contractJournal(journals, id).state);
  if (targets) {
    await collect(
      roots.flatMap((state) => {
        const target = state?.coordinates.target;
        return typeof target === "object" ? [target.contractId] : [];
      }),
    );
  }
  if (after) await collect(roots.flatMap((state) => state?.terms.after ?? []));
  await expand?.(journals, collect);
  return sealView(read.snapshot, journals);
}

export function observeContractsAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  ids: readonly ContractId[],
  options: GitTreeSelection & Omit<Expansion, "targets"> = {},
): Promise<ContractReadView> {
  return withGitTargetedReadObservation(
    repository,
    channel,
    { ...options, paths: [...ids.flatMap(contractJournalPaths), ...(options.paths ?? [])] },
    (read) => observeContractView(read, ids, { ...options, targets: true }),
  );
}

export function withContractReadObservationAt<Value>(
  repository: GitRepository,
  channel: GitDecodeChannel,
  id: ContractId,
  consume: (observation: GitReadObservation) => Value | PromiseLike<Value>,
): Promise<Value> {
  return withGitTargetedReadObservation(
    repository,
    channel,
    {
      paths: contractJournalPaths(id),
    },
    consume,
  );
}

export async function observeContractAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  id: ContractId,
): Promise<GitJournalRecord> {
  return contractJournal((await observeContractsAt(repository, channel, [id])).journals, id);
}
