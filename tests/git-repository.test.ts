import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  repositoryAt, writeCommit,
  writeStateCommit
} from "../src/git/repository.js";
import { GitPlumbingError, consumeGitStdout, executeGit } from "../src/git/process.js";
import { repositoryWithCommit, waitForFile, withGitShim } from "./support/git.js";

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

test("managed dependency provisioning resolves through the registered primary without a local link", (t) => {
  const primary = mkdtempSync(join(tmpdir(), "keiyaku-separate-primary-"));
  const gitDir = mkdtempSync(join(tmpdir(), "keiyaku-separate-gitdir-"));
  t.after(() => {
    rmSync(primary, { recursive: true, force: true });
    rmSync(gitDir, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", `--separate-git-dir=${gitDir}`, primary]);
  execFileSync("git", ["-C", primary, "config", "user.name", "Keiyaku Test"]);
  execFileSync("git", ["-C", primary, "config", "user.email", "keiyaku@example.invalid"]);
  execFileSync("git", ["-C", primary, "commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const common = execFileSync("git", ["-C", primary, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  assert.notEqual(resolve(dirname(common)), resolve(primary));
  const shared = join(primary, "node_modules");
  const dependency = join(shared, "provision-probe");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  writeFileSync(join(dependency, "index.js"), "export default 'primary contents';\n");
  const managed = join(primary, ".keiyaku", "wt", "atlantis");
  execFileSync("git", ["-C", primary, "worktree", "add", "--quiet", "--detach", managed]);
  const provision = () => execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/provision-worktree-dependencies.js", import.meta.url))],
    { cwd: managed, encoding: "utf8" },
  );
  const local = join(managed, "node_modules");
  provision();
  provision();
  assert.equal(existsSync(local), false);

  symlinkSync(relative(managed, shared), local, "dir");
  provision();
  assert.equal(existsSync(local), false, "only the legacy link is removed");
  assert.equal(lstatSync(shared).isDirectory(), true);
  assert.equal(readFileSync(join(dependency, "index.js"), "utf8"), "export default 'primary contents';\n");
  const imported = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", [
    'import value from "provision-probe";',
    'console.log(JSON.stringify({ value, resolved: import.meta.resolve("provision-probe") }));',
  ].join("\n")], { cwd: managed, encoding: "utf8" }));
  assert.equal(imported.value, "primary contents");
  assert.equal(realpathSync(fileURLToPath(imported.resolved)), realpathSync(join(dependency, "index.js")));

  mkdirSync(local);
  writeFileSync(join(local, "sentinel"), "local contents");
  provision();
  assert.equal(readFileSync(join(local, "sentinel"), "utf8"), "local contents");
  rmSync(local, { recursive: true });
  const foreign = join(primary, "foreign-dependencies");
  mkdirSync(foreign);
  symlinkSync(relative(managed, foreign), local, "dir");
  const foreignTarget = readlinkSync(local);
  provision();
  assert.equal(lstatSync(local).isSymbolicLink(), true);
  assert.equal(readlinkSync(local), foreignTarget);
  assert.equal(realpathSync(local), realpathSync(foreign));
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
        { ...(await repositoryAt(repository.path, gitPath)), signal: controller.signal },
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
    executeGit(git, ["--version"], undefined, { PATH: "" }),
    (error: unknown) =>
      error instanceof GitPlumbingError &&
      error.status === null &&
      error.message === "--version: spawn /missing/keiyaku-git ENOENT",
  );
});
