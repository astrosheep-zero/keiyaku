import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AuthorityCorruptionError, Keiyaku, Repo } from "../src/index.js";
import { encodeEntry } from "../src/core/facts/codec.js";
import { prepareDelivery } from "../src/protocol/operations.js";
import { admit } from "../src/git/admission.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  GIT_REF,
  DELIVERY_REF_NAMESPACE,
  readBlob,
  readGit,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import {
  observeBindCoordinates,
  observeContractWorld,
  observeContractsForAdmissionAt,
} from "../src/git/observe.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import { contractJournalPath } from "../src/git/identity.js";
import { bindOperation as rawBindOperation, amendOperation as rawAmendOperation } from "../src/protocol/operations.js";
import { contractId, documentKey, entryUlid, gate, type AmendData, type ContractId, type ContractTerms, type JournalEntry, type SnapshotId } from "../src/core/facts/types.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { decideDeliver } from "../src/core/verbs/deliver.js";
import { admitIntent } from "../src/protocol/intent.js";
import { admitPlacement } from "../src/protocol/placement.js";
import { releaseContractWorktree, reserveContractWorktree } from "../src/contract-worktree.js";
import { runProtocol } from "../src/protocol/run.js";
import { makeGitRepository, observeContract, withGitShim } from "./support/git.js";

const NO_VERIFICATION = { kind: "prepared", data: null } as const;

function bindOperation(
  input: Omit<Parameters<typeof rawBindOperation>[0], "channel" | "verification" | "title"> & Readonly<{ title?: string }>,
) {
  return withGitDecodeChannel(input.scope, (channel) => rawBindOperation({
    ...input,
    channel,
    title: input.title ?? "Protocol bind",
    verification: NO_VERIFICATION,
  }));
}

type AmendTestInput = Omit<Parameters<typeof rawAmendOperation>[0], "channel" | "deriveAmendment"> & Readonly<{
  source?: ContractTerms;
  terms?: AmendData;
}>;

function amendOperation(input: AmendTestInput) {
  const { source, terms, ...operation } = input;
  return withGitDecodeChannel(input.scope, (channel) => rawAmendOperation({
    ...operation,
    channel,
    ...(source === undefined || terms === undefined
      ? {}
      : { source, deriveAmendment: () => ({ terms, verification: NO_VERIFICATION }) }),
  }));
}

function repositoryWithHead() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function preparationCoordinates(state: NonNullable<Awaited<ReturnType<typeof observeContract>>["state"]>) {
  return { contractId: state.id, coordinates: state.coordinates };
}

test("observes a targetless current snapshot when bind target is omitted", () => {
  const repository = repositoryWithHead();
  const start = repository.run(["rev-parse", "HEAD"]).trim();

  assert.deepEqual(observeBindCoordinates(repositoryAt(repository.path)), { start, branch: "refs/heads/main" });
});

test("observes an explicit target by its exact full ref", () => {
  const repository = repositoryWithHead();
  repository.run(["branch", "release"]);
  const target = "refs/heads/release";
  const start = repository.run(["rev-parse", target]).trim();

  assert.deepEqual(observeBindCoordinates(repositoryAt(repository.path), target), {
    target,
    start,
    branch: "refs/heads/main",
  });
});

