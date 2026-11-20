import { present, accepted } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { prepareAmendDocument } from "../src/body/amend.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { journalEntry, type ContractTerms } from "../src/core/facts/types.js";
import { admit } from "../src/git/admission.js";
import { observeContractsAt } from "../src/git/observe.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { contractTerms, documentDerivation } from "../src/library/input.js";
import { amendOperation } from "../src/protocol/amend.js";
import { admitDecidedOffer, mintAttempt } from "../src/protocol/attempt.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { privateStatePublicationSeatPath, withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";
import { deferred, waitForFixtureFile } from "./support/process.js";
import { appointedWorktreePath, cachedRepositoryAt, waitForFile, withGitShim } from "./support/git.js";
import { bind, document, repositoryWithMain } from "./support/library-verbs.js";

test("two concurrent private-state binds both publish distinct accepted contracts", async () => {
  const repository = repositoryWithMain();
  const writers = 2;
  const results = await Promise.all(
    Array.from({ length: writers }, () =>
      (async () =>
        Keis.of(await Repo.at({ path: repository.path })).bind({
          terms: document(),
          gates: ["reviewed"],
        }))(),
    ),
  );
  assert.equal(results.length, writers);
  assert.ok(results.every((result) => result.kind === "accepted"));
  const states = await Promise.all(results.map((result) => result.kei.state()));
  assert.equal(new Set(states.map((state) => present(state).id)).size, writers);
  assert.ok(states.every((state) => present(state).head !== null));
});

test("a stalled clean filter leaves unrelated admission free and journal movement retries the immutable capture", async () => {
  const repository = repositoryWithMain({ files: { ".gitattributes": "*.txt filter=stalled\n" } });
  const bound = await bind(repository);
  const id = present(await bound.state()).id;
  const git = await cachedRepositoryAt(repository.path);
  const worktree = await appointedWorktreePath(git, id);
  const root = join(repository.path, ".git");
  const marker = join(root, "filter-called");
  const release = join(root, "filter-release");
  const script = join(root, "clean-filter");
  const publications = join(root, "review-published");
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  writeFileSync(
    script,
    [
      'if [ "${KEIYAKU_TEST_PRIVATE_ADD:-}" = yes ]; then',
      '  printf "captured\\n" >> "$1"',
      '  i=0; until [ -e "$2" ]; do i=$((i+1)); [ "$i" -lt 3000 ] || exit 42; sleep 0.02; done',
      "fi",
      "cat",
    ].join("\n"),
  );
  repository.run(["config", "filter.stalled.clean", `sh \"${script}\" \"${marker}\" \"${release}\"`]);
  repository.run(["config", "filter.stalled.required", "true"]);
  await withGitShim(
    [
      'if [ -n "$GIT_INDEX_FILE" ] && [ "$3 $4 $5 $6" = "-c core.splitIndex=false add --all" ]; then',
      "  export KEIYAKU_TEST_PRIVATE_ADD=yes",
      "fi",
      'if [ "$1 $2" = "update-ref --stdin" ]; then : > "$PUBLICATIONS"; fi',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { PUBLICATIONS: publications },
    async (gitPath) => {
      const contract = await Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({ id });
      const testimony = { verdict: "unsatisfied", summary: "Checked the captured candidate" } as const;
      const reviewing = contract.review(testimony);
      void reviewing.catch(() => undefined);
      try {
        const captured = await Promise.race([waitForFixtureFile(marker).then(() => true), reviewing.then(() => false)]);
        assert.ok(captured, "review must remain pending in the capture filter");
        assert.notEqual((await bind(repository)).id, id);
        accepted(await bound.amend({ edits: "## Replace: Context\nConcurrent terms.\n" }));
        assert.equal(existsSync(release), false);
      } finally {
        writeFileSync(release, "go");
        await reviewing.catch(() => undefined);
      }
      const result = await reviewing;
      assert.equal(result.kind, "accepted");
      // The invocation captures once; the fresh attempt reuses those immutable bytes.
      assert.equal(readFileSync(marker, "utf8"), "captured\n");
      assert.equal(existsSync(publications), true);
      assert.equal(present(await bound.state()).attestations.length, 1);
    },
  );
});

test("a bind stalled in its seat-external preparation does not hold the publication seat", async () => {
  const repository = repositoryWithMain();
  const stalling = `${repository.path}/external-preparation-stalled`;
  const release = `${repository.path}/external-preparation-release`;
  let stalledBindSettled = false;
  const stalled = withGitShim(
    [
      'if [ "$1" = "for-each-ref" ]; then',
      '  : > "$KEIYAKU_STALLING"',
      '  i=0; while [ ! -e "$KEIYAKU_RELEASE" ]; do i=$((i + 1)); if [ "$i" -ge 3000 ]; then echo "fixture wait for $KEIYAKU_RELEASE expired after 60s" >&2; exit 1; fi; sleep 0.02; done',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_STALLING: stalling, KEIYAKU_RELEASE: release },
    async (gitPath) =>
      await Keis.of(await Repo.at({ path: repository.path, gitPath })).bind({
        terms: document(),
        gates: ["reviewed"],
        target: "refs/heads/main",
      }),
  );
  void stalled.then(() => {
    stalledBindSettled = true;
  });
  for (let attempt = 0; attempt < 500 && !existsSync(stalling); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(stalling), "the bind must stall in its seat-external preparation");
  // Another independent bind must publish while the first still waits outside the seat.
  const concurrent = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      terms: document(),
      gates: ["reviewed"],
    }),
  );
  assert.equal(concurrent.kind, "accepted");
  assert.equal(stalledBindSettled, false, "the stalled bind was still outside the seat");
  writeFileSync(release, "release\n");
  const released = await stalled;
  assert.equal(released.kind, "accepted");
});

