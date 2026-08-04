import assert from "node:assert/strict";
import test from "node:test";
import { encodeEntry } from "../src/core/facts/codec.js";
import { admit } from "../src/core/facts/admission.js";
import {
  CARRIER_FORMAT_BYTES,
  CARRIER_FORMAT_PATH,
  CARRIER_REF,
  buildTree,
  repositoryAt,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
  writeTree,
} from "../src/core/facts/repository.js";
import { foldJournal } from "../src/core/facts/fold.js";
import {
  observeContract,
  observeContracts,
} from "../src/core/protocol/observe.js";
import {
  blobOid,
  contractId,
  contractJournalPath,
  evidencePath,
  entryUlid,
  type BindEntry,
  type ContractId,
  type JournalEntry,
  type ReviewEntry,
} from "../src/core/facts/types.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-03T00:00:00Z";

function bindEntry(id: ContractId, entry = "01ARZ3NDEKTSV4RRFFQ69G5FAV"): BindEntry {
  return {
    v: 1,
    kind: "bind",
    contract: id,
    entry: entryUlid(entry),
    at: AT,
    actor: "test",
    data: {
      title: "Observed contract",
      context: "Context",
      objective: "Objective",
      design: "Design",
      region: ["src"],
      criteria: ["criterion"],
      verification: [],
      extensions: [],
    },
  };
}

function reviewEntry(id: ContractId): ReviewEntry {
  return {
    v: 1,
    kind: "review",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    at: AT,
    actor: "reviewer",
    data: {
      verdict: "approved",
      digest: "review-digest",
      summary: "review summary",
      evidence: [{
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
        seq: 0,
        kind: "report",
        oid: blobOid("f".repeat(40)),
      }],
    },
  };
}

function installCarrier(
  repository: ReturnType<typeof repositoryAt>,
  changes: ReadonlyMap<string, { readonly oid: string; readonly mode?: string; readonly type?: "blob" | "commit" }>,
): void {
  const base = writeTree(repository, []);
  const format = { oid: writeBlob(repository, CARRIER_FORMAT_BYTES) };
  const tree = buildTree(repository, base, new Map([...changes, [CARRIER_FORMAT_PATH, format]]));
  const commit = writeCommit(repository, tree, null);
  updateRefsAtomically(repository, [{ ref: CARRIER_REF, newOid: commit, expectedOid: null }]);
}

test("observing a missing contract in a fresh repository returns no facts", () => {
  const repository = makeGitRepository();
  const id = contractId("kei/missing-contract");

  assert.deepEqual(observeContract(repositoryAt(repository.path), id), {
    id,
    entries: [],
    state: null,
  });
});

test("observing a bound journal returns its exact head, entries, and folded state", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/observed-contract");
  const entries: JournalEntry[] = [bindEntry(id)];
  const result = admit(repo, {
    facts: [{ contractId: id, expectedHead: null, entries }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const head = result.heads[id];
  assert.ok(head);

  const observation = observeContract(repo, id);
  assert.deepEqual(observation.entries, entries);
  assert.deepEqual(observation.state, foldJournal(id, entries, head));
  assert.equal(observation.state?.head, head);
});

test("malformed journals and non-blob journal paths fail closed", () => {
  const malformedRepository = makeGitRepository();
  const malformedRepo = repositoryAt(malformedRepository.path);
  const malformedId = contractId("kei/malformed-contract");
  installCarrier(malformedRepo, new Map([
    [contractJournalPath(malformedId), { oid: writeBlob(malformedRepo, "{\"v\":1}\n") }],
  ]));
  assert.throws(() => observeContract(malformedRepo, malformedId), /missing field/);

  const nonBlobRepository = makeGitRepository();
  const nonBlobRepo = repositoryAt(nonBlobRepository.path);
  const nonBlobId = contractId("kei/non-blob-contract");
  const commit = writeCommit(nonBlobRepo, writeTree(nonBlobRepo, []), null);
  installCarrier(nonBlobRepo, new Map([
    [contractJournalPath(nonBlobId), { oid: commit, mode: "160000", type: "commit" }],
  ]));
  assert.throws(() => observeContract(nonBlobRepo, nonBlobId), /journal path is not a blob/);
});

test("observation keeps inline evidence entries without resolving evidence content", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/evidence-contract");
  const evidenceBlob = writeBlob(repo, "opaque evidence bytes");
  const review = reviewEntry(id);
  const evidenceRef = review.data.evidence[0];
  assert.ok(evidenceRef);
  const storedReview: ReviewEntry = {
    ...review,
    data: { ...review.data, evidence: [{ ...evidenceRef, oid: blobOid(evidenceBlob) }] },
  };
  const entries: JournalEntry[] = [bindEntry(id), storedReview];
  const canonicalJournal = entries.map((entry) => encodeEntry(entry)).join("");
  installCarrier(repo, new Map([
    [contractJournalPath(id), { oid: writeBlob(repo, canonicalJournal) }],
    [evidencePath(id, storedReview.data.evidence[0]!), { oid: evidenceBlob }],
  ]));

  const observation = observeContract(repo, id);
  assert.deepEqual(observation.entries, entries);
  assert.deepEqual(observation.state?.evidence, [entries[1]]);
  assert.equal(observation.state?.evidence[0]?.data.evidence[0]?.oid, evidenceBlob);
});

test("observation rejects a dangling journal evidence reference without reading payload bytes", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/dangling-evidence-contract");
  const entries: JournalEntry[] = [bindEntry(id), reviewEntry(id)];
  installCarrier(repo, new Map([
    [contractJournalPath(id), { oid: writeBlob(repo, entries.map((entry) => encodeEntry(entry)).join("")) }],
  ]));
  assert.throws(() => observeContract(repo, id), /journal evidence is not reachable/);
});

test("observing two contracts reads both journals from the captured carrier tree", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const first = contractId("kei/first-contract");
  const second = contractId("kei/second-contract");
  const evidence = writeBlob(repo, "payload is never read by observation");
  const reviewed = reviewEntry(second);
  const reference = reviewed.data.evidence[0]!;
  const secondReview: ReviewEntry = {
    ...reviewed,
    data: { ...reviewed.data, evidence: [{ ...reference, oid: blobOid(evidence) }] },
  };
  const secondEntries: JournalEntry[] = [bindEntry(second, "01ARZ3NDEKTSV4RRFFQ69G5FAY"), secondReview];
  const result = admit(repo, {
    facts: [
      { contractId: first, expectedHead: null, entries: [bindEntry(first)] },
      { contractId: second, expectedHead: null, entries: secondEntries },
    ],
    evidence: [{ contractId: second, ref: secondReview.data.evidence[0]!, bytes: "payload is never read by observation" }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const observation = observeContracts(repo, [first, second]);
  assert.equal(observation.carrierCommit, result.carrierCommit);
  assert.deepEqual(observation.contracts.get(first)?.entries, [bindEntry(first)]);
  assert.deepEqual(observation.contracts.get(second)?.entries, secondEntries);
});
