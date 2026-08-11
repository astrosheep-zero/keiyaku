import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv, renderContractHelp, renderRootHelp } from "../src/cli/parse.js";
import { renderAkumaHelp } from "../src/cli/commands/akuma.js";
import { renderTaskHelp } from "../src/cli/commands/task.js";

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
  assert.throws(() => parseArgv(["-h"]), CliUsageError);
  assert.throws(() => parseArgv(["help"]), CliUsageError);
});

test("each grammar owner renders its own namespace and leaf help", () => {
  assert.match(renderRootHelp(), /-C, --cwd <path>  Set the invocation working directory\./u);
  assert.match(renderRootHelp(), /task \.\.\.\n    Task coordination; see `keiyaku task --help`\./u);
  assert.match(renderContractHelp("bind"), /usage: keiyaku bind \[--task <task\/\.\.\.>\]/u);
  assert.match(renderContractHelp("review"), /usage: keiyaku review .*--satisfied \| --unsatisfied/u);
  assert.match(renderTaskHelp(), /task update <TaskId>/u);
  assert.doesNotMatch(renderTaskHelp(), /--contract|--no-contract/u);
  assert.match(renderTaskHelp("compose"), /usage: keiyaku task compose \[--json\] -/u);
  assert.match(renderRootHelp(), /interrupt <aku\/\.\.\.>/u);
  assert.equal(renderAkumaHelp("call"), [
    "Call an Akuma from an Archetype and stdin body.",
    "",
    "usage: keiyaku call <akuma> [--contract <kei/...>] [--alias @name] [--workdir <path>] [--wait [--timeout <duration>] | -d | --detach] [--json] -",
  ].join("\n"));
});

test("syntax refusal retains the deepest reached grammar", () => {
  assert.throws(
    () => parseArgv(["call", "--workdir", "/tmp", "-"]),
    (error: unknown) => error instanceof CliUsageError
      && error.diagnostic === "call has invalid positional arguments"
      && error.projection === "usage: keiyaku call <akuma> [--contract <kei/...>] [--alias @name] [--workdir <path>] [--wait [--timeout <duration>] | -d | --detach] [--json] -",
  );
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