test("observes a targetless detached bind snapshot", () => {
  const repository = repositoryWithHead();
  repository.run(["checkout", "--quiet", "--detach"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();

  assert.deepEqual(observeBindCoordinates(repositoryAt(repository.path)), { start, branch: null });
});

test("observes a missing explicit bind target without inventing coordinates", () => {
  const repository = repositoryWithHead();

  assert.equal(observeBindCoordinates(repositoryAt(repository.path), "refs/heads/missing"), null);
});

test("refuses targets that name Keiyaku-owned refs", () => {
  const repository = repositoryWithHead();
  const ownedTargets = [
    GIT_REF,
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
  const git = readGit(repository);
  const malformed = writeBlob(repository, "not a journal\n");
  const tree = updateGitTree(repository, git.tree, new Map([
    [path, { oid: malformed }],
  ]));
  const commit = writeCommit({ repository, tree, parent: git.commit });
  assert.equal(updateRefsAtomically(repository, [{
    ref: GIT_REF,
    newOid: commit,
    expectedOid: git.commit,
  }]).kind, "published");
}

function publishMalformedUnrelatedJournal(repository: ReturnType<typeof repositoryAt>): void {
  publishMalformedJournal(repository, "contracts/unrelated.jsonl");
}

test("batches full Contract observation through one call-scoped object process", async () => {
  const repository = repositoryWithHead();
  await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  for (let index = 1; index < 4; index += 1) {
    await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "worktree" });
  }

  const git = readGit(repositoryAt(repository.path));
  const journals = [...git.paths.keys()].filter((path) => path.startsWith("contracts/") && path.endsWith(".jsonl"));
  assert.equal(journals.length, 4);
  const log = join(repository.path, "cat-file.log");
  const observed = await withGitShim(
    "if [ \"$1\" = \"cat-file\" ]; then printf '%s\\n' \"$*\" >> \"$KEIYAKU_READ_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_READ_LOG: log },
    () => {
      const git = repositoryAt(repository.path);
      return withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, observeContractWorld));
    },
  );

  assert.equal(observed.contracts.size, journals.length);
  const invocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.startsWith("cat-file blob ")).length, 0);
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

test("known publication failure is returned without a post-result ref read", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  const id = (await bound.keiyaku.state()).id;
  const git = repositoryAt(repository.path);
  const failed = join(repository.path, "publication-failed.marker");
  const postRead = join(repository.path, "post-publication-read.marker");

  const result = await withGitShim([
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
  }, () => withGitDecodeChannel(git, async (channel) => {
    const observation = await observeContractsForAdmissionAt(git, channel, [id]);
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
    return admit(git, decision.offer, observation.admission);
  }));

  assert.equal(result.kind, "publication-failed");
  if (result.kind !== "publication-failed") throw new Error("publication failure was not preserved");
  assert.match(result.diagnostic, /forced publication failure/);
  assert.equal(existsSync(postRead), false);
});

test("admission publishes a journal append and opaque companion in one Git snapshot", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  const id = (await bound.keiyaku.state()).id;
  const git = repositoryAt(repository.path);
  const { before, result } = await withGitDecodeChannel(git, async (channel) => {
    const observation = await observeContractsForAdmissionAt(git, channel, [id]);
    const before = observation.admission.snapshot.paths.get(contractJournalPath(id));
    assert.ok(before);
    const decision = decideArc({
      input: {
        contractId: id,
        at: "2026-08-06T00:00:00Z",
        data: { title: "Atomic companion", objective: "Publish together", brief: "Use one root CAS." },
      },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
      observation: observation.decision,
    });
    assert.equal(decision.kind, "offer");
    if (decision.kind !== "offer") throw new Error("arc decision was not an offer");

    const foreignJournal = contractJournalPath(contractId("kei/foreign-companion-target"));
    assert.throws(
      () => admit(git, {
        ...decision.offer,
        companions: [{ path: foreignJournal, bytes: Buffer.from("not a journal\n") }],
      }, observation.admission),
      (error: unknown) => error instanceof Error
        && error.message === `companion path collides with admission-owned path: ${foreignJournal}`,
    );

    return {
      before,
      result: admit(git, {
        ...decision.offer,
        companions: [{ path: "test/companion.txt", bytes: Buffer.from("companion\n") }],
      }, observation.admission),
    };
  });

  assert.equal(result.kind, "accepted");
  const after = readGit(git);
  assert.equal(after.paths.has("test/companion.txt"), true);
  assert.notEqual(after.paths.get(contractJournalPath(id))?.oid, before.oid);
});

