import { present, accepted } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { journalEntry } from "../src/core/facts/types.js";
import { admit } from "../src/git/admission.js";
import { observeContractsAt } from "../src/git/observe.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { admitDecidedOffer, mintAttempt } from "../src/protocol/attempt.js";
import { withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";
import { cachedRepositoryAt, waitForFile, withGitShim } from "./support/git.js";
import { bind, document, repositoryWithMain } from "./support/library-verbs.js";

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
