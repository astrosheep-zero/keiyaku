import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgv } from "../src/cli/parse.js";
import { installOutcome, installHarnesses, renderInstallText } from "../src/cli/commands/install.js";
import type { ProcessInput, ProcessOutcome } from "../src/runtime/proc/run.js";

// The install recipes name the built marketplace root relative to the module that holds them, so the
// expectation follows that same module through the compile seam (.test-build/src links to build/src).
const installModule = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".js") ? "../src/cli/commands/install.js" : "../src/cli/commands/install.ts",
    import.meta.url,
  ),
);
const assetsRoot = resolve(dirname(realpathSync(installModule)), "../../../plugins");

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

test("Codex and Claude use their native marketplace recipes", async () => {
  const calls: string[][] = [];
  const runner = async (input: ProcessInput): Promise<ProcessOutcome> => {
    calls.push([...input.argv]);
    return terminal();
  };
  const result = await installHarnesses(["codex", "claude"], {}, runner);
  const root = assetsRoot;
  assert.deepEqual(calls, [
    ["codex", "plugin", "marketplace", "add", root, "--json"],
    ["codex", "plugin", "add", "keiyaku", "--marketplace", "keiyaku", "--json"],
    ["claude", "plugin", "marketplace", "add", root],
    ["claude", "plugin", "install", "keiyaku@keiyaku", "--scope", "user"],
    ["claude", "plugin", "update", "keiyaku@keiyaku", "--scope", "user"],
  ]);
  assert.equal(installOutcome(result), "accepted");
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
  assert.deepEqual(calls[3], ["opencode", "plugin", join(assetsRoot, "opencode"), "--global", "--force"]);
  assert.deepEqual(calls[4], ["pi", "install", "npm:@astrosheep/keiyaku"]);
  assert.equal(installOutcome(result), "failed");
  assert.match(renderInstallText(result), /claude failed: claude exited 7: not configured/);
});
