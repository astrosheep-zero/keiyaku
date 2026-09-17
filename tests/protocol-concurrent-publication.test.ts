import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { Keiyaku, KeiyakuRetry, Repo } from "../src/index.js";
import { applyAmendDocument } from "../src/body/amend.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { entryUlid, type ContractTerms } from "../src/core/facts/types.js";
import { decideArc } from "../src/core/verbs/arc.js";
import { observeContractsForAdmissionAt } from "../src/git/observe.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../src/git/read-observation.js";
import { contractTerms } from "../src/library/input.js";
import { amendOperation } from "../src/protocol/amend.js";
import { runProtocol } from "../src/protocol/run.js";
import { cachedRepositoryAt, withGitShim } from "./support/git.js";
import { bind, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";

test("concurrent private-state binds all publish accepted contracts", async () => {
  const repository = repositoryWithMain();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      (async () =>
        Keiyaku.bind({
          repo: await Repo.at({ path: repository.path }),
          markdown: document(),
          workspace: "worktree",
          gates: ["reviewed"],
        }))(),
    ),
  );
  assert.equal(results.length, 10);
  assert.ok(results.every((result) => result.kind === "accepted"));
  const states = await Promise.all(results.map((result) => result.keiyaku.state()));
  assert.equal(new Set(states.map((state) => state.id)).size, 10);
  assert.ok(states.every((state) => state.head !== null));
});

test("a preparation spent by a concurrent publication restarts with a fresh attempt identity", async () => {
  const repository = repositoryWithMain();
  const bound = await bind(repository);
  const id = (await bound.state()).id;
  const capability = await cachedRepositoryAt(repository.path);
  const headOf = async (channel: GitDecodeChannel) =>
    (await observeContractsForAdmissionAt(capability, channel, [id])).decision.get(id)?.head ?? null;
  // The spent artifact is a real private-state witness read before a concurrent publication.
  const spent = await withGitDecodeChannel(capability, headOf);
  await bound.amend({ markdown: "## Replace: Context\nConcurrent publication of the same contract.\n" });
  const moved = await withGitDecodeChannel(capability, headOf);
  assert.notEqual(moved, spent, "the concurrent publication must move the witnessed head");
  const spentAttempt = entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FA1");
  const freshAttempt = entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FA2");
  let externalReads = 0;
  let observations = 0;
  const result = await withGitDecodeChannel(capability, (channel) =>
    runProtocol({
      input: {
        contractId: id,
        at: "2026-08-06T00:00:03Z",
        data: { title: "Fresh observation", objective: "Restart the spent preparation", brief: "Discard the offer." },
      },
      channel,
      repository: capability,
      contracts: [id],
      attempts: [{ entryUlids: [spentAttempt] }, { entryUlids: [freshAttempt] }],
      observe: async (repository_, decode, contracts) => {
        observations += 1;
        return await observeContractsForAdmissionAt(repository_, decode, contracts);
      },
      preparation: {
        external: async () => {
          externalReads += 1;
          // The first preparation raced the concurrent publication; every restart reads again.
          return {
            kind: "prepared",
            prepared: externalReads === 1 ? spent : await headOf(channel),
          };
        },
        assemble: (observation, seed, prepared) =>
          (observation.decision.get(id)?.head ?? null) === prepared
            ? { kind: "prepared", input: seed }
            : { kind: "stale" },
      },
      decide: decideArc,
    }),
  );
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("spent preparation did not restart");
  assert.deepEqual(
    result.facts.map((fact) => fact.entry),
    [freshAttempt],
    "the spent attempt's offer must never be replayed",
  );
  assert.equal(externalReads, 2, "the restart must run the seat-external preparation again");
  assert.equal(observations, 2, "each attempt takes exactly one authoritative in-custody observation");
  assert.notDeepEqual(await withGitDecodeChannel(capability, headOf), spent);
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
      await Keiyaku.bind({
        repo: await Repo.at({ path: repository.path, gitPath }),
        markdown: document(),
        workspace: "worktree",
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
  const concurrent = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    gates: ["reviewed"],
  });
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
  await assert.rejects(
    withGitShim(
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
          await Keiyaku.of({
            repo: await Repo.at({ path: repository.path, gitPath }),
            id: (await contract.state()).id,
          })
        ).amend({ markdown: "## Replace: Context\nNo coordinate moved.\n" }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof KeiyakuRetry, `expected KeiyakuRetry, got ${String(error)}`);
      assert.equal(error.code, "publication-failed");
      if (error.reason.kind === "publication-failed")
        assert.match(error.reason.diagnostic, /forced hard publication failure/u);
      return true;
    },
  );
  assert.deepEqual(readFileSync(attempts, "utf8").trim().split("\n"), ["attempt"]);
});

test("conflicting concurrent amends keep their typed business refusals", async () => {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const state = await contract.state();
  const id = state.id;
  const source: ContractTerms = state.terms;
  const capability = await cachedRepositoryAt(repository.path);
  const derive =
    (markdown: string) =>
    (observed: ContractTerms): Readonly<{ terms: ContractTerms; verification: { kind: "prepared"; data: null } }> => {
      const amended = applyAmendDocument(markdown, decodeContractDocument(observed.document.bytes));
      const decoded = decodeContractDocument(amended.document);
      const terms = contractTerms(decoded, observed.gates, observed.after);
      return { terms, verification: { kind: "prepared", data: null } };
    };
  const writer = (markdown: string) =>
    withGitDecodeChannel(capability, (channel) =>
      amendOperation({
        scope: capability,
        channel,
        contractId: id,
        source,
        deriveAmendment: derive(markdown),
      }),
    );
  const outcomes = await Promise.all([
    writer("## Replace: Context\nfirst concurrent amendment\n"),
    writer("## Replace: Objective\nsecond concurrent amendment\n"),
  ]);
  const accepted = outcomes.filter((outcome) => outcome.kind === "accepted");
  const refused = outcomes.filter((outcome) => outcome.kind === "refused");
  assert.equal(accepted.length, 1);
  assert.equal(refused.length, 1);
  const loser = refused[0];
  if (loser?.kind !== "refused") throw new Error("expected one typed amend refusal");
  assert.equal(loser.refusal.kind, "terms-moved");
});

test("bind interleaved with amend, deliver, and review never fails from a stale race", async () => {
  const repository = repositoryWithMain();
  const amendTarget = await bind(repository);
  const deliverTarget = await bind(repository);
  const reviewTarget = await bind(repository);
  commitCandidate(repository);
  await reviewTarget.deliver();
  const settled = await Promise.allSettled([
    Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document(),
      workspace: "worktree",
      gates: ["reviewed"],
    }),
    amendTarget.amend({ markdown: "## Replace: Context\nInterleaved amendment.\n" }),
    deliverTarget.deliver(),
    reviewTarget.review({ verdict: "satisfied" }),
  ]);
  for (const outcome of settled) {
    if (outcome.status !== "rejected") continue;
    const failure = outcome.reason as unknown;
    assert.ok(
      !(failure instanceof KeiyakuRetry),
      `interleaved mutation failed from a retry race: ${
        failure instanceof KeiyakuRetry ? JSON.stringify(failure.reason) : String(failure)
      }`,
    );
  }
  assert.equal(settled[0]?.status, "fulfilled", "the interleaved bind must publish");
  assert.equal(settled[1]?.status, "fulfilled", "the interleaved amend must publish");
});
