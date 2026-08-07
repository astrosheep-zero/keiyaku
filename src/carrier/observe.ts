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
  isKeiyakuOwnedRef,
  extendCarrierPaths,
  readBlobs,
  readCarrier,
  readCarrierPaths,
  runGit,
  type CarrierSnapshot,
  type GitOid,
  type GitRepository,
} from "./repository.js";

type CarrierJournalRecord = Readonly<{
  entries: readonly JournalEntry[];
  state: ContractState | null;
}>;

type CarrierObservation = Readonly<{
  contracts: ReadonlyMap<ContractId, CarrierJournalRecord>;
}>;

type FrozenCarrierObservation = Readonly<{
  contracts: ReadonlyMap<ContractId, CarrierJournalRecord>;
  frozenJournalBytes: ReadonlyMap<GitOid, Buffer>;
}>;

export type CarrierAdmissionSnapshot = Readonly<{
  snapshot: CarrierSnapshot;
  frozenJournalBytes: ReadonlyMap<GitOid, Buffer>;
}>;

export type CarrierDecisionObservation = Readonly<{
  admission: CarrierAdmissionSnapshot;
  decision: ContractsObservation;
  journals: ReadonlyMap<ContractId, CarrierJournalRecord>;
}>;

type BindCoordinatesObservation = Readonly<{ start: SnapshotId; target?: string }>;

