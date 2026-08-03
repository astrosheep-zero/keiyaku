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
  readonly newOid: GitOid | null;
  readonly expectedOid?: GitOid | null;
}

export interface TransactionPlan {
  readonly contractAppends: readonly ContractJournalAppend[];
  readonly evidenceWrites?: readonly EvidenceWrite[];
  readonly refOperations?: readonly RefOperation[];
}

export interface CurrentContractHead {
  readonly contractId: ContractId;
  readonly path: string;
  readonly head: ContractHead | null;
}

export interface ContractHeadConflict extends CurrentContractHead {
  readonly expectedHead: ContractHead | null;
}

export interface FactsSuccess {
  readonly ok: true;
  readonly kind: "committed";
  readonly carrierCommit: CommitOid;
  readonly carrierTree: GitOid;
  readonly heads: Readonly<Record<string, ContractHead>>;
}

export interface FactsConflict {
  readonly ok: false;
  readonly kind: "conflict";
  readonly reason: "watched-path-changed";
  readonly carrierCommit: CommitOid | null;
  readonly currentHeads: readonly CurrentContractHead[];
  readonly conflicts: readonly ContractHeadConflict[];
  readonly rebasable: false;
}

export interface RefConflict {
  readonly ok: false;
  readonly kind: "ref-conflict";
  readonly ref: string;
  readonly expectedOid: GitOid | null;
  readonly currentOid: GitOid | null;
  readonly carrierCommit: CommitOid | null;
  readonly currentHeads: readonly CurrentContractHead[];
}

export interface EvidenceConflict {
  readonly ok: false;
  readonly kind: "evidence-conflict";
  readonly path: string;
  readonly expectedOid: BlobOid;
  readonly currentOid: BlobOid;
  readonly carrierCommit: CommitOid;
  readonly currentHeads: readonly CurrentContractHead[];
}

export type FactsResult = FactsSuccess | FactsConflict | RefConflict | EvidenceConflict;

function carrierPath(id: ContractId): string {
  if (id.length === 0 || id.includes("/") || id.includes("\0") || id === "." || id === "..") {
    throw new TypeError(`invalid contract id: ${id}`);
  }
  return `contracts/${id}.jsonl`;
}

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
  carrierPath(id);
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

function currentHead(snapshot: CarrierSnapshot, id: ContractId): CurrentContractHead {
  const path = carrierPath(id);
  const entry = snapshot.paths.get(path);
  if (entry !== undefined && entry.type !== "blob") throw new TypeError(`journal path is not a blob: ${path}`);
  return {
    contractId: id,
    path,
    head: entry === undefined ? null : contractHead(entry.oid),
  };
}

function currentHeads(snapshot: CarrierSnapshot, ids: readonly ContractId[]): readonly CurrentContractHead[] {
  return ids.map((id) => currentHead(snapshot, id));
}

function conflict(
  snapshot: CarrierSnapshot,
  expected: ReadonlyMap<ContractId, ContractHead | null>,
): FactsConflict {
  const ids = [...expected.keys()];
  const states = currentHeads(snapshot, ids);
  const conflicts = states
    .filter((state) => state.head !== expected.get(state.contractId))
    .map((state) => ({ ...state, expectedHead: expected.get(state.contractId) ?? null }));
  return {
    ok: false,
    kind: "conflict",
    reason: "watched-path-changed",
    carrierCommit: snapshot.commit === null ? null : commitOid(snapshot.commit),
    currentHeads: states,
    conflicts,
    rebasable: false,
  };
}

