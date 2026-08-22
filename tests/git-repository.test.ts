import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  commonGitDirectory,
  readBlob,
  repositoryAt,
  writeBlob,
} from "../src/git/repository.js";
import {
  GitPlumbingError,
  consumeGitStdout,
  runGit,
  runGitWithEnvironment,
} from "../src/git/process.js";
import { worktreePath } from "../src/git/workspace.js";
import { gitExecutablePath, makeGitRepository, withGitShim } from "./support/git.js";

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
    join(primary.primaryWorktree, ".keiyaku", "wt", "atlantis"),
  );
  assert.equal(worktreePath(secondary, "atlantis"), worktreePath(primary, "atlantis"));
});

test("dependency provisioning links a managed worktree to the registered primary with a separate git dir", () => {
  const primary = mkdtempSync(join(tmpdir(), "keiyaku-separate-primary-"));
  const gitDir = mkdtempSync(join(tmpdir(), "keiyaku-separate-gitdir-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", `--separate-git-dir=${gitDir}`, primary]);
  execFileSync("git", ["-C", primary, "config", "user.name", "Keiyaku Test"]);
  execFileSync("git", ["-C", primary, "config", "user.email", "keiyaku@example.invalid"]);
  execFileSync("git", ["-C", primary, "commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const common = execFileSync(
    "git",
    ["-C", primary, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  assert.notEqual(resolve(dirname(common)), resolve(primary));
  mkdirSync(join(primary, "node_modules"));
  const managed = join(primary, ".keiyaku", "wt", "atlantis");
  execFileSync("git", ["-C", primary, "worktree", "add", "--quiet", "--detach", managed]);
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/provision-worktree-dependencies.js", import.meta.url))],
    { cwd: managed, encoding: "utf8" },
  );
  const linked = join(managed, "node_modules");
  assert.equal(lstatSync(linked).isSymbolicLink(), true);
  assert.equal(realpathSync(linked), realpathSync(join(primary, "node_modules")));
  assert.notEqual(resolve(managed, readlinkSync(linked)), resolve(dirname(common), "node_modules"));
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
    async (gitPath) => {
      const pinned = await repositoryAt(repository.path, gitPath);
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
  const pinned = await repositoryAt(repository.path);
  const git = { ...pinned, gitPath: "/missing/keiyaku-git" };

  await assert.rejects(
    runGitWithEnvironment(git, ["--version"], undefined, { PATH: "" }),
    (error: unknown) => error instanceof GitPlumbingError
      && error.status === null
      && error.message === "--version: spawn /missing/keiyaku-git ENOENT",
  );
});

test("Repo capability pins an absolute Git executable across normal and streamed runners", async () => {
  const repository = repositoryWithCommit();
  const realGit = gitExecutablePath();
  const git = await repositoryAt(repository.path, realGit);
  assert.match((await runGit(git, ["--version"])).toString("utf8"), /^git version /u);
  const chunks: Buffer[] = [];
  await consumeGitStdout(git, ["--version"], (chunk) => chunks.push(chunk));
  assert.match(Buffer.concat(chunks).toString("utf8"), /^git version /u);
  assert.match(
    (await runGitWithEnvironment(git, ["--version"], undefined, { PATH: "" })).toString("utf8"),
    /^git version /u,
  );
});
