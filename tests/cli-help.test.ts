import { cliExitCode } from "../src/cli/streams.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { captureOutput } from "./support/cli-fixtures.js";
import { CliUsageError, parseArgv, renderHelp, renderRootHelp } from "../src/cli/parse.js";
import { renderContractHelp } from "../src/cli/commands/contract-help.js";
import { renderAkumaHelp } from "../src/cli/commands/akuma.js";
import { renderInstallHelp } from "../src/cli/commands/install.js";
import { renderDebtHelp } from "../src/cli/commands/debt-grammar.js";
import { displayColumns } from "../src/cli/render/terminal.js";

test("the runtime maps the five process outcomes", () => {
  const outcomes = ["accepted", "refused", "retryable", "failed", "usage"] as const;
  assert.deepEqual(outcomes.map(cliExitCode), [0, 1, 2, 3, 64]);
});

test("help resolves the longest legal command-word prefix before syntax scanning", () => {
  assert.deepEqual(parseArgv(["--help"]), { help: { kind: "root" } });
  assert.deepEqual(parseArgv(["bind", "--unknown", "--help", "-"]), {
    help: { kind: "contract", command: "bind" },
  });
  assert.deepEqual(parseArgv(["debt", "unknown", "--help"]), { help: { kind: "debt" } });
  assert.deepEqual(parseArgv(["debt", "show", "bad", "--help"]), {
    help: { kind: "debt", action: "show" },
  });
  assert.deepEqual(parseArgv(["fork", "--json", "--help"]), {
    help: { kind: "akuma", action: "fork" },
  });
  assert.deepEqual(parseArgv(["-C", "/absent/world", "--json", "--help"]), {
    help: { kind: "root" },
  });
  assert.throws(() => parseArgv(["ls"]), CliUsageError);
  assert.throws(() => parseArgv(["ls", "--json"]), CliUsageError);
  assert.throws(() => parseArgv(["-h"]), CliUsageError);
  assert.throws(() => parseArgv(["help"]), CliUsageError);
});

