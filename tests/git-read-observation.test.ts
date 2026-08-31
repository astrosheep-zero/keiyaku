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
