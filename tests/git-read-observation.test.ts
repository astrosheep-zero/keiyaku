import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GIT_REF, repositoryAt } from "../src/git/repository.js";
import { withGitReadObservation, type GitReadObservation } from "../src/git/read-observation.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

const MISSING_OID = "0000000000000000000000000000000000000000";

function invocations(path: string): readonly string[] {
  const text = readFileSync(path, "utf8").trim();
  return text.length === 0 ? [] : text.split("\n");
}

test("empty Git read observation memoizes refs without starting object transport", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const log = join(repository.path, "git-read-observation.log");
  writeFileSync(log, "");

  await withGitShim(
    "printf '%s\\n' \"$*\" >> \"$KEIYAKU_GIT_OBSERVATION_LOG\"\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_GIT_OBSERVATION_LOG: log },
    () => withGitReadObservation(repositoryAt(repository.path), async (observation) => {
      assert.equal(observation.snapshot.commit, null);
      assert.equal(await observation.resolveRef("refs/heads/main"), await observation.resolveRef("refs/heads/main"));
      assert.deepEqual(await observation.readBlobs([]), new Map());
    }),
  );

  assert.deepEqual(invocations(log), [
    "worktree list --porcelain -z",
    `rev-parse --verify --quiet ${GIT_REF}`,
    "rev-parse --verify --quiet refs/heads/main",
  ]);
});

test("Git read observation returns typed missing objects and closes its batch", async () => {
  const repository = makeGitRepository();
  let retained: GitReadObservation | null = null;

  const result = await withGitReadObservation(repositoryAt(repository.path), async (observation) => {
    retained = observation;
    return (await observation.readBlobs([MISSING_OID])).get(MISSING_OID);
  });

  assert.deepEqual(result, { kind: "missing" });
  assert.notEqual(retained, null);
  await assert.rejects(retained!.readBlobs([]), /Git read observation is closed/u);
  await assert.rejects(retained!.resolveRef("refs/heads/main"), /Git read observation is closed/u);
});

test("Git read observation preserves callback failure and still closes its batch", async () => {
  const repository = makeGitRepository();
  let retained: GitReadObservation | null = null;

  await assert.rejects(
    withGitReadObservation(repositoryAt(repository.path), async (observation) => {
      retained = observation;
      await observation.readBlobs([MISSING_OID]);
      throw new Error("consumer failed");
    }),
    /consumer failed/u,
  );

  assert.notEqual(retained, null);
  await assert.rejects(retained!.readBlobs([]), /Git read observation is closed/u);
});

test("a dead shared batch is not restarted for later object reads", async () => {
  const repository = makeGitRepository();
  const log = join(repository.path, "git-read-observation-death.log");
  writeFileSync(log, "");

  await withGitShim(
    [
      "printf '%s\\n' \"$*\" >> \"$KEIYAKU_GIT_OBSERVATION_LOG\"",
      "if [ \"$1 $2\" = \"cat-file --batch\" ]; then exit 73; fi",
      "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    ].join("\n"),
    { KEIYAKU_GIT_OBSERVATION_LOG: log },
    async () => {
      await assert.rejects(
        withGitReadObservation(repositoryAt(repository.path), async (observation) => {
          await assert.rejects(observation.readBlobs([MISSING_OID]), /git cat-file --batch/u);
          await assert.rejects(observation.readBlobs([MISSING_OID]), /git cat-file --batch/u);
        }),
        /git cat-file --batch/u,
      );
    },
  );

  assert.equal(invocations(log).filter((command) => command === "cat-file --batch").length, 1);
});
