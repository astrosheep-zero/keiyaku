import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { makeGitRepository } from "./support/git.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { invoke } from "../src/cli/invoke.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { parseAkuId } from "../src/akuma/identity.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../src/library/address.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { akumaFailureProjection, invocationExitCode } from "../src/cli/runtime.js";
import { contractId } from "../src/core/facts/types.js";

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

function runCli(cwd: string, argv: readonly string[], input?: string) {
  // A caller inside an Akuma Body carries AKUMA_REQUESTS and would forward the
  // operation to its parent; this suite asserts the local addressing result.
  const environment = { ...process.env };
  delete environment[AKUMA_REQUESTS_ENV];
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
    { encoding: "utf8", env: environment, ...(input === undefined ? {} : { input }) },
  );
}

function builtCli(): string {
  // The compile seam links .test-build/src to the real build/src, so a compiled test
  // and a source test resolve the same built CLI through one relative path.
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".js") ? "../src/cli/index.js" : "../build/src/cli/index.js",
      import.meta.url,
    ),
  );
}

test("a closed stdout pipe during a blocked large write exits silently", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-pipe-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const added = runCli(root, ["task", "add", "Title", "--body", "x".repeat(500_000), "--json"]);
  assert.equal(added.status, 0, added.stderr ?? added.error?.message);
  const id = JSON.parse(added.stdout).value.id as string;
  const child = spawn(
    process.execPath,
    [builtCli(), "task", "show", id, "--json"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
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

test("worktree hook failure reports exit 1 at the CLI boundary", async () => {
  const result: import("../src/cli/result.js").InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [
        {
          kind: "worktree-hook-failed",
          phase: "create",
          path: "/tmp/wt",
          command: 0,
          name: "prepare",
          failure: { kind: "exit", code: 7, stdout: "", stderr: "hook failed", truncated: false },
        },
      ],
      settlement: { actions: [], lags: [] },
    },
  };
  assert.equal(await invocationExitCode(result), 1);
});

test("target checkout retention reports exit 1 at the CLI boundary", async () => {
  const result: import("../src/cli/result.js").InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [
        {
          kind: "target-checkout-retained",
          target: "refs/heads/main",
          path: "/repo/file",
          diagnostic: "checkout failed",
        },
      ],
      settlement: { actions: [], lags: [] },
    },
  };
  assert.equal(await invocationExitCode(result), 1);
});

test("private-state seat-close failure reports exit 1 at the CLI boundary", async () => {
  const result: import("../src/cli/result.js").InvocationResult = {
    kind: "reconcile",
    report: {
      effects: [],
      lag: [],
      settlement: {
        actions: [],
        lags: [],
        seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "could not close publication seat" }],
      },
    },
  };
  assert.equal(await invocationExitCode(result), 1);
});

test("reconcile failure reports exit 1 at the CLI boundary", async () => {
  const result: import("../src/cli/result.js").InvocationResult = {
    kind: "reconcile" as const,
    report: {
      effects: [],
      lag: [{ kind: "contract-file-failed", worktree: "/tmp/wt", path: "KEIYAKU.md", diagnostic: "write failed" }],
      settlement: {
        actions: [],
        lags: [
          {
            kind: "settlement-failed",
            surface: "task" as const,
            contractId: contractId("kei/example"),
            diagnostic: "task failed",
          },
        ],
      },
    },
  };
  assert.equal(await invocationExitCode(result), 1);
});

test("task show preserves a multi-line body end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-task-"));
  const added = runCli(root, ["task", "add", "Title", "--body", "first\nsecond", "--json"]);
  assert.equal(added.status, 0);
  const id = JSON.parse(added.stdout).value.id as string;
  const shown = runCli(root, ["task", "show", id]);
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
  const bound = spawnSync(
    process.execPath,
    [
      builtCli(),
      "-C",
      repository.path,
      "bind",
      "--gates",
      "",
      "-",
      "--json",
    ],
    {
      input: markdown,
      encoding: "utf8",
    },
  );
  assert.equal(bound.status, 0, bound.stderr);
  const contract = JSON.parse(bound.stdout).contract as string;
  const binding = JSON.parse(bound.stdout);
  writeFileSync(join(binding.workspace.path, "candidate.txt"), "candidate\n");
  const audited = spawnSync(
    process.execPath,
    [
      builtCli(),
      "-C",
      repository.path,
      "audit",
      contract,
      "--include-dirty",
      "--show-diff",
    ],
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
  assert.equal(result.stderr, `× Akuma not found  ${id}\n`);
});

test("Akuma address refusals keep Alias absence, a malformed selector, and a foreign World distinct", async () => {
  const id = parseAkuId("aku/intern/33dd4670").id;
  const parsed = parseArgv(["wait", id]);
  if (!("command" in parsed)) throw new Error("wait did not parse as an executable command");
  const refusals: readonly (readonly [unknown, string])[] = [
    [
      new AkumaAddressError({ kind: "akuma-alias-not-found", alias: parseAkumaAlias("@missing") }),
      `× Akuma alias not found  @missing`,
    ],
    [
      new AkumaAddressError({ kind: "invalid-akuma", selector: "aku/intern/nope" }),
      `× invalid Akuma address  aku/intern/nope`,
    ],
    [
      new AkumaWorldScopeError({ kind: "akuma-not-in-world", ids: [id], world: "/private/world" as never }),
      `× Akuma not in this World  ${id}`,
    ],
  ];
  for (const [error, body] of refusals) {
    assert.deepEqual(await akumaFailureProjection(error, parsed.command), { body, exitCode: 1 });
  }
});

