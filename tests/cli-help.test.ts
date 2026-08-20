import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { CONTRACT_COMMAND_SPECS, type ContractCommand } from "../src/cli/commands/contract.js";
import { CliUsageError, parseArgv, renderContractHelp, renderRootHelp } from "../src/cli/parse.js";
import { renderAkumaHelp, type AkumaAction } from "../src/cli/commands/akuma.js";
import { renderInstallHelp } from "../src/cli/commands/install.js";
import { renderTaskHelp, type TaskAction } from "../src/cli/commands/task.js";
import { usageLine } from "../src/cli/usage.js";

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
  assert.match(renderRootHelp(), /-C, --cwd <path>  Set the invocation working directory\./u);
  assert.match(renderRootHelp(), /--repo <path>     Select the Git repository coordinate\./u);
  assert.match(renderRootHelp(), /task \.\.\.\n    Task coordination; see `keiyaku task --help`\./u);
  assert.match(renderContractHelp("bind"), /usage: keiyaku bind \[--task <task\/\.\.\.>\]/u);
  assert.match(renderContractHelp("deliver"), /--message <text>\] \[--include-dirty\] \[--materialize-conflict\]/u);
  assert.match(renderContractHelp("review"), /usage: keiyaku review .*--satisfied \| --unsatisfied/u);
  assert.equal(renderContractHelp("show"), [
    "Read one Contract guidance projection.",
    "",
    "usage: keiyaku show [<contract>|@<contract>]",
  ].join("\n"));
  assert.equal(renderContractHelp("ls"), [
    "List one identity directory.",
    "",
    "usage: keiyaku ls task[/]",
    "       keiyaku ls kei[/]",
    "       keiyaku ls aku[/]",
    "       keiyaku ls aku/<akuma>[/]",
    "       keiyaku ls \"aku/*/*\"",
  ].join("\n"));
  assert.match(renderTaskHelp(), /task update <TaskId>/u);
  assert.match(renderTaskHelp("tree"), /usage: keiyaku task tree <TaskId>/u);
  assert.doesNotMatch(renderTaskHelp(), /--full/u);
  assert.doesNotMatch(renderTaskHelp(), /--contract|--no-contract/u);
  assert.match(renderTaskHelp("compose"), /usage: keiyaku task compose \[--actor <actor>\] -/u);
  assert.match(renderTaskHelp("add"), /--actor <actor>/u);
  assert.doesNotMatch(renderTaskHelp("update"), /--actor/u);
  assert.doesNotMatch(renderTaskHelp("start"), /--actor/u);
  assert.doesNotMatch(renderTaskHelp("done"), /--actor/u);
  assert.doesNotMatch(renderTaskHelp(), /KEIYAKU_PROJECTION_ID/u);
  assert.match(renderTaskHelp("compose"), /documents independently; partial admission has no cross-file atomicity or rollback/u);
  assert.match(renderTaskHelp("ready"), /open Tasks whose every need is terminal/u);
  assert.doesNotMatch(renderRootHelp(), /^  interrupt /mu);
  assert.match(renderRootHelp(), /tell <aku\/\.\.\.|@alias> \[--interrupt\]/u);
  assert.equal(renderAkumaHelp("tell"), [
    "Send one prompt to an existing Akuma and wake it.",
    "",
    "usage: keiyaku tell <aku/...|@alias> [--interrupt] (<prompt> | -)",
    "",
    "Give <prompt> as one argument, or use final - to read stdin.",
    "--interrupt ends the current Body before recording the prompt and waking its successor.",
  ].join("\n"));
  assert.match(renderAkumaHelp("history"), /\[--limit <count>\] \[--last\]/u);
});

test("amend leaf help enumerates the operation grammar", () => {
  assert.equal(renderContractHelp("amend"), [
    "Amend one Contract's document operations or structured terms.",
    "",
    "usage: keiyaku amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name,...>] [--actor <actor>] [-]",
    "",
    "stdin operations (H2 sections only, no H1):",
    "  ## Replace: Context|Objective|Design|Region|Criteria|Verification|<extension>",
    "  ## Append: Context|Objective|Design|Criteria|<extension>",
    "  ## Add: Criteria|<new-extension-title>",
    "  ## Update: Criterion <existing-title>|<existing-extension-title>",
    "  ## Remove: Criterion <existing-title>|<existing-extension-title>",
    "",
    "full operation grammar: docs/document.md, Amend Operations",
  ].join("\n"));
});

test("only amend leaf help carries the operation grammar", () => {
  assert.doesNotMatch(renderRootHelp(), /stdin operations/u);
  for (const command of Object.keys(CONTRACT_COMMAND_SPECS) as ContractCommand[]) {
    if (command === "amend") continue;
    const spec = CONTRACT_COMMAND_SPECS[command];
    assert.equal(renderContractHelp(command), `${spec.purpose}\n\n${usageLine(spec.usage)}`);
    assert.doesNotMatch(renderContractHelp(command), /stdin operations/u);
  }
});

test("amend syntax refusal keeps the stored usage block", () => {
  assert.throws(
    () => parseArgv(["amend"]),
    (error: unknown) => error instanceof CliUsageError
      && error.message.includes("amend requires stdin or --after, --clear-after, or --gates")
      && error.message.includes("usage: keiyaku amend [<contract>|@<contract>]")
      && !error.message.includes("minimal stdin"),
  );
});

test("syntax refusal retains the deepest reached grammar", () => {
  assert.throws(
    () => parseArgv(["task", "unknown"]),
    (error: unknown) => error instanceof CliUsageError
      && error.message.includes("usage: keiyaku task <command>")
      && error.message.includes("task show <TaskId>"),
  );
});

test("help is stdout zero and does not enter an absent world", async () => {
  let stdout = "";
  let stderr = "";
  const writeStdout = process.stdout.write;
  const writeStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
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
  assert.deepEqual(
    parseArgv(["-C", "/definitely/absent/keiyaku-world", "amend", "--json", "-", "--help"]),
    { help: { kind: "contract", command: "amend" } },
  );
});

test("bare ls is help-only even when its cwd cannot be read", async () => {
  let stdout = "";
  let stderr = "";
  const writeStdout = process.stdout.write;
  const writeStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    assert.equal(await main(["-C", "/definitely/absent/keiyaku-world", "ls"]), 0);
  } finally {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
  }
  assert.match(stdout, /^List one identity directory\.\n\nusage: keiyaku ls task\[\/\]/u);
  assert.equal(stderr, "");
});
