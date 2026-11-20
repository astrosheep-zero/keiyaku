import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { makeGitRepository } from "./support/git.js";
import { captureOutput } from "./support/cli-fixtures.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";

function runCli(cwd: string, argv: readonly string[], input?: string) {
  return spawnSync(
    process.execPath,
    [
      ...(import.meta.url.endsWith(".js") ? [] : ["--import", "tsx"]),
      fileURLToPath(
        new URL(import.meta.url.endsWith(".js") ? "../src/cli/index.js" : "../src/cli/index.ts", import.meta.url),
      ),
      "-C",
      cwd,
      ...argv,
    ],
    { encoding: "utf8", env: process.env, ...(input === undefined ? {} : { input }) },
  );
}

function builtCli(): string {
  // The compile seam links .test-build/src to the real build/src, so a compiled test
  // and a source test resolve the same built CLI through one relative path.
  return fileURLToPath(
    new URL(import.meta.url.endsWith(".js") ? "../src/cli/index.js" : "../build/src/cli/index.js", import.meta.url),
  );
}

test("spawn rejects an invalid workdir without establishing a World", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-spawn-invalid-workdir-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await captureOutput(() =>
    main(["-C", root, "spawn", "worker", "--workdir", "missing", "prompt"]),
  );
  assert.equal(result.exit, 64);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /workdir is not an existing directory: missing/u);
  assert.equal(existsSync(join(root, ".keiyaku")), false);
});

