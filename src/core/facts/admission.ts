import {
  appendEntry,
  decodeJournal,
} from "./codec.js";
import { foldJournal } from "./fold.js";
import {
  CARRIER_FORMAT_BYTES,
  CARRIER_FORMAT_PATH,
  CARRIER_REF,
  type CarrierSnapshot,
  type GitOid,
  type GitRepository,
  type TreeChange,
  buildTree,
  GitPlumbingError,
  readBlob,
  readCarrier,
  readRef,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "./repository.js";
import {
  blobOid,
  commitOid,
  contractHead,
  contractJournalPath,
  contractId,
  entryUlid,
  evidencePath,
  type BlobOid,
  type CommitOid,
  type ContractHead,
  type ContractId,
  type EvidenceRef,
  type JournalEntry,
} from "./types.js";

export type BlobInput = string | Uint8Array;

export interface ContractJournalAppend {
  readonly contractId: ContractId;
  readonly expectedHead?: ContractHead | null;
  readonly entries: readonly JournalEntry[];
}

export interface EvidenceWrite {
  readonly contractId: ContractId;
  readonly ref: EvidenceRef;
  readonly bytes: BlobInput;
}

export interface RefOperation {
  readonly ref: string;
  readonly newOid: GitOid;
  readonly expectedOid: GitOid;
}

export interface Offer {
  readonly facts: readonly ContractJournalAppend[];
  readonly evidence?: readonly EvidenceWrite[];
  readonly refs?: readonly [RefOperation];
}

export interface ObservedContractHead {
  readonly contractId: ContractId;
  readonly path: string;
  readonly head: ContractHead | null;
}

export interface MovedContractHead extends ObservedContractHead {
  readonly expectedHead: ContractHead | null;
}

export interface Accepted {
  readonly ok: true;
  readonly kind: "accepted";
  readonly carrierCommit: CommitOid;
  readonly carrierTree: GitOid;
  readonly heads: Readonly<Record<string, ContractHead>>;
}

export interface HeadMoved {
  readonly ok: false;
  readonly kind: "head-moved";
  readonly carrierCommit: CommitOid | null;
  readonly heads: readonly ObservedContractHead[];
  readonly moved: readonly MovedContractHead[];
}

export interface RefMoved {
  readonly ok: false;
  readonly kind: "ref-moved";
  readonly ref: string;
  readonly expectedOid: GitOid;
  readonly currentOid: GitOid | null;
  readonly carrierCommit: CommitOid | null;
  readonly heads: readonly ObservedContractHead[];
}

export interface EvidenceOccupied {
  readonly ok: false;
  readonly kind: "evidence-occupied";
  readonly path: string;
  readonly expectedOid: BlobOid;
  readonly currentOid: BlobOid;
  readonly carrierCommit: CommitOid;
  readonly heads: readonly ObservedContractHead[];
}

export type Unknown = Readonly<{
  readonly ok: false;
  readonly kind: "unknown";
}>;

export type Admission = Accepted | HeadMoved | EvidenceOccupied | RefMoved | Unknown;

function validatePath(path: string): void {
  if (
    path.length === 0
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\0")
    || path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError(`invalid carrier path: ${path}`);
  }
}

function checkedContractId(value: ContractId): ContractId {
  if (typeof value !== "string") throw new TypeError("contract ID must be a string");
  const id = contractId(value);
  contractJournalPath(id);
  return id;
}

function bytesFor(value: BlobInput): string | Uint8Array {
  return typeof value === "string" ? value : new Uint8Array(value);
}

function asArray<T>(value: readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("expected an array");
  return value;
}

function observedHead(snapshot: CarrierSnapshot, id: ContractId): ObservedContractHead {
  const path = contractJournalPath(id);
  const entry = snapshot.paths.get(path);
  if (entry !== undefined && entry.type !== "blob") throw new TypeError(`journal path is not a blob: ${path}`);
  return {
    contractId: id,
    path,
    head: entry === undefined ? null : contractHead(entry.oid),
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
    ok: false,
    kind: "head-moved",
    carrierCommit: snapshot.commit === null ? null : commitOid(snapshot.commit),
    heads,
    moved,
  };
}

function unknown(): Unknown {
  return {
    ok: false,
    kind: "unknown",
  };
}

function refMoved(
  snapshot: CarrierSnapshot,
  ids: readonly ContractId[],
  operation: RefOperation,
  currentOid: GitOid | null,
): RefMoved {
  return {
    ok: false,
    kind: "ref-moved",
    ref: operation.ref,
    expectedOid: operation.expectedOid,
    currentOid,
    carrierCommit: snapshot.commit === null ? null : commitOid(snapshot.commit),
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
    return append.expectedHead === undefined
      ? { contractId: id, entries: append.entries }
      : { contractId: id, entries: append.entries, expectedHead: append.expectedHead === null ? null : contractHead(append.expectedHead) };
  });
}

