import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { makeGitRepository } from "./support/git.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv, renderRootHelp } from "../src/cli/parse.js";
import { invoke } from "../src/cli/invoke.js";

async function captureMain(
  argv: readonly string[],
): Promise<Readonly<{ exit: number; stdout: string; stderr: string }>> {
  let stdout = "";
  let stderr = "";
  const writeStdout = process.stdout.write;
  const writeStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { exit: await main(argv), stdout, stderr };
  } finally {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
  }
}

test("unknown root command renders exact minimal usage", async () => {
  const result = await captureMain(["nonsense"]);
  assert.equal(result.exit, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    [
      "✕ usage  keiyaku",
      "  given  nonsense",
      "  accepts  keiyaku <command> [options]",
      "  help  keiyaku --help",
      "",
    ].join("\n"),
  );
});

test("unknown task command scopes minimal usage to task", () => {
  assert.throws(
    () => parseArgv(["task", "nonsense"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "unknown task command: nonsense" &&
      error.message ===
        [
          "✕ usage  keiyaku task",
          "  given  nonsense",
          "  accepts  keiyaku task <command> ...",
          "  help  keiyaku task --help",
        ].join("\n"),
  );
});

test("invalid args keep diagnostic with deepest leaf usage", () => {
  assert.throws(
    () => parseArgv(["bind", "--task"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "--task requires a value" &&
      error.message.includes("✕ usage  keiyaku bind") &&
      error.message.includes("  diagnostic  --task requires a value") &&
      error.message.includes("  accepts  keiyaku bind ") &&
      error.message.includes("  help  keiyaku bind --help") &&
      !error.message.includes("Contract — standing acceptance"),
  );
  assert.throws(
    () => parseArgv(["--repo", "/one", "--repo", "/two", "status"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "--repo may appear only once" &&
      error.message ===
        [
          "✕ usage  keiyaku",
          "  diagnostic  --repo may appear only once",
          "  accepts  keiyaku <command> [options]",
          "  help  keiyaku --help",
        ].join("\n"),
  );
});

test("unmatched Contract selectors preserve exit and JSON behavior while exposing text evidence", () => {
  const repo = makeGitRepository();
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../src/cli/index.ts", import.meta.url)),
        "-C",
        repo.path,
        "show",
        "kei/missing",
        ...args,
      ],
      { encoding: "utf8" },
    );
  try {
    const text = run([]);
    assert.equal(text.status, 3);
    assert.equal(text.stdout, "");
    assert.equal(
      text.stderr,
      [
        "✕ selector  keiyaku show",
        "  diagnostic  Keiyaku refused: contract-missing",
        "  given  kei/missing",
        "  accepts  keiyaku show [<contract>|@<contract>] [--json]",
        "  help  keiyaku show --help",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(text.stderr, /next|then|please/u);
    const json = run(["--json"]);
    assert.equal(json.status, 3);
    assert.equal(json.stdout, "");
    assert.equal(json.stderr, "Keiyaku refused: contract-missing\n");
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("root complete help still documents cwd and repo", () => {
  const help = renderRootHelp();
  assert.match(help, /-C, --cwd <path>  Set the invocation working directory\./u);
  assert.match(help, /--repo <path>     Select the Git repository coordinate\./u);
  assert.match(help, /^usage  keiyaku <command> \[options\]$/mu);
});

test("blank stdin remains a visible usage diagnostic and performs no operation", async () => {
  const missing = "/absent/keiyaku-usage-blank-stdin";
  let started = false;
  const parsed = parseArgv(["bind", "-"]);
  if ("help" in parsed) throw new Error("bind parsed as help");
  await assert.rejects(
    () =>
      invoke(parsed, {
        cwd: missing,
        environment: {},
        readStdin: async () => " \n\t",
        onOperationStart: () => {
          started = true;
        },
      }),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "bind requires a nonblank stdin document" &&
      error.message.includes("  diagnostic  bind requires a nonblank stdin document") &&
      error.message.includes("  accepts  keiyaku bind ") &&
      error.message.includes("  help  keiyaku bind --help"),
  );
  assert.equal(started, false);
});

test("settings and duplicate-flag diagnostics stay visible", () => {
  assert.throws(
    () => parseArgv(["install", "--all", "--all"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "duplicate option: --all" &&
      error.message.includes("  diagnostic  duplicate option: --all") &&
      error.message.includes("  help  keiyaku install --help"),
  );
});

test("usage refusal exits 1 without touching an absent world", async () => {
  const cwd = join(mkdtempSync(join(tmpdir(), "keiyaku-usage-")), "missing-world");
  const result = await captureMain(["-C", cwd, "nonsense"]);
  assert.equal(result.exit, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^✕ usage  keiyaku$/mu);
  assert.match(result.stderr, /^  given  nonsense$/mu);
  assert.doesNotMatch(result.stderr, /no Keiyaku world/u);
});