test("a closed stdout pipe during a blocked large write exits silently", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-pipe-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  // Keep the output large enough to block the pipe without exceeding the OS's
  // per-argument limit while creating the fixture.
  const added = runCli(root, ["debt", "add", "-", "--json"], `---\ntitle: Title\n---\n\n${"x".repeat(500_000)}`);
  assert.equal(added.status, 0, added.stderr ?? added.error?.message);
  const id = JSON.parse(added.stdout).id as string;
  const child = spawn(process.execPath, [builtCli(), "show", id, "--json"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  // Register settlement before the blocked-write window: a child that exits early
  // (for example when the compiled CLI cannot be resolved) must fail this test
  // rather than escape an unregistered close listener and strand the awaiter.
  let exitCode: number | null | undefined;
  let exitError: Error | undefined;
  const settled = new Promise<void>((resolve) => {
    child.once("close", (code) => {
      exitCode = code;
      resolve();
    });
    child.once("error", (error) => {
      exitError = error;
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  child.stdout?.destroy();
  await settled;
  assert.equal(exitError, undefined, exitError?.message);
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
});

test("show preserves a Debt's multi-line body end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-debt-"));
  const added = runCli(root, ["debt", "add", "Title", "--body", "first\nsecond", "--json"]);
  assert.equal(added.status, 0);
  const id = JSON.parse(added.stdout).id as string;
  const shown = runCli(root, ["show", id]);
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /body\n  first\n  second/u);
  rmSync(root, { recursive: true, force: true });
});

test("audit show-diff preserves an actual candidate diff", () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const markdown = [
    "# CLI audit",
    "",
    "## Context",
    "test",
    "",
    "## Objective",
    "test",
    "",
    "## Design",
    "test",
    "",
    "## Region",
    "src/**",
    "",
    "## Criteria",
    "### candidate",
    "test",
  ].join("\n");
  const bound = spawnSync(process.execPath, [builtCli(), "-C", repository.path, "bind", "--gates", "", "-", "--json"], {
    input: markdown,
    encoding: "utf8",
  });
  assert.equal(bound.status, 0, bound.stderr);
  const binding = JSON.parse(bound.stdout) as { readonly contractId: string; readonly worktreePath: string };
  const contract = binding.contractId;
  writeFileSync(join(binding.worktreePath, "candidate.txt"), "candidate\n");
  const audited = spawnSync(
    process.execPath,
    [builtCli(), "-C", repository.path, "deliver", contract, "--dry-run", "--include-dirty", "--show-diff"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(audited.status, 0, audited.stderr);
  assert.match(audited.stdout, /diff --git/u);
  assert.match(audited.stdout, /\+\+\+|@@/u);
});

test("a local status on an absent complete id reports one caller-facing fact", (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-not-found-"));
  mkdirSync(join(root, ".keiyaku"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const id = "aku/intern/33dd4670";
  const result = runCli(root, ["status", id]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /reason  Akuma not found/u);
  assert.ok(result.stderr.includes(id));
  assert.ok(result.stderr.includes("keiyaku status --help"));
});

test("unknown debt command scopes minimal usage to debt", async () => {
  const result = await captureOutput(() => main(["debt", "nonsense"]));
  assert.equal(result.exit, 64);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, [
    "× usage  keiyaku debt",
    "  given  nonsense",
    "  accepts  keiyaku debt <command> ...",
    "  help  keiyaku debt --help",
    "",
  ].join("\n"));
});

test("invalid args keep diagnostic with deepest leaf usage", async () => {
  const leaf = await captureOutput(() => main(["bind", "--debt"]));
  assert.equal(leaf.exit, 64);
  assert.match(leaf.stderr, /× usage  keiyaku bind/u);
  assert.match(leaf.stderr, /  reason  --debt requires a value/u);
  assert.match(leaf.stderr, /  accepts  keiyaku bind /u);
  assert.match(leaf.stderr, /  help  keiyaku bind --help/u);
  assert.doesNotMatch(leaf.stderr, /Contract — standing acceptance/u);
  const root = await captureOutput(() => main(["--repo", "/one", "--repo", "/two", "status"]));
  assert.equal(root.exit, 64);
  assert.equal(root.stderr, [
    "× usage  keiyaku",
    "  reason  --repo may appear only once",
    "  accepts  keiyaku <command> [options]",
    "  help  keiyaku --help",
    "",
  ].join("\n"));
});

test("malformed bind JSON keeps the draft coordinate in the refusal", () => {
  const cwd = mkdtempSync(join(tmpdir(), "keiyaku-bind-json-refusal-"));
  const result = runCli(cwd, ["bind", "--json", "-"], "not valid bind markdown\n");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout) as {
    kind: string;
    reason: { kind: string; diagnostic: string };
    draft?: { path?: string; warning?: string };
  };
  assert.equal(body.kind, "refused");
  assert.equal(body.reason.kind, "invalid-document");
  assert.match(body.reason.diagnostic, /contract document/u);
  assert.ok(body.draft?.path !== undefined || body.draft?.warning !== undefined);
  rmSync(cwd, { recursive: true, force: true });
});

test("blank stdin remains a visible usage diagnostic and performs no operation", () => {
  const repository = makeGitRepository();
  try {
    const result = runCli(repository.path, ["bind", "-"], " \n\t");
    assert.equal(result.status, 64);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^× usage  keiyaku bind$/mu);
    assert.match(result.stderr, /  reason  bind requires a nonblank stdin document/u);
    assert.match(result.stderr, /  accepts  keiyaku bind /u);
    assert.match(result.stderr, /  help  keiyaku bind --help/u);
    assert.equal(existsSync(join(repository.path, ".keiyaku")), false);
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});

test("usage refusal exits 64 without touching an absent world", async () => {
  const cwd = join(mkdtempSync(join(tmpdir(), "keiyaku-usage-")), "missing-world");
  const result = await captureOutput(() => main(["-C", cwd, "nonsense"]));
  assert.equal(result.exit, 64);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^× usage  keiyaku$/mu);
  assert.match(result.stderr, /^  given  nonsense$/mu);
  assert.doesNotMatch(result.stderr, /no Keiyaku world/u);
});

test("a bare invocation prints the root help index instead of a usage refusal", async () => {
  const result = await captureOutput(() => main([]));
  assert.equal(result.exit, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^keiyaku — /u);
  assert.match(result.stdout, /^usage  keiyaku <command> \[options\]$/mu);
  assert.doesNotMatch(result.stdout, /× usage/u);
});

test("a bare debt family prints the debt help index instead of a usage refusal", async () => {
  const result = await captureOutput(() => main(["debt"]));
  assert.equal(result.exit, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /debt <command>/u);
  assert.doesNotMatch(result.stdout, /× usage/u);
});
