import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { makeGitRepository } from "./support/git.js";
import { captureOutput, runCli as runCliInProcess } from "./support/cli-fixtures.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv, renderHelp } from "../src/cli/parse.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { AkumaAddressError, AkumaWorldScopeError } from "../src/library/address.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { classifyVerb } from "../src/library/keiyaku-verbs.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import type { ReconcileCompletion } from "../src/library/reconcile.js";
import { contractId } from "../src/core/facts/types.js";
import type { WorldRoot } from "../src/world.js";

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

test("category status refuses invalid combinations before reading the invocation cwd", async () => {
  for (const argv of [
    ["status", "aku", "--limit", "0"],
    ["status", "kei", "--limit", "9007199254740992"],
    ["status", "kei/exact", "--limit", "2"],
    ["status", "aku", "--guidance"],
    ["status", "kei", "kei/exact"],
    ["status", "kei/exact", "aku/worker/*"],
  ]) {
    const result = await captureOutput(() => main(["-C", "/definitely/absent/keiyaku-world", ...argv]));
    assert.equal(result.exit, 64);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /invocation cwd/u);
  }
});

test("observing spawn rejects an invalid workdir without establishing a World", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-spawn-invalid-workdir-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await captureOutput(() =>
    main(["-C", root, "spawn", "worker", "--workdir", "missing", "--wait", "1s", "prompt"]),
  );
  assert.equal(result.exit, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /workdir is not an existing directory: missing/u);
  assert.equal(existsSync(join(root, ".keiyaku")), false);
});

test("debt coordinate failures retain usage output for text and JSON", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-debt-coordinate-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".keiyaku"), "not a directory");
  for (const flags of [[], ["--json"]]) {
    const result = await captureOutput(() => main(["-C", root, "ls", "debt/", ...flags]));
    assert.equal(result.exit, 64);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /world marker is not a directory/u);
  }
});

test("debt owner failures use the shared verb failure projection", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-debt-failure-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".keiyaku", "debts"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "debts", "broken.md"), "not a Debt document\n");
  const text = await captureOutput(() => main(["-C", root, "debt", "query", "--where", "ready", "--world"]));
  assert.equal(text.exit, 3);
  assert.match(text.stderr, /debt\.query failed/u);
  const json = await captureOutput(() => main(["-C", root, "debt", "query", "--where", "ready", "--world", "--json"]));
  assert.equal(json.exit, 3);
  assert.ok(JSON.parse(json.stdout));
});

