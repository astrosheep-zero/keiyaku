import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  repositoryAt, updateGitTree, writeBlob, writeCommit,
  writeStateCommit, type TreeChange
} from "../src/git/repository.js";
import { GitPlumbingError, executeGit } from "../src/git/process.js";
import { repositoryWithCommit, withGitShim } from "./support/git.js";

test("native private-tree publication preserves unknown leaves and literal paths while pruning empty directories", async () => {
  const raw = repositoryWithCommit();
  const repository = await repositoryAt(raw.path);
  const blob = await writeBlob(repository, "unknown authority\n");
  const replacement = await writeBlob(repository, "new authority\n");
  const commit = raw.run(["rev-parse", "HEAD"]).trim();
  const leaves = new Map<string, TreeChange>([
    ["authority/journal", { oid: blob }],
    ["authority/delete", { oid: blob }],
    ["unknown/executable", { oid: blob, mode: "100755" }],
    ["unknown/symlink", { oid: blob, mode: "120000" }],
    ["unknown/gitlink", { oid: commit, mode: "160000", type: "commit" }],
    ["unknown/tab\tline\nback\\slash", { oid: blob }],
    ["unknown/:(literal)*[name]", { oid: blob }],
  ]);
  const initial = await updateGitTree(repository, null, leaves);
  assert.equal(raw.run(["show", `${initial}:authority/journal`]), "unknown authority\n");
  const empty = raw.run(["mktree"], "").trim();
  const base = raw.run(["mktree", "-z"],
    raw.run(["ls-tree", "-z", initial]) + `040000 tree ${empty}\tempty\0`).trim();
  const before = raw.run(["ls-tree", "-r", "-z", base]).split("\0").filter(Boolean);
  const result = await updateGitTree(repository, base, new Map([
    ["authority/journal", { oid: replacement }],
    ["authority/delete", null],
    ["unknown/:(literal)*[name]", { oid: replacement, mode: "100755" }],
  ]));
  const after = raw.run(["ls-tree", "-r", "-z", result]).split("\0").filter(Boolean);
  const preserved = (records: readonly string[]) => records.filter((record) => {
    const path = record.slice(record.indexOf("\t") + 1);
    return !["authority/journal", "authority/delete", "unknown/:(literal)*[name]"].includes(path);
  });
  assert.deepEqual(preserved(after), preserved(before));
  assert.equal(raw.run(["show", `${result}:authority/journal`]), "new authority\n");
  assert.equal(after.some((record) => record.endsWith("\tauthority/delete")), false);
  assert.ok(after.includes(`100755 blob ${replacement}\tunknown/:(literal)*[name]`));
  assert.equal(raw.run(["ls-tree", result, "--", "empty"]), "");
  assert.equal(await updateGitTree(repository, null, new Map()), empty);
});

test("native private-tree deletion uses the repository's SHA-256 zero OID and retires successful custody", async (t) => {
  const path = mkdtempSync(join(tmpdir(), "keiyaku-sha256-tree-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", "--object-format=sha256", path]);
  const repository = await repositoryAt(path);
  const blob = await writeBlob(repository, "authority\n");
  assert.equal(blob.length, 64);
  const receipt = join(path, ".git", "writer-index");
  await withGitShim([
    'if [ -n "$GIT_INDEX_FILE" ]; then printf "%s" "$GIT_INDEX_FILE" > "$KEIYAKU_INDEX_RECEIPT"; fi',
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n"), { KEIYAKU_INDEX_RECEIPT: receipt }, async (gitPath) => {
    const git = { ...repository, gitPath };
    const initial = await updateGitTree(git, null, new Map([["authority", { oid: blob }]]));
    assert.equal(initial.length, 64);
    assert.equal(existsSync(dirname(readFileSync(receipt, "utf8"))), false);
    const result = await updateGitTree(git, initial, new Map([["authority", null]]));
    assert.equal(result.length, 64);
    assert.equal(existsSync(dirname(readFileSync(receipt, "utf8"))), false);
    assert.equal(execFileSync("git", ["-C", path, "ls-tree", "-z", result], { encoding: "utf8" }), "");
  });
});

test("native private-tree writes reject file/directory conversions before any index records", async () => {
  const raw = repositoryWithCommit();
  const repository = await repositoryAt(raw.path);
  const blob = await writeBlob(repository, "authority\n");
  const base = await updateGitTree(repository, null, new Map([
    ["authority/unaddressed", { oid: blob }],
    ["leaf", { oid: blob }],
    ["wild*card/child", { oid: blob }],
    ["wildXcard", { oid: blob }],
  ]));
  for (const changes of [
    new Map<string, TreeChange>([["authority", { oid: blob }]]),
    new Map<string, TreeChange>([["leaf/child", { oid: blob }]]),
    new Map<string, TreeChange>([["leaf", null], ["leaf/child", { oid: blob }]]),
    new Map<string, TreeChange>([["authority/unaddressed", null], ["authority", { oid: blob }]]),
    new Map<string, TreeChange>([["wild*card", { oid: blob }]]),
  ]) {
    await assert.rejects(updateGitTree(repository, base, changes), /both file and directory/u);
    assert.equal(raw.run(["show", `${base}:authority/unaddressed`]), "authority\n");
  }
  for (const changes of [
    new Map<string, TreeChange>([["../invalid", { oid: blob }]]),
    new Map<string, TreeChange>([["valid", { oid: "bad\nrecord" }]]),
    new Map<string, TreeChange>([["valid", { oid: blob, mode: "040000", type: "tree" }]]),
  ]) {
    await assert.rejects(updateGitTree(repository, base, changes), /invalid|not a Git object ID/u);
  }
});