function normalizeRefOperations(operations: readonly RefOperation[]): readonly RefOperation[] {
  if (operations.length !== 1) throw new TypeError("an offer accepts exactly one claim ref operation");
  return operations.map((operation) => {
    if (!operation || typeof operation !== "object") throw new TypeError("invalid ref operation");
    if (typeof operation.ref !== "string") throw new TypeError("ref operation ref must be a string");
    if (operation.ref === CARRIER_REF) throw new TypeError(`the carrier ref is owned by admission: ${CARRIER_REF}`);
    if (operation.expectedOid === null || operation.expectedOid === undefined) {
      throw new TypeError("claim ref operation requires a non-null expected OID");
    }
    if (operation.newOid === null || operation.newOid === undefined) {
      throw new TypeError("claim ref operation requires a non-null new OID");
    }
    return { ref: operation.ref, newOid: operation.newOid, expectedOid: operation.expectedOid };
  });
}

function normalizeExpectedHeads(
  snapshot: CarrierSnapshot,
  appends: readonly ContractJournalAppend[],
): Map<ContractId, ContractHead | null> {
  const expected = new Map<ContractId, ContractHead | null>();
  for (const append of appends) {
    const actual = observedHead(snapshot, append.contractId).head;
    expected.set(
      append.contractId,
      append.expectedHead === undefined ? actual : append.expectedHead,
    );
  }
  return expected;
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

function evidenceRefs(entry: JournalEntry): readonly EvidenceRef[] {
  switch (entry.kind) {
    case "review":
    case "check":
    case "verification":
      return entry.data.evidence;
    default:
      return [];
  }
}

function sameEvidenceRef(left: EvidenceRef, right: EvidenceRef): boolean {
  return left.entry === right.entry && left.seq === right.seq && left.kind === right.kind && left.oid === right.oid;
}

function normalizeEvidenceRef(ref: EvidenceRef): EvidenceRef {
  if (!ref || typeof ref !== "object") throw new TypeError("invalid evidence reference");
  const entry = entryUlid(ref.entry);
  const seq = ref.seq;
  if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("evidence sequence must be a nonnegative safe integer");
  const oid = blobOid(ref.oid);
  return { entry, seq, kind: ref.kind, oid };
}

function prepareEvidence(
  snapshot: CarrierSnapshot,
  appends: readonly ContractJournalAppend[],
  writes: readonly EvidenceWrite[],
): readonly (EvidenceWrite & { readonly path: string; readonly ref: EvidenceRef })[] {
  const seen = new Set<string>();
  const journalPaths = new Set(appends.map((append) => contractJournalPath(append.contractId)));
  const prepared = writes.map((write) => {
    const id = checkedContractId(write.contractId);
    const ref = normalizeEvidenceRef(write.ref);
    const path = evidencePath(id, ref);
    validatePath(path);
    if (path === CARRIER_FORMAT_PATH || journalPaths.has(path)) {
      throw new TypeError(`evidence path collides with a carrier metadata or journal path: ${path}`);
    }
    if (seen.has(path)) throw new TypeError(`duplicate evidence path: ${path}`);
    seen.add(path);
    const append = appends.find((candidate) => candidate.contractId === id);
    if (append === undefined || !append.entries.some((entry) => evidenceRefs(entry).some((candidate) => sameEvidenceRef(candidate, ref)))) {
      throw new TypeError(`evidence reference is not in the appended journal: ${path}`);
    }
    return { ...write, contractId: id, ref, path };
  });

  const writesByPath = new Map(prepared.map((write) => [write.path, write]));
  for (const append of appends) {
    for (const entry of append.entries) {
      for (const candidate of evidenceRefs(entry)) {
        const ref = normalizeEvidenceRef(candidate);
        if (ref.entry !== entry.entry) {
          throw new TypeError(`evidence reference entry does not match journal entry: ${entry.entry}`);
        }
        const path = evidencePath(append.contractId, ref);
        const write = writesByPath.get(path);
        if (write !== undefined) {
          if (!sameEvidenceRef(write.ref, ref)) throw new TypeError(`conflicting evidence reference: ${path}`);
          continue;
        }
        const existing = snapshot.paths.get(path);
        if (existing === undefined || existing.type !== "blob" || existing.oid !== ref.oid) {
          throw new TypeError(`journal evidence is not reachable at the declared path and OID: ${path}`);
        }
      }
    }
  }
  return prepared;
}

function carrierRefRace(error: unknown): boolean {
  return error instanceof GitPlumbingError
    && error.command[0] === "update-ref"
    && error.status !== null
    && error.signal === null
    && (/is at .* but expected/i.test(error.message) || error.message.includes(`cannot lock ref '${CARRIER_REF}'`));
}

function publicationIsUnknown(error: unknown): boolean {
  return error instanceof GitPlumbingError
    && error.command[0] === "update-ref"
    && error.pid !== null
    && error.pid > 0
    && error.status === null;
}

function evidenceOccupied(
  snapshot: CarrierSnapshot,
  ids: readonly ContractId[],
  writes: readonly { readonly path: string; readonly ref: EvidenceRef }[],
): EvidenceOccupied | null {
  for (const write of writes) {
    const current = snapshot.paths.get(write.path);
    if (current === undefined) continue;
    if (current.type !== "blob") throw new TypeError(`evidence path is not a blob: ${write.path}`);
    if (snapshot.commit === null) throw new TypeError("published evidence requires a carrier commit");
    return {
      ok: false,
      kind: "evidence-occupied",
      path: write.path,
      expectedOid: write.ref.oid,
      currentOid: blobOid(current.oid),
      carrierCommit: commitOid(snapshot.commit),
      heads: observedHeads(snapshot, ids),
    };
  }
  return null;
}

function watchedRefMoved(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  ids: readonly ContractId[],
  operations: readonly RefOperation[],
): RefMoved | null {
  for (const operation of operations) {
    const currentOid = readRef(repository, operation.ref);
    if (currentOid !== operation.expectedOid) return refMoved(snapshot, ids, operation, currentOid);
  }
  return null;
}

function buildOffer(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  appends: readonly ContractJournalAppend[],
  evidence: readonly (EvidenceWrite & { readonly path: string; readonly ref: EvidenceRef })[],
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
    const blob = blobOid(writeBlob(repository, journal));
    changes.set(contractJournalPath(append.contractId), { oid: blob, mode: "100644", type: "blob" });
    heads[append.contractId] = contractHead(blob);
  }

  for (const write of evidence) {
    const blob = blobOid(writeBlob(repository, bytesFor(write.bytes)));
    if (blob !== write.ref.oid) {
      throw new TypeError(`evidence blob OID does not match Journal EvidenceRef: ${write.path}`);
    }
    changes.set(write.path, { oid: blob, mode: "100644", type: "blob" });
  }

  return { changes, heads };
}