test("debt query defaults to active rows and opts into terminal rows", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-query-"));
  try {
    const added = runCli(root, ["debt", "add", "Active", "--json"]);
    assert.equal(added.status, 0, added.stderr);
    const closed = runCli(root, ["debt", "add", "Closed", "--json"]);
    assert.equal(closed.status, 0, closed.stderr);
    const id = JSON.parse(closed.stdout).id as string;
    assert.equal(runCli(root, ["debt", "done", id]).status, 0);
    const query = (flags: readonly string[]) => {
      const result = runCli(root, ["debt", "query", "--world", "--where", "priority >= 0", ...flags, "--json"]);
      assert.equal(result.status, 0, result.stderr);
      return (JSON.parse(result.stdout).rows as readonly { id: string }[]).map((row) => row.id);
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

test("native reconcile reports preserve hook, checkout, seat and settlement failure classification", () => {
  const id = contractId("kei/example");
  const reports: ReconcileCompletion[] = [
    {
      kind: "contract",
      contractId: id,
      issues: [
        {
          kind: "worktree-hook-failed",
          contractId: id,
          phase: "create",
          path: "/tmp/wt",
          name: "prepare",
          diagnostic: "hook failed",
        },
      ],
    },
    {
      kind: "contract",
      contractId: id,
      issues: [
        {
          kind: "target-checkout-retained",
          contractId: id,
          target: "refs/heads/main",
          path: "/repo/file",
          diagnostic: "checkout failed",
        },
      ],
    },
    {
      kind: "contract",
      contractId: id,
      issues: [
        {
          kind: "private-state-seat-close",
          contractId: id,
          diagnostic: "could not close publication seat",
        },
      ],
    },
    {
      kind: "contract",
      contractId: id,
      issues: [
        { kind: "contract-file-failed", contractId: id, path: "KEIYAKU.md", diagnostic: "write failed" },
        { kind: "settlement-failed", contractId: id, diagnostic: "debt failed" },
      ],
    },
  ];
  for (const report of reports)
    assert.equal(classifyVerb("reconcile", {}, { kind: "returned", value: report }), "failed");
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

test("Akuma address refusals keep Alias absence, a malformed selector, and a foreign World distinct", async () => {
  const id = parseAkumaId("aku/intern/33dd4670").id;
  const input = { selectors: [id] };
  const refusals: readonly (readonly [unknown, readonly string[]])[] = [
    [
      new AkumaAddressError({ kind: "akuma-alias-not-found", alias: parseAkumaAlias("@missing") }),
      ["Akuma alias not found", "@missing"],
    ],
    [
      new AkumaAddressError({ kind: "invalid-akuma", selector: "aku/intern/nope" }),
      ["invalid Akuma address", "aku/intern/nope"],
    ],
    [
      new AkumaWorldScopeError({ kind: "akuma-not-in-world", ids: [id], world: "/private/world" as WorldRoot }),
      ["Akuma not in this World", id, "/private/world"],
    ],
  ];
  for (const [error, facts] of refusals) {
    const completion = { kind: "threw" as const, error };
    assert.equal(classifyVerb("wait", input, completion), "refused");
    const body = renderVerb("wait", input, completion, { columns: 100, color: false });
    for (const fact of facts) assert.ok(body.includes(fact));
  }
});

test("unknown debt command scopes minimal usage to debt", () => {
  assert.throws(
    () => parseArgv(["debt", "nonsense"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "unknown debt command: nonsense" &&
      error.message ===
        [
          "× usage  keiyaku debt",
          "  given  nonsense",
          "  accepts  keiyaku debt <command> ...",
          "  help  keiyaku debt --help",
        ].join("\n"),
  );
});

test("review actor usage stays leaf-scoped and help advertises the flag", () => {
  for (const [flags, diagnostic] of [
    [["--actor"], "--actor requires a value"],
    [["--actor", "one", "--actor", "two"], "duplicate option: --actor"],
    [["--unknown"], "option --unknown is not valid for review"],
  ] as const) {
    assert.throws(
      () => parseArgv(["review", "--satisfied", "--summary", "ok", ...flags]),
      (error: unknown) =>
        error instanceof CliUsageError &&
        error.diagnostic === diagnostic &&
        error.message.includes("  accepts  keiyaku review ") &&
        error.message.includes("[--actor <actor>]"),
    );
  }
  const help = parseArgv(["review", "--help"]);
  assert.ok("help" in help);
  assert.match(renderHelp(help.help), /\[--actor <actor>\]/u);
});

test("invalid args keep diagnostic with deepest leaf usage", () => {
  assert.throws(
    () => parseArgv(["bind", "--debt"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.diagnostic === "--debt requires a value" &&
      error.message.includes("× usage  keiyaku bind") &&
      error.message.includes("  reason  --debt requires a value") &&
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

test("unmatched Contract selectors keep the text refusal and native missing guidance object", () => {
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
      ["× show refused", "  contract  kei/missing", "  reason  contract missing"].join("\n") + "\n",
    );
    const json = run(["--json"]);
    assert.equal(json.status, 1);
    assert.equal(json.stderr, "");
    assert.deepEqual(JSON.parse(json.stdout), { kind: "missing" });
  } finally {
    rmSync(repo.path, { recursive: true, force: true });
  }
});

test("malformed arc document is a substantive refusal", () => {
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
  const id = JSON.parse(bound.stdout).contractId as string;
  for (const document of ["", "#  \n", "## Missing name\n"]) {
    const text = runCli(repository.path, ["arc", id, "-"], document);
    assert.equal(text.status, 1, text.stdout + text.stderr);
    assert.equal(text.stderr, "");
    assert.match(text.stdout, /^× arc refused$/mu);
    assert.match(text.stdout, /reason  invalid document/u);
  }
  const json = runCli(repository.path, ["arc", id, "--json", "-"], "# \n");
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).reason.kind, "invalid-document");
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
    reason: { kind: string; diagnostic: string };
    draft?: { path?: string; warning?: string };
  };
  assert.equal(body.kind, "refused");
  assert.equal(body.reason.kind, "invalid-document");
  assert.match(body.reason.diagnostic, /contract document/u);
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

test("a worldless lifecycle request refuses every requested Debt in its native shape", () => {
  const cwd = mkdtempSync(join(tmpdir(), "keiyaku-usage-worldless-"));
  try {
    const single = runCli(cwd, ["debt", "drop", "debt/alpha"]);
    assert.equal(single.status, 1);
    assert.match(single.stdout, /^× drop refused$/mu);
    assert.match(single.stdout, /^  reason  debt missing$/mu);
    assert.match(single.stdout, /^  debt  debt\/alpha$/mu);
    const plural = runCli(cwd, ["debt", "done", "debt/alpha", "debt/beta", "--json"]);
    assert.equal(plural.status, 1);
    assert.deepEqual(JSON.parse(plural.stdout), {
      items: [
        { kind: "refused", reason: "debt-missing" },
        { kind: "refused", reason: "debt-missing" },
      ],
    });
    const pluralText = runCli(cwd, ["debt", "done", "debt/alpha", "debt/beta"]);
    assert.equal(pluralText.status, 1);
    assert.match(pluralText.stdout, /^  debt  debt\/alpha$/mu);
    assert.match(pluralText.stdout, /^  debt  debt\/beta$/mu);
    assert.ok(pluralText.stdout.indexOf("debt/alpha") < pluralText.stdout.indexOf("debt/beta"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
