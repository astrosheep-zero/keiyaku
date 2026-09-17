import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { renderAkumaUsage } from "../src/cli/commands/akuma.js";
import {
  installAssetsRoot,
  installExitCode,
  installHarnesses,
  renderInstallText,
} from "../src/cli/commands/install.js";
import type { ProcessInput, ProcessOutcome } from "../src/runtime/proc/run.js";

const terminal = (code = 0, stderr = ""): ProcessOutcome => ({
  kind: "terminal",
  code,
  stdout: "",
  stderr,
  truncated: false,
});

test("install parses one supported harness and --all", () => {
  assert.deepEqual(parseArgv(["install", "claude", "--json"]), {
    command: { command: "install", harnesses: ["claude"], output: "json" },
  });
  assert.deepEqual(parseArgv(["install", "--all"]), {
    command: { command: "install", harnesses: ["codex", "claude", "opencode", "pi"], output: "text" },
  });
});

test("install rejects missing, mixed, unknown, and duplicate options", () => {
  const refusals: readonly (readonly string[])[] = [
    ["install"],
    ["install", "claude", "--all"],
    ["install", "unknown"],
    ["install", "claude", "--nope"],
    ["install", "claude", "--json", "--json"],
  ];
  for (const argv of refusals) assert.throws(() => parseArgv(argv), CliUsageError);
});

test("Codex and Claude use their native marketplace recipes", async () => {
  const calls: string[][] = [];
  const runner = async (input: ProcessInput): Promise<ProcessOutcome> => {
    calls.push([...input.argv]);
    return terminal();
  };
  const result = await installHarnesses(["codex", "claude"], {}, runner);
  const root = installAssetsRoot();
  assert.deepEqual(calls, [
    ["codex", "plugin", "marketplace", "add", root, "--json"],
    ["codex", "plugin", "add", "keiyaku", "--marketplace", "keiyaku", "--json"],
    ["claude", "plugin", "marketplace", "add", root],
    ["claude", "plugin", "install", "keiyaku@keiyaku", "--scope", "user"],
    ["claude", "plugin", "update", "keiyaku@keiyaku", "--scope", "user"],
  ]);
  assert.equal(installExitCode(result), 0);
});

test("--all records failure and continues in fixed harness order", async () => {
  const calls: string[][] = [];
  const runner = async (input: ProcessInput): Promise<ProcessOutcome> => {
    calls.push([...input.argv]);
    return input.argv[0] === "claude" ? terminal(7, "not configured") : terminal();
  };
  const result = await installHarnesses(["codex", "claude", "opencode", "pi"], {}, runner);
  assert.deepEqual(
    result.results.map((item) => [item.harness, item.status]),
    [
      ["codex", "installed"],
      ["claude", "failed"],
      ["opencode", "installed"],
      ["pi", "installed"],
    ],
  );
  assert.deepEqual(
    calls.map((argv) => argv[0]),
    ["codex", "codex", "claude", "opencode", "pi"],
  );
  assert.deepEqual(calls[3], [
    "opencode",
    "plugin",
    join(installAssetsRoot(), "plugins", "keiyaku"),
    "--global",
    "--force",
  ]);
  assert.deepEqual(calls[4], ["pi", "install", "npm:@astrosheep/keiyaku"]);
  assert.equal(installExitCode(result), 1);
  assert.match(renderInstallText(result), /claude failed: claude exited 7: not configured/);
});

test("the bundled plugin contains all six skills", () => {
  for (const name of [
    "keiyaku",
    "keiyaku-task",
    "keiyaku-bind",
    "keiyaku-workflow",
    "keiyaku-akuma",
    "keiyaku-babysit",
  ]) {
    const path = join(installAssetsRoot(), "plugins", "keiyaku", "skills", name, "SKILL.md");
    const markdown = readFileSync(path, "utf8");
    assert.match(markdown, new RegExp(`^name: ${name}$`, "m"));
    assert.doesNotMatch(markdown, /keiyaku-v4/u);
  }
});

test("the bundled Akuma skill links to its packaged automation guide", () => {
  const skill = join(installAssetsRoot(), "plugins", "keiyaku", "skills", "keiyaku-akuma");
  const index = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.ok(index.includes("(references/automation.md)"));
  const guide = readFileSync(join(skill, "references", "automation.md"), "utf8");
  assert.match(guide, /^# Automation With The Akuma API/mu);
  assert.ok(guide.includes('from "@astrosheep/keiyaku"'));
  assert.ok(guide.includes("Schema.zod"));
});

test("bundled instructions keep facade and standalone Akuma call surfaces distinct", () => {
  const plugin = join(installAssetsRoot(), "plugins", "keiyaku", "skills");
  const call = renderAkumaUsage("call").slice("usage  keiyaku ".length);
  const canonical = `keiyaku -C <cwd> ${call}`;
  const standalone = canonical.replace(" [--contract <kei/...>]", "");
  const rootSkill = readFileSync(join(plugin, "keiyaku", "SKILL.md"), "utf8");
  const akumaSkill = readFileSync(join(plugin, "keiyaku-akuma", "SKILL.md"), "utf8");
  assert.ok(rootSkill.includes(canonical));
  assert.ok(akumaSkill.includes(standalone));
  assert.doesNotMatch(akumaSkill, /\bpersona\b|--persona/iu);
});
