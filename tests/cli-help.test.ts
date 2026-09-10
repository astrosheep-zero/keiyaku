import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { CONTRACT_COMMAND_SPECS, type ContractCommand } from "../src/cli/commands/contract.js";
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
  assert.match(renderInstallHelp(), /install/u);
  assert.match(renderTaskHelp("add"), /usage  keiyaku task add/u);
  assert.match(renderAkumaHelp("tell"), /usage  keiyaku tell/u);
  assert.match(renderContractHelp("bind"), /stdin is Contract Markdown/u);
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

test("amend leaf help enumerates the operation grammar", () => {
  const help = renderContractHelp("amend");
  assert.match(
    help,
    /usage  keiyaku amend \[<contract>\|@<contract>\] \[--after <kei\/\.\.\.> \.\.\. \| --clear-after\] \[--gates <name,\.\.\.>\] \[--actor <actor>\] \[--json\] \[-\]/u,
  );
  assert.match(help, /## Replace: Context\|Objective\|Design\|Region\|Criteria\|Verification\|<extension>/u);
  assert.match(help, /## Append: Context\|Objective\|Design\|Criteria\|<extension>/u);
  assert.match(help, /## Add: Criteria\|<new-extension-title>/u);
  assert.match(help, /## Update: <existing-extension-title>/u);
  assert.match(help, /## Remove: <existing-extension-title>/u);
});

test("deliver and review leaf help retain their distinct recovery and placement facts", () => {
  const deliver = renderContractHelp("deliver");
  assert.match(deliver, /--materialize-conflict[\s\S]*preserved\s+as the handoff base/u);

  const review = renderContractHelp("review");
  assert.match(review, /Pre-delivery review is real\s+testimony[\s\S]*without a delivered\s+candidate it can never place/u);
  assert.match(review, /A blocked placement leaves the verdict recorded and the Contract active/u);
});

test("Akuma call and tell help expose schema files", () => {
  assert.match(renderAkumaHelp("call"), /--schema <file>/u);
  assert.match(renderAkumaHelp("tell"), /--schema <file>/u);
  assert.match(renderAkumaHelp("tell"), /stdin remains the prompt source/u);
});

test("help contains no Markdown file pointers", () => {
  const help = [
    renderRootHelp(),
    ...Object.keys(CONTRACT_COMMAND_SPECS).map((command) => renderContractHelp(command as ContractCommand)),
    renderTaskHelp(),
    ...(["tell", "history"] as const).map((action) => renderAkumaHelp(action)),
    renderInstallHelp(),
  ].join("\n");
  assert.doesNotMatch(help, /(?:docs\/|\.md\b)/u);
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

test("amend help resolves at the parser edge for an absent world", () => {
  assert.deepEqual(parseArgv(["-C", "/definitely/absent/keiyaku-world", "amend", "--json", "-", "--help"]), {
    help: { kind: "contract", command: "amend" },
  });
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
