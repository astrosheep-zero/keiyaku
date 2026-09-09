import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inheritVerificationEnvironment, VerificationEnvironmentError } from "../src/git/verification-environment.js";
import { repositoryAt } from "../src/git/repository.js";
import { makeGitRepository, type TestGitRepository } from "./support/git.js";

type Fixture = Readonly<{
  raw: TestGitRepository;
  repository: Awaited<ReturnType<typeof repositoryAt>>;
  source: string;
  destination(): string;
}>;

async function fixture(): Promise<Fixture> {
  const raw = makeGitRepository();
  writeFileSync(join(raw.path, ".gitignore"), "environment/\nnode_modules/\n.keiyaku/\nKEIYAKU.md\n");
  writeFileSync(join(raw.path, "candidate.txt"), "source candidate\n");
  writeFileSync(join(raw.path, "removed-from-candidate.txt"), "source only\n");
  raw.run(["add", "."]);
  raw.run(["commit", "--quiet", "-m", "source"]);
  const sourceCommit = raw.run(["rev-parse", "HEAD"]).trim();

  writeFileSync(join(raw.path, "candidate.txt"), "candidate bytes\n");
  unlinkSync(join(raw.path, "removed-from-candidate.txt"));
  mkdirSync(join(raw.path, "environment"));
  writeFileSync(join(raw.path, "environment", "candidate-owned.txt"), "candidate environment\n");
  mkdirSync(join(raw.path, "environment", "protected"));
  writeFileSync(join(raw.path, "environment", "protected", "candidate.txt"), "candidate protected\n");
  raw.run([
    "add",
    "-f",
    "candidate.txt",
    "environment/candidate-owned.txt",
    "environment/protected/candidate.txt",
    "removed-from-candidate.txt",
  ]);
  raw.run(["commit", "--quiet", "-m", "candidate"]);
  const candidateCommit = raw.run(["rev-parse", "HEAD"]).trim();

  const source = mkdtempSync(join(tmpdir(), "keiyaku-verify-source-"));
  raw.run(["worktree", "add", "--quiet", "--detach", source, sourceCommit]);
  const destination = (): string => {
    const path = mkdtempSync(join(tmpdir(), "keiyaku-verify-destination-"));
    raw.run(["worktree", "add", "--quiet", "--detach", path, candidateCommit]);
    return path;
  };
  return { raw, repository: await repositoryAt(raw.path), source, destination };
}

