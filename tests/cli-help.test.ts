import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli/main.js";
import {
  CONTRACT_COMMAND_SPECS,
  type ContractCommand,
  type ContractCommandSpec,
} from "../src/cli/commands/contract.js";
import { CliUsageError, parseArgv, renderContractHelp, renderHelp, renderRootHelp } from "../src/cli/parse.js";
import { renderAkumaHelp } from "../src/cli/commands/akuma.js";
import { renderInstallHelp } from "../src/cli/commands/install.js";
import { renderTaskHelp } from "../src/cli/commands/task.js";
import { usageLine } from "../src/cli/usage.js";
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

test("each grammar owner renders its own namespace and leaf help", () => {
  assert.match(renderRootHelp(), /^keiyaku — Contract, Task, and Akuma control for one repository$/mu);
  assert.match(renderRootHelp(), /^usage: keiyaku <command> \[options\]$/mu);
  assert.match(renderRootHelp(), /^Contract — standing acceptance$/mu);
  assert.match(renderRootHelp(), /^Task — plan memory$/mu);
  assert.match(renderRootHelp(), /^Akuma — invoke capability$/mu);
  assert.match(renderRootHelp(), /^Workspace$/mu);
  assert.match(renderRootHelp(), /^  install   Install Keiyaku into coding harnesses$/mu);
  assert.match(renderRootHelp(), /^  settings  Show effective Settings \(user \+ project, read-only\)$/mu);
  assert.match(renderRootHelp(), /-C, --cwd <path>  Set the invocation working directory\./u);
  assert.match(renderRootHelp(), /--repo <path>     Select the Git repository coordinate\./u);
  assert.match(renderRootHelp(), /task\s+Task coordination; see `keiyaku task --help`\./u);
  assert.match(
    renderInstallHelp(),
    /Install Keiyaku into your coding harnesses via each harness's native plugin\/package installer\. --all continues past failures; any failure exits 1\./u,
  );
  const settingsHelp = renderContractHelp("settings");
  assert.match(settingsHelp, /^Show effective Settings — the merged read-only view of:$/mu);
  assert.match(settingsHelp, /^  user      ~\/\.keiyaku\/settings\.json$/mu);
  assert.match(settingsHelp, /^  project   <WorldRoot>\/\.keiyaku\/settings\.json$/mu);
  assert.match(settingsHelp, /A project record wholly shadows the same-name user record\./u);
  assert.match(settingsHelp, /Shape: namespace -> entry -> JSON value\. There is no write/u);
  assert.match(settingsHelp, /^Recognized settings:$/mu);
  assert.match(settingsHelp, /^  providers\s+the available Akuma and how each is run$/mu);
  assert.match(settingsHelp, /A rejected\nvalue's diagnostic states the expected shape\./u);
  assert.match(settingsHelp, /^usage: keiyaku settings \[--json\]$/mu);
  assert.match(renderContractHelp("bind"), /usage: keiyaku bind \[--task <task\/\.\.\.>\]/u);
  assert.match(renderContractHelp("bind"), /stdin is Contract Markdown:/u);
  assert.match(renderContractHelp("bind"), /Region uses one closed fence with no info string or exactly 'txt'/u);
  assert.match(renderContractHelp("bind"), /Verification uses one or more closed bash, zsh, or pwsh fences/u);
  assert.match(renderContractHelp("deliver"), /--message <text>\] \[--include-dirty\] \[--materialize-conflict\]/u);
  assert.match(renderContractHelp("review"), /usage: keiyaku review .*--satisfied \| --unsatisfied/u);
  assert.match(renderContractHelp("show"), /usage: keiyaku show \[<contract>\|@<contract>\] \[--json\]/u);
  assert.match(renderContractHelp("ls"), /usage: keiyaku ls task\[\/\] \[--limit <count>\] \[--json\]/u);
  assert.doesNotMatch(renderContractHelp("ls"), /--all/u);
  assert.match(renderTaskHelp(), /task update <TaskId>/u);
  assert.match(renderTaskHelp("tree"), /usage: keiyaku task tree <TaskId>/u);
  assert.match(renderTaskHelp("update"), /--body <text>\|- \| --append <text>/u);
  assert.doesNotMatch(renderTaskHelp("update"), /--append <text>\|-|--note <text>\|-/u);
  assert.doesNotMatch(renderTaskHelp(), /--full/u);
  assert.doesNotMatch(renderTaskHelp(), /--contract|--no-contract/u);
  assert.match(renderTaskHelp("compose"), /usage: keiyaku task compose \[--actor <actor>\] \[--plan\] \[--json\] -/u);
  assert.match(renderTaskHelp("add"), /--actor <actor>/u);
  assert.doesNotMatch(renderTaskHelp("update"), /--actor/u);
  assert.doesNotMatch(renderTaskHelp("start"), /--actor/u);
  assert.doesNotMatch(renderTaskHelp("done"), /--actor/u);
  assert.doesNotMatch(renderTaskHelp(), /KEIYAKU_PROJECTION_ID/u);
  assert.match(renderTaskHelp("compose"), /references: @task\/\.\.\. is pre-existing/u);
  assert.match(renderTaskHelp("ready"), /open Tasks whose every need is terminal/u);
  assert.doesNotMatch(renderRootHelp(), /^  interrupt /mu);
  assert.match(renderRootHelp(), /tell\s+Send one prompt to an existing Akuma/u);
  assert.equal(
    renderAkumaHelp("tell"),
    [
      "Send one prompt to an existing Akuma and wake it.",
      "",
      "usage: keiyaku tell <aku/...|@alias> [--interrupt] [--schema <file>] [--json] (<prompt> | -)",
      "",
      "Give <prompt> as one argument, or use - to read stdin.",
      "--interrupt ends the current Body before recording the prompt and waking its successor.",
      "--schema reads a JSON Schema file for the answer contract; stdin remains the prompt source.",
    ].join("\n"),
  );
  assert.match(renderAkumaHelp("history"), /\[--limit <count>\] \[--last\]/u);
  assert.doesNotMatch(renderAkumaHelp("call"), /final -/u);
  assert.doesNotMatch(renderAkumaHelp("tell"), /final -/u);
  assert.doesNotMatch(renderRootHelp(), /final -/u);
  assert.doesNotMatch(renderTaskHelp("add"), /final -/u);
  assert.doesNotMatch(renderTaskHelp("compose"), /final -/u);
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
  assert.match(history, /usage: keiyaku history/u);
  assert.match(history, /--limit/u);
  assert.match(history, /<count>/u);
  assert.match(history, /--last/u);
});