test("unknown task command scopes minimal usage to task", () => {
  assert.throws(
    () => parseArgv(["task", "nonsense"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "unknown task command: nonsense" &&
      error.message ===
        [
          "× usage  keiyaku task",
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
      error.message.includes("× usage  keiyaku bind") &&
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
          "× usage  keiyaku",
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
        ...(import.meta.url.endsWith(".js") ? [] : ["--import", "tsx"]),
        fileURLToPath(
          new URL(import.meta.url.endsWith(".js") ? "../src/cli/index.js" : "../src/cli/index.ts", import.meta.url),
        ),
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
    assert.equal(text.status, 1);
    assert.equal(text.stderr, "");
    assert.equal(
      text.stdout,
      ["× show refused", "  contract  kei/missing", "  diagnostic  contract missing"].join("\n") + "\n",
    );
    const json = run(["--json"]);
    assert.equal(json.status, 1);
    assert.equal(json.stderr, "");
    assert.match(json.stdout, /contract-missing/u);
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("arc help gives the complete chapter grammar and the shipped source avoids banned vocabulary", () => {
  const help = runCli(process.cwd(), ["arc", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /named|Name|chapter name/iu);
  assert.match(help.stdout, /story arc/u);
  assert.match(help.stdout, /one nonblank H1|nonblank H1/u);
  assert.match(help.stdout, /freeform body, optional/u);
  const source = fileURLToPath(new URL("../src", import.meta.url));
  const scan = spawnSync("rg", ["-ni", "arc admitted", source], { encoding: "utf8" });
  assert.equal(scan.status, 1, scan.stdout || scan.stderr);
});

test("malformed arc document is a substantive refusal with the full grammar", () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const markdown = [
    "# Arc refusal",
    "## Context", "Context.",
    "## Objective", "Objective.",
    "## Design", "Design.",
    "## Region", "src/**",
    "## Criteria", "### Works", "Works.",
  ].join("\n");
  const bound = runCli(repository.path, ["bind", "--gates", "", "--json", "-"], markdown);
  assert.equal(bound.status, 0, bound.stdout + bound.stderr);
  const id = JSON.parse(bound.stdout).contract as string;
  for (const document of ["", "#  \n", "## Missing name\n"]) {
    const text = runCli(repository.path, ["arc", id, "-"], document);
    assert.equal(text.status, 1, text.stdout + text.stderr);
    assert.equal(text.stderr, "");
    assert.match(text.stdout, /^× arc refused$/mu);
    assert.match(text.stdout, /diagnostic  invalid document/u);
    assert.match(text.stdout, /exactly one nonblank H1 chapter name/u);
    assert.match(text.stdout, /freeform Markdown body \(which may be empty\)/u);
  }
  const json = runCli(repository.path, ["arc", id, "--json", "-"], "# \n");
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).refusal.kind, "invalid-document");
  rmSync(repository.path, { recursive: true, force: true });
});

test("malformed bind is a substantive refusal on stdout with its draft", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "keiyaku-bind-refusal-"));
  const result = runCli(cwd, ["bind", "-"], "not valid bind markdown\n");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^× bind refused$/mu);
  assert.match(result.stdout, /^  diagnostic  invalid document$/mu);
  assert.equal(result.stderr, "");
  rmSync(cwd, { recursive: true, force: true });
});

test("malformed bind JSON keeps the draft coordinate in the refusal", () => {
  const cwd = mkdtempSync(join(tmpdir(), "keiyaku-bind-json-refusal-"));
  const result = runCli(cwd, ["bind", "--json", "-"], "not valid bind markdown\n");
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const body = JSON.parse(result.stdout) as {
    kind: string;
    refusal: { kind: string; diagnostic: string };
    draft?: { path?: string; warning?: string };
  };
  assert.equal(body.kind, "refused");
  assert.equal(body.refusal.kind, "invalid-document");
  assert.match(body.refusal.diagnostic, /contract document/u);
  assert.ok(body.draft?.path !== undefined || body.draft?.warning !== undefined);
  rmSync(cwd, { recursive: true, force: true });
});

test("blank stdin remains a visible usage diagnostic and performs no operation", async () => {
  const missing = "/absent/keiyaku-usage-blank-stdin";
  const parsed = parseArgv(["bind", "-"]);
  if (!("command" in parsed)) throw new Error("bind did not parse as executable");
  await assert.rejects(
    () =>
      invoke(parsed, {
        cwd: missing,
        environment: {},
        readStdin: async () => " \n\t",
      }),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "bind requires a nonblank stdin document" &&
      error.message.includes("  diagnostic  bind requires a nonblank stdin document") &&
      error.message.includes("  accepts  keiyaku bind ") &&
      error.message.includes("  help  keiyaku bind --help"),
  );
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

test("usage refusal exits 64 without touching an absent world", async () => {
  const cwd = join(mkdtempSync(join(tmpdir(), "keiyaku-usage-")), "missing-world");
  const result = await captureMain(["-C", cwd, "nonsense"]);
  assert.equal(result.exit, 64);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^× usage  keiyaku$/mu);
  assert.match(result.stderr, /^  given  nonsense$/mu);
  assert.doesNotMatch(result.stderr, /no Keiyaku world/u);
});
