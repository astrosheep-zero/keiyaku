import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withGitAbortSignal } from "../src/git/process.js";
import { GIT_REF, repositoryAt } from "../src/git/repository.js";
import { withGitDecodeChannel, withGitReadObservation, type GitReadObservation } from "../src/git/read-observation.js";
import { gitExecutablePath, makeGitRepository, waitForFile, withGitShim } from "./support/git.js";

const MISSING_OID = "0000000000000000000000000000000000000000";

function invocations(path: string): readonly string[] {
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}

test("empty Git read observation memoizes refs without starting object transport", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const log = join(repository.path, "git-read-observation.log");
  writeFileSync(log, "");

  await withGitShim(
    'printf \'%s\\n\' "$*" >> "$KEIYAKU_GIT_OBSERVATION_LOG"\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_GIT_OBSERVATION_LOG: log },
    async (gitPath) => {
      const git = await repositoryAt(repository.path, gitPath);
      return withGitDecodeChannel(git, (channel) =>
        withGitReadObservation(git, channel, async (observation) => {
          assert.equal(observation.snapshot.commit, null);
          assert.equal(
            await observation.resolveRef("refs/heads/main"),
            await observation.resolveRef("refs/heads/main"),
          );
          assert.deepEqual(await observation.readBlobs([]), new Map());
        }),
      );
    },
  );

  assert.deepEqual(invocations(log), [
    "worktree list --porcelain -z",
    "rev-parse --path-format=absolute --show-toplevel",
    "rev-parse --path-format=absolute --git-common-dir",
    `rev-parse --verify --quiet ${GIT_REF}`,
    "rev-parse --verify --quiet refs/heads/main",
  ]);
});

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

test("Git read observation uses the pinned executable for its batch", async () => {
  const repository = makeGitRepository();
  const gitPath = gitExecutablePath();
  const git = await repositoryAt(repository.path, gitPath);
  const result = await withGitDecodeChannel(git, (channel) =>
    withGitReadObservation(git, channel, async (observation) =>
      (await observation.readBlobs([MISSING_OID])).get(MISSING_OID),
    ),
  );
  assert.deepEqual(result, { kind: "missing" });
});

test("Git read observation preserves callback failure over a simultaneous close failure", async () => {
  const repository = makeGitRepository();
  let retained: GitReadObservation | null = null;

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
              retained = observation;
              await observation.readBlobs([MISSING_OID]);
              throw new Error("consumer failed");
            }),
          );
        })(),
        /consumer failed/u,
      ),
  );

  assert.notEqual(retained, null);
  await assert.rejects(retained!.readBlobs([]), /Git read observation is closed/u);
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

test("a dead shared batch is not restarted for later object reads", async (t) => {
  if (process.platform !== "win32") {
    const originalKill = process.kill;
    t.mock.method(process, "kill", ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid < 0 && signal !== 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return originalKill(pid, signal as NodeJS.Signals);
    }) as typeof process.kill);
  }
  const repository = makeGitRepository();
  const log = join(repository.path, "git-read-observation-death.log");
  writeFileSync(log, "");

  await withGitShim(
    [
      'printf \'%s\\n\' "$*" >> "$KEIYAKU_GIT_OBSERVATION_LOG"',
      'if [ "$1 $2" = "cat-file --batch" ]; then exit 73; fi',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_GIT_OBSERVATION_LOG: log },
    async (gitPath) => {
      const git = await repositoryAt(repository.path, gitPath);
      await withGitDecodeChannel(git, (channel) =>
        withGitReadObservation(git, channel, async (observation) => {
          await assert.rejects(observation.readBlobs([MISSING_OID]), (error: Error) => {
            assert.match(error.message, /git cat-file --batch/u);
            assert.doesNotMatch(error.message, /EPERM/u);
            return true;
          });
          await assert.rejects(observation.readBlobs([MISSING_OID]), (error: Error) => {
            assert.match(error.message, /git cat-file --batch/u);
            assert.doesNotMatch(error.message, /EPERM/u);
            return true;
          });
        }),
      );
    },
  );

  assert.equal(invocations(log).filter((command) => command === "cat-file --batch").length, 1);
});


test("batch cursor copies large binary objects linearly and preserves retained bytes", async (t) => {
  const repository = makeGitRepository();
  const large = Buffer.alloc(8 * 1024 * 1024);
  for (let index = 0; index < large.length; index += 1) large[index] = index % 251;
  const values = [large, Buffer.alloc(0), Buffer.from("next\0object\n", "utf8")];
  const oids = values.map((bytes) => repository.run(["hash-object", "-w", "--stdin"], bytes).trim());
  const git = await repositoryAt(repository.path);
  const concat = Buffer.concat;
  let concatenatedBytes = 0;
  t.mock.method(Buffer, "concat", ((parts: readonly Uint8Array[], length?: number) => {
    concatenatedBytes += length ?? parts.reduce((total, part) => total + part.length, 0);
    return concat(parts, length);
  }) as typeof Buffer.concat);
  await withGitDecodeChannel(git, async (channel) => {
    const first = await channel.readObjects([oids[0]!]);
    const rest = await channel.readObjects([...oids, MISSING_OID]);
    for (const [index, oid] of oids.entries()) {
      assert.deepEqual(rest.get(oid), { kind: "present", type: "blob", bytes: values[index] });
    }
    assert.equal(first.get(oids[0]!), rest.get(oids[0]!), "later reads do not overwrite cached object bytes");
    assert.deepEqual(rest.get(MISSING_OID), { kind: "missing" });
  });
  assert.ok(concatenatedBytes <= large.length * 2,
    `batch parsing copied ${concatenatedBytes} bytes through concatenation for ${large.length} input bytes`);
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