test("amend leaf help enumerates the operation grammar", () => {
  const help = renderContractHelp("amend");
  assert.match(
    help,
    /usage: keiyaku amend \[<contract>\|@<contract>\] \[--after <kei\/\.\.\.> \.\.\. \| --clear-after\] \[--gates <name,\.\.\.>\] \[--actor <actor>\] \[--json\] \[-\]/u,
  );
  assert.match(help, /## Replace: Context\|Objective\|Design\|Region\|Criteria\|Verification\|<extension>/u);
  assert.match(help, /## Append: Context\|Objective\|Design\|Criteria\|<extension>/u);
  assert.match(help, /## Add: Criteria\|<new-extension-title>/u);
  assert.match(help, /## Update: <existing-extension-title>/u);
  assert.match(help, /## Remove: <existing-extension-title>/u);
});

test("deliver leaf help explains candidate capture, placement, review, and conflict continuation", () => {
  const help = renderContractHelp("deliver");
  assert.match(help, /The subject is the whole Contract\. An Arc names the chapter/u);
  assert.match(help, /--include-dirty captures the complete final\s+non-ignored worktree bytes through a private index/u);
  assert.match(help, /shared index\s+is unmerged \(UU\); the branch and real index stay untouched/u);
  assert.match(help, /Delivering again replaces the candidate and stales any earlier review/u);
  assert.match(help, /Deliver never satisfies a review gate/u);
  assert.match(help, /--materialize-conflict[\s\S]*preserved\s+as the handoff base/u);
  assert.match(help, /After conflict resolution,[\s\S]*without git add or commit/u);
  assert.doesNotMatch(renderRootHelp(), /Capture the complete non-ignored worktree tree/u);
});

test("review leaf help distinguishes pre-delivery testimony from placement", () => {
  const help = renderContractHelp("review");
  assert.match(help, /delivered candidate if one exists, or the current\s+document and worktree state/u);
  assert.match(
    help,
    /Pre-delivery review is real\s+testimony[\s\S]*without a delivered\s+candidate it can never place/u,
  );
  assert.match(help, /a verdict that places cannot be taken back/u);
  assert.match(help, /Verify the complete current subject first, then testify/u);
  assert.match(help, /--unsatisfied records what is not met and never requests placement/u);
});

test("supplemental Contract help is owned by command specs", () => {
  assert.doesNotMatch(renderRootHelp(), /stdin operations/u);
  for (const command of (Object.keys(CONTRACT_COMMAND_SPECS) as ContractCommand[]).filter(
    (command) => command !== "settings",
  )) {
    const spec: ContractCommandSpec = CONTRACT_COMMAND_SPECS[command];
    const expected = `${spec.purpose}\n\n${usageLine(spec.usage)}${spec.details === undefined ? "" : `\n\n${spec.details}`}`;
    assert.equal(renderContractHelp(command), expected);
  }
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

test("amend syntax refusal keeps the stored usage block", () => {
  assert.throws(
    () => parseArgv(["amend"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message.includes("amend requires stdin or --after, --clear-after, or --gates") &&
      error.message.includes("usage: keiyaku amend [<contract>|@<contract>]") &&
      !error.message.includes("minimal stdin"),
  );
});

test("syntax refusal retains the deepest reached grammar", () => {
  assert.throws(
    () => parseArgv(["task", "unknown"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      error.message.includes("usage: keiyaku task <command>") &&
      error.message.includes("task show <TaskId>"),
  );
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
  assert.match(stdout, /^usage: keiyaku task <command>/u);
  assert.equal(stderr, "");
  assert.doesNotMatch(stdout, /^\{/u);
});

test("amend help resolves at the parser edge for an absent world", () => {
  assert.deepEqual(parseArgv(["-C", "/definitely/absent/keiyaku-world", "amend", "--json", "-", "--help"]), {
    help: { kind: "contract", command: "amend" },
  });
});

async function captureMain(
  argv: readonly string[],
): Promise<Readonly<{ exit: number; stdout: string; stderr: string }>> {
  let stdout = "";
  let stderr = "";
  const writeStdout = process.stdout.write;
  const writeStderr = process.stderr.write;
  const forwardStdout = writeStdout.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk !== "string") return forwardStdout(chunk);
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { exit: await main(argv), stdout, stderr };
  } finally {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
  }
}

test("ordinary CLI help, usage, and JSON end with one LF", async () => {
  const help = await captureMain(["--help"]);
  assert.equal(help.exit, 0);
  assert.equal(renderRootHelp().endsWith("\n"), false);
  assert.equal(help.stdout, `${renderRootHelp()}\n`);
  assert.equal(help.stderr, "");

  const usage = await captureMain([]);
  assert.equal(usage.exit, 1);
  assert.equal(usage.stdout, "");
  assert.equal(usage.stderr.endsWith("\n"), true);
  assert.equal(usage.stderr.endsWith("\n\n"), false);
  assert.match(usage.stderr, /^unknown command: \nkeiyaku — Contract, Task, and Akuma control/u);

  const json = await captureMain(["-C", mkdtempSync(join(tmpdir(), "keiyaku-cli-lf-")), "task", "ls", "--json"]);
  assert.equal(json.exit, 1);
  assert.equal(json.stdout, '{"kind":"absent"}\n');
  assert.equal(json.stderr, "");
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
  assert.match(stdout, /^List one identity directory\.\n\nusage: keiyaku ls task\[\/\]/u);
  assert.equal(stderr, "");
});
