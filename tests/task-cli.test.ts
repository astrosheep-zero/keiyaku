import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invoke } from "../src/cli/invoke.js";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { renderTaskIncompleteDiagnostic, renderTaskText, taskExitCode } from "../src/cli/render/task.js";
import type { TaskInvocationResult } from "../src/cli/commands/task-invoke.js";
import { makeGitRepository } from "./support/git.js";

function world(): string { const root = mkdtempSync(join(tmpdir(), "keiyaku-task-cli-")); mkdirSync(join(root, ".keiyaku")); return root; }

async function runMain(argv: readonly string[]): Promise<Readonly<{ exit: number; stdout: string; stderr: string }>> {
  let stdout = "", stderr = "";
  const writeStdout = process.stdout.write, writeStderr = process.stderr.write;
  const forwardStdout = writeStdout.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk !== "string") return forwardStdout(chunk);
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { exit: await main(argv), stdout, stderr }; }
  finally { process.stdout.write = writeStdout; process.stderr.write = writeStderr; }
}

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
  const query = parseArgv(["task", "query", "--where", "priority <= 1 and not state = done", "--sort", "updated", "--limit", "10"]);
  assert.equal(query.command.command, "task");
  if (query.command.command === "task") assert.equal(query.command.where?.kind, "and");
  assert.throws(() => parseArgv(["task", "query", "--where", "prioty = 1"]), /unknown query field/u);
  assert.throws(() => parseArgv(["task", "query", "--where", "title ~ auth"]), /double quotes/u);
  assert.throws(() => parseArgv(["task", "query", "--limit", "0"]), /--limit/u);
  assert.throws(() => parseArgv(["task", "ready", "--parent", "not-a-task"]), /--parent/u);
});

