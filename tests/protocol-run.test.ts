import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admit, type Offer } from "../src/core/facts/admission.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import {
  CARRIER_FORMAT_BYTES,
  CARRIER_FORMAT_PATH,
  buildTree,
  readRef,
  repositoryAt,
  writeBlob,
  writeCommit,
  writeTree,
} from "../src/core/facts/repository.js";
import { runProtocol, type AttemptContext } from "../src/core/protocol/run.js";
import {
  contractId,
  contractJournalPath,
  entryUlid,
  type AmendEntry,
  type BindEntry,
  type ContractHead,
  type ContractId,
} from "../src/core/facts/types.js";
import { makeGitRepository } from "./support/git.js";

const AT = "2026-08-03T00:00:00Z";

function context(ordinal: number, value: string): AttemptContext {
  return { ordinal, entryUlids: [entryUlid(value)] };
}

function bind(id: ContractId, value: string): BindEntry {
  return {
    v: 1, kind: "bind", contract: id, entry: entryUlid(value), at: AT, actor: "test",
    data: { title: id, context: "Context", objective: "Objective", design: "Design", region: ["src"], criteria: ["criterion"], verification: [], extensions: [] },
  };
}

function amend(id: ContractId, value: string): AmendEntry {
  return { v: 1, kind: "amend", contract: id, entry: entryUlid(value), at: AT, actor: "test", data: { region: ["src/core"] } };
}

function offer(id: ContractId, head: ContractHead | null, value: string, bound: boolean): Offer {
  return { facts: [{ contractId: id, expectedHead: head, entries: [bound ? bind(id, value) : amend(id, value)] }] };
}

function alternateCarrier(repository: ReturnType<typeof repositoryAt>, id: ContractId, entry: BindEntry): string {
  const emptyTree = writeTree(repository, []);
  const format = writeBlob(repository, CARRIER_FORMAT_BYTES);
  const journal = writeBlob(repository, encodeEntry(entry));
  const tree = buildTree(repository, emptyTree, new Map([
    [CARRIER_FORMAT_PATH, { oid: format, mode: "100644", type: "blob" }],
    [contractJournalPath(id), { oid: journal, mode: "100644", type: "blob" }],
  ]));
  return writeCommit(repository, tree, null);
}

