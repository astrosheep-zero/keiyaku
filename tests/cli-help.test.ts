import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { captureOutput } from "./support/cli-fixtures.js";
import { CliUsageError, parseArgv, renderContractHelp, renderHelp, renderRootHelp } from "../src/cli/parse.js";
import { renderAkumaHelp } from "../src/cli/commands/akuma.js";
import { renderInstallHelp } from "../src/cli/commands/install.js";
import { renderTaskHelp } from "../src/cli/commands/task.js";
import { displayColumns } from "../src/cli/render/terminal.js";

test("help resolves the longest legal command-word prefix before syntax scanning", () => {
  assert.deepEqual(parseArgv(["--help"]), { help: { kind: "root" } });
  assert.deepEqual(parseArgv(["bind", "--unknown", "--help", "-"]), {
    help: { kind: "contract", command: "bind" },
  });
  assert.deepEqual(parseArgv(["task", "unknown", "--help"]), { help: { kind: "task" } });
  assert.deepEqual(parseArgv(["task", "show", "bad", "--help"]), {
    help: { kind: "task", action: "show" },
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
  assert.match(renderRootHelp(), /--workdir <path>/u);
  assert.match(renderRootHelp(), /Outcomes:  exit 0 accepted · 1 refused · 2 retry · 3 failed · 64 usage/u);
  assert.match(renderRootHelp(), /--version\s+Print the running package version\./u);
  assert.match(renderInstallHelp(), /install/u);
  assert.match(renderTaskHelp("add"), /usage  keiyaku task add/u);
  assert.match(renderAkumaHelp("tell"), /usage  keiyaku tell/u);
  assert.match(renderAkumaHelp("ask"), /--wait <duration>/u);
  assert.match(renderAkumaHelp("call"), /\[--workdir <path>\]/u);
  assert.match(
    renderAkumaHelp("call"),
    /keiyaku ls aku\/ to find visible Akuma names; hidden definitions can still be called by name/u,
  );
  assert.match(renderContractHelp("status"), /--guidance reads one Contract's guidance/u);
  assert.doesNotMatch(renderContractHelp("status"), /\bverb\b/u);
  assert.match(renderAkumaHelp("wait"), /default mode is any/u);
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
    main(["-C", "/definitely/absent/keiyaku-world", "task", "unknown", "--json", "-", "--help"]),
  );
  assert.equal(exit, 0);
  assert.match(stdout, /^usage  keiyaku task <command>/u);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /^\{/u);
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
