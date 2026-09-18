import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  repositoryAt, writeCommit,
  writeStateCommit
} from "../src/git/repository.js";
import {
  GitPlumbingError,
  consumeGitStdout, runGitWithEnvironment,
  withGitAbortSignal
} from "../src/git/process.js";
import { makeGitRepository, waitForFile, withGitShim } from "./support/git.js";

function repositoryWithCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  return repository;
}

test("state commit construction warns while ordinary commit messages stay unchanged", async () => {
  const raw = repositoryWithCommit();
  const repository = await repositoryAt(raw.path);
  const parent = raw.run(["rev-parse", "HEAD"]).trim();
  const tree = raw.run(["rev-parse", "HEAD^{tree}"]).trim();

  const state = await writeStateCommit({ repository, tree, parent, message: "dispatch detail" });
  assert.equal(raw.run(["show", "-s", "--format=%s", state]).trim(), "keiyaku authority - do not delete or rewrite");
  assert.match(raw.run(["show", "-s", "--format=%B", state]), /\n\ndispatch detail\n/u);

  const ordinary = await writeCommit({ repository, tree, parent, message: "ordinary detail" });
  assert.equal(raw.run(["show", "-s", "--format=%s", ordinary]).trim(), "ordinary detail");
});

test("dependency provisioning links a managed worktree to the registered primary with a separate git dir", () => {
  const primary = mkdtempSync(join(tmpdir(), "keiyaku-separate-primary-"));
  const gitDir = mkdtempSync(join(tmpdir(), "keiyaku-separate-gitdir-"));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", `--separate-git-dir=${gitDir}`, primary]);
  execFileSync("git", ["-C", primary, "config", "user.name", "Keiyaku Test"]);
  execFileSync("git", ["-C", primary, "config", "user.email", "keiyaku@example.invalid"]);
  execFileSync("git", ["-C", primary, "commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const common = execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
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

test("cancelling streamed Git execution uses its capability signal", async () => {
  const repository = repositoryWithCommit();
  const started = join(mkdtempSync(join(tmpdir(), "keiyaku-git-stream-cancellation-")), "started");

  await withGitShim(
    [
      'if [ "$1" = "--version" ]; then',
      '  sh -c \'echo ready; echo $$ > "$KEIYAKU_STARTED"; trap "exit 0" TERM; while :; do sleep 10; done\'',
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_STARTED: started },
    async (gitPath) => {
      const controller = new AbortController();
      const pending = consumeGitStdout(
        withGitAbortSignal(await repositoryAt(repository.path, gitPath), controller.signal),
        ["--version"],
        () => undefined,
      );
      await waitForFile(started);
      controller.abort();
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof GitPlumbingError && /--version: git process ended with cancelled/u.test(error.message),
      );
    },
  );
});

test("a missing Git executable reports one normalized command prefix", async () => {
  const repository = repositoryWithCommit();
  const pinned = await repositoryAt(repository.path);
  const git = { ...pinned, gitPath: "/missing/keiyaku-git" };

  await assert.rejects(
    runGitWithEnvironment(git, ["--version"], undefined, { PATH: "" }),
    (error: unknown) =>
      error instanceof GitPlumbingError &&
      error.status === null &&
      error.message === "--version: spawn /missing/keiyaku-git ENOENT",
  );
});