test("an injected Git publication error still returns publication-failed", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const attempts = `${repository.path}/publication-attempts`;
  const outcome = await withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      "  cat >/dev/null",
      '  printf "attempt\\n" >> "$KEIYAKU_ATTEMPTS"',
      '  printf "forced hard publication failure\\n" >&2',
      "  exit 42",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_ATTEMPTS: attempts },
    async (gitPath) =>
      (
        await Keis.of(await Repo.at({ path: repository.path, gitPath })).kei({
          id: present(await contract.state()).id,
        })
      ).amend({ edits: "## Replace: Context\nNo coordinate moved.\n" }),
  );
  assert.equal(outcome.kind, "retry");
  assert.ok(outcome.kind === "retry" && outcome.reason === "publication-failed");
  assert.match(outcome.diagnostic, /forced hard publication failure/u);
  assert.deepEqual(readFileSync(attempts, "utf8").trim().split("\n"), ["attempt"]);
});

test("unknown publication never confirms an entry whose persisted bytes differ", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const contractId = present(await contract.state()).id;
  const raw = await cachedRepositoryAt(repository.path);
  const attempt = mintAttempt(1);
  const input = { contractId, at: "2026-08-06T00:00:03Z" };
  const entry = journalEntry("arc", input, attempt.entryUlids[0]!, { seq: 1, title: "Planned", body: "Exact bytes" });
  const offer = { facts: [{ contractId, entries: [entry] }] };
  const marker = join(repository.path, ".git", "publication-started");
  const release = join(repository.path, ".git", "release-publication");
  await withGitShim(
    [
      'if [ "$1 $2" = "update-ref --stdin" ]; then',
      '  printf "publication\\n" >> "$KEIYAKU_STARTED"',
      '  i=0; until [ -e "$KEIYAKU_RELEASE" ]; do i=$((i+1)); [ "$i" -lt 3000 ] || exit 42; sleep 0.02; done',
      "  kill -TERM $$",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_STARTED: marker, KEIYAKU_RELEASE: release },
    async (gitPath) => {
      const scope = await cachedRepositoryAt(repository.path, gitPath);
      // Keep fixture observation retirement separate from the publisher cancellation being tested.
      const publication = withGitDecodeChannel(raw, async (channel) => {
        const { value } = await withPrivateStatePublicationSeat(scope, async (seat) => {
          const observation = await observeContractsAt(scope, channel, [contractId]);
          return await admitDecidedOffer({ scope, channel, contractId, seat, observation, attempt, offer });
        });
        return value;
      });
      try {
        await Promise.race([waitForFile(marker), publication]);
        // A writer outside the cooperating seat publishes the same identity with different bytes.
        const observed = await withGitDecodeChannel(raw, (channel) => observeContractsAt(raw, channel, [contractId]));
        const foreign = { ...entry, data: { ...entry.data, title: "Another fact" } };
        assert.equal((await admit(raw, { facts: [{ contractId, entries: [foreign] }] }, observed)).kind, "accepted");
      } finally {
        writeFileSync(release, "go");
      }
      assert.deepEqual(await publication, { kind: "collision" });
      assert.equal(readFileSync(marker, "utf8"), "publication\n");
    },
  );
});

test("concurrent amends spend a prepared edit, while a new attempt still refuses an already stale source", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const state = present(await contract.state());
  const id = state.id;
  const source: ContractTerms = state.terms;
  const capability = await cachedRepositoryAt(repository.path);
  const derive = (markdown: string) => (observed: ContractTerms) => {
    const amended = prepareAmendDocument(markdown)(decodeContractDocument(observed.document.bytes));
    const decoded = decodeContractDocument(amended.document);
    const terms = contractTerms(decoded, observed.gates, observed.after);
    return { terms, verification: documentDerivation(decoded).verification };
  };
  const writer = (markdown: string, ready?: () => void) => {
    const scope = ready === undefined ? capability : { ...capability, onPrivateStateSeatContention: ready };
    return withGitDecodeChannel(scope, (channel) =>
      amendOperation({
        scope,
        channel,
        contractId: id,
        source,
        deriveAmendment: derive(markdown),
      }),
    );
  };
  const held = await acquireSqliteTransactionLock({
    path: privateStatePublicationSeatPath(capability),
    mode: "immediate",
  });
  const first = deferred<void>();
  const second = deferred<void>();
  const context = "## Replace: Context\nfirst concurrent amendment\n";
  const objective = "## Replace: Objective\nsecond concurrent amendment\n";
  const both = Promise.all([writer(context, first.resolve), writer(objective, second.resolve)]);
  try {
    await Promise.race([
      Promise.all([first.promise, second.promise]),
      both.then(() => assert.fail("writers did not contend")),
    ]);
  } finally {
    held.close();
  }
  const outcomes = await both;
  assert.equal(outcomes.filter((outcome) => outcome.kind === "accepted").length, 1);
  assert.deepEqual(
    outcomes.find((outcome) => outcome.kind !== "accepted"),
    {
      kind: "refused",
      refusal: { kind: "terms-moved" },
    },
  );
  const lost = outcomes[0]!.kind === "accepted" ? objective : context;
  assert.deepEqual(await writer(lost), { kind: "refused", refusal: { kind: "terms-moved" } });
  accepted(await contract.amend({ edits: lost }));
});
