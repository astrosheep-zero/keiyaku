import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AuthorityCorruptionError, Repo } from "../src/index.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { prepareDelivery } from "../src/carrier/delivery.js";
import { admit } from "../src/carrier/admission.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  CARRIER_REF,
  DELIVERY_REF_NAMESPACE,
  readBlob,
  readCarrier,
  repositoryAt,
  updateCarrierTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/carrier/repository.js";
import {
  observeBindCoordinates,
  observeCarrier,
  observeContract,
  observeContractsForAdmission,
} from "../src/carrier/observe.js";
import { contractJournalPath } from "../src/carrier/identity.js";
import { bindOperation, amendOperation } from "../src/protocol/operations.js";
import { contractId, documentKey, entryUlid, gate, type ContractId, type JournalEntry, type SnapshotId } from "../src/core/facts/types.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { decideDeliver } from "../src/core/verbs/deliver.js";
import { admitIntent, admitPlacement } from "../src/protocol/intent.js";
import { runProtocol } from "../src/protocol/run.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function repositoryWithHead() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function preparationCoordinates(state: NonNullable<ReturnType<typeof observeContract>["state"]>) {
  return { contractId: state.id, coordinates: state.coordinates };
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

test("observes a missing explicit bind target without inventing coordinates", () => {
  const repository = repositoryWithHead();

  assert.equal(observeBindCoordinates(repositoryAt(repository.path), "refs/heads/missing"), null);
});

test("refuses targets that name Keiyaku-owned refs", () => {
  const repository = repositoryWithHead();
  const ownedTargets = [
    CARRIER_REF,
    DELIVERY_REF_NAMESPACE,
    `${DELIVERY_REF_NAMESPACE}/contract`,
    CANDIDATE_PIN_REF_NAMESPACE,
    `${CANDIDATE_PIN_REF_NAMESPACE}/contract`,
  ];

  for (const target of ownedTargets) {
    assert.throws(
      () => observeBindCoordinates(repositoryAt(repository.path), target),
      (error: unknown) => error instanceof Error
        && !(error instanceof TypeError)
        && error.message === `bind target names a Keiyaku-owned ref: ${target}`,
    );
  }
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
        /malformed structured Git output while observing bind coordinates/,
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

function publishMalformedJournal(repository: ReturnType<typeof repositoryAt>, path: string): void {
  const carrier = readCarrier(repository);
  const malformed = writeBlob(repository, "not a journal\n");
  const tree = updateCarrierTree(repository, carrier.tree, new Map([
    [path, { oid: malformed }],
  ]));
  const commit = writeCommit({ repository, tree, parent: carrier.commit });
  assert.equal(updateRefsAtomically(repository, [{
    ref: CARRIER_REF,
    newOid: commit,
    expectedOid: carrier.commit,
  }]).kind, "published");
}

function publishMalformedUnrelatedJournal(repository: ReturnType<typeof repositoryAt>): void {
  publishMalformedJournal(repository, "contracts/unrelated.jsonl");
}

test("batches full-carrier journal observation into one Git invocation", async () => {
  const repository = repositoryWithHead();
  for (let index = 0; index < 4; index += 1) {
    const bound = await Repo.at({ path: repository.path }).bind({ markdown: contractBody(), workspace: "here" });
    assert.equal(bound.kind, "accepted");
  }

  const carrier = readCarrier(repositoryAt(repository.path));
  const journals = [...carrier.paths.keys()].filter((path) => path.startsWith("contracts/") && path.endsWith(".jsonl"));
  assert.equal(journals.length, 4);
  const log = join(repository.path, "cat-file.log");
  const observed = withGitShim(
    "if [ \"$1\" = \"cat-file\" ]; then printf '%s\\n' \"$*\" >> \"$KEIYAKU_READ_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_READ_LOG: log },
    () => observeCarrier(repositoryAt(repository.path)),
  );

  assert.equal(observed.contracts.size, journals.length);
  const invocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.startsWith("cat-file blob ")).length, 1);
});

function gitProcessCounts(invocations: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const invocation of invocations) {
    const command = invocation.split(" ")[0];
    if (command === undefined || command.length === 0) throw new Error("Git invocation is missing a command");
    counts[command] = (counts[command] ?? 0) + 1;
  }
  return counts;
}

