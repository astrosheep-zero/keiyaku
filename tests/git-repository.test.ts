import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  commonGitDirectory,
  DELIVERY_REF_NAMESPACE,
  GIT_REF,
  isKeiyakuOwnedRef,
  readBlob,
  readRefs,
  repositoryAt,
  writeBlob,
  writeCommit,
  writeStateCommit,
} from "../src/git/repository.js";
import {
  GitPlumbingError,
  consumeGitStdout,
  runGit,
  runGitPipe,
  runGitWithEnvironment,
  withGitAbortSignal,
} from "../src/git/process.js";
import { captureWorkspaceTree, worktreePath } from "../src/git/workspace.js";
import { worktreeChangeId } from "../src/git/integration.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { gitExecutablePath, makeGitRepository, protocolContractId, waitForFile, withGitShim } from "./support/git.js";

function repositoryWithCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  return repository;
}

test("change identity streams a large binary patch without retaining the patch in Node", async (t) => {
  const repository = repositoryWithCommit();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const git = await repositoryAt(repository.path);
  const start = mintSnapshotId(repository.run(["rev-parse", "HEAD"]).trim());
  const input = {
    contractId: protocolContractId("streamed-identity"),
    coordinates: { start, workspace: "worktree" as const },
  };
  assert.equal(await worktreeChangeId(git, input, await captureWorkspaceTree(git, repository.path)), "0".repeat(40));
  writeFileSync(join(repository.path, "payload.bin"), randomBytes(2 * 1024 * 1024));
  const tender = await captureWorkspaceTree(git, repository.path);
  const patch = execFileSync("git", ["-C", repository.path, "diff", "--binary", "--full-index", start, tender.tree], {
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ok(patch.length > 2 * 1024 * 1024);
  const expected = repository.run(["patch-id", "--verbatim"], patch).trim().split(/\s/u)[0];
  let concatenated = 0;
  const concat = Buffer.concat;
  const spy = t.mock.method(Buffer, "concat", (chunks: readonly Uint8Array[], length?: number) => {
    concatenated += length ?? chunks.reduce((size, chunk) => size + chunk.length, 0);
    return concat(chunks, length);
  });
  try {
    assert.equal(await worktreeChangeId(git, input, tender), expected);
    assert.ok(concatenated < 128 * 1024, `retained ${concatenated} bytes for a small identity`);
  } finally {
    spy.mock.restore();
  }
});

test("a Git pipe rejects either failed command even if its sink emits an identity", async (t) => {
  const repository = repositoryWithCommit();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const git = { ...(await repositoryAt(repository.path)), gitPath: process.execPath };
  await assert.rejects(
    runGitPipe(
      git,
      ["-e", "process.stdout.write('partial patch'); process.stderr.write('source failed'); process.exitCode = 17"],
      ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('a'.repeat(40)))"],
    ),
    (error: unknown) => error instanceof GitPlumbingError && error.status === 17,
  );
  const pidFile = join(repository.path, "source-pid");
  await assert.rejects(
    runGitPipe(
      git,
      [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        process.stdout.on('error', () => {}); setInterval(() => {}, 1000);
        const chunk = Buffer.alloc(65536); function write() { while (process.stdout.write(chunk)) {} }
        process.stdout.on('drain', write); write();`,
      ],
      ["-e", "process.stdin.once('data', () => { process.stdout.write('a'.repeat(40)); process.exit(23) })"],
    ),
    GitPlumbingError,
  );
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("cancelling a Git pipe retires both live commands before rejection", async (t) => {
  const repository = repositoryWithCommit();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const controller = new AbortController();
  const git = { ...(await repositoryAt(repository.path)), gitPath: process.execPath, signal: controller.signal };
  const files = [join(repository.path, "source-pid"), join(repository.path, "sink-pid")];
  const args = files.map((path) => [
    "-e",
    `require('node:fs').writeFileSync(${JSON.stringify(path)}, String(process.pid)); setInterval(() => {}, 1000)`,
  ]);
  const pending = runGitPipe(git, args[0]!, args[1]!);
  void pending.catch(() => undefined);
  try {
    await Promise.all(files.map(waitForFile));
  } finally {
    controller.abort();
  }
  await assert.rejects(pending, GitPlumbingError);
  for (const file of files) assert.throws(() => process.kill(Number(readFileSync(file, "utf8")), 0), { code: "ESRCH" });
  await assert.rejects(
    runGitPipe({ ...(await repositoryAt(repository.path)), gitPath: "/missing/keiyaku-git" }, ["diff"], ["patch-id"]),
    GitPlumbingError,
  );
});

test("Keiyaku-owned refs keep delivery and candidate namespaces distinct across generations", () => {
  assert.equal(isKeiyakuOwnedRef(GIT_REF), true);
  for (const root of [DELIVERY_REF_NAMESPACE, CANDIDATE_PIN_REF_NAMESPACE]) {
    assert.equal(isKeiyakuOwnedRef(root), true);
    assert.equal(isKeiyakuOwnedRef(`${root}/leaf`), true);
  }
  assert.equal(isKeiyakuOwnedRef("refs/heads/main"), false);
  assert.equal(isKeiyakuOwnedRef("refs/keiyaku/other"), false);
  assert.equal(DELIVERY_REF_NAMESPACE.startsWith(CANDIDATE_PIN_REF_NAMESPACE), false);
  assert.equal(CANDIDATE_PIN_REF_NAMESPACE.startsWith(DELIVERY_REF_NAMESPACE), false);
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

test("repositoryAt pins one absolute common directory for primary and linked worktrees", async () => {
  const repository = repositoryWithCommit();
  const linked = mkdtempSync(join(tmpdir(), "keiyaku-linked-"));
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);

  const primary = await repositoryAt(repository.path);
  const secondary = await repositoryAt(linked);
  const expected = resolve(realpathSync(repository.path), ".git");
  assert.equal(commonGitDirectory(primary), expected);
  assert.equal(commonGitDirectory(secondary), expected);
  assert.equal(worktreePath(secondary, "atlantis"), join(primary.primaryWorktree, ".keiyaku", "wt", "atlantis"));
  assert.equal(worktreePath(secondary, "atlantis"), worktreePath(primary, "atlantis"));
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

test("contract path derivation reuses the common directory pinned by repositoryAt", async () => {
  const repository = repositoryWithCommit();
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-common-dir-calls-")), "calls");

  await withGitShim(
    ['printf "%s\\n" "$*" >> "$KEIYAKU_CALLS"', 'exec "$KEIYAKU_REAL_GIT" "$@"'].join("\n"),
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

test("batched ref reads preserve missing refs and deduplicate one fresh observation", async () => {
  const repository = repositoryWithCommit();
  const calls = join(mkdtempSync(join(tmpdir(), "keiyaku-ref-read-calls-")), "calls");
  const main = repository.run(["rev-parse", "refs/heads/main"]).trim();

  await withGitShim(
    ['printf "%s\\n" "$*" >> "$KEIYAKU_CALLS"', 'exec "$KEIYAKU_REAL_GIT" "$@"'].join("\n"),
    { KEIYAKU_CALLS: calls },
    async (gitPath) => {
      const refs = await readRefs(await repositoryAt(repository.path, gitPath), [
        GIT_REF,
        "HEAD",
        "refs/heads/main",
        "refs/heads/missing",
        "refs/heads/main",
      ]);
      assert.deepEqual(
        [...refs],
        [
          [GIT_REF, null],
          ["HEAD", main],
          ["refs/heads/main", main],
          ["refs/heads/missing", null],
        ],
      );
    },
  );

  const invocations = readFileSync(calls, "utf8").trim().split("\n");
  const reads = invocations.filter((command) => command.startsWith("cat-file --batch-check=%(objectname)"));
  assert.equal(reads.length, 1);
});

test("batched ref reads do not treat descendant refs as an exact ref", async () => {
  const repository = repositoryWithCommit();
  repository.run(["branch", "missing/child"]);

  const refs = await readRefs(await repositoryAt(repository.path), ["refs/heads/missing"]);

  assert.deepEqual([...refs], [["refs/heads/missing", null]]);
});

test("batched ref reads report a moved target and assertion ref from a fresh observation", async () => {
  const repository = repositoryWithCommit();
  repository.run(["branch", "release"]);
  const initial = repository.run(["rev-parse", "refs/heads/release"]).trim();
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "advance"]);
  const advanced = repository.run(["rev-parse", "HEAD"]).trim();
  repository.run(["update-ref", "refs/heads/release", advanced]);

  const refs = await readRefs(await repositoryAt(repository.path), [
    "refs/heads/release",
    "refs/heads/main",
    "refs/heads/release",
  ]);
  assert.notEqual(advanced, initial);
  assert.deepEqual(
    [...refs],
    [
      ["refs/heads/release", advanced],
      ["refs/heads/main", advanced],
    ],
  );
});

test("batched ref reads reject malformed Git output", async () => {
  const repository = repositoryWithCommit();

  await withGitShim(
    [
      'if [ "$1" = "cat-file" ]; then',
      "  cat >/dev/null",
      "  printf 'not-an-oid\\n'",
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      await assert.rejects(
        readRefs(await repositoryAt(repository.path, gitPath), ["refs/heads/main"]),
        /ref refs\/heads\/main is not a Git object ID/u,
      );
    },
  );
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
    (error: unknown) =>
      error instanceof GitPlumbingError && error.status === 128 && error.stderr.length > 0 && error.pid !== null,
  );
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