test("a failed Git CAS publishes neither its journal append nor its companion", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  const id = (await bound.keiyaku.state()).id;
  const git = repositoryAt(repository.path);
  const observation = await withGitDecodeChannel(git, (channel) => observeContractsForAdmissionAt(git, channel, [id]));
  const before = observation.admission.snapshot.paths.get(contractJournalPath(id));
  assert.ok(before);
  const decision = decideArc({
    input: {
      contractId: id,
      at: "2026-08-06T00:00:00Z",
      data: { title: "Losing companion", objective: "Lose one CAS", brief: "Leave no partial fact." },
    },
    attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
    observation: observation.decision,
  });
  assert.equal(decision.kind, "offer");
  if (decision.kind !== "offer") throw new Error("arc decision was not an offer");

  const winnerBlob = writeBlob(git, "winner\n");
  const winnerTree = updateGitTree(git, observation.admission.snapshot.tree, new Map([
    ["test/winner.txt", { oid: winnerBlob }],
  ]));
  const winnerCommit = writeCommit({
    repository: git,
    tree: winnerTree,
    parent: observation.admission.snapshot.commit,
  });
  assert.equal(updateRefsAtomically(git, [{
    ref: GIT_REF,
    newOid: winnerCommit,
    expectedOid: observation.admission.snapshot.commit,
  }]).kind, "published");

  const result = admit(git, {
    ...decision.offer,
    companions: [{ path: "test/loser.txt", bytes: Buffer.from("loser\n") }],
  }, observation.admission);

  assert.equal(result.kind, "publication-failed");
  const after = readGit(git);
  assert.equal(after.paths.has("test/winner.txt"), true);
  assert.equal(after.paths.has("test/loser.txt"), false);
  assert.equal(after.paths.get(contractJournalPath(id))?.oid, before.oid);
});

