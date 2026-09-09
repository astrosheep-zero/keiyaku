import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { repositoryAt } from "../src/git/repository.js";
import { GitPlumbingError, runGitPipe } from "../src/git/process.js";
import { captureWorkspaceTree } from "../src/git/workspace.js";
import { worktreeChangeId } from "../src/git/integration.js";
import { mintSnapshotId } from "../src/git/identity.js";
import { makeGitRepository, protocolContractId, waitForFile } from "./support/git.js";

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
    `const fs = require('node:fs'); const path = ${JSON.stringify(path)};
     fs.writeFileSync(path + '.pending', String(process.pid));
     fs.renameSync(path + '.pending', path); setInterval(() => {}, 1000)`,
  ]);
  const pending = runGitPipe(git, args[0]!, args[1]!);
  void pending.catch(() => undefined);
  let pids: number[] = [];
  try {
    await Promise.all(files.map(waitForFile));
    pids = files.map((file) => Number(readFileSync(file, "utf8")));
    for (const pid of pids) {
      assert.ok(Number.isSafeInteger(pid) && pid > 0, "published receipt must name an actual child");
      process.kill(pid, 0);
    }
  } finally {
    controller.abort();
    await assert.rejects(pending, GitPlumbingError);
  }
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(
    runGitPipe({ ...(await repositoryAt(repository.path)), gitPath: "/missing/keiyaku-git" }, ["diff"], ["patch-id"]),
    GitPlumbingError,
  );
});
