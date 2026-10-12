import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { GitPlumbingError } from "../src/git/process.js";
import { captureWorkspaceTree, observeWorkspace, withPrivateGitIndex } from "../src/git/workspace.js";
import { cachedRepositoryAt, withGitShim, type TestGitRepository } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";

function custody(repository: TestGitRepository, workspace = repository.path) {
  const index = repository.run(["-C", workspace, "rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const head = repository.run(["-C", workspace, "rev-parse", "HEAD"]).trim();
  return { index: readFileSync(index), head };
}

async function capturePreservingCustody(repository: TestGitRepository, workspace = repository.path) {
  const before = custody(repository, workspace);
  const captured = await captureWorkspaceTree(await cachedRepositoryAt(repository.path), workspace);
  assert.deepEqual(custody(repository, workspace), before);
  assert.equal(captured.head, before.head);
  return captured;
}

test("fresh capture takes final staged, unstaged, deleted and untracked bytes", async () => {
  const repository = repositoryWithMain({ files: { "tracked.txt": "base\n", "deleted.txt": "delete\n" } });
  writeFileSync(join(repository.path, "tracked.txt"), "staged\n");
  repository.run(["add", "tracked.txt"]);
  writeFileSync(join(repository.path, "tracked.txt"), "final\n");
  rmSync(join(repository.path, "deleted.txt"));
  writeFileSync(join(repository.path, "untracked.txt"), "new\n");

  const captured = await capturePreservingCustody(repository);

  assert.equal(captured.dirty, true);
  assert.equal(repository.run(["show", `${captured.tree}:tracked.txt`]), "final\n");
  assert.equal(repository.run(["show", `${captured.tree}:untracked.txt`]), "new\n");
  assert.equal(repository.run(["ls-tree", "--name-only", captured.tree]), "tracked.txt\nuntracked.txt\n");
});

test("removed-filter history captures raw worktree bytes instead of cached converted bytes", async () => {
  const repository = repositoryWithMain();
  repository.run(["config", "filter.capture.clean", "sed 's/RAW/OLD/g'"]);
  writeFileSync(join(repository.path, ".gitattributes"), "payload.txt filter=capture\n");
  writeFileSync(join(repository.path, "payload.txt"), "RAW\n");
  repository.run(["add", "--all"]);
  repository.run(["commit", "--quiet", "-m", "filtered payload"]);
  assert.equal(repository.run(["show", "HEAD:payload.txt"]), "OLD\n");
  utimesSync(join(repository.path, "payload.txt"), new Date(1_000_000), new Date(1_000_000));
  repository.run(["update-index", "--refresh"]);
  rmSync(join(repository.path, ".gitattributes"));
  repository.run(["config", "--unset", "filter.capture.clean"]);

  const captured = await capturePreservingCustody(repository);

  assert.deepEqual(captured.changes.unstaged, [".gitattributes"]);
  assert.equal(repository.run(["show", `${captured.tree}:payload.txt`]), "RAW\n");
});

test("fresh capture excludes a newly force-staged ignored path", async () => {
  const repository = repositoryWithMain({ files: { ".gitignore": "ignored.txt\n" } });
  writeFileSync(join(repository.path, "ignored.txt"), "force-staged\n");
  repository.run(["add", "--force", "ignored.txt"]);

  const captured = await capturePreservingCustody(repository);

  assert.deepEqual(captured.changes.staged, ["ignored.txt"]);
  assert.equal(repository.run(["ls-tree", "--name-only", captured.tree]), ".gitignore\n");
  assert.equal(repository.run(["show", ":ignored.txt"]), "force-staged\n");
});

for (const flag of ["skip-worktree", "assume-unchanged"]) {
  test(`fresh capture reads ${flag} edits with an independent dirty trigger`, async () => {
    const repository = repositoryWithMain({ files: { "hidden.txt": "base\n" } });
    repository.run(["update-index", `--${flag}`, "hidden.txt"]);
    writeFileSync(join(repository.path, "hidden.txt"), "hidden edit\n");
    writeFileSync(join(repository.path, "trigger.txt"), "dirty trigger\n");

    const captured = await capturePreservingCustody(repository);

    assert.deepEqual(captured.changes.unstaged, []);
    assert.deepEqual(captured.changes.untracked, ["trigger.txt"]);
    assert.equal(repository.run(["show", `${captured.tree}:hidden.txt`]), "hidden edit\n");
  });
}

test("unstaged conflict resolution is captured while the real unmerged index is preserved", async () => {
  const repository = repositoryWithMain({ files: { "conflict.txt": "base\n" } });
  repository.run(["checkout", "--quiet", "-b", "other"]);
  writeFileSync(join(repository.path, "conflict.txt"), "other\n");
  repository.run(["commit", "--quiet", "-am", "other"]);
  repository.run(["checkout", "--quiet", "main"]);
  writeFileSync(join(repository.path, "conflict.txt"), "main\n");
  repository.run(["commit", "--quiet", "-am", "main"]);
  assert.throws(() => repository.run(["merge", "--no-edit", "other"]));
  const unmerged = repository.run(["ls-files", "--unmerged"]);
  assert.notEqual(unmerged, "");
  writeFileSync(join(repository.path, "conflict.txt"), "resolved without staging\n");

  const captured = await capturePreservingCustody(repository);

  assert.equal(repository.run(["show", `${captured.tree}:conflict.txt`]), "resolved without staging\n");
  assert.equal(repository.run(["ls-files", "--unmerged"]), unmerged);
});

test("capture selects the linked worktree and preserves both real indices and heads", async () => {
  const repository = repositoryWithMain({ files: { "tracked.txt": "base\n" } });
  const workspace = join(repository.path, "linked");
  repository.run(["worktree", "add", "--quiet", "--detach", workspace]);
  writeFileSync(join(repository.path, "tracked.txt"), "primary edit\n");
  repository.run(["add", "tracked.txt"]);
  writeFileSync(join(workspace, "tracked.txt"), "linked edit\n");
  repository.run(["-C", workspace, "add", "tracked.txt"]);
  const primary = custody(repository);

  const captured = await capturePreservingCustody(repository, workspace);

  assert.equal(repository.run(["show", `${captured.tree}:tracked.txt`]), "linked edit\n");
  assert.deepEqual(custody(repository), primary);
});

test("capture creates no shared-index output when split index is enabled", async () => {
  const repository = repositoryWithMain({ files: { "tracked.txt": "base\n" } });
  repository.run(["config", "core.splitIndex", "true"]);
  repository.run(["update-index", "--split-index"]);
  const gitDirectory = join(repository.path, ".git");
  const sharedBefore = readdirSync(gitDirectory).filter((name) => name.startsWith("sharedindex."));
  assert.ok(sharedBefore.length > 0);
  const sharedBytes = sharedBefore.map((name) => readFileSync(join(gitDirectory, name)));
  writeFileSync(join(repository.path, "tracked.txt"), "edited\n");

  const captured = await capturePreservingCustody(repository);

  assert.equal(repository.run(["show", `${captured.tree}:tracked.txt`]), "edited\n");
  assert.deepEqual(
    readdirSync(gitDirectory).filter((name) => name.startsWith("sharedindex.")),
    sharedBefore,
  );
  assert.deepEqual(
    sharedBefore.map((name) => readFileSync(join(gitDirectory, name))),
    sharedBytes,
  );
});

test("status observation and clean capture do not refresh caller index bytes", async () => {
  const repository = repositoryWithMain({ files: { "tracked.txt": "base\n" } });
  utimesSync(join(repository.path, "tracked.txt"), new Date(1_000_000), new Date(1_000_000));
  const before = custody(repository);
  const git = await cachedRepositoryAt(repository.path);

  const observation = await observeWorkspace(git, { kind: "worktree", path: repository.path }, repository.path);
  assert.equal(observation.kind, "clean");
  assert.deepEqual(custody(repository), before);
  const captured = await capturePreservingCustody(repository);
  assert.equal(captured.dirty, false);

  // Prove the stale-stat fixture would let ordinary status rewrite the real index.
  repository.run(["status", "--porcelain=v2"]);
  assert.notDeepEqual(custody(repository).index, before.index);
});

test("read-tree uses the captured HEAD oid even if the ref moves during observation", async () => {
  const repository = repositoryWithMain({ files: { ".gitignore": "ignored.txt\n", "base.txt": "base\n" } });
  const head = repository.run(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository.path, "ignored.txt"), "only tracked by later HEAD\n");
  repository.run(["add", "--force", "ignored.txt"]);
  repository.run(["commit", "--quiet", "-m", "later HEAD"]);
  const later = repository.run(["rev-parse", "HEAD"]).trim();
  repository.run(["update-ref", "HEAD", head]);
  writeFileSync(join(repository.path, "trigger.txt"), "trigger\n");
  const before = custody(repository).index;
  const captured = await withGitShim(
    [
      'for argument in "$@"; do',
      '  if [ "$argument" = "status" ]; then',
      '    "$KEIYAKU_REAL_GIT" -C "$KEIYAKU_TEST_REPO" update-ref HEAD "$KEIYAKU_LATER_HEAD"',
      "  fi",
      "done",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_TEST_REPO: repository.path, KEIYAKU_LATER_HEAD: later },
    async (gitPath) => captureWorkspaceTree(await cachedRepositoryAt(repository.path, gitPath), repository.path),
  );

  assert.equal(captured.head, head);
  assert.equal(repository.run(["rev-parse", "HEAD"]).trim(), later);
  assert.equal(repository.run(["ls-tree", "--name-only", captured.tree]), ".gitignore\nbase.txt\ntrigger.txt\n");
  assert.deepEqual(custody(repository).index, before);
});

for (const command of ["read-tree", "add", "write-tree"]) {
  test(`a failed ${command} removes its private index directory and propagates the Git error`, async () => {
    const repository = repositoryWithMain({ files: { "tracked.txt": "base\n" } });
    writeFileSync(join(repository.path, "tracked.txt"), "edited\n");
    const before = custody(repository);
    const receipt = join(repository.path, ".git", "capture-index");
    await withGitShim(
      [
        'for argument in "$@"; do',
        '  if [ "$argument" = "$KEIYAKU_FAIL_COMMAND" ]; then',
        '    printf "%s" "$GIT_INDEX_FILE" > "$KEIYAKU_INDEX_RECEIPT"',
        '    : > "${GIT_INDEX_FILE}.lock"',
        '    printf "forced capture failure\\n" >&2',
        "    exit 17",
        "  fi",
        "done",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      { KEIYAKU_FAIL_COMMAND: command, KEIYAKU_INDEX_RECEIPT: receipt },
      async (gitPath) => {
        await assert.rejects(
          captureWorkspaceTree(await cachedRepositoryAt(repository.path, gitPath), repository.path),
          (error: unknown) => error instanceof GitPlumbingError && error.status === 17,
        );
      },
    );
    assert.equal(existsSync(dirname(readFileSync(receipt, "utf8"))), false);
    assert.deepEqual(custody(repository), before);
  });
}

test("cancellation retires the capture child before removing its private index", async () => {
  const repository = repositoryWithMain({ files: { "tracked.txt": "base\n" } });
  writeFileSync(join(repository.path, "tracked.txt"), "edited\n");
  const before = custody(repository);
  const script = join(repository.path, ".git", "cancel-capture.cjs");
  const receipt = join(repository.path, ".git", "capture-started");
  const retired = join(repository.path, ".git", "capture-retired");
  writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args.includes('add')) {",
      "  process.on('SIGTERM', () => {",
      "    fs.writeFileSync(process.env.KEIYAKU_RETIRED, String(fs.existsSync(process.env.GIT_INDEX_FILE)));",
      "    process.exit(0);",
      "  });",
      "  fs.writeFileSync(process.env.KEIYAKU_RECEIPT, JSON.stringify({pid: process.pid, index: process.env.GIT_INDEX_FILE}));",
      "  setInterval(() => {}, 1000);",
      "} else {",
      "  process.stdout.write(require('node:child_process').execFileSync(process.env.KEIYAKU_REAL_GIT, args));",
      "}",
    ].join("\n"),
  );
  const controller = new AbortController();
  await withGitShim(
    'exec "$KEIYAKU_TEST_NODE" "$KEIYAKU_TEST_SCRIPT" "$@"',
    {
      KEIYAKU_TEST_NODE: process.execPath,
      KEIYAKU_TEST_SCRIPT: script,
      KEIYAKU_RECEIPT: receipt,
      KEIYAKU_RETIRED: retired,
    },
    async (gitPath) => {
      const git = { ...(await cachedRepositoryAt(repository.path, gitPath)), signal: controller.signal };
      const pending = captureWorkspaceTree(git, repository.path);
      void pending.catch(() => undefined);
      try {
        for (let attempt = 0; attempt < 200 && !existsSync(receipt); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(existsSync(receipt), true, "capture child must publish its index before cancellation");
      } finally {
        controller.abort();
        await assert.rejects(pending, GitPlumbingError);
      }
    },
  );
  const started = JSON.parse(readFileSync(receipt, "utf8")) as { pid: number; index: string };
  assert.equal(readFileSync(retired, "utf8"), "true");
  assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
  assert.equal(existsSync(dirname(started.index)), false);
  assert.deepEqual(custody(repository), before);
});

test("private index cleanup retains both capture and cleanup failures", async (t) => {
  const captureError = new Error("capture failed");
  const cleanupError = new Error("cleanup failed");
  const originalRm = fsPromises.rm;
  let directory = "";
  const mock = t.mock.method(fsPromises, "rm", async (...args: Parameters<typeof originalRm>) => {
    if (String(args[0]) === directory) throw cleanupError;
    return originalRm(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withPrivateGitIndex(({ GIT_INDEX_FILE }) => {
        directory = dirname(GIT_INDEX_FILE);
        assert.equal(existsSync(GIT_INDEX_FILE), false);
        throw captureError;
      }),
      (error: unknown) =>
        error instanceof AggregateError && error.errors[0] === captureError && error.errors[1] === cleanupError,
    );
    assert.equal(existsSync(directory), true);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    await originalRm(directory, { recursive: true, force: true });
  }
});
