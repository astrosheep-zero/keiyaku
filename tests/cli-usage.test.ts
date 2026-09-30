import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { makeGitRepository } from "./support/git.js";
import { captureOutput, runCli as runCliInProcess } from "./support/cli-fixtures.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { parseAkuId } from "../src/akuma/identity.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../src/library/address.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { akumaFailureProjection } from "../src/cli/runtime.js";
import { reconcileHasFailure } from "../src/cli/render/reconcile.js";
import type { ReconcileReport } from "../src/library/contract-types.js";
import { contractId } from "../src/core/facts/types.js";
import type { WorldRoot } from "../src/world.js";

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
    new URL(import.meta.url.endsWith(".js") ? "../src/cli/index.js" : "../build/src/cli/index.js", import.meta.url),
  );
}

test("task query defaults to active rows and opts into terminal rows", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-query-"));
  try {
    const added = runCli(root, ["task", "add", "Active", "--json"]);
    assert.equal(added.status, 0, added.stderr);
    const closed = runCli(root, ["task", "add", "Closed", "--json"]);
    assert.equal(closed.status, 0, closed.stderr);
    const id = JSON.parse(closed.stdout).value.id as string;
    assert.equal(runCli(root, ["task", "done", id]).status, 0);
    const query = (flags: readonly string[]) => {
      const result = runCli(root, ["task", "query", "--world", "--where", "priority >= 0", ...flags, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      return (JSON.parse(result.stdout).value.rows as readonly { id: string }[]).map((row) => row.id);
    };
    assert.equal(query([]).length, 1);
    assert.deepEqual(query(["--closed"]), [id]);
    assert.equal(query(["--all"]).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a closed stdout pipe during a blocked large write exits silently", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-cli-pipe-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const added = runCli(root, ["task", "add", "Title", "--body", "x".repeat(500_000), "--json"]);
  assert.equal(added.status, 0, added.stderr ?? added.error?.message);
  const id = JSON.parse(added.stdout).value.id as string;
  const child = spawn(process.execPath, [builtCli(), "task", "show", id, "--json"], {
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

test("worktree hook failure reports exit 1 at the CLI boundary", async () => {
  const report: ReconcileReport = {
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
  };
  assert.equal(reconcileHasFailure(report), true);
});

test("target checkout retention reports exit 1 at the CLI boundary", async () => {
  const report: ReconcileReport = {
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
  };
  assert.equal(reconcileHasFailure(report), true);
});

test("private-state seat-close failure reports exit 1 at the CLI boundary", async () => {
  const report: ReconcileReport = {
    effects: [],
    lag: [],
    settlement: {
      actions: [],
      lags: [],
      seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "could not close publication seat" }],
    },
  };
  assert.equal(reconcileHasFailure(report), true);
});

test("reconcile failure reports exit 1 at the CLI boundary", async () => {
  const report: ReconcileReport = {
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
  };
  assert.equal(reconcileHasFailure(report), true);
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
  const bound = spawnSync(process.execPath, [builtCli(), "-C", repository.path, "bind", "--gates", "", "-", "--json"], {
    input: markdown,
    encoding: "utf8",
  });
  assert.equal(bound.status, 0, bound.stderr);
  const contract = JSON.parse(bound.stdout).contract as string;
  const binding = JSON.parse(bound.stdout) as { readonly value: { readonly workspace: { readonly path: string } } };
  writeFileSync(join(binding.value.workspace.path, "candidate.txt"), "candidate\n");
  const audited = spawnSync(
    process.execPath,
    [builtCli(), "-C", repository.path, "audit", contract, "--include-dirty", "--show-diff"],
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
  assert.equal(
    result.stderr,
    [
      "× status refused",
      "  reason  Akuma not found",
      `  id  ${id}`,
      "  accepts  keiyaku status [<contract>|@name|<aku/...>]...",
      "           keiyaku status --guidance [<contract>|@<contract>]",
      "  help  keiyaku status --help",
      "",
    ].join("\n"),
  );
});

test("Akuma address refusals keep Alias absence, a malformed selector, and a foreign World distinct", async () => {
  const id = parseAkuId("aku/intern/33dd4670").id;
  const parsed = parseArgv(["wait", id]);
  if (!("command" in parsed)) throw new Error("wait did not parse as an executable command");
  const refusals: readonly (readonly [unknown, string])[] = [
    [
      new AkumaAddressError({ kind: "akuma-alias-not-found", alias: parseAkumaAlias("@missing") }),
      [
        "× wait refused",
        "  reason  Akuma alias not found",
        "  alias  @missing",
        "  accepts  keiyaku wait <aku/...|@alias>... [--any | --all] [--timeout <duration>]",
        "  help  keiyaku wait --help",
      ].join("\n"),
    ],
    [
      new AkumaAddressError({ kind: "invalid-akuma", selector: "aku/intern/nope" }),
      [
        "× wait refused",
        "  reason  invalid Akuma address",
        "  selector  aku/intern/nope",
        "  accepts  keiyaku wait <aku/...|@alias>... [--any | --all] [--timeout <duration>]",
        "  help  keiyaku wait --help",
      ].join("\n"),
    ],
    [
      new AkumaWorldScopeError({ kind: "akuma-not-in-world", ids: [id], world: "/private/world" as WorldRoot }),
      [
        "× wait refused",
        "  reason  Akuma not in this World",
        `  ids  ${id}`,
        "  world  /private/world",
        "  accepts  keiyaku wait <aku/...|@alias>... [--any | --all] [--timeout <duration>]",
        "  help  keiyaku wait --help",
      ].join("\n"),
    ],
  ];
  for (const [error, body] of refusals) {
    const projected = await akumaFailureProjection(error, parsed.command);
    assert.deepEqual(projected, { body, exitCode: 1 });
    assert.match(projected!.body, /^× wait refused\n  reason  /u);
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
      error.message.includes("  reason  --task requires a value") &&
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
          "  reason  --repo may appear only once",
          "  accepts  keiyaku <command> [options]",
          "  help  keiyaku --help",
        ].join("\n"),
  );
});

test("unmatched Contract selectors keep the text refusal and preserve the native missing-guidance null in JSON", () => {
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
        "status",
        "--guidance",
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
      ["× status refused", "  contract  kei/missing", "  reason  contract missing"].join("\n") + "\n",
    );
    const json = run(["--json"]);
    assert.equal(json.status, 1);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout.trim(), "null");
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
    "## Context",
    "Context.",
    "## Objective",
    "Objective.",
    "## Design",
    "Design.",
    "## Region",
    "src/**",
    "## Criteria",
    "### Works",
    "Works.",
  ].join("\n");
  const bound = runCli(repository.path, ["bind", "--gates", "", "--json", "-"], markdown);
  assert.equal(bound.status, 0, bound.stdout + bound.stderr);
  const id = JSON.parse(bound.stdout).contract as string;
  for (const document of ["", "#  \n", "## Missing name\n"]) {
    const text = runCli(repository.path, ["arc", id, "-"], document);
    assert.equal(text.status, 1, text.stdout + text.stderr);
    assert.equal(text.stderr, "");
    assert.match(text.stdout, /^× arc refused$/mu);
    assert.match(text.stdout, /reason  invalid document/u);
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
  assert.match(result.stdout, /^  reason  invalid document$/mu);
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
  const repository = makeGitRepository();
  try {
    await assert.rejects(
      () =>
        runCliInProcess(["-C", repository.path, "bind", "-"], {
          cwd: repository.path,
          environment: {},
          readStdin: async () => " \n\t",
        }),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.diagnostic === "bind requires a nonblank stdin document" &&
        error.message.includes("  reason  bind requires a nonblank stdin document") &&
        error.message.includes("  accepts  keiyaku bind ") &&
        error.message.includes("  help  keiyaku bind --help"),
    );
  } finally {
    rmSync(repository.path, { recursive: true, force: true });
  }
});

test("settings and duplicate-flag diagnostics stay visible", () => {
  assert.throws(
    () => parseArgv(["install", "--all", "--all"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "duplicate option: --all" &&
      error.message.includes("  reason  duplicate option: --all") &&
      error.message.includes("  help  keiyaku install --help"),
  );
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