function appendUnrelatedGitJournals(
  repository: ReturnType<typeof repositoryAt>,
  count: number,
  start: SnapshotId,
): void {
  const snapshot = readGit(repository);
  const changes = new Map();
  for (let index = 0; index < count; index += 1) {
    const id = contractId(`kei/git-load-${index}`);
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
  const tree = updateGitTree(repository, snapshot.tree, changes);
  const commit = writeCommit({ repository, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(repository, [{
    ref: GIT_REF,
    newOid: commit,
    expectedOid: snapshot.commit,
  }]).kind, "published");
}

async function amendObjectIo(
  repository: ReturnType<typeof repositoryAt>,
  id: ContractId,
): Record<string, number> {
  const state = (await observeContract(repository, id)).state;
  if (state === null) throw new Error("bound contract state was not observed");
  const log = join(repository.effectiveCwd, "amend-object-io.log");
  const amended = await withGitShim(
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

async function amendBatchRequests(
  repository: ReturnType<typeof repositoryAt>,
  id: ContractId,
): Promise<number> {
  const state = (await observeContract(repository, id)).state;
  if (state === null) throw new Error("bound contract state was not observed");
  const log = join(repository.effectiveCwd, "amend-batch-oids.log");
  const amended = await withGitShim([
    'if [ "$1 $2" = "cat-file --batch" ]; then',
    '  tee "$KEIYAKU_BATCH_OID_LOG" | "$KEIYAKU_REAL_GIT" "$@"',
    "  exit $?",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_BATCH_OID_LOG: log }, () => amendOperation({
    scope: repository,
    contractId: id,
    source: state.terms,
    terms: state.terms,
  }));
  assert.equal(amended.kind, "accepted");
  return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
}

test("single-contract amend object I/O stays fixed as the git grows", async () => {
  const one = repositoryWithHead();
  const oneGit = repositoryAt(one.path);
  const oneBound = await bindOperation({ scope: oneGit, terms: terms([]), workspace: "here" });
  assert.equal(oneBound.kind, "accepted");
  if (oneBound.kind !== "accepted") throw new Error("one-contract bind was not accepted");

  const many = repositoryWithHead();
  const manyGit = repositoryAt(many.path);
  const manyBound = await bindOperation({ scope: manyGit, terms: terms([]), workspace: "here" });
  assert.equal(manyBound.kind, "accepted");
  if (manyBound.kind !== "accepted") throw new Error("many-contract bind was not accepted");
  const manyState = (await observeContract(manyGit, manyBound.value.contractId)).state;
  if (manyState === null) throw new Error("many-contract bound state was not observed");
  appendUnrelatedGitJournals(manyGit, 32, manyState.coordinates.start);

  const oneIo = await amendObjectIo(oneGit, oneBound.value.contractId);
  const manyIo = await amendObjectIo(manyGit, manyBound.value.contractId);
  assert.deepEqual(manyIo, oneIo);
  assert.equal(oneIo.mktree, 1);

  assert.equal(
    await amendBatchRequests(manyGit, manyBound.value.contractId),
    await amendBatchRequests(oneGit, oneBound.value.contractId),
  );
});

test("bind reobserves and atomically asserts target coordinates after an identity collision", async () => {
  const repository = repositoryWithHead();
  repository.run(["branch", "release"]);
  const git = repositoryAt(repository.path);
  const first = await bindOperation({
    scope: git,
    title: "Moving target",
    terms: terms([]),
    target: "refs/heads/release",
    workspace: "worktree",
  });
  assert.equal(first.kind, "accepted");

  const predecessor = repository.run(["rev-parse", "refs/heads/release"]).trim();
  const tree = repository.run(["rev-parse", `${predecessor}^{tree}`]).trim();
  const moved = repository.run(["commit-tree", tree, "-p", predecessor, "-m", "move target"]).trim();
  const marker = join(repository.path, "bind-target-observation.marker");
  const second = await withGitShim([
    'if [ "$1" = "for-each-ref" ]; then',
    '  if [ -e "$KEIYAKU_BIND_MARKER" ]; then',
    '    "$KEIYAKU_REAL_GIT" update-ref refs/heads/release "$KEIYAKU_MOVED_TARGET" "$KEIYAKU_OLD_TARGET" || exit $?',
    "  else",
    '    : > "$KEIYAKU_BIND_MARKER"',
    "  fi",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), {
    KEIYAKU_BIND_MARKER: marker,
    KEIYAKU_MOVED_TARGET: moved,
    KEIYAKU_OLD_TARGET: predecessor,
  }, () => bindOperation({
    scope: git,
    title: "Moving target",
    terms: terms([]),
    target: "refs/heads/release",
    workspace: "worktree",
  }));

  assert.equal(second.kind, "accepted");
  if (second.kind !== "accepted") throw new Error("collision bind was not accepted");
  const state = (await observeContract(git, second.value.contractId)).state;
  assert.equal(state?.coordinates.start, moved);
});

test("bind fits Contract identity stems to 48 UTF-8 bytes", async () => {
  const repository = repositoryWithHead();
  const git = repositoryAt(repository.path);
  const ascii = await bindOperation({
    scope: git,
    title: "a".repeat(100),
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(ascii.kind, "accepted");
  if (ascii.kind !== "accepted") throw new Error("long ASCII bind was not accepted");
  assert.equal(ascii.value.contractId, `kei/${"a".repeat(48)}`);
  assert.equal(Buffer.byteLength(ascii.value.contractId), 52);

  const unicode = await bindOperation({
    scope: git,
    title: "👩‍💻".repeat(20),
    terms: terms([]),
    workspace: "worktree",
  });
  assert.equal(unicode.kind, "accepted");
  if (unicode.kind !== "accepted") throw new Error("long Unicode bind was not accepted");
  assert.equal(unicode.value.contractId, `kei/${"👩‍💻".repeat(4)}`);
  assert.equal(Buffer.byteLength(unicode.value.contractId.slice("kei/".length)) <= 48, true);

  const collision = await bindOperation({
    scope: git,
    title: "a".repeat(100),
    terms: terms([]),
    workspace: "worktree",
  });
  assert.equal(collision.kind, "accepted");
  if (collision.kind !== "accepted") throw new Error("long identity collision bind was not accepted");
  const collisionStem = collision.value.contractId.slice("kei/".length);
  assert.equal(Buffer.byteLength(collisionStem), 65);
  assert.match(collisionStem, /^a{48}-[0-9a-f]{16}$/u);
});

test("protocol bind does not own here-worktree appointment", async () => {
  const repository = repositoryWithHead();
  const git = repositoryAt(repository.path);
  const first = await bindOperation({
    scope: git,
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(first.kind, "accepted");
  if (first.kind !== "accepted") throw new Error("first here bind was not accepted");

  const second = await bindOperation({
    scope: git,
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(second.kind, "accepted");
});

test("bind never restores a targeted here checkout that moved to a same-OID branch", async () => {
  const repository = repositoryWithHead();
  repository.run(["branch", "feature"]);
  const start = repository.run(["rev-parse", "HEAD"]).trim();
  const git = repositoryAt(repository.path);

  const bound = await withGitShim([
    'if [ "$1 $2" = "update-ref --stdin" ]; then',
    '  "$KEIYAKU_REAL_GIT" symbolic-ref HEAD refs/heads/feature || exit $?',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), {}, () => bindOperation({
    scope: git,
    title: "Same OID checkout movement",
    terms: terms([]),
    target: "refs/heads/main",
    workspace: "here",
  }));

  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("same-OID moved bind was not accepted");
  assert.equal(repository.run(["symbolic-ref", "HEAD"]).trim(), "refs/heads/feature");
  assert.equal((await observeContract(git, bound.value.contractId)).state?.coordinates.start, start);
});

test("targetless bind reobserves a different HEAD OID after atomic verification fails", async () => {
  const repository = repositoryWithHead();
  const predecessor = repository.run(["rev-parse", "HEAD"]).trim();
  const tree = repository.run(["rev-parse", `${predecessor}^{tree}`]).trim();
  const moved = repository.run(["commit-tree", tree, "-p", predecessor, "-m", "move HEAD"]).trim();
  repository.run(["branch", "feature", moved]);
  const marker = join(repository.path, "bind-head-observation.marker");
  const git = repositoryAt(repository.path);

  const bound = await withGitShim([
    'if [ "$1 $2" = "update-ref --stdin" ] && [ ! -e "$KEIYAKU_BIND_MARKER" ]; then',
    '  : > "$KEIYAKU_BIND_MARKER"',
    '  "$KEIYAKU_REAL_GIT" symbolic-ref HEAD refs/heads/feature || exit $?',
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_BIND_MARKER: marker }, () => bindOperation({
    scope: git,
    title: "Different OID checkout movement",
    terms: terms([]),
    workspace: "worktree",
  }));

  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("moved targetless bind was not accepted");
  assert.equal(repository.run(["symbolic-ref", "HEAD"]).trim(), "refs/heads/feature");
  assert.equal((await observeContract(git, bound.value.contractId)).state?.coordinates.start, moved);
});

test("runProtocol observes only watched contracts", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  const id = (await bound.keiyaku.state()).id;

  const git = readGit(repositoryAt(repository.path));
  const malformed = writeBlob(repositoryAt(repository.path), "not a journal\n");
  const tree = updateGitTree(repositoryAt(repository.path), git.tree, new Map([
    ["contracts/unrelated.jsonl", { oid: malformed }],
  ]));
  const commit = writeCommit({ repository: repositoryAt(repository.path), tree, parent: git.commit });
  assert.equal(updateRefsAtomically(repositoryAt(repository.path), [{
    ref: GIT_REF,
    newOid: commit,
    expectedOid: git.commit,
  }]).kind, "published");

  const gitOwner = repositoryAt(repository.path);
  const result = await withGitDecodeChannel(gitOwner, (channel) => runProtocol({
    input: { contractId: id },
    channel,
    repository: gitOwner,
    contracts: [id],
    attempts: [{ entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] }],
    decide: ({ observation }) => {
      assert.deepEqual([...observation.keys()], [id]);
      return { kind: "refused", refusal: "test refusal" };
    },
  }));
  assert.deepEqual(result, { kind: "refused", refusal: "test refusal" });
});

test("contract-local intent ignores an unrelated malformed journal", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  const id = (await bound.keiyaku.state()).id;
  const git = repositoryAt(repository.path);
  publishMalformedUnrelatedJournal(git);

  const result = await withGitDecodeChannel(git, (channel) => admitIntent(channel, git, {
    contractId: id,
    at: "2026-08-06T00:00:00Z",
    data: { title: "Observation", objective: "Observe one journal", brief: "Keep the intent local." },
  }, decideArc));

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

test("Git journal depth is independent of contract identity length", () => {
  const short = contractJournalPath(contractId("kei/alpha"));
  const long = contractJournalPath(contractId(`kei/${"可读".repeat(1_000)}`));

  assert.match(short, /^contracts\/active\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}\.jsonl$/);
  assert.match(long, /^contracts\/active\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{60}\.jsonl$/);
  assert.notEqual(long, short);
});

test("placement claims only the selected contract", async () => {
  const repository = repositoryWithHead();
  const git = repositoryAt(repository.path);
  const source = await bindOperation({ scope: git, terms: terms([]), workspace: "here" });
  assert.equal(source.kind, "accepted");
  if (source.kind !== "accepted") throw new Error("source bind was not accepted");
  const dependent = await bindOperation({
    scope: git,
    terms: terms([source.value.contractId]),
    workspace: "worktree",
  });
  assert.equal(dependent.kind, "accepted");
  if (dependent.kind !== "accepted") throw new Error("dependent bind was not accepted");

  const sourceState = (await observeContract(git, source.value.contractId)).state;
  if (sourceState === null) throw new Error("source state was not observed");
  const prepared = prepareDelivery(git, preparationCoordinates(sourceState), {
    title: "Frozen journal bytes",
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("source delivery was not prepared");
  const delivered = await withGitDecodeChannel(git, (channel) => admitIntent(channel, git, {
    contractId: source.value.contractId,
    at: "2026-08-07T00:00:00Z",
    preparation: { kind: "prepared", document: sourceState.terms.document.key, data: prepared.data },
  }, decideDeliver));
  assert.equal(delivered.kind, "accepted");

  const claimed = await withGitDecodeChannel(git, (channel) => admitPlacement(
    channel,
    git,
    sourceState.coordinates.target,
    { contractId: source.value.contractId, at: "2026-08-07T00:00:01Z" },
  ));

  assert.equal(claimed.kind, "accepted");
  if (claimed.kind !== "accepted") throw new Error("placement was not accepted");
  assert.deepEqual(claimed.facts.map((entry) => entry.kind), ["claimed"]);
  assert.equal((await observeContract(git, dependent.value.contractId)).state?.bound, null);
});

test("public reconcile and admission observation retain canonical journal validation", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  const id = (await bound.keiyaku.state()).id;
  const git = repositoryAt(repository.path);
  const snapshot = readGit(git);
  const path = contractJournalPath(id);
  const journal = snapshot.paths.get(path);
  if (journal === undefined) throw new Error("bound journal was not observed");
  const noncanonical = writeBlob(
    git,
    Buffer.concat([readBlob(git, journal.oid).subarray(0, -1), Buffer.from(" \n")]),
  );
  const tree = updateGitTree(git, snapshot.tree, new Map([[path, { oid: noncanonical }]]));
  const commit = writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(git, [{
    ref: GIT_REF,
    newOid: commit,
    expectedOid: snapshot.commit,
  }]).kind, "published");

  await assert.rejects(
    () => withGitDecodeChannel(git, (channel) => observeContractsForAdmissionAt(git, channel, [id])),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && /journal entry is not canonical/.test(error.message),
  );
  await assert.rejects(
    () => bound.keiyaku.reconcile(),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && /journal entry is not canonical/.test(error.message),
  );
});

test("bind and amend eligibility read only self and their after contracts", async () => {
  const repository = repositoryWithHead();
  const git = repositoryAt(repository.path);
  const dependency = await bindOperation({
    scope: git,
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(dependency.kind, "accepted");
  if (dependency.kind !== "accepted") throw new Error("dependency bind was not accepted");
  const dependencyId = dependency.value.contractId;
  publishMalformedUnrelatedJournal(git);

  const result = await bindOperation({
    scope: git,
    terms: terms([dependencyId]),
    workspace: "worktree",
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("targeted bind was not accepted");
  assert.deepEqual(result.facts.map((entry) => entry.kind), ["bind"]);
  const resultState = (await observeContract(git, result.value.contractId)).state;
  if (resultState === null) throw new Error("bound contract state was not observed");

  const amended = await amendOperation({
    scope: git,
    contractId: result.value.contractId,
    source: resultState.terms,
    terms: terms([dependencyId]),
  });
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("targeted amend was not accepted");
  assert.deepEqual(amended.facts.map((entry) => entry.kind), ["amend"]);
});

test("amend reads the current prerequisite before replacing it", async () => {
  const repository = repositoryWithHead();
  const git = repositoryAt(repository.path);
  const dependency = await bindOperation({ scope: git, terms: terms([]), workspace: "here" });
  assert.equal(dependency.kind, "accepted");
  if (dependency.kind !== "accepted") throw new Error("dependency bind was not accepted");
  const waiting = await bindOperation({
    scope: git,
    terms: terms([dependency.value.contractId]),
    workspace: "worktree",
  });
  assert.equal(waiting.kind, "accepted");
  if (waiting.kind !== "accepted") throw new Error("waiting bind was not accepted");
  const before = (await observeContract(git, waiting.value.contractId)).state;
  if (before === null) throw new Error("waiting contract was not observed");
  const amended = await amendOperation({
    scope: git,
    contractId: waiting.value.contractId,
    source: before.terms,
    terms: terms([]),
  });

  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("replacement amend was not accepted");
  assert.deepEqual(amended.facts.map((entry) => entry.kind), ["amend"]);
});

test("amend refuses a stale complete-terms replacement when document bytes did not move", async () => {
  const repository = repositoryWithHead();
  const git = repositoryAt(repository.path);
  const bound = await bindOperation({ scope: git, terms: terms([]), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  const before = (await observeContract(git, bound.value.contractId)).state;
  if (before === null) throw new Error("contract state was not observed");
  const reviewed = { ...before.terms, gates: [gate("reviewed")] };
  assert.equal((await amendOperation({
    scope: git,
    contractId: before.id,
    source: before.terms,
    terms: reviewed,
  })).kind, "accepted");

  const stale = await amendOperation({
    scope: git,
    contractId: before.id,
    source: before.terms,
    terms: before.terms,
  });
  assert.deepEqual(stale, {
    kind: "refused",
    refusal: { kind: "terms-moved", contractId: before.id },
  });
});

test("bind rejects unresolved after and bound amend prioritizes consumed prerequisites", async () => {
  const repository = repositoryWithHead();
  const git = repositoryAt(repository.path);
  const missing = contractId("kei/missing-prerequisite");
  const bound = await bindOperation({
    scope: git,
    terms: terms([missing]),
    workspace: "here",
  });
  assert.equal(bound.kind, "refused");
  if (bound.kind !== "refused") throw new Error("bind must refuse an unresolved prerequisite");
  assert.equal(bound.refusal.kind, "unknown-prerequisite");

  const existing = await bindOperation({
    scope: git,
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(existing.kind, "accepted");
  if (existing.kind !== "accepted") throw new Error("existing bind was not accepted");
  const existingState = (await observeContract(git, existing.value.contractId)).state;
  if (existingState === null) throw new Error("existing contract state was not observed");
  const amended = await amendOperation({
    scope: git,
    contractId: existing.value.contractId,
    source: existingState.terms,
    terms: terms([missing]),
  });
  assert.deepEqual(amended, {
    kind: "refused",
    refusal: { kind: "prerequisites-already-consumed", contractId: existing.value.contractId },
  });
});

test("bind and amend leave eligible prerequisites unmaterialized", async () => {
  const repository = repositoryWithHead();
  const activeDependency = await bindOperation({
    scope: repositoryAt(repository.path),
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(activeDependency.kind, "accepted");
  if (activeDependency.kind !== "accepted") throw new Error("active dependency bind was not accepted");
  const waiting = await bindOperation({
    scope: repositoryAt(repository.path),
    terms: terms([activeDependency.value.contractId]),
    workspace: "worktree",
  });
  assert.equal(waiting.kind, "accepted");
  if (waiting.kind !== "accepted") throw new Error("waiting bind was not accepted");

  const claimedDependency = await bindOperation({
    scope: repositoryAt(repository.path),
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(claimedDependency.kind, "accepted");
  if (claimedDependency.kind !== "accepted") throw new Error("claimable dependency bind was not accepted");
  const git = repositoryAt(repository.path);
  const state = (await withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, observeContractWorld)))
    .contracts.get(claimedDependency.value.contractId)?.state;
  if (state === undefined || state === null) throw new Error("claimable dependency state was not observed");
  const delivery = prepareDelivery(git, preparationCoordinates(state), { title: "Targeted" });
  assert.equal(delivery.kind, "prepared");
  if (delivery.kind !== "prepared") throw new Error("claimable dependency delivery was not prepared");
  const delivered = await withGitDecodeChannel(git, (channel) => admitIntent(channel, git, {
    contractId: claimedDependency.value.contractId,
    at: "2026-08-06T00:00:00Z",
    preparation: { kind: "prepared", document: state.terms.document.key, data: delivery.data },
  }, decideDeliver));
  assert.equal(delivered.kind, "accepted");
  const claimed = await withGitDecodeChannel(git, (channel) => admitPlacement(
    channel,
    git,
    state.coordinates.target,
    { contractId: claimedDependency.value.contractId, at: "2026-08-06T00:00:01Z" },
  ));
  assert.equal(claimed.kind, "accepted");

  const immediatelyBound = await bindOperation({
    scope: git,
    terms: terms([claimedDependency.value.contractId]),
    workspace: "worktree",
  });
  assert.equal(immediatelyBound.kind, "accepted");
  if (immediatelyBound.kind !== "accepted") throw new Error("claimed prerequisite bind was not accepted");
  assert.deepEqual(immediatelyBound.facts.map((entry) => entry.kind), ["bind"]);

  const waitingState = (await observeContract(git, waiting.value.contractId)).state;
  if (waitingState === null) throw new Error("waiting contract state was not observed");

  const amended = await amendOperation({
    scope: git,
    contractId: waiting.value.contractId,
    source: waitingState.terms,
    terms: terms([claimedDependency.value.contractId]),
  });
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("eligible amend was not accepted");
  assert.deepEqual(amended.facts.map((entry) => entry.kind), ["amend"]);
});

test("placement redecides after a world advance without binding a dependent", async () => {
  const repository = repositoryWithHead();
  const source = await bindOperation({
    scope: repositoryAt(repository.path),
    terms: terms([]),
    workspace: "here",
  });
  assert.equal(source.kind, "accepted");
  if (source.kind !== "accepted") throw new Error("source bind was not accepted");

  const git = repositoryAt(repository.path);
  const sourceState = (await observeContract(git, source.value.contractId)).state;
  if (sourceState === null) throw new Error("source state was not observed");
  const prepared = prepareDelivery(git, preparationCoordinates(sourceState), { title: "Concurrent placement" });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw new Error("source delivery was not prepared");
  const delivered = await withGitDecodeChannel(git, (channel) => admitIntent(channel, git, {
    contractId: source.value.contractId,
    at: "2026-08-06T00:00:00Z",
    preparation: { kind: "prepared", document: sourceState.terms.document.key, data: prepared.data },
  }, decideDeliver));
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

  const claimed = await withGitShim(
    shim,
    { KEIYAKU_RACE_MARKER: marker, KEIYAKU_RACE_JOURNAL: dependentJournal },
    () => withGitDecodeChannel(git, (channel) => admitPlacement(
      channel,
      git,
      sourceState.coordinates.target,
      { contractId: source.value.contractId, at: "2026-08-06T00:00:02Z" },
    )),
  );
  assert.equal(claimed.kind, "accepted");
  if (claimed.kind !== "accepted") throw new Error("placement was not accepted after redecision");
  assert.deepEqual(claimed.facts.map((fact) => fact.kind), ["claimed"]);
  assert.equal((await observeContract(git, source.value.contractId)).state?.terminal?.kind, "claimed");
  assert.equal((await observeContract(git, dependent)).state?.bound, null);
});

test("delivery preparation ignores an unrelated malformed journal", async () => {
  const repository = repositoryWithHead();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: contractBody(), workspace: "here" });
  const id = (await bound.keiyaku.state()).id;
  const git = repositoryAt(repository.path);
  publishMalformedUnrelatedJournal(git);

  const state = (await observeContract(git, id)).state;
  if (state === null) throw new Error("bound contract state was not observed");
  assert.equal(prepareDelivery(git, preparationCoordinates(state), { title: "Observation" }).kind, "prepared");
});
