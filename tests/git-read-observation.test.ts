import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withGitAbortSignal } from "../src/git/process.js";
import { repositoryAt } from "../src/git/repository.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../src/git/read-observation.js";
import { makeGitRepository, waitForFile, withGitShim } from "./support/git.js";

const MISSING_OID = "0000000000000000000000000000000000000000";


test("Git read observation returns typed missing objects and closes its batch", async () => {
  const repository = makeGitRepository();
  let retained: GitReadObservation | null = null;

  const git = await repositoryAt(repository.path);
  const result = await withGitDecodeChannel(git, (channel) =>
    withGitReadObservation(git, channel, async (observation) => {
      retained = observation;
      return (await observation.readBlobs([MISSING_OID])).get(MISSING_OID);
    }),
  );

  assert.deepEqual(result, { kind: "missing" });
  assert.notEqual(retained, null);
  await assert.rejects(retained!.readBlobs([]), /Git read observation is closed/u);
  await assert.rejects(retained!.resolveRef("refs/heads/main"), /Git read observation is closed/u);
});

test("Git read observation returns a close-only batch failure", async () => {
  const repository = makeGitRepository();

  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@"',
      "  exit 73",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) =>
      assert.rejects(
        (async () => {
          const git = await repositoryAt(repository.path, gitPath);
          return withGitDecodeChannel(git, (channel) =>
            withGitReadObservation(git, channel, async (observation) => {
              assert.deepEqual((await observation.readBlobs([MISSING_OID])).get(MISSING_OID), { kind: "missing" });
            }),
          );
        })(),
        /git cat-file --batch: git cat-file --batch did not close cleanly/u,
      ),
  );
});

test("Git read observation reports cancellation instead of the interrupted batch read error", async () => {
  const repository = makeGitRepository();
  const marker = join(repository.path, "batch-cancellation-started");
  const controller = new AbortController();

  await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  printf started > "$KEIYAKU_BATCH_CANCEL_MARKER"',
      "  while :; do sleep 10; done",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_BATCH_CANCEL_MARKER: marker },
    async (gitPath) => {
      const git = withGitAbortSignal(await repositoryAt(repository.path, gitPath), controller.signal);
      await assert.rejects(
        withGitDecodeChannel(git, (channel) =>
          withGitReadObservation(git, channel, async (observation) => {
            const pending = observation.readBlobs([MISSING_OID]);
            await waitForFile(marker);
            controller.abort();
            await pending;
          }),
        ),
        /git cat-file --batch: git process cancelled/u,
      );
    },
  );
});

test("batch cursor rejects truncated and malformed object frames", async () => {
  const repository = makeGitRepository();
  for (const frame of [
    `${MISSING_OID} blob 4\nabc`,
    `${MISSING_OID} blob 0\n!`,
    `${MISSING_OID} blob invalid\n`,
    `${MISSING_OID} blob 9007199254740992\n`,
  ]) {
    const fixture = join(repository.path, "batch-frame.mjs");
    writeFileSync(fixture, `process.stdin.once("data", () => { process.stdout.end(${JSON.stringify(frame)}); process.stdin.destroy(); });`);
    await withGitShim(
      'if [ "$1 $2" = "cat-file --batch" ]; then exec "$KEIYAKU_FRAME_NODE" "$KEIYAKU_FRAME_SCRIPT"; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
      { KEIYAKU_FRAME_NODE: process.execPath, KEIYAKU_FRAME_SCRIPT: fixture },
      async (gitPath) => {
        const git = await repositoryAt(repository.path, gitPath);
        await assert.rejects(withGitDecodeChannel(git, (channel) => channel.readObjects([MISSING_OID])), /git cat-file --batch/u);
      },
    );
  }
});

test("batch requests are pipelined, deduplicated across concurrent calls and read in order", async () => {
  const repository = makeGitRepository();
  const fixture = join(repository.path, "batch-pipeline.mjs");
  const oids = Array.from({ length: 12000 }, (_, index) => (index + 1).toString(16).padStart(40, "0"));
  // A peer that requires two requests before replying proves this is a pipeline,
  // not merely faster sequential RPC. Replies exceed stdout's pipe capacity.
  writeFileSync(fixture, `
    import { createInterface } from 'node:readline';
    import { once } from 'node:events';
    const input = createInterface({input:process.stdin});
    const seen = new Set(); const pending = [];
    let tail = Promise.resolve();
    input.on('line', oid => {
      if (seen.has(oid)) { console.error('duplicate '+oid); process.exit(72); }
      seen.add(oid); pending.push(oid);
      if (pending.length < 2) return;
      const pair = pending.splice(0);
      tail = tail.then(async () => {
        for (const id of pair) {
          const frame = id+' blob 512\\n'+id.repeat(13).slice(0,512)+'\\n';
          if (!process.stdout.write(frame)) await once(process.stdout,'drain');
        }
      });
    });
    input.on('close', () => tail.then(() => { if (pending.length) process.exitCode=73; }));
  `);
  await withGitShim(
    'if [ "$1 $2" = "cat-file --batch" ]; then exec "$KEIYAKU_TEST_NODE" "$KEIYAKU_BATCH_FIXTURE"; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_TEST_NODE: process.execPath, KEIYAKU_BATCH_FIXTURE: fixture },
    async (gitPath) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const git = withGitAbortSignal(await repositoryAt(repository.path, gitPath), controller.signal);
        await withGitDecodeChannel(git, async (channel) => {
          const [first, second] = await Promise.all([
            channel.readObjects([...oids, oids[0]!]),
            channel.readObjects([oids[3]!, oids[0]!]),
          ]);
          assert.equal(first.size, oids.length);
          for (const oid of oids) assert.deepEqual(first.get(oid), {
            kind: "present", type: "blob", bytes: Buffer.from(oid.repeat(13).slice(0,512)),
          });
          assert.equal(second.get(oids[0]!), first.get(oids[0]!));
          assert.deepEqual([...second.keys()], [oids[3], oids[0]]);
        });
      } finally { clearTimeout(timer); }
    },
  );
});

test("a malformed pipelined batch rejects all waiting callers without restarting transport", async () => {
  const repository = makeGitRepository();
  const other = "1".repeat(40);
  await withGitShim(
    'if [ "$1 $2" = "cat-file --batch" ]; then printf "malformed\\n"; exit 71; fi\nexec "$KEIYAKU_REAL_GIT" "$@"',
    {}, async (gitPath) => {
      await withGitDecodeChannel(await repositoryAt(repository.path, gitPath), async (channel) => {
        const outcomes = await Promise.allSettled([
          channel.readObjects([MISSING_OID, other]), channel.readObjects([other]),
          channel.readObjects(["2".repeat(40)]),
        ]);
        for (const outcome of outcomes) assert.equal(outcome.status, "rejected");
        await assert.rejects(channel.readObjects(["3".repeat(40)]), /cat-file --batch/);
      });
    },
  );
});
