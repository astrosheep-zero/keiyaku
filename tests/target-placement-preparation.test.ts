import { present } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { gate } from "../src/core/facts/types.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { tryAcquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { admitIntent } from "../src/protocol/intent.js";
import { admitPlacement } from "../src/protocol/placement.js";
import {
  cachedRepositoryAt,
  waitForFile,
  withGitShim,
} from "./support/git.js";
import { managedCandidate, repositoryWithMain, TARGET_PLACEMENT_FILES } from "./support/library-verbs.js";

async function readyPlacementFixture() {
  const repository = repositoryWithMain({ files: TARGET_PLACEMENT_FILES });
  const value = { repository, ...(await managedCandidate(repository, ["reviewed"])) };
  await value.contract.deliver();
  await value.contract.review({ verdict: "unsatisfied" });
  const git = await cachedRepositoryAt(value.repository.path);
  const subject = (present(await value.contract.state())).attestations.at(-1)!.data.subject;
  await withGitDecodeChannel(git, async (channel) => {
    const result = await admitIntent(
      channel,
      git,
      {
        contractId: value.id,
        at: new Date().toISOString(),
        preparation: {
          kind: "prepared" as const,
          data: { gate: gate("reviewed"), subject, verdict: "satisfied" as const },
        },
      },
      decideAttestation<never>,
    );
    assert.equal(result.kind, "accepted");
  });
  return { ...value, git };
}

test("placement preparation leaves the publication seat free and rechecks journal authority", async () => {
  for (const mutation of ["checkout", "authority"] as const) {
    const value = await readyPlacementFixture();
    const { repository, git, id, contract } = value;
    const before = repository.run(["rev-parse", "refs/heads/main"]);
    const marker = resolve(repository.path, ".git", "shape-started");
    const release = resolve(repository.path, ".git", "shape-release");
    await withGitShim(
      [
        'case " $* " in',
        '  *" --no-renames "*)',
        '    if [ ! -e "$SHAPE_STARTED" ]; then',
        '      touch "$SHAPE_STARTED"',
        '      i=0; while [ ! -e "$SHAPE_RELEASE" ]; do i=$((i + 1)); if [ "$i" -ge 6000 ]; then echo "fixture wait for $SHAPE_RELEASE expired after 60s" >&2; exit 1; fi; sleep 0.01; done',
        "    fi ;;",
        "esac",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { SHAPE_STARTED: marker, SHAPE_RELEASE: release },
      async (gitPath) => {
        const observedGit = await cachedRepositoryAt(repository.path, gitPath);
        const placing = withGitDecodeChannel(observedGit, (channel) =>
          admitPlacement({
            channel,
            repository: observedGit,
            target: "refs/heads/main",
            placement: { contractId: id, at: new Date().toISOString() },
          }),
        );
        void placing.catch(() => undefined);
        try {
          await waitForFile(marker);
          const otherWriter = await tryAcquireSqliteTransactionLock({
            path: privateStatePublicationSeatPath(git),
            mode: "immediate",
          });
          assert.ok(otherWriter, "immutable diff preparation held the shared publication seat");
          otherWriter.close();
          if (mutation === "checkout")
            writeFileSync(resolve(repository.path, "delivered.txt"), "local edit during preparation\n");
          else await contract.abandon();
        } finally {
          writeFileSync(release, "release");
          await placing.catch(() => undefined);
        }
        const result = await placing;
        if (mutation === "checkout") {
          assert.equal(result.kind, "accepted", "a dirty checkout must not veto placement");
          if (result.kind !== "accepted") return;
          assert.equal((present(await contract.state())).terminal?.kind, "claimed");
          assert.ok(result.physical?.lag.some((lag) => lag.kind === "target-checkout-retained"));
          assert.notEqual(repository.run(["rev-parse", "refs/heads/main"]), before);
          assert.equal(
            readFileSync(resolve(repository.path, "delivered.txt"), "utf8"),
            "local edit during preparation\n",
          );
        } else {
          assert.equal(result.kind, "refused");
          if (result.kind !== "refused") assert.fail("stale preparation was accepted");
          assert.equal(result.refusal.kind, "terminal");
          assert.equal((present(await contract.state())).terminal?.kind, "abandoned");
          assert.equal(repository.run(["rev-parse", "refs/heads/main"]), before);
        }
      },
    );
  }
});