function publishOffer(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  operations: readonly RefOperation[],
  changes: ReadonlyMap<string, TreeChange>,
): { readonly carrierCommit: CommitOid; readonly carrierTree: GitOid } {
  const carrierTree = buildTree(repository, snapshot.tree, changes);
  const carrierCommit = commitOid(writeCommit(repository, carrierTree, snapshot.commit));
  updateRefsAtomically(repository, [
    { ref: CARRIER_REF, newOid: carrierCommit, expectedOid: snapshot.commit },
    ...operations.map((operation) => ({
      ref: operation.ref,
      newOid: operation.newOid,
      expectedOid: operation.expectedOid,
    })),
  ]);
  return { carrierCommit, carrierTree };
}

export function admit(
  repository: GitRepository,
  offer: Offer,
): Admission {
  if (!offer || typeof offer !== "object") throw new TypeError("offer must be an object");
  if (!Array.isArray(offer.facts)) throw new TypeError("facts must be an array");

  const appends = normalizeAppends(offer.facts);
  const evidence = asArray(offer.evidence);
  const operations = offer.refs === undefined ? [] : normalizeRefOperations(asArray(offer.refs));
  const watchedIds = appends.map((append) => append.contractId);
  const initial = readCarrier(repository);
  const expectedHeads = normalizeExpectedHeads(initial, appends);
  const initialHeadMovement = headMoved(initial, expectedHeads);
  if (initialHeadMovement.moved.length > 0) return initialHeadMovement;
  const preparedEvidence = prepareEvidence(initial, appends, evidence);
  const initialEvidenceOccupation = evidenceOccupied(initial, watchedIds, preparedEvidence);
  if (initialEvidenceOccupation !== null) return initialEvidenceOccupation;

  let snapshot = initial;
  while (true) {
    const currentHeadMovement = headMoved(snapshot, expectedHeads);
    if (currentHeadMovement.moved.length > 0) return currentHeadMovement;
    const currentEvidenceOccupation = evidenceOccupied(snapshot, watchedIds, preparedEvidence);
    if (currentEvidenceOccupation !== null) return currentEvidenceOccupation;
    const refMovement = watchedRefMoved(repository, snapshot, watchedIds, operations);
    if (refMovement !== null) return refMovement;

    const attempt = buildOffer(repository, snapshot, appends, preparedEvidence);
    try {
      const accepted = publishOffer(repository, snapshot, operations, attempt.changes);
      return {
        ok: true,
        kind: "accepted",
        carrierCommit: accepted.carrierCommit,
        carrierTree: accepted.carrierTree,
        heads: attempt.heads,
      };
    } catch (error) {
      if (publicationIsUnknown(error)) return unknown();
      if (!carrierRefRace(error)) throw error;
      const racedSnapshot = readCarrier(repository);
      const racedHeadMovement = headMoved(racedSnapshot, expectedHeads);
      if (racedHeadMovement.moved.length > 0) return racedHeadMovement;
      const racedEvidenceOccupation = evidenceOccupied(racedSnapshot, watchedIds, preparedEvidence);
      if (racedEvidenceOccupation !== null) return racedEvidenceOccupation;
      const racedRefMovement = watchedRefMoved(repository, racedSnapshot, watchedIds, operations);
      if (racedRefMovement !== null) return racedRefMovement;
      if (racedSnapshot.commit === snapshot.commit) throw error;
      snapshot = racedSnapshot;
    }
  }
}
