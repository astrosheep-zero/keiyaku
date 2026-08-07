import {
  encodeEntry,
} from "../core/facts/codec.js";
import type { ContractJournalAppend, Offer, RefOperation } from "../core/facts/offer.js";
import type { CarrierAdmissionSnapshot } from "./observe.js";
import {
  CARRIER_FORMAT_BYTES,
  CARRIER_FORMAT_PATH,
  CARRIER_REF,
  type CarrierSnapshot,
  type GitRepository,
  type RefPublication,
  type TreeChange,
  updateCarrierTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "./repository.js";
import {
  type ContractHead,
  type ContractId,
} from "../core/facts/types.js";
import {
  contractJournalPath,
  gitObjectIdForSnapshot,
  mintContractHead,
  mintSnapshotId,
} from "./identity.js";

type Accepted = Readonly<{
  kind: "accepted";
  heads: Readonly<Record<string, ContractHead>>;
}>;

export type PublicationFailed = Readonly<{
  kind: "publication-failed";
  diagnostic: string;
}>;

type Unknown = Readonly<{ kind: "unknown" }>;

export type Admission = Accepted | PublicationFailed | Unknown;

function assertAppendStructure(
  appends: readonly ContractJournalAppend[],
): readonly ContractJournalAppend[] {
  const seen = new Set<ContractId>();
  for (const append of appends) {
    if (!append || typeof append !== "object") throw new Error("invalid contract append");
    const id = append.contractId;
    contractJournalPath(id);
    if (seen.has(id)) throw new Error(`duplicate contract append: ${id}`);
    seen.add(id);
    if (!Array.isArray(append.entries) || append.entries.length === 0) {
      throw new Error(`entries must be a nonempty array: ${id}`);
    }
  }
  return appends;
}

function readCanonicalJournal(
  admission: CarrierAdmissionSnapshot,
  id: ContractId,
): Buffer {
  const snapshot = admission.snapshot;
  const path = contractJournalPath(id);
  const entry = snapshot.paths.get(path);
  if (entry === undefined) return Buffer.alloc(0);
  if (entry.type !== "blob") throw new Error(`journal path is not a blob: ${path}`);
  const journal = admission.frozenJournalBytes.get(entry.oid);
  if (journal === undefined) throw new Error(`missing frozen journal bytes: ${path}`);
  return journal;
}

function buildOffer(
  repository: GitRepository,
  admission: CarrierAdmissionSnapshot,
  appends: readonly ContractJournalAppend[],
): { readonly changes: ReadonlyMap<string, TreeChange>; readonly heads: Readonly<Record<string, ContractHead>> } {
  const snapshot = admission.snapshot;
  const changes = new Map<string, TreeChange>();
  const heads: Record<string, ContractHead> = {};

  if (snapshot.commit === null) {
    changes.set(CARRIER_FORMAT_PATH, { oid: writeBlob(repository, CARRIER_FORMAT_BYTES), mode: "100644", type: "blob" });
  }

  for (const append of appends) {
    let journal = readCanonicalJournal(admission, append.contractId);
    for (const entry of append.entries) journal = Buffer.concat([journal, Buffer.from(encodeEntry(entry))]);
    const blob = writeBlob(repository, journal);
    changes.set(contractJournalPath(append.contractId), { oid: blob, mode: "100644", type: "blob" });
    heads[append.contractId] = mintContractHead(blob);
  }

  return { changes, heads };
}

function publishOffer(
  repository: GitRepository,
  snapshot: CarrierSnapshot,
  target: RefOperation | null,
  changes: ReadonlyMap<string, TreeChange>,
): RefPublication {
  const carrierTree = updateCarrierTree(repository, snapshot.tree, changes);
  const carrierCommit = mintSnapshotId(writeCommit({
    repository,
    tree: carrierTree,
    parent: snapshot.commit,
  }));
  return updateRefsAtomically(repository, [
    { ref: CARRIER_REF, newOid: gitObjectIdForSnapshot(carrierCommit), expectedOid: snapshot.commit },
    ...(target === null
      ? []
      : [{
          ref: target.target,
          newOid: gitObjectIdForSnapshot(target.newOid),
          expectedOid: gitObjectIdForSnapshot(target.expectedOid),
        }]),
  ]);
}

export function admit(
  repository: GitRepository,
  offer: Offer,
  admission: CarrierAdmissionSnapshot,
): Admission {
  if (!Array.isArray(offer.facts) || offer.facts.length === 0) {
    throw new Error("facts must be a nonempty array");
  }

  const appends = assertAppendStructure(offer.facts);
  const target = offer.target ?? null;

  const attempt = buildOffer(repository, admission, appends);
  const publication = publishOffer(repository, admission.snapshot, target, attempt.changes);
  if (publication.kind === "published") {
    return {
      kind: "accepted",
      heads: attempt.heads,
    };
  }
  if (publication.kind === "unknown") return { kind: "unknown" };
  return {
    kind: "publication-failed",
    diagnostic: publication.error instanceof Error ? publication.error.message : String(publication.error),
  };
}