function withGitShim<T>(body: string, variables: Readonly<Record<string, string>>, action: () => T): T {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-git-shim-"));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimPath = join(directory, "git");
  writeFileSync(shimPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(shimPath, 0o755);
  const updates = {
    PATH: `${directory}:${process.env.PATH ?? ""}`,
    KEIYAKU_REAL_GIT: realGit,
    ...variables,
  };
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  try {
    return action();
  } finally {
    for (const key of Object.keys(updates)) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("refusal publishes nothing", () => {
  const repository = makeGitRepository();
  const result = runProtocol({
    input: undefined, repository: repositoryAt(repository.path), contracts: [contractId("kei/refused")], attempts: [context(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV")],
    decide: () => ({ kind: "refused", refusal: "no" }),
  });
  assert.deepEqual(result, { kind: "refused", refusal: "no" });
  assert.equal(readRef(repositoryAt(repository.path), "refs/heads/keiyaku-state"), null);
});

test("accepted admission returns reconciliation data and no post-admission effect", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/accepted");
  const result = runProtocol({
    input: { actor: "test", body: "body" }, repository: repo, contracts: [id], attempts: [context(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV")],
    decide: (input) => {
      assert.deepEqual(input.input, { actor: "test", body: "body" });
      return { kind: "offer", offer: offer(id, input.observation.contracts.get(id)?.state?.head ?? null, input.attempt.entryUlids[0]!, true), handoff: { target: "workspace" } };
    },
  });
  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
  assert.deepEqual(result.handoff.acceptedEntries.map((entry) => entry.entry), [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")]);
  assert.deepEqual(result.handoff.handoff, { target: "workspace" });
});

test("moved heads are re-decided with the next fresh ULID", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/moved");
  const attempts = [context(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV"), context(1, "01ARZ3NDEKTSV4RRFFQ69G5FAW")];
  let decisions = 0;
  const result = runProtocol({
    input: undefined, repository: repo, contracts: [id], attempts,
    decide: (input) => {
      decisions += 1;
      const head = input.observation.contracts.get(id)?.state?.head ?? null;
      if (decisions === 1) {
        const moved = admit(repo, { facts: [{ contractId: id, expectedHead: null, entries: [bind(id, "01ARZ3NDEKTSV4RRFFQ69G5FAX")] }] });
        assert.equal(moved.kind, "accepted");
      }
      return { kind: "offer", offer: offer(id, head, input.attempt.entryUlids[0]!, head === null), handoff: input.attempt.ordinal };
    },
  });
  assert.equal(decisions, 2);
  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.handoff, 1);
  assert.deepEqual(result.handoff.acceptedEntries.map((entry) => entry.entry), [attempts[1]!.entryUlids[0]!]);
});

test("unknown exact canonical entries hand off with no admission", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/unknown-exact");
  const result = withGitShim([
    'if [ "$1" = "update-ref" ]; then',
    '  "$KEIYAKU_REAL_GIT" "$@"',
    '  kill -9 $$',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), {}, () => runProtocol({
    input: undefined,
    repository: repo,
    contracts: [id],
    attempts: [context(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV")],
    decide: (input) => ({
      kind: "offer",
      offer: offer(id, input.observation.contracts.get(id)?.state?.head ?? null, input.attempt.entryUlids[0]!, true),
      handoff: null,
    }),
  }));

  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission, null);
  assert.deepEqual(result.handoff.acceptedEntries.map((entry) => entry.entry), [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")]);
});

test("unknown absent entries reuse the offer until a later admission succeeds", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/unknown-retry");
  const marker = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-marker-")), "first-update-ref");
  let decisions = 0;
  const result = withGitShim([
    'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_MARKER" ]; then',
    '  touch "$KEIYAKU_MARKER"',
    '  kill -9 $$',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_MARKER: marker }, () => runProtocol({
    input: { actor: "retry", body: "body" },
    repository: repo,
    contracts: [id],
    attempts: [context(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV")],
    decide: (input) => {
      decisions += 1;
      assert.deepEqual(input.input, { actor: "retry", body: "body" });
      return {
        kind: "offer",
        offer: offer(id, input.observation.contracts.get(id)?.state?.head ?? null, input.attempt.entryUlids[0]!, true),
        handoff: null,
      };
    },
  }));

  assert.equal(decisions, 1);
  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
});

test("unknown moved heads redecide with a fresh attempt ULID", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/unknown-moved");
  const alternate = alternateCarrier(repo, id, bind(id, "01ARZ3NDEKTSV4RRFFQ69G5FAX"));
  const marker = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-marker-")), "first-update-ref");
  const attempts = [context(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV"), context(1, "01ARZ3NDEKTSV4RRFFQ69G5FAW")];
  let decisions = 0;
  const result = withGitShim([
    'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_MARKER" ]; then',
    '  touch "$KEIYAKU_MARKER"',
    '  sed "s#^update refs/heads/keiyaku-state [^ ]* #update refs/heads/keiyaku-state $KEIYAKU_ALTERNATE #" | "$KEIYAKU_REAL_GIT" "$@"',
    '  status=$?',
    '  if [ "$status" -ne 0 ]; then exit "$status"; fi',
    '  kill -9 $$',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_MARKER: marker, KEIYAKU_ALTERNATE: alternate }, () => runProtocol({
    input: "moved-input",
    repository: repo,
    contracts: [id],
    attempts,
    decide: (input) => {
      decisions += 1;
      assert.equal(input.input, "moved-input");
      const head = input.observation.contracts.get(id)?.state?.head ?? null;
      if (input.attempt.ordinal === 0) {
        assert.equal(head, null);
        return { kind: "offer", offer: offer(id, head, input.attempt.entryUlids[0]!, true), handoff: 0 };
      }
      assert.notEqual(head, null);
      assert.equal(input.attempt.entryUlids[0], entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"));
      return { kind: "offer", offer: offer(id, head, input.attempt.entryUlids[0]!, false), handoff: 1 };
    },
  }));

  assert.equal(decisions, 2);
  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.handoff, 1);
  assert.equal(result.handoff.admission?.kind, "accepted");
});

test("unknown collisions are passed to the next decision", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/unknown-collision");
  const plannedUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const alternate = alternateCarrier(repo, id, { ...bind(id, plannedUlid), actor: "collision" });
  const marker = join(mkdtempSync(join(tmpdir(), "keiyaku-v4-marker-")), "first-update-ref");
  const attempts = [context(0, plannedUlid), context(1, "01ARZ3NDEKTSV4RRFFQ69G5FAW")];
  let decisions = 0;
  const result = withGitShim([
    'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_MARKER" ]; then',
    '  touch "$KEIYAKU_MARKER"',
    '  sed "s#^update refs/heads/keiyaku-state [^ ]* #update refs/heads/keiyaku-state $KEIYAKU_ALTERNATE #" | "$KEIYAKU_REAL_GIT" "$@"',
    '  status=$?',
    '  if [ "$status" -ne 0 ]; then exit "$status"; fi',
    '  kill -9 $$',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_MARKER: marker, KEIYAKU_ALTERNATE: alternate }, () => runProtocol({
    input: { body: "body", actor: "actor", futureVerb: "future" },
    repository: repo,
    contracts: [id],
    attempts,
    decide: (input) => {
      decisions += 1;
      assert.deepEqual(input.input, { body: "body", actor: "actor", futureVerb: "future" });
      const head = input.observation.contracts.get(id)?.state?.head ?? null;
      if (input.attempt.ordinal === 0) {
        assert.equal(input.collision, undefined);
        return { kind: "offer", offer: offer(id, head, input.attempt.entryUlids[0]!, true), handoff: null };
      }
      assert.equal(input.attempt.entryUlids[0], entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"));
      assert.equal(input.collision?.kind, "collision");
      if (input.collision?.kind === "collision") {
        assert.equal(input.collision.contractId, id);
        assert.equal(input.collision.planned.entry, entryUlid(plannedUlid));
        assert.equal(input.collision.observed.actor, "collision");
      }
      return { kind: "offer", offer: offer(id, head, input.attempt.entryUlids[0]!, false), handoff: null };
    },
  }));

  assert.equal(decisions, 2);
  assert.equal(result.kind, "handoff");
  if (result.kind !== "handoff") return;
  assert.equal(result.handoff.admission?.kind, "accepted");
});

test("stale Offer ref expectations return ref-moved without publication or retry", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/stale-ref");
  const current = writeCommit(repo, writeTree(repo, []), null);
  repository.run(["update-ref", "refs/heads/verb", current]);
  const stale = "a".repeat(40);
  const attempts = [context(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV"), context(1, "01ARZ3NDEKTSV4RRFFQ69G5FAW")];
  let decisions = 0;
  const result = runProtocol({
    input: undefined, repository: repo, contracts: [id], attempts,
    decide: (input) => {
      decisions += 1;
      return {
        kind: "offer",
        offer: {
          ...offer(id, input.observation.contracts.get(id)?.state?.head ?? null, input.attempt.entryUlids[0]!, true),
          refs: [{ ref: "refs/heads/verb", newOid: null, expectedOid: stale }],
        },
        handoff: null,
      };
    },
  });

  assert.equal(decisions, 1);
  assert.equal(result.kind, "ref-moved");
  if (result.kind !== "ref-moved") return;
  assert.equal(result.ref, "refs/heads/verb");
  assert.equal(result.expectedOid, stale);
  assert.equal(result.currentOid, current);
  assert.equal(result.carrierCommit, null);
  assert.equal(readRef(repo, "refs/heads/keiyaku-state"), null);
});

test("attempt contexts bound repeated moved admissions", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/bounded");
  let decisions = 0;
  const result = runProtocol({
    input: undefined, repository: repo, contracts: [id], attempts: [context(0, "01ARZ3NDEKTSV4RRFFQ69G5FAV")],
    decide: (input) => {
      decisions += 1;
      const moved = admit(repo, { facts: [{ contractId: id, expectedHead: null, entries: [bind(id, "01ARZ3NDEKTSV4RRFFQ69G5FAX")] }] });
      assert.equal(moved.kind, "accepted");
      return { kind: "offer", offer: offer(id, input.observation.contracts.get(id)?.state?.head ?? null, input.attempt.entryUlids[0]!, true), handoff: null };
    },
  });
  assert.equal(decisions, 1);
  assert.equal(result.kind, "exhausted");
  assert.equal(result.kind === "exhausted" ? result.admission?.kind : null, "head-moved");
});

test("attempt contexts are consecutive", () => {
  const repository = makeGitRepository();
  const repo = repositoryAt(repository.path);
  const id = contractId("kei/validation");
  const decide = () => ({ kind: "refused" as const, refusal: null });
  assert.throws(() => runProtocol({
    input: undefined, repository: repo, contracts: [id], attempts: [], decide,
  }), /at least one attempt/);
  assert.throws(() => runProtocol({
    input: undefined, repository: repo, contracts: [id], attempts: [context(1, "01ARZ3NDEKTSV4RRFFQ69G5FAV")], decide,
  }), /consecutive from zero/);
});