test("contract-local admission never recursively enumerates the carrier", async () => {
  const repository = repositoryWithHead();
  const bound = await Repo.at({ path: repository.path }).bind({ markdown: contractBody(), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const id = (await bound.value.state()).id;
  const carrier = repositoryAt(repository.path);
  const attempt = { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] };
  const log = join(repository.path, "ls-tree.log");
  const admission = withGitShim(
    "printf '%s\\n' \"$*\" >> \"$KEIYAKU_READ_LOG\"\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_READ_LOG: log },
    () => {
      const observation = observeContractsForAdmission(carrier, [id]);
      const decision = decideArc({
        input: {
          contractId: id,
          at: "2026-08-06T00:00:00Z",
          data: { title: "Process count", objective: "Reuse one observation", brief: "Use its immutable paths." },
        },
        attempt,
        observation: observation.decision,
      });
      assert.equal(decision.kind, "offer");
      if (decision.kind !== "offer") throw new Error("arc decision was not an offer");
      return admit(carrier, decision.offer, observation.admission);
    },
  );

  assert.equal(admission.kind, "accepted");
  const invocations = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.equal(invocations.some((command) => command.startsWith("ls-tree -r ")), false);
});

test("known publication failure is returned without a post-result ref read", async () => {
  const repository = repositoryWithHead();
  const bound = await Repo.at({ path: repository.path }).bind({ markdown: contractBody(), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const id = (await bound.value.state()).id;
  const carrier = repositoryAt(repository.path);
  const observation = observeContractsForAdmission(carrier, [id]);
  const attempt = { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] };
  const decision = decideArc({
    input: {
      contractId: id,
      at: "2026-08-06T00:00:00Z",
      data: { title: "Failed publication", objective: "Keep failure factual", brief: "Do not reread refs." },
    },
    attempt,
    observation: observation.decision,
  });
  assert.equal(decision.kind, "offer");
  if (decision.kind !== "offer") throw new Error("arc decision was not an offer");
  const failed = join(repository.path, "publication-failed.marker");
  const postRead = join(repository.path, "post-publication-read.marker");

  const result = withGitShim([
    'if [ "$1" = "update-ref" ]; then',
    '  cat >/dev/null',
    '  touch "$KEIYAKU_PUBLICATION_FAILED"',
    '  printf "forced publication failure\\n" >&2',
    '  exit 42',
    'fi',
    'if [ -e "$KEIYAKU_PUBLICATION_FAILED" ] && [ "$1" = "rev-parse" ]; then',
    '  touch "$KEIYAKU_POST_FAILURE_READ"',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), {
    KEIYAKU_PUBLICATION_FAILED: failed,
    KEIYAKU_POST_FAILURE_READ: postRead,
  }, () => admit(carrier, decision.offer, observation.admission));

  assert.equal(result.kind, "publication-failed");
  if (result.kind !== "publication-failed") throw new Error("publication failure was not preserved");
  assert.match(result.diagnostic, /forced publication failure/);
  assert.equal(existsSync(postRead), false);
});

function appendUnrelatedCarrierJournals(
  repository: ReturnType<typeof repositoryAt>,
  count: number,
  start: SnapshotId,
): void {
  const snapshot = readCarrier(repository);
  const changes = new Map();
  for (let index = 0; index < count; index += 1) {
    const id = contractId(`kei/carrier-load-${index}`);
    const entry: JournalEntry = {
      v: 1,
      kind: "bind",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      at: "2026-08-06T00:00:00Z",
      data: {
        coordinates: { start, workspace: "here" },
        terms: terms([]),
      },
    };
    changes.set(contractJournalPath(id), { oid: writeBlob(repository, encodeEntry(entry)) });
  }
  const tree = updateCarrierTree(repository, snapshot.tree, changes);
  const commit = writeCommit({ repository, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(repository, [{
    ref: CARRIER_REF,
    newOid: commit,
    expectedOid: snapshot.commit,
  }]).kind, "published");
}

function amendObjectIo(
  repository: ReturnType<typeof repositoryAt>,
  id: ContractId,
): Record<string, number> {
  const state = observeContract(repository, id).state;
  if (state === null) throw new Error("bound contract state was not observed");
  const log = join(repository.effectiveCwd, "amend-object-io.log");
  const amended = withGitShim(
    "printf '%s\\n' \"$*\" >> \"$KEIYAKU_READ_LOG\"\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_READ_LOG: log },
    () => amendOperation({
      scope: repository,
      contractId: id,
      source: state.terms,
      terms: state.terms,
    }),
  );
  assert.equal(amended.kind, "accepted");
  return gitProcessCounts(readFileSync(log, "utf8").split("\n").filter(Boolean));
}

test("single-contract amend object I/O stays fixed as the carrier grows", () => {
  const one = repositoryWithHead();
  const oneCarrier = repositoryAt(one.path);
  const oneBound = bindOperation({ scope: oneCarrier, terms: terms([]), workspace: "here" });
  assert.equal(oneBound.kind, "accepted");
  if (oneBound.kind !== "accepted") throw new Error("one-contract bind was not accepted");

  const many = repositoryWithHead();
  const manyCarrier = repositoryAt(many.path);
  const manyBound = bindOperation({ scope: manyCarrier, terms: terms([]), workspace: "here" });
  assert.equal(manyBound.kind, "accepted");
  if (manyBound.kind !== "accepted") throw new Error("many-contract bind was not accepted");
  const manyState = observeContract(manyCarrier, manyBound.value.contractId).state;
  if (manyState === null) throw new Error("many-contract bound state was not observed");
  appendUnrelatedCarrierJournals(manyCarrier, 32, manyState.coordinates.start);

  const oneIo = amendObjectIo(oneCarrier, oneBound.value.contractId);
  const manyIo = amendObjectIo(manyCarrier, manyBound.value.contractId);
  assert.deepEqual(manyIo, oneIo);
});

test("runProtocol observes only watched contracts", async () => {
  const repository = repositoryWithHead();
  const bound = await Repo.at({ path: repository.path }).bind({ markdown: contractBody(), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const id = (await bound.value.state()).id;

  const carrier = readCarrier(repositoryAt(repository.path));
  const malformed = writeBlob(repositoryAt(repository.path), "not a journal\n");
  const tree = updateCarrierTree(repositoryAt(repository.path), carrier.tree, new Map([
    ["contracts/unrelated.jsonl", { oid: malformed }],
  ]));
  const commit = writeCommit({ repository: repositoryAt(repository.path), tree, parent: carrier.commit });
  assert.equal(updateRefsAtomically(repositoryAt(repository.path), [{
    ref: CARRIER_REF,
    newOid: commit,
    expectedOid: carrier.commit,
  }]).kind, "published");

  const result = runProtocol({
    input: null,
    repository: repositoryAt(repository.path),
    contracts: [id],
    attempts: [{ entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] }],
    decide: ({ observation }) => {
      assert.deepEqual([...observation.keys()], [id]);
      return { kind: "refused", refusal: "test refusal" };
    },
  });
  assert.deepEqual(result, { kind: "refused", refusal: "test refusal" });
});

test("contract-local intent ignores an unrelated malformed journal", async () => {
  const repository = repositoryWithHead();
  const bound = await Repo.at({ path: repository.path }).bind({ markdown: contractBody(), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const id = (await bound.value.state()).id;
  const carrier = repositoryAt(repository.path);
  publishMalformedUnrelatedJournal(carrier);

  const result = admitIntent(carrier, {
    contractId: id,
    at: "2026-08-06T00:00:00Z",
    data: { title: "Observation", objective: "Observe one journal", brief: "Keep the intent local." },
  }, decideArc);

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("arc was not accepted");
  assert.deepEqual(result.facts.map((entry) => entry.kind), ["arc"]);
});

function terms(after: readonly ContractId[]) {
  return {
    document: { bytes: "# Targeted\n", key: documentKey("targeted") },
    segments: [],
    gates: [],
    after,
  } as const;
}

test("admission reuses frozen journal bytes for a multi-contract placement offer", () => {
  const repository = repositoryWithHead();
  const carrier = repositoryAt(repository.path);
  const source = bindOperation({ scope: carrier, terms: terms([]), workspace: "here" });
  assert.equal(source.kind, "accepted");
  if (source.kind !== "accepted") throw new Error("source bind was not accepted");
  const dependent = bindOperation({
    scope: carrier,
    terms: terms([source.value.contractId]),
    workspace: "here",
  });
  assert.equal(dependent.kind, "accepted");
  if (dependent.kind !== "accepted") throw new Error("dependent bind was not accepted");

  const sourceState = observeContract(carrier, source.value.contractId).state;
  if (sourceState === null) throw new Error("source state was not observed");
  const prepared = prepareDelivery(carrier, preparationCoordinates(sourceState), {
    title: "Frozen journal bytes",
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("source delivery was not prepared");
  const delivered = admitIntent(carrier, {
    contractId: source.value.contractId,
    at: "2026-08-07T00:00:00Z",
    preparation: { kind: "prepared", document: sourceState.terms.document.key, data: prepared.data },
  }, decideDeliver);
  assert.equal(delivered.kind, "accepted");

  const log = join(repository.path, "placement-cat-file.log");
  const claimed = withGitShim(
    "if [ \"$1\" = \"cat-file\" ]; then printf '%s\\n' \"$*\" >> \"$KEIYAKU_READ_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_READ_LOG: log },
    () => admitPlacement(carrier, { contractId: source.value.contractId, at: "2026-08-07T00:00:01Z" }),
  );

  assert.equal(claimed.kind, "accepted");
  if (claimed.kind !== "accepted") throw new Error("placement was not accepted");
  assert.deepEqual(claimed.facts.map((entry) => entry.kind), ["bound", "claimed"]);
  const invocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.startsWith("cat-file blob ")).length, 1);
});

test("admission observation retains canonical journal validation", async () => {
  const repository = repositoryWithHead();
  const bound = await Repo.at({ path: repository.path }).bind({ markdown: contractBody(), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not succeed");
  const id = (await bound.value.state()).id;
  const carrier = repositoryAt(repository.path);
  const snapshot = readCarrier(carrier);
  const path = contractJournalPath(id);
  const journal = snapshot.paths.get(path);
  if (journal === undefined) throw new Error("bound journal was not observed");
  const noncanonical = writeBlob(
    carrier,
    Buffer.concat([readBlob(carrier, journal.oid).subarray(0, -1), Buffer.from(" \n")]),
  );
  const tree = updateCarrierTree(carrier, snapshot.tree, new Map([[path, { oid: noncanonical }]]));
  const commit = writeCommit({ repository: carrier, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(carrier, [{
    ref: CARRIER_REF,
    newOid: commit,
    expectedOid: snapshot.commit,
  }]).kind, "published");

  assert.throws(
    () => observeContractsForAdmission(carrier, [id]),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && /journal entry is not canonical/.test(error.message),
  );
});

test("bind and amend eligibility read only self and their after contracts", () => {
  const repository = repositoryWithHead();
  const carrier = repositoryAt(repository.path);
  const dependency = bindOperation({
    scope: carrier,
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(dependency.kind, "accepted");
  if (dependency.kind !== "accepted") throw new Error("dependency bind was not accepted");
  const dependencyId = dependency.value.contractId;
  publishMalformedUnrelatedJournal(carrier);

  const result = bindOperation({
    scope: carrier,
    terms: terms([dependencyId]),
    workspace: "here",
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("targeted bind was not accepted");
  assert.deepEqual(result.facts.map((entry) => entry.kind), ["bind"]);
  const resultState = observeContract(carrier, result.value.contractId).state;
  if (resultState === null) throw new Error("bound contract state was not observed");

  const amended = amendOperation({
    scope: carrier,
    contractId: result.value.contractId,
    source: resultState.terms,
    terms: terms([dependencyId]),
  });
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("targeted amend was not accepted");
  assert.deepEqual(amended.facts.map((entry) => entry.kind), ["amend"]);
});

test("amend replacement does not observe a removed prerequisite closure", () => {
  const repository = repositoryWithHead();
  const carrier = repositoryAt(repository.path);
  const dependency = bindOperation({ scope: carrier, terms: terms([]), workspace: "here" });
  assert.equal(dependency.kind, "accepted");
  if (dependency.kind !== "accepted") throw new Error("dependency bind was not accepted");
  const waiting = bindOperation({
    scope: carrier,
    terms: terms([dependency.value.contractId]),
    workspace: "here",
  });
  assert.equal(waiting.kind, "accepted");
  if (waiting.kind !== "accepted") throw new Error("waiting bind was not accepted");
  const before = observeContract(carrier, waiting.value.contractId).state;
  if (before === null) throw new Error("waiting contract was not observed");
  publishMalformedJournal(carrier, contractJournalPath(dependency.value.contractId));

  const amended = amendOperation({
    scope: carrier,
    contractId: waiting.value.contractId,
    source: before.terms,
    terms: terms([]),
  });

  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("replacement amend was not accepted");
  assert.deepEqual(amended.facts.map((entry) => entry.kind), ["amend", "bound"]);
});

test("amend refuses a stale complete-terms replacement when document bytes did not move", () => {
  const repository = repositoryWithHead();
  const carrier = repositoryAt(repository.path);
  const bound = bindOperation({ scope: carrier, terms: terms([]), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const before = observeContract(carrier, bound.value.contractId).state;
  if (before === null) throw new Error("contract state was not observed");
  const reviewed = { ...before.terms, gates: [gate("reviewed")] };
  assert.equal(amendOperation({
    scope: carrier,
    contractId: before.id,
    source: before.terms,
    terms: reviewed,
  }).kind, "accepted");

  const stale = amendOperation({
    scope: carrier,
    contractId: before.id,
    source: before.terms,
    terms: before.terms,
  });
  assert.deepEqual(stale, {
    kind: "refused",
    refusal: { kind: "terms-moved", contractId: before.id },
  });
});

test("bind rejects unresolved after and bound amend prioritizes consumed prerequisites", () => {
  const repository = repositoryWithHead();
  const carrier = repositoryAt(repository.path);
  const missing = contractId("kei/missing-prerequisite");
  const bound = bindOperation({
    scope: carrier,
    terms: terms([missing]),
    workspace: "here",
  });
  assert.equal(bound.kind, "refused");
  if (bound.kind !== "refused") throw new Error("bind must refuse an unresolved prerequisite");
  assert.equal(bound.refusal.kind, "unknown-prerequisite");

  const existing = bindOperation({
    scope: carrier,
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(existing.kind, "accepted");
  if (existing.kind !== "accepted") throw new Error("existing bind was not accepted");
  const existingState = observeContract(carrier, existing.value.contractId).state;
  if (existingState === null) throw new Error("existing contract state was not observed");
  const amended = amendOperation({
    scope: carrier,
    contractId: existing.value.contractId,
    source: existingState.terms,
    terms: terms([missing]),
  });
  assert.deepEqual(amended, {
    kind: "refused",
    refusal: { kind: "prerequisites-already-consumed", contractId: existing.value.contractId },
  });
});

test("amend emits bound atomically when its resulting after set is claimed", () => {
  const repository = repositoryWithHead();
  const activeDependency = bindOperation({
    scope: repositoryAt(repository.path),
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(activeDependency.kind, "accepted");
  if (activeDependency.kind !== "accepted") throw new Error("active dependency bind was not accepted");
  const waiting = bindOperation({
    scope: repositoryAt(repository.path),
    terms: terms([activeDependency.value.contractId]),
    workspace: "here",
  });
  assert.equal(waiting.kind, "accepted");
  if (waiting.kind !== "accepted") throw new Error("waiting bind was not accepted");

  const claimedDependency = bindOperation({
    scope: repositoryAt(repository.path),
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(claimedDependency.kind, "accepted");
  if (claimedDependency.kind !== "accepted") throw new Error("claimable dependency bind was not accepted");
  const carrier = repositoryAt(repository.path);
  const state = observeCarrier(carrier).contracts.get(claimedDependency.value.contractId)?.state;
  if (state === undefined || state === null) throw new Error("claimable dependency state was not observed");
  const delivery = prepareDelivery(carrier, preparationCoordinates(state), { title: "Targeted" });
  assert.equal(delivery.kind, "prepared");
  if (delivery.kind !== "prepared") throw new Error("claimable dependency delivery was not prepared");
  const delivered = admitIntent(carrier, {
    contractId: claimedDependency.value.contractId,
    at: "2026-08-06T00:00:00Z",
    preparation: { kind: "prepared", document: state.terms.document.key, data: delivery.data },
  }, decideDeliver);
  assert.equal(delivered.kind, "accepted");
  const claimed = admitPlacement(carrier, {
    contractId: claimedDependency.value.contractId,
    at: "2026-08-06T00:00:01Z",
  });
  assert.equal(claimed.kind, "accepted");

  const immediatelyBound = bindOperation({
    scope: carrier,
    terms: terms([claimedDependency.value.contractId]),
    workspace: "here",
  });
  assert.equal(immediatelyBound.kind, "accepted");
  if (immediatelyBound.kind !== "accepted") throw new Error("claimed prerequisite bind was not accepted");
  assert.deepEqual(immediatelyBound.facts.map((entry) => entry.kind), ["bind", "bound"]);

  const waitingState = observeContract(carrier, waiting.value.contractId).state;
  if (waitingState === null) throw new Error("waiting contract state was not observed");

  const amended = amendOperation({
    scope: carrier,
    contractId: waiting.value.contractId,
    source: waitingState.terms,
    terms: terms([claimedDependency.value.contractId]),
  });
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("eligible amend was not accepted");
  assert.deepEqual(amended.facts.map((entry) => entry.kind), ["amend", "bound"]);
});

test("placement redecides after a world advance and binds a new dependent", async () => {
  const repository = repositoryWithHead();
  const source = bindOperation({
    scope: repositoryAt(repository.path),
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(source.kind, "accepted");
  if (source.kind !== "accepted") throw new Error("source bind was not accepted");

  const carrier = repositoryAt(repository.path);
  const sourceState = observeContract(carrier, source.value.contractId).state;
  if (sourceState === null) throw new Error("source state was not observed");
  const prepared = prepareDelivery(carrier, preparationCoordinates(sourceState), { title: "Concurrent placement" });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("source delivery was not prepared");
  const delivered = admitIntent(carrier, {
    contractId: source.value.contractId,
    at: "2026-08-06T00:00:00Z",
    preparation: { kind: "prepared", document: sourceState.terms.document.key, data: prepared.data },
  }, decideDeliver);
  assert.equal(delivered.kind, "accepted");

  const dependent = contractId("kei/concurrent-dependent");
  const waitingEntry: JournalEntry = {
    v: 1,
    kind: "bind",
    contract: dependent,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    at: "2026-08-06T00:00:01Z",
    data: {
      coordinates: { start: sourceState.coordinates.start, workspace: "here" },
      terms: terms([source.value.contractId]),
    },
  };
  const marker = join(repository.path, ".concurrent-bind-once");
  const dependentJournal = encodeEntry(waitingEntry);
  const shim = [
    'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_RACE_MARKER" ]; then',
    '  touch "$KEIYAKU_RACE_MARKER"',
    '  current=$("$KEIYAKU_REAL_GIT" rev-parse refs/heads/keiyaku-state)',
    '  tree=$("$KEIYAKU_REAL_GIT" rev-parse "$current^{tree}")',
    '  blob=$(printf "%s" "$KEIYAKU_RACE_JOURNAL" | "$KEIYAKU_REAL_GIT" hash-object -w --stdin)',
    '  index=$(mktemp)',
    '  GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" read-tree "$tree"',
    `  printf "100644 blob %s\\t${contractJournalPath(dependent)}\\n" "$blob" | GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" update-index --index-info`,
    '  next_tree=$(GIT_INDEX_FILE="$index" "$KEIYAKU_REAL_GIT" write-tree)',
    '  next_commit=$("$KEIYAKU_REAL_GIT" commit-tree "$next_tree" -p "$current" < /dev/null)',
    '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$next_commit" "$current"',
    '  rm -f "$index"',
    'fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");

  const claimed = withGitShim(
    shim,
    { KEIYAKU_RACE_MARKER: marker, KEIYAKU_RACE_JOURNAL: dependentJournal },
    () => admitPlacement(carrier, { contractId: source.value.contractId, at: "2026-08-06T00:00:02Z" }),
  );
  assert.equal(claimed.kind, "accepted");
  if (claimed.kind !== "accepted") throw new Error("placement was not accepted after redecision");
  assert.deepEqual(claimed.facts.map((fact) => fact.kind), ["bound", "claimed"]);
  assert.equal(observeContract(carrier, source.value.contractId).state?.terminal?.kind, "claimed");
  assert.equal(observeContract(carrier, dependent).state?.bound?.kind, "bound");
});

test("delivery preparation ignores an unrelated malformed journal", async () => {
  const repository = repositoryWithHead();
  const bound = await Repo.at({ path: repository.path }).bind({ markdown: contractBody(), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const id = (await bound.value.state()).id;
  const carrier = repositoryAt(repository.path);
  publishMalformedUnrelatedJournal(carrier);

  const state = observeContract(carrier, id).state;
  if (state === null) throw new Error("bound contract state was not observed");
  assert.equal(prepareDelivery(carrier, preparationCoordinates(state), { title: "Observation" }).kind, "prepared");
});