test("Task commands reject the removed Contract association flags", () => {
  assert.throws(() => parseArgv(["task", "add", "Old association", "--contract", "kei/example"]), /option --contract is not valid for task add/u);
  assert.throws(() => parseArgv(["task", "update", "task/example", "--no-contract"]), /option --no-contract is not valid for task update/u);
});
test("task invocation works outside Git and consumes stdin only when selected", async () => {
  const root = world(); let reads = 0;
  const add = await invoke(parseArgv(["-C", root, "task", "add", "Native CLI", "--state", "on_hold", "--note", "initial"]), { readStdin: () => { reads += 1; return "unused"; } }) as TaskInvocationResult;
  assert.equal((add as { kind: string }).kind, "accepted"); assert.equal(reads, 0);
  const update = await invoke(parseArgv(["-C", root, "task", "update", "task/native-cli", "--body", "-"]), { readStdin: () => { reads += 1; return "body from stdin\n"; } }) as TaskInvocationResult;
  assert.equal((update as { kind: string }).kind, "accepted"); assert.equal(reads, 1);
  const shown = await invoke(parseArgv(["-C", root, "task", "show", "task/native-cli"])) as TaskInvocationResult;
  assert.equal((shown as { task: { body: string } }).task.body, "body from stdin\n");
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

test("Task, Settings, and Kanshi share the primary WorldRoot across Git worktrees", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Keiyaku Test"]);
  repository.run(["config", "user.email", "keiyaku@example.invalid"]);
  repository.run(["commit", "--quiet", "--allow-empty", "-m", "initial"]);
  const linked = mkdtempSync(join(tmpdir(), "keiyaku-task-linked-"));
  repository.run(["worktree", "add", "--quiet", "--detach", linked]);

  const added = await invoke(parseArgv(["-C", linked, "task", "add", "Shared worktree task"])) as TaskInvocationResult;
  assert.equal((added as { kind: string }).kind, "accepted");
  const shown = await invoke(parseArgv(["-C", repository.path, "task", "show", "task/shared-worktree-task"])) as TaskInvocationResult;
  assert.equal((shown as { task: { title: string } }).task.title, "Shared worktree task");
  assert.equal(existsSync(join(linked, ".keiyaku", "tasks")), false);
  await invoke(parseArgv(["-C", linked, "task", "namespace", "contract/shared"]));
  const namespace = await invoke(parseArgv(["-C", repository.path, "task", "namespace"]));
  assert.deepEqual(namespace, { kind: "accepted", value: ["contract", "shared"] });

  const settings = await invoke(parseArgv(["-C", linked, "settings"]));
  if (settings.kind !== "settings") throw new Error("expected settings result");
  const primary = realpathSync(repository.path);
  assert.equal(settings.value.scopes.project.path, join(primary, ".keiyaku", "settings.json"));

  const status = await invoke(parseArgv(["-C", linked, "status"]));
  if (status.kind !== "status") throw new Error("expected status result");
  assert.equal(status.report.root, primary);
  assert.equal(status.report.tasks.kind, "present");
  if (status.report.tasks.kind !== "present") throw new Error("expected Task section");
  assert.equal(status.report.tasks.value.rows.some((row) => row.id === "task/shared-worktree-task"), true);
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

test("task done note is passed to each independent lifecycle mutation", async () => {
  const root = world();
  await invoke(parseArgv(["-C", root, "task", "add", "First"]));
  await invoke(parseArgv(["-C", root, "task", "add", "Second"]));
  const result = await invoke(parseArgv(["-C", root, "task", "done", "task/first", "task/missing", "task/second", "--note", "finished"])) as TaskInvocationResult;
  assert.equal(taskExitCode(result), 1);
  if (!("items" in result)) throw new Error("expected batch result");
  assert.deepEqual(result.items.map((item) => item.outcome.kind), ["accepted", "refused", "accepted"]);
  assert.equal((await invoke(parseArgv(["-C", root, "task", "show", "task/first"])) as { task: { note: string; state: string } }).task.note, "finished");
  assert.equal((await invoke(parseArgv(["-C", root, "task", "show", "task/second"])) as { task: { note: string; state: string } }).task.state, "done");
});

test("task compose and views flow through native results", async () => {
  const root = world();
  const composed = await invoke(parseArgv(["-C", root, "task", "compose", "-"]), { readStdin: () => "+ Parent\n  + Child\n" }) as TaskInvocationResult;
  assert.equal((composed as { kind: string }).kind, "accepted");
  const listed = await invoke(parseArgv(["-C", root, "task", "ls"])) as TaskInvocationResult;
  const command = parseArgv(["task", "ls"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(command, listed), /^2 ls$/mu);
  assert.match(renderTaskText(command, listed), /^task\/parent - P2 - ready - Parent$/mu);
  assert.equal(taskExitCode(listed), 0);
});

test("task query keeps text and JSON membership on one typed page", async () => {
  const root = world();
  await invoke(parseArgv(["-C", root, "task", "add", "Critical auth", "--priority", "0"]));
  await invoke(parseArgv(["-C", root, "task", "add", "Routine docs", "--priority", "2"]));
  const argv = ["-C", root, "task", "query", "--where", "priority <= 1 and title ~ \"auth\"", "--limit", "1"] as const;
  const result = await invoke(parseArgv(argv)) as TaskInvocationResult;
  const command = parseArgv(argv).command;
  if (command.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(command, result), /^1 query$/mu);
  assert.match(renderTaskText(command, result), /^task\/critical-auth - P0 - ready - Critical auth$/mu);
  const hostileArgv = ["-C", root, "task", "query", "--where", "title ~ \"auth\nforged heading\""] as const;
  const hostile = await invoke(parseArgv(hostileArgv)) as TaskInvocationResult;
  const hostileCommand = parseArgv(hostileArgv).command;
  if (hostileCommand.command !== "task") throw new Error("not a task command");
  assert.equal(renderTaskText(hostileCommand, hostile), "0 query");
  const json = await runMain([...argv, "--json"]);
  assert.equal(json.exit, 0);
  const parsed = JSON.parse(json.stdout) as { kind: string; value: { kind: string; value: { rows: readonly { id: string }[]; total: number } } };
  assert.equal(parsed.kind, "present");
  assert.deepEqual(parsed.value.value.rows.map((row) => row.id), ["task/critical-auth"]);
  assert.equal(parsed.value.value.total, 1);
});

test("Task world reads distinguish absent, present-empty, and failed", async () => {
  const absent = mkdtempSync(join(tmpdir(), "keiyaku-task-cli-absent-"));
  const present = world();
  const missing = await runMain(["-C", absent, "task", "ls", "--json"]);
  assert.deepEqual(missing, { exit: 1, stdout: '{"kind":"absent"}\n', stderr: "" });
  const empty = await runMain(["-C", present, "task", "ls", "--json"]);
  assert.equal(empty.exit, 0);
  assert.deepEqual(JSON.parse(empty.stdout), { kind: "present", value: { kind: "accepted", value: { rows: [], total: 0, returned: 0, truncated: false } } });

  const tasksDirectory = join(present, ".keiyaku", "tasks");
  mkdirSync(tasksDirectory);
  writeFileSync(join(tasksDirectory, "broken.md"), "not Task authority\n");
  const failed = await runMain(["-C", present, "task", "ls", "--json"]);
  assert.equal(failed.exit, 3);
  assert.equal(JSON.parse(failed.stdout).kind, "failed");
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
