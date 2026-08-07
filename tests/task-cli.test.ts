import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invoke } from "../src/cli/invoke.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { renderTaskIncompleteDiagnostic, renderTaskText, taskExitCode } from "../src/cli/render/task.js";
import type { TaskInvocationResult } from "../src/cli/commands/task.js";

function world(): string { const root = mkdtempSync(join(tmpdir(), "keiyaku-task-cli-")); mkdirSync(join(root, ".keiyaku")); return root; }

test("task parser owns subcommand arity, repeat flags, and selected stdin", () => {
  assert.deepEqual(parseArgv(["-C", "/tmp/project", "task", "add", "Ship task", "--namespace", "contract/inside", "--state", "in_progress", "--needs", "task/a", "--needs", "task/b", "--json"]), {
    cwd: "/tmp/project",
    command: { command: "task", action: "add", output: "json", positionals: ["Ship task"], flags: { namespace: "contract/inside", state: "in_progress", needs: ["task/a", "task/b"], json: true } },
  });
  assert.deepEqual(parseArgv(["task", "update", "task/a", "--append", "-"]), {
    command: { command: "task", action: "update", output: "text", positionals: ["task/a"], flags: { append: "" }, stdin: "append" },
  });
  assert.deepEqual(parseArgv(["task", "update", "task/a", "--note", "-"]), {
    command: { command: "task", action: "update", output: "text", positionals: ["task/a"], flags: { note: "" }, stdin: "note" },
  });
  assert.equal(parseArgv(["task", "compose", "-"]).command.command, "task");
  assert.throws(() => parseArgv(["task", "add", "Title", "-"]), CliUsageError);
  assert.throws(() => parseArgv(["task", "add", "--state", "done", "-"]), CliUsageError);
  assert.throws(() => parseArgv(["task", "ls", "--closed", "--all"]), CliUsageError);
  assert.throws(() => parseArgv(["task", "update", "task/a"]), CliUsageError);
});
test("task invocation works outside Git and consumes stdin only when selected", async () => {
  const root = world(); let reads = 0;
  const add = await invoke(parseArgv(["-C", root, "task", "add", "Native CLI", "--state", "on_hold", "--note", "initial", "--contract", "external #7"]), { readStdin: () => { reads += 1; return "unused"; } }) as TaskInvocationResult;
  assert.equal((add as { kind: string }).kind, "accepted"); assert.equal(reads, 0);
  const update = await invoke(parseArgv(["-C", root, "task", "update", "task/native-cli", "--body", "-"]), { readStdin: () => { reads += 1; return "body from stdin\n"; } }) as TaskInvocationResult;
  assert.equal((update as { kind: string }).kind, "accepted"); assert.equal(reads, 1);
  const shown = await invoke(parseArgv(["-C", root, "task", "show", "task/native-cli"])) as TaskInvocationResult;
  assert.equal((shown as { task: { body: string; contractId: string } }).task.body, "body from stdin\n");
  assert.equal((shown as { task: { body: string; contractId: string } }).task.contractId, "external #7");
  assert.equal((shown as { task: { state: string } }).task.state, "on_hold");
  assert.equal((shown as { task: { note: string } }).task.note, "initial");

  const noteUpdate = await invoke(parseArgv(["-C", root, "task", "update", "task/native-cli", "--note", "-"]), { readStdin: () => { reads += 1; return "replacement"; } }) as TaskInvocationResult;
  assert.equal((noteUpdate as { kind: string }).kind, "accepted"); assert.equal(reads, 2);
  const noteShown = await invoke(parseArgv(["-C", root, "task", "show", "task/native-cli"])) as TaskInvocationResult;
  assert.equal((noteShown as { task: { note: string } }).task.note, "replacement");
  const showCommand = parseArgv(["task", "show", "task/native-cli"]).command;
  if (showCommand.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(showCommand, noteShown), /createdAt: .*\nupdatedAt: .*\nnote: replacement/u);

  const document = "---\ntitle: From document\nstate: done\n---\ncreated closed\n";
  const documentAdd = await invoke(parseArgv(["-C", root, "task", "add", "-"]), { readStdin: () => document }) as TaskInvocationResult;
  assert.equal((documentAdd as { kind: string }).kind, "accepted");
  const documentShown = await invoke(parseArgv(["-C", root, "task", "show", "task/from-document"])) as TaskInvocationResult;
  assert.equal((documentShown as { task: { state: string } }).task.state, "done");
});

test("task drop note is passed to each independent lifecycle mutation", async () => {
  const root = world();
  await invoke(parseArgv(["-C", root, "task", "add", "First"]));
  await invoke(parseArgv(["-C", root, "task", "add", "Second"]));
  const result = await invoke(parseArgv(["-C", root, "task", "drop", "task/first", "task/second", "--note", "cancelled"])) as TaskInvocationResult;
  assert.equal(taskExitCode(result), 0);
  for (const id of ["task/first", "task/second"]) {
    const shown = await invoke(parseArgv(["-C", root, "task", "show", id])) as TaskInvocationResult;
    assert.equal((shown as { task: { note: string } }).task.note, "cancelled");
  }
});

test("task compose and views flow through native results", async () => {
  const root = world();
  const composed = await invoke(parseArgv(["-C", root, "task", "compose", "-"]), { readStdin: () => "+ Parent\n  + Child\n" }) as TaskInvocationResult;
  assert.equal((composed as { kind: string }).kind, "accepted");
  const listed = await invoke(parseArgv(["-C", root, "task", "ls"])) as TaskInvocationResult;
  const command = parseArgv(["task", "ls"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(command, listed), /task\/parent - P2 - ready - Parent/u);
  assert.equal(taskExitCode(listed), 0);
});

test("task doctor renders graph disease and controls exit status", async () => {
  const root = world();
  await invoke(parseArgv(["-C", root, "task", "add", "First"]));
  await invoke(parseArgv(["-C", root, "task", "add", "Second"]));
  await invoke(parseArgv(["-C", root, "task", "update", "task/first", "--needs", "task/second"]));
  await invoke(parseArgv(["-C", root, "task", "update", "task/second", "--needs", "task/first"]));
  const result = await invoke(parseArgv(["-C", root, "task", "doctor"])) as TaskInvocationResult;
  const command = parseArgv(["task", "doctor"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(command, result), /needs cycle: task\/first -> task\/second/u);
  assert.equal(taskExitCode(result), 1);
});

test("incomplete compose rendering keeps draft on stdout and diagnostics separate", () => {
  const command = parseArgv(["task", "compose", "-"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  const result = {
    kind: "incomplete" as const,
    documentChanges: [{ taskId: "task/a" as const, kind: "created" as const, documentDiff: "diff bytes" }],
    stopped: { kind: "retry" as const, reason: "busy" as const },
    draft: "ns=\n+ Remaining body=\n",
  };
  assert.equal(renderTaskText(command, result), "");
  assert.equal(renderTaskIncompleteDiagnostic(result), 'incomplete {"kind":"retry","reason":"busy"}\ndiff bytes');
  assert.equal(taskExitCode(result), 1);
});