function refConflict(
  snapshot: CarrierSnapshot,
  ids: readonly ContractId[],
  operation: RefOperation,
  currentOid: GitOid | null,
): RefConflict {
  const expectedOid = operation.expectedOid === undefined ? null : operation.expectedOid;
  return {
    ok: false,
    kind: "ref-conflict",
    ref: operation.ref,
    expectedOid,
    currentOid,
    carrierCommit: snapshot.commit === null ? null : commitOid(snapshot.commit),
    currentHeads: currentHeads(snapshot, ids),
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

function normalizeRefOperations(
  repository: GitRepository,
  operations: readonly RefOperation[],
): readonly RefOperation[] {
  const seen = new Set<string>();
  return operations.map((operation) => {
    if (operation.ref === CARRIER_REF) throw new TypeError(`the carrier ref is owned by the transaction: ${CARRIER_REF}`);
    if (seen.has(operation.ref)) throw new TypeError(`duplicate ref operation: ${operation.ref}`);
    seen.add(operation.ref);
    const expectedOid = operation.expectedOid === undefined ? readRef(repository, operation.ref) : operation.expectedOid;
    return { ref: operation.ref, newOid: operation.newOid, expectedOid };
  });
}

function normalizeExpectedHeads(
  snapshot: CarrierSnapshot,
  appends: readonly ContractJournalAppend[],
): Map<ContractId, ContractHead | null> {
  const expected = new Map<ContractId, ContractHead | null>();
  for (const append of appends) {
    const actual = currentHead(snapshot, append.contractId).head;
    expected.set(
      append.contractId,
      append.expectedHead === undefined ? actual : append.expectedHead,
    );
  }
  return expected;
}

function readCanonicalJournal(repository: GitRepository, snapshot: CarrierSnapshot, id: ContractId): string {
  const path = carrierPath(id);
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

function prepareEvidenceWrites(
  snapshot: CarrierSnapshot,
  appends: readonly ContractJournalAppend[],
  writes: readonly EvidenceWrite[],
): readonly (EvidenceWrite & { readonly path: string; readonly ref: EvidenceRef })[] {
  const seen = new Set<string>();
  const journalPaths = new Set(appends.map((append) => carrierPath(append.contractId)));
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

function transactionErrorIsRace(error: unknown): boolean {
  return error instanceof Error && /cannot lock ref|is at .* but expected|transaction failed/i.test(error.message);
}

function evidenceConflict(
  snapshot: CarrierSnapshot,
  ids: readonly ContractId[],
  writes: readonly { readonly path: string; readonly ref: EvidenceRef }[],
): EvidenceConflict | null {
  for (const write of writes) {
    const current = snapshot.paths.get(write.path);
    if (current === undefined) continue;
    if (current.type !== "blob") throw new TypeError(`evidence path is not a blob: ${write.path}`);
    if (snapshot.commit === null) throw new TypeError("published evidence requires a carrier commit");
    return {
      ok: false,
      kind: "evidence-conflict",
      path: write.path,
      expectedOid: write.ref.oid,
      currentOid: blobOid(current.oid),
      carrierCommit: commitOid(snapshot.commit),
      currentHeads: currentHeads(snapshot, ids),
    };
  }
  return null;
}

function watchedRefConflict(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  ids: readonly ContractId[],
  operations: readonly RefOperation[],
): RefConflict | null {
  for (const operation of operations) {
    const currentOid = readRef(repository, operation.ref);
    if (currentOid !== operation.expectedOid) return refConflict(snapshot, ids, operation, currentOid);
  }
  return null;
}

function buildAttempt(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  appends: readonly ContractJournalAppend[],
  evidenceWrites: readonly (EvidenceWrite & { readonly path: string; readonly ref: EvidenceRef })[],
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
      const existing = currentHead(snapshot, append.contractId).head;
      if (existing !== null) heads[append.contractId] = existing;
      continue;
    }
    foldJournal(append.contractId, decodeJournal(journal));
    const blob = blobOid(writeBlob(repository, journal));
    changes.set(carrierPath(append.contractId), { oid: blob, mode: "100644", type: "blob" });
    heads[append.contractId] = contractHead(blob);
  }

  for (const write of evidenceWrites) {
    const blob = blobOid(writeBlob(repository, bytesFor(write.bytes)));
    if (blob !== write.ref.oid) {
      throw new TypeError(`evidence blob OID does not match Journal EvidenceRef: ${write.path}`);
    }
    changes.set(write.path, { oid: blob, mode: "100644", type: "blob" });
  }

  return { changes, heads };
}

function commitAttempt(
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
      expectedOid: operation.expectedOid ?? null,
    })),
  ]);
  return { carrierCommit, carrierTree };
}

export function commitContractTransaction(repository: GitRepository, plan: TransactionPlan): FactsResult {
  if (!plan || typeof plan !== "object") throw new TypeError("transaction plan must be an object");
  if (!Array.isArray(plan.contractAppends)) throw new TypeError("contractAppends must be an array");

  const appends = normalizeAppends(plan.contractAppends);
  const evidenceWrites = asArray(plan.evidenceWrites);
  const operations = normalizeRefOperations(repository, asArray(plan.refOperations));
  const watchedIds = appends.map((append) => append.contractId);
  const initial = readCarrier(repository);
  const expectedHeads = normalizeExpectedHeads(initial, appends);
  const initialConflict = conflict(initial, expectedHeads);
  if (initialConflict.conflicts.length > 0) return initialConflict;
  const preparedEvidence = prepareEvidenceWrites(initial, appends, evidenceWrites);
  const initialEvidenceConflict = evidenceConflict(initial, watchedIds, preparedEvidence);
  if (initialEvidenceConflict !== null) return initialEvidenceConflict;

  let snapshot = initial;
  while (true) {
    const currentConflict = conflict(snapshot, expectedHeads);
    if (currentConflict.conflicts.length > 0) return currentConflict;
    const currentEvidenceConflict = evidenceConflict(snapshot, watchedIds, preparedEvidence);
    if (currentEvidenceConflict !== null) return currentEvidenceConflict;
    const refChanged = watchedRefConflict(repository, snapshot, watchedIds, operations);
    if (refChanged !== null) return refChanged;

    const attempt = buildAttempt(repository, snapshot, appends, preparedEvidence);
    try {
      const committed = commitAttempt(repository, snapshot, operations, attempt.changes);
      return {
        ok: true,
        kind: "committed",
        carrierCommit: committed.carrierCommit,
        carrierTree: committed.carrierTree,
        heads: attempt.heads,
      };
    } catch (error) {
      if (!transactionErrorIsRace(error)) throw error;
      snapshot = readCarrier(repository);
      const racedConflict = conflict(snapshot, expectedHeads);
      if (racedConflict.conflicts.length > 0) return racedConflict;
      const racedEvidenceConflict = evidenceConflict(snapshot, watchedIds, preparedEvidence);
      if (racedEvidenceConflict !== null) return racedEvidenceConflict;
      const racedRefConflict = watchedRefConflict(repository, snapshot, watchedIds, operations);
      if (racedRefConflict !== null) return racedRefConflict;
    }
  }
}
