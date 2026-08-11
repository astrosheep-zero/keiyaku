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
  assert.deepEqual(result.results.map((item) => [item.harness, item.status]), [
    ["codex", "installed"],
    ["claude", "failed"],
    ["opencode", "installed"],
    ["pi", "installed"],
  ]);
  assert.deepEqual(calls.map((argv) => argv[0]), ["codex", "codex", "claude", "opencode", "pi"]);
  assert.deepEqual(calls[3], ["opencode", "plugin", join(installAssetsRoot(), "plugins", "keiyaku"), "--global", "--force"]);
  assert.equal(installExitCode(result), 1);
  assert.match(renderInstallText(result), /claude failed: claude exited 7: not configured/);
});

test("the bundled plugin contains all four v4 skills", () => {
  for (const name of ["keiyaku", "keiyaku-task", "keiyaku-workflow", "keiyaku-akuma"]) {
    const path = join(installAssetsRoot(), "plugins", "keiyaku", "skills", name, "SKILL.md");
    const markdown = readFileSync(path, "utf8");
    assert.match(markdown, new RegExp(`^name: ${name}$`, "m"));
    assert.doesNotMatch(markdown, /keiyaku-v4/u);
  }
});

test("bundled Akuma instructions use the current hard-cut call surface", () => {
  const plugin = join(installAssetsRoot(), "plugins", "keiyaku", "skills");
  const call = renderAkumaUsage("call").slice("usage: ".length);
  const rootSkill = readFileSync(join(plugin, "keiyaku", "SKILL.md"), "utf8");
  const akumaSkill = readFileSync(join(plugin, "keiyaku-akuma", "SKILL.md"), "utf8");
  assert.equal(rootSkill.includes(call), true);
  assert.equal(akumaSkill.includes(call), true);
  assert.doesNotMatch(akumaSkill, /\bpersona\b|--persona|Contract association/iu);
});

test("all harness manifests identify the same bundle version", () => {
  const plugin = join(installAssetsRoot(), "plugins", "keiyaku");
  const manifests = [
    join(plugin, ".codex-plugin", "plugin.json"),
    join(plugin, ".claude-plugin", "plugin.json"),
    join(plugin, "package.json"),
  ];
  const versions = manifests.map((path) => {
    const version = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
    assert.equal(typeof version, "string", `${path} must declare a version`);
    return version;
  });
  assert.equal(new Set(versions).size, 1, `harness manifest versions differ: ${versions.join(", ")}`);
});
