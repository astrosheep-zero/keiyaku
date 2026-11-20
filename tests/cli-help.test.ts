import { cliExitCode } from "../src/cli/streams.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { captureOutput } from "./support/cli-fixtures.js";
import { renderRootHelp } from "../src/cli/parse.js";
import { renderContractHelp } from "../src/cli/commands/contract-help.js";
import { renderAkumaHelp } from "../src/cli/commands/akuma.js";
import { renderDebtHelp } from "../src/cli/commands/debt-grammar.js";

test("the runtime maps the six process outcomes", () => {
  const outcomes = ["accepted", "refused", "retryable", "failed", "unsatisfied", "usage"] as const;
  assert.deepEqual(outcomes.map(cliExitCode), [0, 1, 2, 3, 4, 64]);
});

test("command family and leaf help expose executable usage and flags", () => {
  assert.match(renderRootHelp(), /^usage  keiyaku <command> \[options\]$/mu);
  assert.match(renderRootHelp(), /--workdir <path>/u);
  assert.match(renderRootHelp(), /--version/u);
  assert.match(renderDebtHelp("add"), /usage  keiyaku debt add/u);
  assert.match(renderAkumaHelp("tell"), /usage  keiyaku tell/u);
  assert.match(renderAkumaHelp("ask"), /--wait <duration>/u);
  assert.match(renderAkumaHelp("spawn"), /\[--workdir <path>\]/u);
  assert.match(renderAkumaHelp("surveil"), /usage  keiyaku surveil <aku\/\.\.\.\|@name>/u);
  assert.match(renderAkumaHelp("unsurveil"), /usage  keiyaku unsurveil <aku\/\.\.\.\|@name>/u);
  const verifyHelp = renderContractHelp("verify");
  assert.match(verifyHelp, /usage  keiyaku verify/u);
  assert.match(verifyHelp, /--index <n>/u);
  const showHelp = renderContractHelp("show");
  assert.match(showHelp, /usage  keiyaku show <contract\|@name>/u);
  assert.match(showHelp, /--json/u);
  const statusHelp = renderContractHelp("status");
  assert.match(statusHelp, /status \[kei\/\.\.\.\|aku\/\.\.\.\|@name\]/u);
  const lsHelp = renderContractHelp("ls");
  assert.match(lsHelp, /--mine \[--settled \| --all\] \[--limit <count>\]/u);
  assert.match(lsHelp, /ls debt\[\/\] \[--settled \| --all\] \[--limit <count>\]/u);
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

test("verify help stays complete on a narrow TTY without a World or plugins", async () => {
  const result = await captureOutput(() => {
    Object.assign(process.stdout, { isTTY: true, columns: 12 });
    return main(["-C", "/definitely/absent/keiyaku-world", "verify", "--help"]);
  });
  assert.equal(result.exit, 0);
  assert.equal(result.stdout, `${renderContractHelp("verify").trimEnd()}\n`);
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
