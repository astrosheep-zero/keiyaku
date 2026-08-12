import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import { commonGitDirectory, repositoryAt } from "../src/git/repository.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function repositoryWithCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  return repository;
}

test("repositoryAt pins one absolute common directory for primary and linked worktrees", () => {
  const repository = repositoryWithCommit();
  const linked = mkdtempSync(join(tmpdir(), "keiyaku-linked-"));
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);

  const primary = repositoryAt(repository.path);
  const secondary = repositoryAt(linked);
  const expected = resolve(realpathSync(repository.path), ".git");
  assert.equal(commonGitDirectory(primary), expected);
  assert.equal(commonGitDirectory(secondary), expected);
  assert.equal(
    deliveryWorktreePath(secondary, contractId("kei/common-directory")),
    join(expected, "keiyaku", "wt", "kei-common-directory"),
  );
});

test("contract path derivation reuses the common directory pinned by repositoryAt", () => {
  const repository = repositoryWithCommit();
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-common-dir-calls-")), "calls");

  withGitShim(
    [
      'printf "%s\\n" "$*" >> "$KEIYAKU_CALLS"',
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_CALLS: calls },
    () => {
      const pinned = repositoryAt(repository.path);
      commonGitDirectory(pinned);
      deliveryWorktreePath(pinned, contractId("kei/first"));
      deliveryWorktreePath(pinned, contractId("kei/second"));
    },
  );

  const invocations = readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command.includes("--git-common-dir")).length, 1);
});
