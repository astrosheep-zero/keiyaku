import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku } from "../src/index.js";
import { prepareDelivery } from "../src/carrier/delivery.js";
import { buildTree, CARRIER_REF, readCarrier, repositoryAt, updateRefsAtomically, writeBlob, writeCommit } from "../src/carrier/repository.js";
import {
  BindCoordinatesObservationError,
  observeBindCoordinates,
  observeCarrier,
} from "../src/carrier/observe.js";
import { entryUlid } from "../src/core/facts/types.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { admitArc } from "../src/protocol/intent.js";
import { runProtocol } from "../src/protocol/run.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function repositoryWithHead() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

test("observes a targetless current snapshot when bind target is omitted", () => {
  const repository = repositoryWithHead();
  const start = repository.run(["rev-parse", "HEAD"]).trim();

  assert.deepEqual(observeBindCoordinates(repositoryAt(repository.path)), { start });
});

test("observes an explicit target by its exact full ref", () => {
  const repository = repositoryWithHead();
  repository.run(["branch", "release"]);
  const target = "refs/heads/release";
  const start = repository.run(["rev-parse", target]).trim();

  assert.deepEqual(observeBindCoordinates(repositoryAt(repository.path), target), { target, start });
});

test("observes a targetless detached bind snapshot", () => {
  const repository = repositoryWithHead();
  repository.run(["checkout", "--quiet", "--detach"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();

  assert.deepEqual(observeBindCoordinates(repositoryAt(repository.path)), { start });
});

test("refuses a missing explicit bind target with a typed error", () => {
  const repository = repositoryWithHead();

  assert.throws(
    () => observeBindCoordinates(repositoryAt(repository.path), "refs/heads/missing"),
    (error: unknown) => error instanceof BindCoordinatesObservationError && error.code === "explicit-target-missing",
  );
});

test("refuses malformed structured bind observations", () => {
  const repository = repositoryWithHead();

  withGitShim(
    "" +
      "if [ \"$1\" = \"for-each-ref\" ]; then\n" +
      "  printf 'refs/heads/main\\000not-an-oid\\000\\n'\n" +
      "  exit 0\n" +
      "fi\n" +
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    {},
    () => {
      assert.throws(
        () => observeBindCoordinates(repositoryAt(repository.path), "refs/heads/main"),
        (error: unknown) => error instanceof BindCoordinatesObservationError && error.code === "malformed-structured-output",
      );
    },
  );
});

function contractBody(): string {
  return [
    "# Targeted observation",
    "",
    "## Context",
    "Test one-contract observation.",
    "",
    "## Objective",
    "Avoid decoding unrelated journals.",
    "",
    "## Design",
    "Use the requested contract primitive.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### C1",
    "The local operation ignores unrelated malformed journals.",
  ].join("\n");
}

function publishMalformedUnrelatedJournal(repository: ReturnType<typeof repositoryAt>): void {
  const carrier = readCarrier(repository);
  const malformed = writeBlob(repository, "not a journal\n");
  const tree = buildTree(repository, carrier.tree, new Map([
    ["contracts/unrelated.jsonl", { oid: malformed }],
  ]));
  const commit = writeCommit(repository, tree, carrier.commit);
  assert.equal(updateRefsAtomically(repository, [{
    ref: CARRIER_REF,
    newOid: commit,
    expectedOid: carrier.commit,
  }]).kind, "published");
}

test("batches full-carrier journal observation into one Git invocation", async () => {
  const repository = repositoryWithHead();
  for (let index = 0; index < 4; index += 1) {
    const bound = await Keiyaku.bind({ markdown: contractBody(), repo: repository.path, workspace: "here" });
    assert.equal(bound.kind, "accepted");
  }

  const carrier = readCarrier(repositoryAt(repository.path));
  const journals = [...carrier.paths.values()].filter((entry) => entry.path.startsWith("contracts/") && entry.path.endsWith(".jsonl"));
  assert.equal(journals.length, 4);
  const log = join(repository.path, "cat-file.log");
  const observed = withGitShim(
    "if [ \"$1\" = \"cat-file\" ]; then printf '%s\\n' \"$*\" >> \"$KEIYAKU_READ_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_READ_LOG: log },
    () => observeCarrier(repositoryAt(repository.path)),
  );

  assert.equal(observed.carrierSnapshot, carrier.commit);
  assert.equal(observed.contracts.size, journals.length);
  const invocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.startsWith("cat-file blob ")).length, 1);
});

test("runProtocol observes only watched contracts", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ markdown: contractBody(), repo: repository.path, workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const id = (await bound.value.state()).id;

  const carrier = readCarrier(repositoryAt(repository.path));
  const malformed = writeBlob(repositoryAt(repository.path), "not a journal\n");
  const tree = buildTree(repositoryAt(repository.path), carrier.tree, new Map([
    ["contracts/unrelated.jsonl", { oid: malformed }],
  ]));
  const commit = writeCommit(repositoryAt(repository.path), tree, carrier.commit);
  assert.equal(updateRefsAtomically(repositoryAt(repository.path), [{
    ref: CARRIER_REF,
    newOid: commit,
    expectedOid: carrier.commit,
  }]).kind, "published");

  const result = runProtocol({
    input: null,
    repository: repositoryAt(repository.path),
    contracts: [id],
    attempts: [{ ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] }],
    decide: ({ observation }) => {
      assert.deepEqual([...observation.contracts.keys()], [id]);
      return { kind: "refused", refusal: "test refusal" };
    },
  });
  assert.deepEqual(result, { kind: "refused", refusal: "test refusal" });
});

test("contract-local intent ignores an unrelated malformed journal", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ markdown: contractBody(), repo: repository.path, workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const id = (await bound.value.state()).id;
  const carrier = repositoryAt(repository.path);
  publishMalformedUnrelatedJournal(carrier);

  const result = admitArc(carrier, {
    contractId: id,
    at: "2026-08-06T00:00:00Z",
    data: { title: "Observation", objective: "Observe one journal", brief: "Keep the intent local." },
  }, decideArc);

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("arc was not accepted");
  assert.deepEqual(result.receipt.facts.map((entry) => entry.kind), ["arc"]);
  assert.equal(result.receipt.prior?.id, id);
  assert.equal(result.receipt.snapshot.id, id);
});

test("delivery preparation ignores an unrelated malformed journal", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ markdown: contractBody(), repo: repository.path, workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const id = (await bound.value.state()).id;
  const carrier = repositoryAt(repository.path);
  publishMalformedUnrelatedJournal(carrier);

  assert.equal(prepareDelivery(carrier, id).kind, "prepared");
});