test("namespace and leaf help identify an executable command", () => {
  assert.match(renderRootHelp(), /^usage  keiyaku <command> \[options\]$/mu);
  assert.match(renderRootHelp(), /Debt — unresolved-work ledger/u);
  assert.doesNotMatch(renderRootHelp(), /plan memory|keiyaku task/u);
  assert.match(renderRootHelp(), /--workdir <path>/u);
  assert.match(renderRootHelp(), /Outcomes:  exit 0 accepted · 1 refused · 2 retryable · 3 failed · 64 usage/u);
  assert.match(renderRootHelp(), /--version\s+Print the running package version\./u);
  assert.match(renderInstallHelp(), /install/u);
  assert.match(renderDebtHelp("add"), /usage  keiyaku debt add/u);
  assert.match(renderAkumaHelp("tell"), /usage  keiyaku tell/u);
  assert.match(renderAkumaHelp("ask"), /--wait <duration>/u);
  assert.match(renderAkumaHelp("call"), /\[--workdir <path>\]/u);
  assert.match(
    renderAkumaHelp("call"),
    /keiyaku ls aku\/ to find visible Akuma names; hidden definitions can still be called by name/u,
  );
  const showHelp = renderContractHelp("show");
  assert.match(renderRootHelp(), /show\s+Read one Contract's guidance/u);
  assert.match(showHelp, /usage  keiyaku show \[<contract>\|@<contract>\]/u);
  assert.match(showHelp, /--json/u);
  assert.doesNotMatch(showHelp, /status --guidance/u);
  const statusHelp = renderContractHelp("status");
  assert.match(statusHelp, /status \(aku\|aku\/\|aku\/\*\) \[--limit <count>\]/u);
  assert.match(statusHelp, /status \(kei\|kei\/\|kei\/\*\) \[--limit <count>\]/u);
  assert.match(statusHelp, /default 10/u);
  assert.match(statusHelp, /Contract category requires a Repo/u);
  assert.doesNotMatch(statusHelp, /guidance/u);
  assert.doesNotMatch(renderContractHelp("status"), /\bverb\b/u);
  assert.match(renderAkumaHelp("wait"), /default mode is any/u);
  const lsHelp = renderContractHelp("ls");
  assert.match(lsHelp, /--mine \| --caller \(<integration>:<id> \| aku\/<name>\/<suffix>\)/u);
  assert.match(lsHelp, /ls debt\/<namespace>\/ \[--limit <count>\]/u);
  assert.match(lsHelp, /direct and transitive descendants in this World/u);
  const settingsHelp = renderContractHelp("settings");
  assert.match(settingsHelp, /"url": "ws:\/\/127\.0\.0\.1:6767\/ws"/u);
  assert.match(settingsHelp, /native provider id is bare/u);
  assert.match(settingsHelp, /model: <native-model-id>/u);
  assert.match(settingsHelp, /effort: high/u);
  assert.match(settingsHelp, /PASEO_PASSWORD=<password> keiyaku call/u);
  assert.match(settingsHelp, /native reload\/restart create a fresh Akuma/u);
  assert.match(settingsHelp, /check\/send race/u);
  assert.match(settingsHelp, /session-wide/u);
  assert.match(settingsHelp, /never cancels later work/u);
  assert.match(settingsHelp, /Socket closure does not prove native cancellation/u);
});

test("leaf help and usage refusals share accepted invocation options", () => {
  for (const help of [
    renderContractHelp("show"),
    renderContractHelp("status"),
    renderDebtHelp("show"),
    renderAkumaHelp("tell"),
    renderInstallHelp(),
    renderHelp({ kind: "whoami" }),
  ]) {
    assert.match(help, /\[--json\]/u);
    assert.match(help, /-C <path> \| --cwd <path>/u);
  }
  for (const args of [
    ["show", "--bad"],
    ["debt", "show"],
    ["tell", "@worker"],
  ]) {
    assert.throws(
      () => parseArgv(args),
      (error: unknown) => {
        assert.ok(error instanceof CliUsageError);
        assert.match(error.guide!.accepts, /\[--json\]/u);
        assert.match(error.guide!.accepts, /-C <path> \| --cwd <path>/u);
        return true;
      },
    );
  }
  assert.match(renderContractHelp("show"), /\[--repo <path>\]/u);
  assert.match(renderAkumaHelp("history"), /history <kei\/\.\.\.> \[--full\] \[--repo <path>\]/u);
});

test("Akuma help distinguishes schema contracts, exact results, and fork points", () => {
  for (const action of ["call", "ask"] as const) {
    assert.match(renderAkumaHelp(action), /JSON Schema answer contract to the provider/u);
    assert.match(renderAkumaHelp(action), /does not independently validate schema conformance/u);
  }
  assert.match(renderAkumaHelp("call"), /status <aku\/\.\.\.\|@alias> --json to inspect status\.allowed/u);
  assert.match(renderAkumaHelp("history"), /answer or failure diagnostic/u);
  assert.match(renderAkumaHelp("fork"), /history <aku\/\.\.\.\|@alias> --json/u);
});

test("help projections reflow at the requested terminal width without splitting tokens", () => {
  const root = renderHelp({ kind: "root" }, 72);
  const history = renderHelp({ kind: "akuma", action: "history" }, 72);
  for (const help of [root, history]) {
    assert.ok(
      help.split("\n").every((line) => displayColumns(line) <= 72),
      help,
    );
  }
  assert.match(root, /usage  keiyaku <command>/u);
  assert.match(history, /usage  keiyaku history/u);
  assert.match(history, /--limit/u);
  assert.match(history, /<count>/u);
  assert.match(history, /--last/u);
});

test("help is stdout zero and does not enter an absent world", async () => {
  const { exit, stdout, stderr } = await captureOutput(() =>
    main(["-C", "/definitely/absent/keiyaku-world", "debt", "unknown", "--json", "-", "--help"]),
  );
  assert.equal(exit, 0);
  assert.match(stdout, /^usage  keiyaku debt <command>/u);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /^\{/u);
});

test("show help needs neither World nor plugins", async () => {
  const result = await captureOutput(() => main(["-C", "/definitely/absent/keiyaku-world", "show", "--help"]));
  assert.equal(result.exit, 0);
  assert.match(result.stdout, /usage  keiyaku show/u);
  assert.equal(result.stderr, "");
});

test("version is stdout zero and does not enter an absent world", () => {
  const root = resolve(import.meta.dirname, import.meta.url.endsWith(".js") ? "../.." : "..");
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  assert.equal(manifest.name, "@astrosheep/keiyaku");
  const compiled = import.meta.url.endsWith(".js");
  const cli = resolve(root, compiled ? "build/src/cli/index.js" : "src/cli/index.ts");
  const result = spawnSync(
    process.execPath,
    [...(compiled ? [] : ["--import", "tsx"]), cli, "-C", "/definitely/absent/keiyaku-world", "--version"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${manifest.version}\n`);
  assert.equal(result.stderr, "");
});

test("bare ls is a compact usage refusal even when its cwd cannot be read", async () => {
  const { exit, stdout, stderr } = await captureOutput(() => main(["-C", "/definitely/absent/keiyaku-world", "ls"]));
  assert.equal(exit, 64);
  assert.equal(stdout, "");
  assert.match(stderr, /× usage  keiyaku ls/u);
  assert.match(stderr, /ls requires a selector/u);
});
