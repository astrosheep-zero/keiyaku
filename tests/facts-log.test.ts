import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  commitContractTransaction,
  type TransactionPlan,
} from "../src/core/facts/log.js";
import { decodeJournal } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import {
  CARRIER_FORMAT_PATH,
  CARRIER_REF,
  buildTree,
  readCarrier,
  readRef,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
  writeTree,
  repositoryAt,
} from "../src/core/facts/repository.js";
import {
  blobOid,
  commitOid,
  contractId,
  entryUlid,
  type AmendEntry,
  type BindEntry,
  type ContractHead,
  type ContractId,
  type EvidenceRef,
  type JournalEntry,
  type ReviewEntry,
} from "../src/core/facts/types.js";
import { cloneGitRepository, makeGitRepository } from "./support/git.js";

const execFileAsync = promisify(execFile);
const AT = "2026-01-01T00:00:00Z";

function bindEntry(id: ContractId, entry = entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")): BindEntry {
  return {
    v: 1,
    kind: "bind",
    contract: id,
    entry,
    at: AT,
    actor: "test",
    data: {
      title: "Contract",
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

function amendEntry(id: ContractId, entry = entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW")): AmendEntry {
  return {
    v: 1,
    kind: "amend",
    contract: id,
    entry,
    at: AT,
    actor: "test",
    data: { region: ["src/core"] },
  };
}

function reviewEntry(id: ContractId, ref: EvidenceRef, entry = entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX")): ReviewEntry {
  return {
    v: 1,
    kind: "review",
    contract: id,
    entry,
    at: AT,
    actor: "test",
    data: {
      verdict: "approved",
      digest: "digest",
      summary: "summary",
      evidence: [ref],
    },
  };
}

function journalPlan(id: ContractId, expectedHead: ContractHead | null, entries: readonly BindEntry[] | readonly AmendEntry[]): TransactionPlan {
  return {
    contractAppends: [{ contractId: id, expectedHead, entries }],
  };
}

function installCarrier(repository: ReturnType<typeof repositoryAt>, format: string | null): void {
  const emptyTree = writeTree(repository, []);
  const tree = format === null
    ? emptyTree
    : buildTree(repository, emptyTree, new Map([[CARRIER_FORMAT_PATH, { oid: writeBlob(repository, format) }]]));
  const commit = writeCommit(repository, tree, null);
  updateRefsAtomically(repository, [{ ref: CARRIER_REF, newOid: commit, expectedOid: null }]);
}

test("initializes the current format and publishes journal plus evidence in one carrier commit", () => {
  const source = makeGitRepository();
  const repository = repositoryAt(source.path);
  const id = contractId("contract-a");
  const bytes = "review evidence";
  const ref: EvidenceRef = {
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    seq: 0,
    kind: "report",
    oid: blobOid(writeBlob(repository, bytes)),
  };
  const result = commitContractTransaction(repository, {
    contractAppends: [{ contractId: id, expectedHead: null, entries: [bindEntry(id), reviewEntry(id, ref)] }],
    evidenceWrites: [{ contractId: id, ref, bytes }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(source.run(["show", `${CARRIER_REF}:${CARRIER_FORMAT_PATH}`]), '{"version":1}\n');
  assert.match(source.run(["ls-tree", "-r", result.carrierTree]), /meta\/format\.json/);
  assert.match(source.run(["ls-tree", "-r", result.carrierTree]), /contracts\/contract-a\.jsonl/);
  assert.match(source.run(["ls-tree", "-r", result.carrierTree]), /contracts\/contract-a\/evidence\/01ARZ3NDEKTSV4RRFFQ69G5FAX\/0-report/);

  const clone = cloneGitRepository(source);
  clone.run(["gc", "--prune=now"]);
  assert.equal(clone.run(["show", `${CARRIER_REF}:contracts/contract-a/evidence/01ARZ3NDEKTSV4RRFFQ69G5FAX/0-report`]), bytes);
  assert.equal(clone.run(["show", `${CARRIER_REF}:meta/format.json`]), '{"version":1}\n');
});

test("terminal journal and evidence survive clone and GC after the candidate ref retires", () => {
  const source = makeGitRepository();
  const repository = repositoryAt(source.path);
  const id = contractId("terminal-contract");
  const tree = writeTree(repository, []);
  const predecessor = writeCommit(repository, tree, null);
  const candidate = writeCommit(repository, tree, predecessor);
  updateRefsAtomically(repository, [{ ref: "refs/heads/candidate", newOid: candidate, expectedOid: null }]);

  const petitionId = entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY");
  const reviewId = entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX");
  const bytes = "terminal review evidence";
  const ref: EvidenceRef = {
    entry: reviewId,
    seq: 0,
    kind: "review",
    oid: blobOid(writeBlob(repository, bytes)),
  };
  const entries: JournalEntry[] = [
    bindEntry(id),
    { v: 1, kind: "seal", contract: id, entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"), at: AT, actor: "test", data: {} },
    {
      v: 1,
      kind: "petition",
      contract: id,
      entry: petitionId,
      at: AT,
      actor: "test",
      data: {
        intent: "claim",
        oath: "candidate is ready",
        expectedPredecessor: commitOid(predecessor),
        seat: 1,
        candidate: commitOid(candidate),
      },
    },
    reviewEntry(id, ref, reviewId),
    {
      v: 1,
      kind: "claim",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
      at: AT,
      actor: "test",
      data: { petition: petitionId },
    },
  ];
  const result = commitContractTransaction(repository, {
    contractAppends: [{ contractId: id, expectedHead: null, entries }],
    evidenceWrites: [{ contractId: id, ref, bytes }],
    refOperations: [{ ref: "refs/heads/candidate", newOid: null, expectedOid: candidate }],
  });
  assert.equal(result.ok, true);
  assert.equal(readRef(repository, "refs/heads/candidate"), null);

  const clone = cloneGitRepository(source);
  clone.run(["gc", "--prune=now"]);
  const journal = clone.run(["show", `${CARRIER_REF}:contracts/${id}.jsonl`]);
  assert.equal(foldJournal(id, decodeJournal(journal)).phase, "claimed");
  assert.equal(clone.run(["show", `${CARRIER_REF}:contracts/${id}/evidence/${reviewId}/0-review`]), bytes);
  assert.throws(() => clone.run(["cat-file", "-e", candidate]));
});

test("appends typed entries to the canonical journal instead of replacing it", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("contract-a");
  const first = commitContractTransaction(repo, journalPlan(id, null, [bindEntry(id)]));
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = commitContractTransaction(repo, journalPlan(id, first.heads[id] ?? null, [amendEntry(id)]));
  assert.equal(second.ok, true);
  assert.equal(repository.run(["show", `${CARRIER_REF}:contracts/contract-a.jsonl`]).split("\n").filter(Boolean).length, 2);
  assert.match(repository.run(["show", `${CARRIER_REF}:contracts/contract-a.jsonl`]), /"kind":"bind"/);
  assert.match(repository.run(["show", `${CARRIER_REF}:contracts/contract-a.jsonl`]), /"kind":"amend"/);
});

test("rejects a syntactically valid append that makes the journal impossible to fold", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("contract-a");
  assert.throws(
    () => commitContractTransaction(repo, journalPlan(id, null, [amendEntry(id)])),
    /journal must begin with bind/,
  );
  assert.equal(readRef(repo, CARRIER_REF), null);
});

test("rejects an evidence OID that does not match its Journal EvidenceRef", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("contract-a");
  const ref: EvidenceRef = {
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    seq: 0,
    kind: "report",
    oid: blobOid(writeBlob(repo, "expected")),
  };

  assert.throws(
    () => commitContractTransaction(repo, {
      contractAppends: [{ contractId: id, expectedHead: null, entries: [bindEntry(id), reviewEntry(id, ref)] }],
      evidenceWrites: [{ contractId: id, ref, bytes: "published" }],
    }),
    /does not match/,
  );
  assert.equal(readRef(repo, CARRIER_REF), null);
});

test("evidence paths are derived and write-once", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("contract-a");
  const bytes = "evidence";
  const ref: EvidenceRef = {
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    seq: 2,
    kind: "report",
    oid: blobOid(writeBlob(repo, bytes)),
  };
  const first = commitContractTransaction(repo, {
    contractAppends: [{ contractId: id, expectedHead: null, entries: [bindEntry(id), reviewEntry(id, ref)] }],
    evidenceWrites: [{ contractId: id, ref, bytes }],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const collision = commitContractTransaction(repo, {
    contractAppends: [{ contractId: id, expectedHead: first.heads[id] ?? null, entries: [reviewEntry(id, ref)] }],
    evidenceWrites: [{ contractId: id, ref, bytes }],
  });
  assert.equal(collision.ok, false);
  if (collision.ok) return;
  assert.equal(collision.kind, "evidence-conflict");
  if (collision.kind !== "evidence-conflict") return;
  assert.equal(collision.path, `contracts/${id}/evidence/${ref.entry}/2-report`);
  assert.equal(collision.currentOid, ref.oid);
});

test("rejects a journal EvidenceRef whose blob is absent", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("contract-a");
  const ref: EvidenceRef = {
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
    seq: 0,
    kind: "report",
    oid: blobOid("a".repeat(40)),
  };
  assert.throws(
    () => commitContractTransaction(repo, {
      contractAppends: [{ contractId: id, expectedHead: null, entries: [bindEntry(id), reviewEntry(id, ref)] }],
    }),
    /journal evidence is not reachable/,
  );
  assert.equal(readRef(repo, CARRIER_REF), null);
});

test("rejects malformed and missing carrier format markers", () => {
  for (const format of [null, "{\"version\":2}\n", "not json\n"]) {
    const repository = makeGitRepository();
    const repo = repositoryAt(repository.path);
    installCarrier(repo, format);
    assert.throws(
      () => commitContractTransaction(repo, {
        contractAppends: [{ contractId: contractId("contract-a"), entries: [bindEntry(contractId("contract-a"))] }],
      }),
      /carrier (?:is missing|format)/,
    );
  }
});

test("two concurrent appends to one contract have exactly one winner", async () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("contract-a");
  const first = commitContractTransaction(repo, journalPlan(id, null, [bindEntry(id)]));
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const script = [
    "import { commitContractTransaction } from './src/core/facts/log.ts';",
    "import { repositoryAt } from './src/core/facts/repository.ts';",
    "const id = process.argv[2];",
    "const entry = { v: 1, kind: 'amend', contract: id, entry: process.argv[3], at: '2026-01-01T00:00:00Z', actor: 'child', data: { region: [process.argv[4]] } };",
    "const result = commitContractTransaction(repositoryAt(process.argv[1]), { contractAppends: [{ contractId: id, expectedHead: process.argv[5], entries: [entry] }] });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const head = first.heads[id];
  assert.ok(head);
  const args = (entry: string, region: string) => ["--import", "tsx", "-e", script, repository.path, id, entry, region, head];
  const [left, right] = await Promise.all([
    execFileAsync(process.execPath, args("01ARZ3NDEKTSV4RRFFQ69G5FAW", "left")),
    execFileAsync(process.execPath, args("01ARZ3NDEKTSV4RRFFQ69G5FAX", "right")),
  ]);
  const results = [JSON.parse(left.stdout), JSON.parse(right.stdout)] as Array<{ ok: boolean }>;
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok).length, 1);
});

test("reports a watched verb ref CAS conflict as a ref conflict", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const ref = writeCommit(repo, writeTree(repo, []), null);
  updateRefsAtomically(repo, [{ ref: "refs/heads/verb", newOid: ref, expectedOid: null }]);
  const id = contractId("contract-a");
  const result = commitContractTransaction(repo, {
    contractAppends: [{ contractId: id, expectedHead: null, entries: [bindEntry(id)] }],
    refOperations: [{ ref: "refs/heads/verb", newOid: null, expectedOid: null }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "ref-conflict");
  assert.equal(result.ref, "refs/heads/verb");
  assert.equal(result.expectedOid, null);
  assert.equal(result.currentOid, ref);
  assert.equal(readRef(repo, CARRIER_REF), null);
});

test("publishes the carrier and verb-owned ref in one successful ref transaction", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const verbCommit = writeCommit(repo, writeTree(repo, []), null);
  const id = contractId("contract-a");
  const result = commitContractTransaction(repo, {
    contractAppends: [{ contractId: id, expectedHead: null, entries: [bindEntry(id)] }],
    refOperations: [{ ref: "refs/heads/verb", newOid: verbCommit, expectedOid: null }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(readRef(repo, CARRIER_REF), result.carrierCommit);
  assert.equal(readRef(repo, "refs/heads/verb"), verbCommit);
});

test("unrelated carrier movement is rebased into the next transaction", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const firstId = contractId("contract-a");
  const unrelatedId = contractId("contract-b");
  const first = commitContractTransaction(repo, journalPlan(firstId, null, [bindEntry(firstId)]));
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const movement = commitContractTransaction(repo, journalPlan(unrelatedId, null, [bindEntry(unrelatedId)]));
  assert.equal(movement.ok, true);
  const result = commitContractTransaction(repo, journalPlan(firstId, first.heads[firstId] ?? null, [amendEntry(firstId)]));
  assert.equal(result.ok, true);
  assert.doesNotThrow(() => readCarrier(repo));
  assert.equal(repository.run(["show", `${CARRIER_REF}:contracts/contract-b.jsonl`]).includes('"kind":"bind"'), true);
});

test("concurrent appends to different contracts both survive carrier CAS", async () => {
  const repository = makeGitRepository();
  const script = [
    "import { commitContractTransaction } from './src/core/facts/log.ts';",
    "import { repositoryAt } from './src/core/facts/repository.ts';",
    "const id = process.argv[2];",
    "const entry = { v: 1, kind: 'bind', contract: id, entry: process.argv[3], at: '2026-01-01T00:00:00Z', actor: 'child', data: { title: id, context: 'c', objective: 'o', design: 'd', region: [], criteria: [], verification: [], extensions: [] } };",
    "const result = commitContractTransaction(repositoryAt(process.argv[1]), { contractAppends: [{ contractId: id, expectedHead: null, entries: [entry] }] });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const args = (id: string, entry: string) => ["--import", "tsx", "-e", script, repository.path, id, entry];
  const [left, right] = await Promise.all([
    execFileAsync(process.execPath, args("contract-a", "01ARZ3NDEKTSV4RRFFQ69G5FAV")),
    execFileAsync(process.execPath, args("contract-b", "01ARZ3NDEKTSV4RRFFQ69G5FAW")),
  ]);
  assert.equal(JSON.parse(left.stdout).ok, true);
  assert.equal(JSON.parse(right.stdout).ok, true);
  assert.match(repository.run(["show", `${CARRIER_REF}:contracts/contract-a.jsonl`]), /"kind":"bind"/);
  assert.match(repository.run(["show", `${CARRIER_REF}:contracts/contract-b.jsonl`]), /"kind":"bind"/);
  assert.equal(repository.run(["rev-list", "--count", CARRIER_REF]), "2\n");
});
