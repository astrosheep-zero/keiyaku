import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  commonGitDirectory,
  GitPlumbingError,
  readBlob,
  repositoryAt,
  runGit,
  runGitWithEnvironment,
  writeBlob,
} from "../src/git/repository.js";
import { worktreePath } from "../src/git/workspace.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function repositoryWithCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  return repository;
}

test("repositoryAt pins one absolute common directory for primary and linked worktrees", async () => {
  const repository = repositoryWithCommit();
  const linked = mkdtempSync(join(tmpdir(), "keiyaku-linked-"));
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);

  const primary = await repositoryAt(repository.path);
  const secondary = await repositoryAt(linked);
  const expected = resolve(realpathSync(repository.path), ".git");
  assert.equal(commonGitDirectory(primary), expected);
  assert.equal(commonGitDirectory(secondary), expected);
  assert.equal(
    worktreePath(secondary, "atlantis"),
    join(expected, "keiyaku", "wt", "atlantis"),
  );
});

test("contract path derivation reuses the common directory pinned by repositoryAt", async () => {
  const repository = repositoryWithCommit();
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-common-dir-calls-")), "calls");

  await withGitShim(
    [
      'printf "%s\\n" "$*" >> "$KEIYAKU_CALLS"',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_CALLS: calls },
    async () => {
      const pinned = await repositoryAt(repository.path);
      commonGitDirectory(pinned);
      worktreePath(pinned, "atlantis");
      worktreePath(pinned, "hogwarts");
    },
  );

  const invocations = readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command.includes("--git-common-dir")).length, 1);
});

test("async Git plumbing preserves binary stdin and stdout", async () => {
  const repository = repositoryWithCommit();
  const git = await repositoryAt(repository.path);
  const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x80, 0x41]);

  const oid = await writeBlob(git, bytes);

  assert.deepEqual(await readBlob(git, oid), bytes);
});

test("async Git plumbing preserves nonzero exit evidence", async () => {
  const repository = repositoryWithCommit();
  const git = await repositoryAt(repository.path);

  await assert.rejects(
    runGit(git, ["rev-parse", "--verify", "refs/heads/missing"]),
    (error: unknown) => error instanceof GitPlumbingError
      && error.status === 128
      && error.stderr.length > 0
      && error.pid !== null,
  );
});

test("a missing Git executable reports one normalized command prefix", async () => {
  const repository = repositoryWithCommit();
  const git = await repositoryAt(repository.path);

  await assert.rejects(
    runGitWithEnvironment(git, ["--version"], undefined, { PATH: "" }),
    (error: unknown) => error instanceof GitPlumbingError
      && error.status === null
      && error.message === "--version: spawn git ENOENT",
  );
});
