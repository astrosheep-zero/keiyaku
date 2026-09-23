import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
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
  assert.deepEqual(parseArgv(["ls"]), { help: { kind: "contract", command: "ls" } });
  assert.deepEqual(parseArgv(["ls", "--json"]), { help: { kind: "contract", command: "ls" } });
  assert.throws(() => parseArgv(["-h"]), CliUsageError);
  assert.throws(() => parseArgv(["help"]), CliUsageError);
});

test("namespace and leaf help identify an executable command", () => {
  assert.match(renderRootHelp(), /^usage  keiyaku <command> \[options\]$/mu);
  assert.match(renderRootHelp(), /--workdir <path>/u);
  assert.match(renderRootHelp(), /--version\s+Print the running package version\./u);
  assert.match(renderInstallHelp(), /install/u);
  assert.match(renderTaskHelp("add"), /usage  keiyaku task add/u);
  assert.match(renderAkumaHelp("tell"), /usage  keiyaku tell/u);
  assert.match(renderAkumaHelp("tell"), /--wait <duration>/u);
  assert.match(renderAkumaHelp("call"), /\[--workdir <path>\]/u);
  assert.match(renderAkumaHelp("call"), /relative path is relative to the invocation cwd/u);
  assert.match(renderAkumaHelp("call"), /Default: return after birth without waiting/u);
  assert.match(renderAkumaHelp("call"), /Explicit --wait observes the first work/u);
  assert.doesNotMatch(renderAkumaHelp("call"), /--detach|\s-d(?:\s|\])/u);
  assert.match(renderAkumaHelp("call"), /--contract associates .*never selects a workdir/u);
  assert.match(renderAkumaHelp("call"), /uses the invocation cwd whether or not --contract is present/u);
  const auditHelp = renderContractHelp("audit");
  assert.match(auditHelp, /\[--show-diff\]/u);
  assert.doesNotMatch(auditHelp, /\[--diff\]/u);
  assert.match(renderContractHelp("status"), /execution workdir/u);
  assert.match(renderAkumaHelp("call"), /Default actions: .*contract\.deliver.*task\.update/u);
  assert.doesNotMatch(renderAkumaHelp("call").match(/Default actions: .*/u)?.[0] ?? "", /contract\.review/u);
  assert.match(renderContractHelp("bind"), /stdin is Contract Markdown/u);
  assert.match(renderContractHelp("bind"), /existing owner modules\/entry points.*critical ordering/u);
  assert.match(renderContractHelp("bind"), /narrowest justified intended writes for this approach/u);
  const settingsHelp = renderContractHelp("settings");
  assert.match(settingsHelp, /^Akuma definitions are Markdown files, one per name:$/mu);
  assert.match(settingsHelp, /^  user      ~\/\.keiyaku\/akuma\/<name>\.md$/mu);
  assert.match(settingsHelp, /^  project   <WorldRoot>\/\.keiyaku\/akuma\/<name>\.md$/mu);
  assert.match(settingsHelp, /^usage  keiyaku settings$/mu);
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
  assert.match(root, /bind\s+Create one Contract/u);
  assert.match(history, /usage  keiyaku history/u);
  assert.match(history, /--limit/u);
  assert.match(history, /<count>/u);
  assert.match(history, /--last/u);
});

test("help is stdout zero and does not enter an absent world", async () => {
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
    const exit = await main(["-C", "/definitely/absent/keiyaku-world", "task", "unknown", "--json", "-", "--help"]);
    assert.equal(exit, 0);
  } finally {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
  }
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

test("bare ls is help-only even when its cwd cannot be read", async () => {
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
    assert.equal(await main(["-C", "/definitely/absent/keiyaku-world", "ls"]), 0);
  } finally {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
  }
  assert.match(stdout, /^List one identity directory\.\n\nusage  keiyaku ls task\[\/\]/u);
  assert.equal(stderr, "");
});
