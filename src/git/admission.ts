import {
  decodeJournal,
  encodeEntry,
} from "../core/facts/codec.js";
import type { ContractJournalAppend, Offer, RefOperation, TreeUpdate } from "../core/facts/offer.js";
import type { GitAdmissionSnapshot } from "./observe.js";
import {
  GIT_FORMAT_BYTES,
  GIT_FORMAT_PATH,
  GIT_REF,
  type GitRefAssertion,
  type RefPublication,
  type TreeChange,
  updateGitTreeFromFrozenDirectories,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "./repository.js";
import type { GitRepository } from "./process.js";
import {
  type ContractHead,
  type ContractId,
} from "../core/facts/types.js";
import {
  contractJournalPath,
  contractJournalPaths,
  gitObjectIdForSnapshot,
  mintContractHead,
  mintSnapshotId,
} from "./identity.js";
import { validPath } from "./tree.js";

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

const CONTRACT_JOURNAL_PATH = /^contracts\/(?:active|terminal)\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}\.jsonl$/u;

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

function assertCompanionStructure(
  companions: readonly TreeUpdate[],
  appends: readonly ContractJournalAppend[],
): readonly TreeUpdate[] {
  const reserved = new Set([GIT_FORMAT_PATH, ...appends.flatMap((append) => contractJournalPaths(append.contractId))]);
  const seen = new Set<string>();
  for (const companion of companions) {
    if (!companion || typeof companion !== "object") throw new Error("invalid companion update");
    validPath(companion.path);
    if (!(companion.bytes instanceof Uint8Array)) throw new Error(`companion bytes must be Uint8Array: ${companion.path}`);
    if (seen.has(companion.path)) throw new Error(`duplicate companion path: ${companion.path}`);
    if (reserved.has(companion.path) || CONTRACT_JOURNAL_PATH.test(companion.path)) {
      throw new Error(`companion path collides with admission-owned path: ${companion.path}`);
    }
    seen.add(companion.path);
  }
  return companions;
}

function readCanonicalJournal(
  admission: GitAdmissionSnapshot,
  id: ContractId,
): Readonly<{ bytes: Buffer; path: string | null }> {
  const snapshot = admission.snapshot;
  const matches = contractJournalPaths(id).filter((path) => snapshot.paths.has(path));
  if (matches.length > 1) throw new Error(`duplicate contract journal identity: ${id}`);
  const path = matches[0];
  if (path === undefined) return { bytes: Buffer.alloc(0), path: null };
  const entry = snapshot.paths.get(path)!;
  if (entry.type !== "blob") throw new Error(`journal path is not a blob: ${path}`);
  const journal = admission.frozenJournalBytes.get(entry.oid);
  if (journal === undefined) throw new Error(`missing frozen journal bytes: ${path}`);
  return { bytes: journal, path };
}

async function buildOffer(
  repository: GitRepository,
  admission: GitAdmissionSnapshot,
  appends: readonly ContractJournalAppend[],
  companions: readonly TreeUpdate[],
): Promise<{ readonly changes: ReadonlyMap<string, TreeChange>; readonly heads: Readonly<Record<string, ContractHead>> }> {
  const snapshot = admission.snapshot;
  const changes = new Map<string, TreeChange>();
  const heads: Record<string, ContractHead> = {};

  if (snapshot.commit === null) {
    changes.set(GIT_FORMAT_PATH, { oid: await writeBlob(repository, GIT_FORMAT_BYTES), mode: "100644", type: "blob" });
  }

  for (const companion of companions) {
    changes.set(companion.path, {
      oid: await writeBlob(repository, companion.bytes),
      mode: "100644",
      type: "blob",
    });
  }

  for (const append of appends) {
    const current = readCanonicalJournal(admission, append.contractId);
    let journal = current.bytes;
    for (const entry of append.entries) journal = Buffer.concat([journal, Buffer.from(encodeEntry(entry))]);
    const blob = await writeBlob(repository, journal);
    const entries = decodeJournal(journal.toString("utf8"));
    const terminal = entries.some((entry) => entry.kind === "claimed" || entry.kind === "abandoned");
    const destination = contractJournalPath(append.contractId, terminal ? "terminal" : "active");
    if (current.path !== null && current.path !== destination) changes.set(current.path, null);
    changes.set(destination, { oid: blob, mode: "100644", type: "blob" });
    heads[append.contractId] = mintContractHead(blob);
  }

  return { changes, heads };
}

async function publishOffer(
  repository: GitRepository,
  admission: GitAdmissionSnapshot,
  target: RefOperation | null,
  changes: ReadonlyMap<string, TreeChange>,
  assertions: readonly GitRefAssertion[],
): Promise<RefPublication> {
  const { snapshot } = admission;
  const gitTree = await updateGitTreeFromFrozenDirectories(
    repository,
    snapshot.tree,
    admission.treeDirectories,
    changes,
  );
  const gitCommit = mintSnapshotId(await writeCommit({
    repository,
    tree: gitTree,
    parent: snapshot.commit,
  }));
  return await updateRefsAtomically(repository, [
    { ref: GIT_REF, newOid: gitObjectIdForSnapshot(gitCommit), expectedOid: snapshot.commit },
    ...(target === null
      ? []
      : [{
          ref: target.target,
          newOid: gitObjectIdForSnapshot(target.newOid),
          expectedOid: gitObjectIdForSnapshot(target.expectedOid),
        }]),
  ], assertions);
}

export async function admit(
  repository: GitRepository,
  offer: Offer,
  admission: GitAdmissionSnapshot,
  assertions: readonly GitRefAssertion[] = [],
): Promise<Admission> {
  if (!Array.isArray(offer.facts) || offer.facts.length === 0) {
    throw new Error("facts must be a nonempty array");
  }

  const appends = assertAppendStructure(offer.facts);
  const companions = assertCompanionStructure(offer.companions ?? [], appends);
  const target = offer.target ?? null;

  const attempt = await buildOffer(repository, admission, appends, companions);
  const publication = await publishOffer(repository, admission, target, attempt.changes, assertions);
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