for (const command of ["read-tree", "update-index", "write-tree"]) {
  test(`failed private-tree ${command} retires its private index and preserves cleanup failures`, async (t) => {
    const raw = repositoryWithCommit();
    const repository = await repositoryAt(raw.path);
    const blob = await writeBlob(repository, "authority\n");
    const receipt = join(raw.path, ".git", "private-index");
    const cleanupError = new Error("independent cleanup failure");
    const originalRm = fsPromises.rm;
    let failCleanup = false;
    const mock = t.mock.method(fsPromises, "rm", async (...args: Parameters<typeof originalRm>) => {
      if (failCleanup && existsSync(receipt) && String(args[0]) === dirname(readFileSync(receipt, "utf8"))) {
        throw cleanupError;
      }
      return originalRm(...args);
    });
    syncBuiltinESMExports();
    try {
      await withGitShim([
        'for argument in "$@"; do',
        '  if [ "$argument" = "$KEIYAKU_FAIL_COMMAND" ]; then',
        '    printf "%s" "$GIT_INDEX_FILE" > "$KEIYAKU_INDEX_RECEIPT"',
        '    : > "${GIT_INDEX_FILE}.lock"',
        '    echo "private writer failed" >&2',
        '    exit 17',
        '  fi',
        'done',
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"), { KEIYAKU_FAIL_COMMAND: command, KEIYAKU_INDEX_RECEIPT: receipt }, async (gitPath) => {
        const git = { ...repository, gitPath };
        const changes = new Map([["authority", { oid: blob }]]);
        await assert.rejects(updateGitTree(git, null, changes), (error: unknown) =>
          error instanceof GitPlumbingError && error.status === 17);
        assert.equal(existsSync(dirname(readFileSync(receipt, "utf8"))), false);
        failCleanup = true;
        await assert.rejects(updateGitTree(git, null, changes), (error: unknown) =>
          error instanceof AggregateError && error.errors[0] instanceof GitPlumbingError &&
          error.errors[0].status === 17 && error.errors[1] === cleanupError);
      });
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
      if (existsSync(receipt)) await originalRm(dirname(readFileSync(receipt, "utf8")), { recursive: true, force: true });
    }
  });
}

test("private-tree cancellation awaits child exit before retiring the index", async () => {
  const raw = repositoryWithCommit();
  const repository = await repositoryAt(raw.path);
  const blob = await writeBlob(repository, "authority\n");
  const script = join(raw.path, ".git", "cancel-writer.cjs");
  const receipt = join(raw.path, ".git", "writer-started");
  const retired = join(raw.path, ".git", "writer-retired");
  writeFileSync(script, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args.includes('update-index')) {",
    "  process.stdin.resume();",
    "  process.on('SIGTERM', () => {",
    "    fs.writeFileSync(process.env.KEIYAKU_RETIRED, String(fs.existsSync(process.env.GIT_INDEX_FILE)));",
    "    process.exit(0);",
    "  });",
    "  fs.writeFileSync(process.env.KEIYAKU_RECEIPT, JSON.stringify({ pid: process.pid, index: process.env.GIT_INDEX_FILE }));",
    "  setInterval(() => {}, 1000);",
    "} else {",
    "  process.stdout.write(require('node:child_process').execFileSync(process.env.KEIYAKU_REAL_GIT, args));",
    "}",
  ].join("\n"));
  await withGitShim('exec "$KEIYAKU_TEST_NODE" "$KEIYAKU_TEST_SCRIPT" "$@"', {
    KEIYAKU_TEST_NODE: process.execPath, KEIYAKU_TEST_SCRIPT: script,
    KEIYAKU_RECEIPT: receipt, KEIYAKU_RETIRED: retired,
  }, async (gitPath) => {
    const controller = new AbortController();
    const pending = updateGitTree({ ...repository, gitPath, signal: controller.signal }, null,
      new Map([["authority", { oid: blob }]]));
    void pending.catch(() => undefined);
    try {
      for (let attempt = 0; attempt < 200 && !existsSync(receipt); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(existsSync(receipt), true, "writer must publish its private index before cancellation");
    } finally {
      controller.abort();
      await assert.rejects(pending, GitPlumbingError);
    }
  });
  const started = JSON.parse(readFileSync(receipt, "utf8")) as { pid: number; index: string };
  assert.equal(readFileSync(retired, "utf8"), "true");
  assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
  assert.equal(existsSync(dirname(started.index)), false);
});

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
