import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  admit,
  type Offer,
} from "../src/core/facts/admission.js";
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
  contractJournalPath,
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

function journalOffer(id: ContractId, expectedHead: ContractHead | null, entries: readonly BindEntry[] | readonly AmendEntry[]): Offer {
  return {
    facts: [{ contractId: id, expectedHead, entries }],
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

function gitShim(body: string): { readonly env: NodeJS.ProcessEnv } {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-git-shim-"));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const path = join(directory, "git");
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}`, KEIYAKU_REAL_GIT: realGit } };
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
  const result = admit(repository, {
    facts: [{ contractId: id, expectedHead: null, entries: [bindEntry(id), reviewEntry(id, ref)] }],
    evidence: [{ contractId: id, ref, bytes }],
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
  const result = admit(repository, {
    facts: [{ contractId: id, expectedHead: null, entries }],
    evidence: [{ contractId: id, ref, bytes }],
    refs: [{ ref: "refs/heads/candidate", newOid: null, expectedOid: candidate }],
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
  const first = admit(repo, journalOffer(id, null, [bindEntry(id)]));
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = admit(repo, journalOffer(id, first.heads[id] ?? null, [amendEntry(id)]));
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
    () => admit(repo, journalOffer(id, null, [amendEntry(id)])),
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
    () => admit(repo, {
      facts: [{ contractId: id, expectedHead: null, entries: [bindEntry(id), reviewEntry(id, ref)] }],
      evidence: [{ contractId: id, ref, bytes: "published" }],
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
  const first = admit(repo, {
    facts: [{ contractId: id, expectedHead: null, entries: [bindEntry(id), reviewEntry(id, ref)] }],
    evidence: [{ contractId: id, ref, bytes }],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const collision = admit(repo, {
    facts: [{ contractId: id, expectedHead: first.heads[id] ?? null, entries: [reviewEntry(id, ref)] }],
    evidence: [{ contractId: id, ref, bytes }],
  });
  assert.equal(collision.ok, false);
  if (collision.ok) return;
  assert.equal(collision.kind, "evidence-occupied");
  if (collision.kind !== "evidence-occupied") return;
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
    () => admit(repo, {
      facts: [{ contractId: id, expectedHead: null, entries: [bindEntry(id), reviewEntry(id, ref)] }],
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
      () => admit(repo, {
        facts: [{ contractId: contractId("contract-a"), entries: [bindEntry(contractId("contract-a"))] }],
      }),
      /carrier (?:is missing|format)/,
    );
  }
});

test("two concurrent appends to one contract have exactly one winner", async () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("contract-a");
  const first = admit(repo, journalOffer(id, null, [bindEntry(id)]));
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const script = [
    "import { admit } from './src/core/facts/admission.ts';",
    "import { repositoryAt } from './src/core/facts/repository.ts';",
    "const id = process.argv[2];",
    "const entry = { v: 1, kind: 'amend', contract: id, entry: process.argv[3], at: '2026-01-01T00:00:00Z', actor: 'child', data: { region: [process.argv[4]] } };",
    "const result = admit(repositoryAt(process.argv[1]), { facts: [{ contractId: id, expectedHead: process.argv[5], entries: [entry] }] });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const head = first.heads[id];
  assert.ok(head);
  const args = (entry: string, region: string) => ["--import", "tsx", "-e", script, repository.path, id, entry, region, head];
  const [left, right] = await Promise.all([
    execFileAsync(process.execPath, args("01ARZ3NDEKTSV4RRFFQ69G5FAW", "left")),
    execFileAsync(process.execPath, args("01ARZ3NDEKTSV4RRFFQ69G5FAX", "right")),
  ]);
  const results = [JSON.parse(left.stdout), JSON.parse(right.stdout)] as Array<{ ok: boolean; kind: string }>;
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => !item.ok).length, 1);
  assert.equal(results.find((item) => !item.ok)?.kind, "head-moved");
});

test("reports a watched verb ref movement", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const ref = writeCommit(repo, writeTree(repo, []), null);
  updateRefsAtomically(repo, [{ ref: "refs/heads/verb", newOid: ref, expectedOid: null }]);
  const id = contractId("contract-a");
  const result = admit(repo, {
    facts: [{ contractId: id, expectedHead: null, entries: [bindEntry(id)] }],
    refs: [{ ref: "refs/heads/verb", newOid: null, expectedOid: null }],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "ref-moved");
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
  const result = admit(repo, {
    facts: [{ contractId: id, expectedHead: null, entries: [bindEntry(id)] }],
    refs: [{ ref: "refs/heads/verb", newOid: verbCommit, expectedOid: null }],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(readRef(repo, CARRIER_REF), result.carrierCommit);
  assert.equal(readRef(repo, "refs/heads/verb"), verbCommit);
});

test("a persistent ref lock failure terminates instead of retrying forever", async () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const parent = writeCommit(repo, writeTree(repo, []), null);
  updateRefsAtomically(repo, [{ ref: "refs/heads/verb", newOid: parent, expectedOid: null }]);
  const script = [
    "import { admit } from './src/core/facts/admission.ts';",
    "import { repositoryAt } from './src/core/facts/repository.ts';",
    "const id = 'lock-contract';",
    "const entry = { v: 1, kind: 'bind', contract: id, entry: '01ARZ3NDEKTSV4RRFFQ69G5FAV', at: '2026-01-01T00:00:00Z', actor: 'child', data: { title: id, context: 'c', objective: 'o', design: 'd', region: [], criteria: [], verification: [], extensions: [] } };",
    "try {",
    "  admit(repositoryAt(process.argv[1]), { facts: [{ contractId: id, expectedHead: null, entries: [entry] }], refs: [{ ref: 'refs/heads/verb/child', newOid: process.argv[2], expectedOid: null }] });",
    "  process.stdout.write(JSON.stringify({ threw: false }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ threw: true, message: error instanceof Error ? error.message : String(error) }));",
    "}",
  ].join("\n");
  const child = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "-e", script, repository.path, parent],
    { timeout: 2_000 },
  );
  const result = JSON.parse(child.stdout) as { threw: boolean; message?: string };
  assert.equal(result.threw, true);
  assert.match(result.message ?? "", /cannot lock ref/);
  assert.equal(readRef(repo, CARRIER_REF), null);
});

test("a killed update-ref child returns unknown without probing the journal", async () => {
  const repository = makeGitRepository();
  const script = [
    "import { admit } from './src/core/facts/admission.ts';",
    "import { repositoryAt } from './src/core/facts/repository.ts';",
    "const id = 'killed-contract';",
    "const entry = { v: 1, kind: 'bind', contract: id, entry: '01ARZ3NDEKTSV4RRFFQ69G5FAV', at: '2026-01-01T00:00:00Z', actor: 'child', data: { title: id, context: 'c', objective: 'o', design: 'd', region: [], criteria: [], verification: [], extensions: [] } };",
    "process.stdout.write(JSON.stringify(admit(repositoryAt(process.argv[1]), { facts: [{ contractId: id, expectedHead: null, entries: [entry] }] })));",
  ].join("\n");
  const shim = gitShim([
    'if [ "$1" = "update-ref" ]; then',
    '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
    '  kill -9 $$',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"));
  const child = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "-e", script, repository.path],
    { env: shim.env },
  );
  const result = JSON.parse(child.stdout) as { ok: boolean; kind: string };
  assert.equal(result.ok, false);
  assert.equal(result.kind, "unknown");
  const repo = repositoryAt(repository.path);
  assert.ok(readRef(repo, CARRIER_REF));
  assert.match(repository.run(["show", `${CARRIER_REF}:contracts/killed-contract.jsonl`]), /"kind":"bind"/);
});

test("unbounded carrier rebuilds are coupled to unrelated carrier movement", async () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const baseId = contractId("base-contract");
  const base = admit(repo, journalOffer(baseId, null, [bindEntry(baseId)]));
  assert.equal(base.ok, true);
  if (!base.ok) return;

  let parent: string = base.carrierCommit;
  const chain: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const next = writeCommit(repo, base.carrierTree, parent);
    chain.push(next);
    parent = next;
  }
  const queue = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-carrier-queue-")), "queue");
  writeFileSync(queue, `${chain.join("\n")}\n`);
  const attempts = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-update-ref-attempts-")), "attempts");
  const movements = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-carrier-movements-")), "movements");
  writeFileSync(attempts, "");
  writeFileSync(movements, "");
  const script = [
    'if [ "$1" = "update-ref" ]; then',
    '  printf "1\\n" >> "$KEIYAKU_UPDATE_REF_ATTEMPTS"',
    '  next=$(sed -n "1p" "$KEIYAKU_QUEUE")',
    '  if [ -n "$next" ]; then',
    '    tail -n +2 "$KEIYAKU_QUEUE" > "$KEIYAKU_QUEUE.next"',
    '    mv "$KEIYAKU_QUEUE.next" "$KEIYAKU_QUEUE"',
    '    current=$("$KEIYAKU_REAL_GIT" rev-parse --verify --quiet refs/heads/keiyaku-state)',
    '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$next" "$current" || exit $?',
    '    printf "%s\\n" "$next" >> "$KEIYAKU_CARRIER_MOVEMENTS"',
    '  fi',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const shim = gitShim(script);
  const env = {
    ...shim.env,
    KEIYAKU_QUEUE: queue,
    KEIYAKU_UPDATE_REF_ATTEMPTS: attempts,
    KEIYAKU_CARRIER_MOVEMENTS: movements,
  };
  const childScript = [
    "import { admit } from './src/core/facts/admission.ts';",
    "import { repositoryAt } from './src/core/facts/repository.ts';",
    "const id = process.argv[2];",
    "const entry = { v: 1, kind: 'bind', contract: id, entry: '01ARZ3NDEKTSV4RRFFQ69G5FAW', at: '2026-01-01T00:00:00Z', actor: 'child', data: { title: id, context: 'c', objective: 'o', design: 'd', region: [], criteria: [], verification: [], extensions: [] } };",
    "process.stdout.write(JSON.stringify(admit(repositoryAt(process.argv[1]), { facts: [{ contractId: id, expectedHead: null, entries: [entry] }] })));",
  ].join("\n");
  const child = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "-e", childScript, repository.path, "rebuilt-contract"],
    { env },
  );
  const result = JSON.parse(child.stdout) as { ok: boolean; kind: string };
  assert.equal(result.ok, true);
  assert.equal(result.kind, "accepted");
  const attempted = readFileSync(attempts, "utf8").split("\n").filter(Boolean).length;
  const advanced = readFileSync(movements, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(advanced, chain);
  assert.equal(attempted, advanced.length + 1);
  assert.match(repository.run(["show", `${CARRIER_REF}:contracts/rebuilt-contract.jsonl`]), /"kind":"bind"/);
});

test("unrelated carrier movement is rebased into the next transaction", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const firstId = contractId("contract-a");
  const unrelatedId = contractId("contract-b");
  const first = admit(repo, journalOffer(firstId, null, [bindEntry(firstId)]));
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const movement = admit(repo, journalOffer(unrelatedId, null, [bindEntry(unrelatedId)]));
  assert.equal(movement.ok, true);
  const result = admit(repo, journalOffer(firstId, first.heads[firstId] ?? null, [amendEntry(firstId)]));
  assert.equal(result.ok, true);
  assert.doesNotThrow(() => readCarrier(repo));
  assert.equal(repository.run(["show", `${CARRIER_REF}:contracts/contract-b.jsonl`]).includes('"kind":"bind"'), true);
});

test("concurrent appends to different contracts both survive carrier CAS", async () => {
  const repository = makeGitRepository();
  const script = [
    "import { admit } from './src/core/facts/admission.ts';",
    "import { repositoryAt } from './src/core/facts/repository.ts';",
    "const id = process.argv[2];",
    "const entry = { v: 1, kind: 'bind', contract: id, entry: process.argv[3], at: '2026-01-01T00:00:00Z', actor: 'child', data: { title: id, context: 'c', objective: 'o', design: 'd', region: [], criteria: [], verification: [], extensions: [] } };",
    "const result = admit(repositoryAt(process.argv[1]), { facts: [{ contractId: id, expectedHead: null, entries: [entry] }] });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const args = (id: string, entry: string) => ["--import", "tsx", "-e", script, repository.path, id, entry];
  const rounds = [
    ["contract-a", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "contract-b", "01ARZ3NDEKTSV4RRFFQ69G5FAW"],
    ["contract-c", "01ARZ3NDEKTSV4RRFFQ69G5FAX", "contract-d", "01ARZ3NDEKTSV4RRFFQ69G5FAY"],
    ["contract-e", "01ARZ3NDEKTSV4RRFFQ69G5FAZ", "contract-f", "01ARZ3NDEKTSV4RRFFQ69G5FB0"],
  ] as const;
  for (const [leftId, leftEntry, rightId, rightEntry] of rounds) {
    const [left, right] = await Promise.all([
      execFileAsync(process.execPath, args(leftId, leftEntry)),
      execFileAsync(process.execPath, args(rightId, rightEntry)),
    ]);
    assert.equal(JSON.parse(left.stdout).ok, true);
    assert.equal(JSON.parse(right.stdout).ok, true);
  }
  for (const id of ["contract-a", "contract-b", "contract-c", "contract-d", "contract-e", "contract-f"]) {
    assert.match(repository.run(["show", `${CARRIER_REF}:contracts/${id}.jsonl`]), /"kind":"bind"/);
  }
  assert.equal(repository.run(["rev-list", "--count", CARRIER_REF]), "6\n");
});
