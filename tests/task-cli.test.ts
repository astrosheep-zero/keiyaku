import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const worktree = resolve(import.meta.dirname, "..");
const cliEntry = join(worktree, "src", "cli", "index.ts");
const cliArgv = [process.execPath, "--import", "tsx", cliEntry];

type RunResult = Readonly<{ code: number; stdout: string; stderr: string }>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runCli(args: readonly string[], columns?: number): Promise<RunResult> {
  const invocation = [...cliArgv, ...args];
  const child = columns === undefined
    ? spawn(invocation[0]!, invocation.slice(1), {
      cwd: worktree,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    : spawn("script", process.platform === "darwin"
      ? ["-q", "/dev/null", "sh", "-c", `stty columns ${String(columns)} rows 100; ${invocation.map(shellQuote).join(" ")}`]
      : ["-q", "-c", `stty columns ${String(columns)} rows 100; ${invocation.map(shellQuote).join(" ")}`, "/dev/null"], {
      cwd: worktree,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  return new Promise((resolveRun, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({
      code: code ?? 1,
      stdout: columns === undefined
        ? stdout
        : stdout.replaceAll("\r", "").replace(/\^D/gu, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ""),
      stderr,
    }));
  });
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
  assert.throws(() => parseArgv(["task", "tree", "task/area", "--full"]), /option --full is not valid for task tree/u);
  const blankArgv: ReadonlyArray<readonly [argv: readonly string[], pattern: RegExp]> = [
    [["task", "add", ""], /task add requires a nonblank value/],
    [["task", "add", "Title", "--note", " "], /--note requires a nonblank value/],
    [["task", "update", "task/a", "--body", ""], /--body requires a nonblank value/],
    [["task", "drop", "task/a", "--note", "\t"], /--note requires a nonblank value/],
    [["task", "show", " "], /task show requires a nonblank value/],
    [["task", "update", "task/a", "--needs", "  "], /--needs requires a nonblank value/],
    [["task", "namespace", "   "], /task namespace requires a nonblank value/],
    [["task", "namespace", ""], /task namespace requires a nonblank value/],
    [["task", "add", "Title", "--namespace", "   "], /--namespace requires a nonblank value/],
    [["task", "add", "Title", "--namespace", ""], /--namespace requires a nonblank value/],
  ];
  assert.deepEqual(parseArgv(["task", "namespace", "/"]), {
    command: { command: "task", action: "namespace", output: "text", positionals: ["/"], flags: {} },
  });
  assert.deepEqual(parseArgv(["task", "add", "Title", "--namespace", "/"]), {
    command: { command: "task", action: "add", output: "text", positionals: ["Title"], flags: { namespace: "/" } },
  });
  for (const [argv, pattern] of blankArgv) {
    assert.throws(() => parseArgv(argv), (error: unknown) => error instanceof CliUsageError && pattern.test(error.message));
  }
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

  const priorityOnly = await invoke(parseArgv(["-C", root, "task", "update", "task/native-cli", "--priority", "1"]), {
    readStdin: () => { throw new Error("task update without body must not read stdin"); },
  }) as TaskInvocationResult;
  assert.equal((priorityOnly as { kind: string }).kind, "accepted");
  const afterPriority = await invoke(parseArgv(["-C", root, "task", "show", "task/native-cli"])) as TaskInvocationResult;
  assert.equal((afterPriority as { task: { body: string; priority: number } }).task.body, "body from stdin\n");
  assert.equal((afterPriority as { task: { body: string; priority: number } }).task.priority, 1);

  await assert.rejects(
    () => invoke(parseArgv(["task", "add", "-"]), { cwd: "/absent/task-blank-stdin", readStdin: () => " \n" }),
    (error: unknown) => error instanceof CliUsageError
      && /task add requires a nonblank stdin document/.test(error.message)
      && !/invocation cwd is not an existing directory/u.test(error.message),
  );
  const padded = "  keep body  \n";
  const paddedUpdate = await invoke(parseArgv(["-C", root, "task", "update", "task/native-cli", "--body", "-"]), {
    readStdin: () => padded,
  }) as TaskInvocationResult;
  assert.equal((paddedUpdate as { kind: string }).kind, "accepted");
  const paddedShown = await invoke(parseArgv(["-C", root, "task", "show", "task/native-cli"])) as TaskInvocationResult;
  assert.equal((paddedShown as { task: { body: string } }).task.body, padded);
});

test("literal slash namespace selects root; empty and whitespace-only namespace are usage", async () => {
  const root = world();
  await invoke(parseArgv(["-C", root, "task", "namespace", "contract/inside"]));
  const added = await invoke(parseArgv(["-C", root, "task", "add", "Rooted", "--namespace", "/"])) as TaskInvocationResult;
  assert.equal((added as { kind: string }).kind, "accepted");
  const shown = await invoke(parseArgv(["-C", root, "task", "show", "task/rooted"])) as TaskInvocationResult;
  assert.equal((shown as { task: { title: string; id: string } }).task.title, "Rooted");
  assert.equal((shown as { task: { title: string; id: string } }).task.id, "task/rooted");
  const current = await invoke(parseArgv(["-C", root, "task", "namespace"]));
  assert.deepEqual(current, { kind: "accepted", value: ["contract", "inside"] });
  const reset = await invoke(parseArgv(["-C", root, "task", "namespace", "/"]));
  assert.deepEqual(reset, { kind: "accepted", value: [] });
  await assert.rejects(
    async () => invoke(parseArgv(["-C", root, "task", "namespace", ""])),
    (error: unknown) => error instanceof CliUsageError && /task namespace requires a nonblank value/.test(error.message),
  );
  await assert.rejects(
    async () => invoke(parseArgv(["-C", root, "task", "namespace", "   "])),
    (error: unknown) => error instanceof CliUsageError && /task namespace requires a nonblank value/.test(error.message),
  );
  await assert.rejects(
    async () => invoke(parseArgv(["-C", root, "task", "add", "Nope", "--namespace", ""])),
    (error: unknown) => error instanceof CliUsageError && /--namespace requires a nonblank value/.test(error.message),
  );
  await assert.rejects(
    async () => invoke(parseArgv(["-C", root, "task", "add", "Nope", "--namespace", "   "])),
    (error: unknown) => error instanceof CliUsageError && /--namespace requires a nonblank value/.test(error.message),
  );
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

test("Task world reads distinguish absent authority from a present empty world", async () => {
  const absent = mkdtempSync(join(tmpdir(), "keiyaku-task-cli-absent-"));
  const present = world();
  const emptyPage = { kind: "accepted", value: { rows: [], total: 0, returned: 0, truncated: false } };
  for (const action of ["ls", "ready", "blocked", "query", "doctor"] as const) {
    const command = parseArgv(["task", action]).command;
    if (command.command !== "task") throw new Error("not a task command");

    const missing = await invoke(parseArgv(["-C", absent, "task", action])) as TaskInvocationResult;
    assert.deepEqual(missing, { kind: "absent" });
    assert.equal(renderTaskText(command, missing), "task world absent");
    assert.equal(taskExitCode(missing), 1);
    const missingText = await runMain(["-C", absent, "task", action]);
    assert.deepEqual(missingText, { exit: 1, stdout: "task world absent\n", stderr: "" });
    const missingJson = await runMain(["-C", absent, "task", action, "--json"]);
    assert.deepEqual(missingJson, { exit: 1, stdout: '{"kind":"absent"}\n', stderr: "" });

    const observed = await invoke(parseArgv(["-C", present, "task", action])) as TaskInvocationResult;
    assert.equal((observed as { kind: string }).kind, "present");
    if ((observed as { kind: string }).kind !== "present") throw new Error("expected present observation");
    const value = (observed as { value: unknown }).value;
    assert.deepEqual(value, action === "doctor" ? { issues: [] } : emptyPage);
    assert.equal(renderTaskText(command, observed), action === "doctor" ? "healthy" : `0 ${action}`);
    assert.equal(taskExitCode(observed), 0);
  }
});

test("Task world reads retain failed observations", async () => {
  const root = world();
  const path = join(root, ".keiyaku", "tasks");
  mkdirSync(path);
  writeFileSync(join(path, "broken.md"), "not Task authority\n");
  for (const action of ["ls", "ready", "blocked", "query", "doctor"] as const) {
    const command = parseArgv(["task", action]).command;
    if (command.command !== "task") throw new Error("not a task command");

    const result = await invoke(parseArgv(["-C", root, "task", action])) as TaskInvocationResult;
    assert.equal((result as { kind: string }).kind, "failed");
    assert.match(renderTaskText(command, result), /^task world failed\n/u);
    assert.equal(taskExitCode(result), 3);
    const text = await runMain(["-C", root, "task", action]);
    assert.equal(text.exit, 3);
    assert.match(text.stdout, /^task world failed\n/u);
    assert.equal(text.stderr, "");
    const json = await runMain(["-C", root, "task", action, "--json"]);
    assert.equal(json.exit, 3);
    assert.equal(json.stderr, "");
    assert.equal(JSON.parse(json.stdout).kind, "failed");
  }
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

test("task tree text follows parent children and marks parent cycles", async () => {
  const root = world();
  await invoke(parseArgv(["-C", root, "task", "add", "Area"]));
  await invoke(parseArgv(["-C", root, "task", "add", "Need"]));
  await invoke(parseArgv(["-C", root, "task", "add", "Child", "--parent", "task/area"]));
  await invoke(parseArgv(["-C", root, "task", "add", "Nested", "--parent", "task/child"]));
  await invoke(parseArgv(["-C", root, "task", "update", "task/area", "--needs", "task/need"]));
  const tree = await invoke(parseArgv(["-C", root, "task", "tree", "task/area"])) as TaskInvocationResult;
  const command = parseArgv(["task", "tree", "task/area"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  const text = renderTaskText(command, tree);
  assert.match(text, /^task\/area - P2 - open - Area$/mu);
  assert.match(text, /^  task\/child - P2 - open - Child$/mu);
  assert.match(text, /^    task\/nested - P2 - open - Nested$/mu);
  assert.doesNotMatch(text, /task\/need/u);
  assert.doesNotMatch(text, /reference/u);

  await invoke(parseArgv(["-C", root, "task", "update", "task/area", "--parent", "task/nested"]));
  const cycled = await invoke(parseArgv(["-C", root, "task", "tree", "task/area"])) as TaskInvocationResult;
  const cycledText = renderTaskText(command, cycled);
  assert.match(cycledText, /task\/area - P2 - cycle - Area/u);
  assert.doesNotMatch(cycledText, /reference/u);
  const doctor = await invoke(parseArgv(["-C", root, "task", "doctor"])) as TaskInvocationResult;
  const doctorCommand = parseArgv(["task", "doctor"]).command;
  if (doctorCommand.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(doctorCommand, doctor), /parent cycle: task\/area -> task\/child -> task\/nested/u);
});

test("built CLI task tree follows parent decomposition at 36 columns", async () => {
  const root = world();
  const titles = [
    "Alpha parent decomposition root for tree smoke",
    "Need only blocker outside the tree",
    "Child under the alpha parent root",
    "Nested grandchild under the child",
  ] as const;
  for (const title of titles) {
    const added = await invoke(parseArgv(["-C", root, "task", "add", title])) as { kind: string; value?: { id: string } };
    assert.equal(added.kind, "accepted");
  }
  const ids = {
    root: "task/alpha-parent-decomposition-root-for-tree-smoke",
    need: "task/need-only-blocker-outside-the-tree",
    child: "task/child-under-the-alpha-parent-root",
    nested: "task/nested-grandchild-under-the-child",
  };
  assert.equal((await invoke(parseArgv(["-C", root, "task", "update", ids.child, "--parent", ids.root])) as { kind: string }).kind, "accepted");
  assert.equal((await invoke(parseArgv(["-C", root, "task", "update", ids.nested, "--parent", ids.child])) as { kind: string }).kind, "accepted");
  assert.equal((await invoke(parseArgv(["-C", root, "task", "update", ids.root, "--needs", ids.need])) as { kind: string }).kind, "accepted");

  const tree = await runCli(["-C", root, "task", "tree", ids.root], 36);
  assert.equal(tree.code, 0, tree.stderr);
  assert.match(tree.stdout, new RegExp(ids.root.replaceAll("/", "\\/"), "u"));
  assert.match(tree.stdout, new RegExp(`  ${ids.child.replaceAll("/", "\\/")}`, "u"));
  assert.match(tree.stdout, new RegExp(`    ${ids.nested.replaceAll("/", "\\/")}`, "u"));
  assert.doesNotMatch(tree.stdout, new RegExp(ids.need.replaceAll("/", "\\/"), "u"));
  assert.doesNotMatch(tree.stdout, /reference/u);

  const forbidden = await runCli(["-C", root, "task", "tree", "--full", ids.root]);
  assert.notEqual(forbidden.code, 0);
  assert.match(`${forbidden.stdout}\n${forbidden.stderr}`, /option --full is not valid for task tree/u);

  assert.equal((await invoke(parseArgv(["-C", root, "task", "update", ids.root, "--parent", ids.nested])) as { kind: string }).kind, "accepted");
  const cycled = await runCli(["-C", root, "task", "tree", ids.root], 36);
  assert.equal(cycled.code, 0, cycled.stderr);
  assert.match(cycled.stdout, /cycle/u);
  assert.match(cycled.stdout, new RegExp(ids.root.replaceAll("/", "\\/"), "u"));
  const doctor = await runCli(["-C", root, "task", "doctor", "--json"]);
  assert.equal(doctor.code, 1, doctor.stderr);
  assert.match(doctor.stdout, /"relation":"parent"/u);
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
