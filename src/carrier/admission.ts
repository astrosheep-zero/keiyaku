import {
  appendEntry,
  decodeJournal,
} from "../core/facts/codec.js";
import { foldJournal } from "../core/facts/fold.js";
import type { ContractJournalAppend, Offer, RefOperation } from "../core/facts/offer.js";
import {
  CARRIER_FORMAT_BYTES,
  CARRIER_FORMAT_PATH,
  CARRIER_REF,
  type CarrierSnapshot,
  type GitOid,
  type GitRepository,
  type RefPublication,
  type TreeChange,
  buildTree,
  readBlob,
  readCarrier,
  readRef,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "./repository.js";
import {
  contractHead,
  contractId,
  type ContractHead,
  type ContractId,
  type JournalEntry,
  type SnapshotId,
} from "../core/facts/types.js";
import {
  contractJournalPath,
  gitObjectIdForSnapshot,
  mintContractHead,
  mintSnapshotId,
} from "./identity.js";

export type ObservedContractHead = Readonly<{
  contractId: ContractId;
  path: string;
  head: ContractHead | null;
}>;

export type MovedContractHead = Readonly<ObservedContractHead & {
  expectedHead: ContractHead | null;
}>;

export type Accepted = Readonly<{
  kind: "accepted";
  heads: Readonly<Record<string, ContractHead>>;
}>;

export type HeadMoved = Readonly<{
  kind: "head-moved";
  carrierCommit: SnapshotId | null;
  heads: readonly ObservedContractHead[];
  moved: readonly MovedContractHead[];
}>;

export type RefMoved = Readonly<{
  kind: "ref-moved";
  target: string;
  expectedOid: SnapshotId;
  currentOid: SnapshotId | null;
  carrierCommit: SnapshotId | null;
  heads: readonly ObservedContractHead[];
}>;

export type Unknown = Readonly<{
  kind: "unknown";
  proposedHeads: Readonly<Record<string, ContractHead>>;
}>;

export type Admission = Accepted | HeadMoved | RefMoved | Unknown;

function checkedContractId(value: ContractId): ContractId {
  if (typeof value !== "string") throw new TypeError("contract ID must be a string");
  const id = contractId(value);
  contractJournalPath(id);
  return id;
}

function observedHead(snapshot: CarrierSnapshot, id: ContractId): ObservedContractHead {
  const path = contractJournalPath(id);
  const entry = snapshot.paths.get(path);
  if (entry !== undefined && entry.type !== "blob") throw new TypeError(`journal path is not a blob: ${path}`);
  return {
    contractId: id,
    path,
    head: entry === undefined ? null : mintContractHead(entry.oid),
  };
}

function observedHeads(snapshot: CarrierSnapshot, ids: readonly ContractId[]): readonly ObservedContractHead[] {
  return ids.map((id) => observedHead(snapshot, id));
}

function headMoved(
  snapshot: CarrierSnapshot,
  expected: ReadonlyMap<ContractId, ContractHead | null>,
): HeadMoved {
  const ids = [...expected.keys()];
  const heads = observedHeads(snapshot, ids);
  const moved = heads
    .filter((state) => state.head !== expected.get(state.contractId))
    .map((state) => ({ ...state, expectedHead: expected.get(state.contractId) ?? null }));
  return {
    kind: "head-moved",
    carrierCommit: snapshot.commit === null ? null : mintSnapshotId(snapshot.commit),
    heads,
    moved,
  };
}

function unknown(proposedHeads: Readonly<Record<string, ContractHead>>): Unknown {
  return {
    kind: "unknown",
    proposedHeads,
  };
}

function refMoved(
  snapshot: CarrierSnapshot,
  ids: readonly ContractId[],
  operation: RefOperation,
  currentOid: GitOid | null,
): RefMoved {
  return {
    kind: "ref-moved",
    target: operation.target,
    expectedOid: operation.expectedOid,
    currentOid: currentOid === null ? null : mintSnapshotId(currentOid),
    carrierCommit: snapshot.commit === null ? null : mintSnapshotId(snapshot.commit),
    heads: observedHeads(snapshot, ids),
  };
}

function normalizeAppends(
  appends: readonly ContractJournalAppend[],
): readonly ContractJournalAppend[] {
  const seen = new Set<ContractId>();
  return appends.map((append) => {
    if (!append || typeof append !== "object") throw new TypeError("invalid contract append");
    const id = checkedContractId(append.contractId);
    if (seen.has(id)) throw new TypeError(`duplicate contract append: ${id}`);
    seen.add(id);
    if (!Array.isArray(append.entries)) throw new TypeError(`entries must be an array: ${id}`);
    for (const entry of append.entries) {
      if (entry.contract !== id) throw new TypeError(`journal entry contract does not match append: ${id}`);
    }
    return {
      contractId: id,
      entries: append.entries,
      expectedHead: append.expectedHead === null ? null : contractHead(append.expectedHead),
    };
  });
}

function normalizeTarget(target: RefOperation | undefined): readonly RefOperation[] {
  if (target === undefined) return [];
  if (!target || typeof target !== "object") throw new TypeError("invalid target ref operation");
  if (typeof target.target !== "string") throw new TypeError("target ref operation target must be a string");
  if (target.target === CARRIER_REF) throw new TypeError(`the carrier ref is owned by admission: ${CARRIER_REF}`);
  if (target.expectedOid === null || target.expectedOid === undefined) {
    throw new TypeError("target ref operation requires a non-null expected OID");
  }
  if (target.newOid === null || target.newOid === undefined) {
    throw new TypeError("target ref operation requires a non-null new OID");
  }
  gitObjectIdForSnapshot(target.newOid);
  gitObjectIdForSnapshot(target.expectedOid);
  return [{ target: target.target, newOid: target.newOid, expectedOid: target.expectedOid }];
}

type OfferedClaim = Readonly<{
  append: ContractJournalAppend;
  entry: Extract<JournalEntry, { kind: "claimed" }>;
  entryIndex: number;
}>;

type ClaimRefOperation = Readonly<{
  claim: OfferedClaim;
  operation: RefOperation;
}>;

function validateRefOperationPairing(
  appends: readonly ContractJournalAppend[],
  operations: readonly RefOperation[],
): ClaimRefOperation | null {
  let claim: OfferedClaim | null = null;
  for (const append of appends) {
    for (const [entryIndex, entry] of append.entries.entries()) {
      if (entry.kind !== "claimed") continue;
      if (claim !== null) throw new TypeError("a claim target requires exactly one claimed entry");
      claim = { append, entry, entryIndex };
    }
  }

  if (operations.length === 0) return null;
  if (claim === null) throw new TypeError("a target ref operation requires exactly one claimed entry");
  const operation = operations[0];
  if (operation === undefined) throw new TypeError("a claimed entry requires exactly one target ref operation");
  return { claim, operation };
}

function readCanonicalJournal(repository: GitRepository, snapshot: CarrierSnapshot, id: ContractId): string {
  const path = contractJournalPath(id);
  const entry = snapshot.paths.get(path);
  if (entry === undefined) return "";
  if (entry.type !== "blob") throw new TypeError(`journal path is not a blob: ${path}`);
  const journal = readBlob(repository, entry.oid).toString("utf8");
  decodeJournal(journal);
  return journal;
}

function validateClaimTarget(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  claimTarget: ClaimRefOperation,
): void {
  const { append, entry, entryIndex } = claimTarget.claim;
  const prefix = [
    ...decodeJournal(readCanonicalJournal(repository, snapshot, append.contractId)),
    ...append.entries.slice(0, entryIndex),
  ];
  const state = foldJournal(append.contractId, prefix);
  if (state.coordinates === null || state.delivery === null) {
    throw new TypeError("claimed entry requires bound contract coordinates and a current deliver");
  }
  if (state.delivery.entry !== entry.data.delivery) throw new TypeError("claimed entry must name the current deliver");
  if (state.coordinates.target === undefined || claimTarget.operation.target !== state.coordinates.target) {
    throw new TypeError("target ref operation must target the contract coordinate");
  }
  if (claimTarget.operation.expectedOid !== state.delivery.data.expectedPredecessor) {
    throw new TypeError("target ref operation expected OID must match the deliver predecessor");
  }
  if (claimTarget.operation.newOid !== state.delivery.data.candidate) {
    throw new TypeError("target ref operation new OID must match the deliver candidate");
  }
}

function watchedRefMoved(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  ids: readonly ContractId[],
  operations: readonly RefOperation[],
): RefMoved | null {
  for (const operation of operations) {
    const currentOid = readRef(repository, operation.target);
    if (currentOid !== operation.expectedOid) return refMoved(snapshot, ids, operation, currentOid);
  }
  return null;
}

function buildOffer(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  appends: readonly ContractJournalAppend[],
): { readonly changes: ReadonlyMap<string, TreeChange>; readonly heads: Readonly<Record<string, ContractHead>> } {
  const changes = new Map<string, TreeChange>();
  const heads: Record<string, ContractHead> = {};

  if (snapshot.commit === null) {
    changes.set(CARRIER_FORMAT_PATH, { oid: writeBlob(repository, CARRIER_FORMAT_BYTES), mode: "100644", type: "blob" });
  }

  for (const append of appends) {
    let journal = readCanonicalJournal(repository, snapshot, append.contractId);
    for (const entry of append.entries) journal = appendEntry(journal, entry);
    if (append.entries.length === 0) {
      const existing = observedHead(snapshot, append.contractId).head;
      if (existing !== null) heads[append.contractId] = existing;
      continue;
    }
    foldJournal(append.contractId, decodeJournal(journal));
    const blob = writeBlob(repository, journal);
    changes.set(contractJournalPath(append.contractId), { oid: blob, mode: "100644", type: "blob" });
    heads[append.contractId] = mintContractHead(blob);
  }

  return { changes, heads };
}

function publishOffer(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  operations: readonly RefOperation[],
  changes: ReadonlyMap<string, TreeChange>,
): RefPublication {
  const carrierTree = buildTree(repository, snapshot.tree, changes);
  const carrierCommit = mintSnapshotId(writeCommit(repository, carrierTree, snapshot.commit));
  return updateRefsAtomically(repository, [
    { ref: CARRIER_REF, newOid: gitObjectIdForSnapshot(carrierCommit), expectedOid: snapshot.commit },
    ...operations.map((operation) => ({
      ref: operation.target,
      newOid: gitObjectIdForSnapshot(operation.newOid),
      expectedOid: gitObjectIdForSnapshot(operation.expectedOid),
    })),
  ]);
}

function observePublicationFailure(
  repository: GitRepository,
  operations: readonly RefOperation[],
): { readonly snapshot: CarrierSnapshot; readonly targetOid: GitOid | null | undefined } {
  const snapshot = readCarrier(repository);
  const operation = operations[0];
  return {
    snapshot,
    targetOid: operation === undefined ? undefined : readRef(repository, operation.target),
  };
}

export function admit(
  repository: GitRepository,
  offer: Offer,
): Admission {
  if (!offer || typeof offer !== "object") throw new TypeError("offer must be an object");
  if (!Array.isArray(offer.facts)) throw new TypeError("facts must be an array");

  const appends = normalizeAppends(offer.facts);
  const operations = normalizeTarget(offer.target);
  const claimTarget = validateRefOperationPairing(appends, operations);
  const watchedIds = appends.map((append) => append.contractId);
  const initial = readCarrier(repository);
  const expectedHeads = new Map(appends.map((append) => [append.contractId, append.expectedHead]));
  const initialHeadMovement = headMoved(initial, expectedHeads);
  if (initialHeadMovement.moved.length > 0) return initialHeadMovement;
  if (claimTarget !== null) validateClaimTarget(repository, initial, claimTarget);
  let snapshot = initial;
  let rebuildAfterCarrierMovement = false;
  while (true) {
    const currentHeadMovement = headMoved(snapshot, expectedHeads);
    if (currentHeadMovement.moved.length > 0) return currentHeadMovement;
    const refMovement = rebuildAfterCarrierMovement
      ? null
      : watchedRefMoved(repository, snapshot, watchedIds, operations);
    rebuildAfterCarrierMovement = false;
    if (refMovement !== null) return refMovement;

    const attempt = buildOffer(repository, snapshot, appends);
    const publication = publishOffer(repository, snapshot, operations, attempt.changes);
    if (publication.kind === "published") {
      return {
        kind: "accepted",
        heads: attempt.heads,
      };
    }
    if (publication.kind === "unknown") return unknown(attempt.heads);

    const observed = observePublicationFailure(repository, operations);
    if (observed.snapshot.commit !== snapshot.commit) {
      snapshot = observed.snapshot;
      rebuildAfterCarrierMovement = true;
      continue;
    }
    const operation = operations[0];
    if (operation !== undefined && observed.targetOid !== operation.expectedOid) {
      return refMoved(observed.snapshot, watchedIds, operation, observed.targetOid ?? null);
    }
    throw publication.error;
  }
}