function writeDependency(source: string): void {
  mkdirSync(join(source, "node_modules", "tool", "bin"), { recursive: true });
  mkdirSync(join(source, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(source, "node_modules", "tool", "bin", "tool.js"), "module.exports = 'source dependency';\n", {
    mode: 0o755,
  });
  symlinkSync("../tool/bin/tool.js", join(source, "node_modules", ".bin", "tool"));
  symlinkSync(join(source, "node_modules", "tool", "bin", "tool.js"), join(source, "node_modules", "absolute-tool"));
}

test("inherits ignored execution state without changing the integrated tracked candidate", async () => {
  const { raw, repository, source, destination } = await fixture();
  const candidate = destination();
  writeDependency(source);
  mkdirSync(join(source, "environment"), { recursive: true });
  writeFileSync(join(source, "environment", "candidate-owned.txt"), "source environment collision\n");
  writeFileSync(join(source, "local-environment.txt"), "untracked environment\n");
  mkdirSync(join(source, ".keiyaku"), { recursive: true });
  writeFileSync(join(source, ".keiyaku", "runtime-authority"), "do not copy\n");
  writeFileSync(join(source, "KEIYAKU.md"), "do not copy guidance\n");
  const before = {
    sourceHead: raw.run(["-C", source, "rev-parse", "HEAD"]),
    sourceIndex: raw.run(["-C", source, "ls-files", "--stage", "-z"]),
    candidateIndex: raw.run(["-C", candidate, "ls-files", "--stage", "-z"]),
  };

  await inheritVerificationEnvironment(repository, source, candidate);

  assert.equal(readFileSync(join(candidate, "candidate.txt"), "utf8"), "candidate bytes\n");
  assert.equal(readFileSync(join(candidate, "environment", "candidate-owned.txt"), "utf8"), "candidate environment\n");
  assert.equal(existsSync(join(candidate, "removed-from-candidate.txt")), false);
  assert.equal(readFileSync(join(candidate, "local-environment.txt"), "utf8"), "untracked environment\n");
  assert.equal(
    readFileSync(join(candidate, "node_modules", "tool", "bin", "tool.js"), "utf8"),
    "module.exports = 'source dependency';\n",
  );
  assert.equal(
    readFileSync(join(candidate, "node_modules", ".bin", "tool"), "utf8"),
    "module.exports = 'source dependency';\n",
  );
  assert.equal(readlinkSync(join(candidate, "node_modules", ".bin", "tool")), "../tool/bin/tool.js");
  assert.equal(
    readlinkSync(join(candidate, "node_modules", "absolute-tool")),
    join(realpathSync(candidate), "node_modules", "tool", "bin", "tool.js"),
  );
  assert.equal(existsSync(join(candidate, ".keiyaku", "runtime-authority")), false);
  assert.equal(existsSync(join(candidate, "KEIYAKU.md")), false);
  assert.deepEqual(
    {
      sourceHead: raw.run(["-C", source, "rev-parse", "HEAD"]),
      sourceIndex: raw.run(["-C", source, "ls-files", "--stage", "-z"]),
      candidateIndex: raw.run(["-C", candidate, "ls-files", "--stage", "-z"]),
    },
    before,
  );

  writeFileSync(join(candidate, "node_modules", "tool", "bin", "tool.js"), "destination mutation\n");
  assert.equal(
    readFileSync(join(source, "node_modules", "tool", "bin", "tool.js"), "utf8"),
    "module.exports = 'source dependency';\n",
  );
});

test("candidate file and directory ancestors win over source environment collisions", async () => {
  const { repository, source, destination } = await fixture();
  const candidate = destination();
  mkdirSync(join(source, "environment"), { recursive: true });
  symlinkSync(join(tmpdir(), "not-the-candidate"), join(source, "environment", "protected"));

  await inheritVerificationEnvironment(repository, source, candidate);

  assert.equal(lstatSync(join(candidate, "environment", "protected")).isDirectory(), true);
  assert.equal(
    readFileSync(join(candidate, "environment", "protected", "candidate.txt"), "utf8"),
    "candidate protected\n",
  );
});

test("refuses external links and special files instead of following them", async () => {
  const { repository, source, destination } = await fixture();
  const first = destination();
  mkdirSync(join(source, "node_modules"), { recursive: true });
  symlinkSync(join(tmpdir(), "outside"), join(source, "node_modules", "external"));

  await assert.rejects(
    inheritVerificationEnvironment(repository, source, first),
    (error: unknown) =>
      error instanceof VerificationEnvironmentError && /escapes source appointment/u.test(error.message),
  );

  unlinkSync(join(source, "node_modules", "external"));
  execFileSync("mkfifo", [join(source, "node_modules", "pipe")]);
  await assert.rejects(
    inheritVerificationEnvironment(repository, source, destination()),
    (error: unknown) => error instanceof VerificationEnvironmentError && /special file/u.test(error.message),
  );

  unlinkSync(join(source, "node_modules", "pipe"));
  mkdirSync(join(source, "node_modules", "nested"));
  writeFileSync(join(source, "node_modules", "nested", ".git"), "gitdir: elsewhere\n");
  await assert.rejects(
    inheritVerificationEnvironment(repository, source, destination()),
    (error: unknown) => error instanceof VerificationEnvironmentError && /nested repository state/u.test(error.message),
  );
});

test("honors cancellation before touching either worktree", async () => {
  const { repository, source, destination } = await fixture();
  const candidate = destination();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    inheritVerificationEnvironment(repository, source, candidate, controller.signal),
    (error: unknown) => error instanceof VerificationEnvironmentError && /cancelled/u.test(error.message),
  );
  assert.equal(existsSync(join(candidate, "node_modules")), false);
});

test("detects a source file mutation while its bytes are being inherited", async () => {
  const { repository, source, destination } = await fixture();
  writeDependency(source);
  const mutable = join(source, "node_modules", "tool", "bin", "tool.js");
  const handle = await open(mutable, "r");
  const prototype = Object.getPrototypeOf(handle) as { readFile(...args: unknown[]): Promise<Buffer> };
  const original = prototype.readFile;
  await handle.close();
  let mutated = false;
  Object.defineProperty(prototype, "readFile", {
    configurable: true,
    value: async function (this: unknown, ...args: unknown[]): Promise<Buffer> {
      if (!mutated) {
        mutated = true;
        writeFileSync(mutable, "changed while inheriting\n");
      }
      return await original.apply(this, args);
    },
  });
  try {
    await assert.rejects(
      inheritVerificationEnvironment(repository, source, destination()),
      (error: unknown) => error instanceof VerificationEnvironmentError && /source changed while reading/u.test(error.message),
    );
  } finally {
    Object.defineProperty(prototype, "readFile", { configurable: true, value: original });
  }
  assert.equal(mutated, true);
});

test("simultaneous destinations receive independent copies without a shared cache", async () => {
  const { repository, source, destination } = await fixture();
  writeDependency(source);
  const first = destination();
  const second = destination();

  await Promise.all([
    inheritVerificationEnvironment(repository, source, first),
    inheritVerificationEnvironment(repository, source, second),
  ]);
  writeFileSync(join(first, "node_modules", "tool", "bin", "tool.js"), "first destination only\n");

  assert.equal(
    readFileSync(join(second, "node_modules", "tool", "bin", "tool.js"), "utf8"),
    "module.exports = 'source dependency';\n",
  );
  assert.equal(
    readFileSync(join(source, "node_modules", "tool", "bin", "tool.js"), "utf8"),
    "module.exports = 'source dependency';\n",
  );
});