const TARGET_COORDINATES_FORMAT = "%(refname)%00%(objectname)%00";

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
): BindCoordinatesObservation {
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
  if (output.length === 0) {
    throw new Error(`bind target does not exist: ${requestedTarget}`);
  }
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

function decodeCarrierJournal(
  path: string,
  carrier: CarrierSnapshot,
  bytes: Buffer,
  expectedId?: ContractId,
): DecodedJournal {
  const journal = carrier.paths.get(path);
  if (journal === undefined) throw new AuthorityCorruptionError(`missing carrier journal: ${path}`);
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

function observeDecodedJournal(id: ContractId, decoded: DecodedJournal): CarrierJournalRecord {
  return {
    entries: decoded.entries,
    state: foldJournal(id, decoded.entries, mintContractHead(decoded.oid)),
  };
}

function observeFromCarrier(
  carrier: CarrierSnapshot,
  id: ContractId,
  blobs: ReadonlyMap<GitOid, Buffer>,
): CarrierJournalRecord {
  const path = contractJournalPath(id);
  const journal = carrier.paths.get(path);
  if (journal === undefined) return { entries: [], state: null };
  if (journal.type !== "blob") throw new AuthorityCorruptionError(`journal path is not a blob: ${path}`);
  const bytes = blobs.get(journal.oid);
  if (bytes === undefined) throw new Error(`missing batched journal bytes: ${path}`);
  const decoded = decodeCarrierJournal(path, carrier, bytes, id);
  return observeDecodedJournal(id, decoded);
}

function enumerateContractObservations(
  carrier: CarrierSnapshot,
  blobs: ReadonlyMap<GitOid, Buffer>,
): ReadonlyMap<ContractId, CarrierJournalRecord> {
  const observations = new Map<ContractId, CarrierJournalRecord>();
  const seen = new Set<ContractId>();
  for (const [path, journal] of carrier.paths) {
    if (!path.startsWith("contracts/") || !path.endsWith(".jsonl")) continue;
    if (journal.type !== "blob") throw new AuthorityCorruptionError(`journal path is not a blob: ${path}`);
    const bytes = blobs.get(journal.oid);
    if (bytes === undefined) throw new Error(`missing batched journal bytes: ${path}`);
    const decoded = decodeCarrierJournal(path, carrier, bytes);
    const id = decoded.id;
    if (seen.has(id)) throw new AuthorityCorruptionError(`duplicate contract journal identity: ${id}`);
    seen.add(id);
    observations.set(id, observeDecodedJournal(id, decoded));
  }
  return observations;
}

/** Read one immutable carrier snapshot, enumerate its journals, and include requested absence. */
export function observeCarrier(
  repository: GitRepository,
  requested: readonly ContractId[] = [],
): CarrierObservation {
  const carrier = readCarrier(repository);
  const observed = observeFrozenCarrierSnapshot(repository, carrier, requested);
  return { contracts: observed.contracts };
}

function observeFrozenCarrierSnapshot(
  repository: GitRepository,
  carrier: CarrierSnapshot,
  requested: readonly ContractId[],
): FrozenCarrierObservation {
  const blobs = readBlobs(repository, [...carrier.paths]
    .filter(([path, entry]) => path.startsWith("contracts/") && path.endsWith(".jsonl") && entry.type === "blob")
    .map(([, entry]) => entry.oid));
  const contracts = new Map(enumerateContractObservations(carrier, blobs));
  for (const id of requested) {
    if (!contracts.has(id)) contracts.set(id, observeFromCarrier(carrier, id, blobs));
  }
  return {
    contracts,
    frozenJournalBytes: blobs,
  };
}

/** Read one carrier tree and fold all requested contracts from that immutable snapshot. */
export function observeContracts(
  repository: GitRepository,
  ids: readonly ContractId[],
): CarrierObservation {
  const carrier = readCarrierPaths(repository, ids.map((id) => contractJournalPath(id)));
  const observed = observeFrozenContractsSnapshot(repository, carrier, ids);
  return { contracts: observed.contracts };
}

function observeFrozenContractsSnapshot(
  repository: GitRepository,
  carrier: CarrierSnapshot,
  ids: readonly ContractId[],
): FrozenCarrierObservation {
  const contracts = new Map<ContractId, CarrierJournalRecord>();
  const paths = ids.map((id) => contractJournalPath(id));
  const blobs = readBlobs(repository, paths.flatMap((path) => {
    const journal = carrier.paths.get(path);
    return journal?.type === "blob" ? [journal.oid] : [];
  }));
  for (const id of ids) {
    if (!contracts.has(id)) contracts.set(id, observeFromCarrier(carrier, id, blobs));
  }
  return {
    contracts,
    frozenJournalBytes: blobs,
  };
}

function decisionProjection(observation: CarrierObservation): ContractsObservation {
  return new Map([...observation.contracts].map(([id, record]) => [id, record.state]));
}

export function observeContractsForAdmission(
  repository: GitRepository,
  ids: readonly ContractId[],
): CarrierDecisionObservation {
  const carrier = readCarrierPaths(repository, ids.map((id) => contractJournalPath(id)));
  const contracts = observeFrozenContractsSnapshot(repository, carrier, ids);
  return {
    admission: { snapshot: carrier, frozenJournalBytes: contracts.frozenJournalBytes },
    decision: decisionProjection(contracts),
    journals: contracts.contracts,
  };
}

/** Extend one admission observation with contracts from its already-pinned tree. */
export function extendContractsForAdmission(
  repository: GitRepository,
  observation: CarrierDecisionObservation,
  ids: readonly ContractId[],
): CarrierDecisionObservation {
  const missing = ids.filter((id) => !observation.decision.has(id));
  if (missing.length === 0) return observation;
  const snapshot = extendCarrierPaths(
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

export function observeCarrierForAdmission(
  repository: GitRepository,
  ids: readonly ContractId[],
): CarrierDecisionObservation {
  const carrier = readCarrier(repository);
  const contracts = observeFrozenCarrierSnapshot(repository, carrier, ids);
  return {
    admission: { snapshot: carrier, frozenJournalBytes: contracts.frozenJournalBytes },
    decision: decisionProjection(contracts),
    journals: contracts.contracts,
  };
}

export function observeContract(repository: GitRepository, id: ContractId): CarrierJournalRecord {
  const observation = observeContracts(repository, [id]).contracts.get(id);
  if (observation === undefined) throw new Error(`missing requested contract observation: ${id}`);
  return observation;
}
