import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { invoke } from "../src/cli/invoke.js";
import { main } from "../src/cli/main.js";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { parseTaskQueryExpression } from "../src/cli/commands/task-query.js";
import { renderTaskIncompleteDiagnostic, renderTaskText, taskExitCode } from "../src/cli/render/task.js";
import { writeTask } from "../src/cli/runtime.js";
import { displayColumns } from "../src/cli/render/terminal.js";
import type { TaskInvocationResult } from "../src/cli/commands/task-invoke.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";

function world(): string {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-task-cli-"));
  mkdirSync(join(root, ".keiyaku"));
  return root;
}

async function runMain(argv: readonly string[]): Promise<Readonly<{ exit: number; stdout: string; stderr: string }>> {
  let stdout = "",
    stderr = "";
  const writeStdout = process.stdout.write,
    writeStderr = process.stderr.write;
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

const worktree = resolve(import.meta.dirname, "..");
const cliEntry = join(worktree, "src", "cli", "index.ts");
const cliArgv = [process.execPath, "--import", "tsx", cliEntry];

type RunResult = Readonly<{ code: number; stdout: string; stderr: string }>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  return env;
}

function runCli(args: readonly string[], columns?: number, stdin = ""): Promise<RunResult> {
  const invocation = [...cliArgv, ...args];
  const quoted = invocation.map(shellQuote).join(" ");
  const piped = stdin.length === 0 ? quoted : `printf %s ${shellQuote(stdin)} | ${quoted}`;
  const child =
    columns === undefined
      ? spawn(invocation[0]!, invocation.slice(1), {
          cwd: worktree,
          env: cliEnv(),
          stdio: ["pipe", "pipe", "pipe"],
        })
      : spawn(
          "script",
          process.platform === "darwin"
            ? ["-q", "/dev/null", "sh", "-c", `stty columns ${String(columns)} rows 100; ${piped}`]
            : ["-q", "-c", `stty columns ${String(columns)} rows 100; ${piped}`, "/dev/null"],
          {
            cwd: worktree,
            env: cliEnv(),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
  return new Promise((resolveRun, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    if (columns === undefined) child.stdin.end(stdin);
    child.on("close", (code) =>
      resolveRun({
        code: code ?? 1,
        stdout:
          columns === undefined
            ? stdout
            : stdout
                .replaceAll("\r", "")
                .replace(/\^D/gu, "")
                .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ""),
        stderr,
      }),
    );
  });
}

function assertCopyable(text: string, tokens: readonly string[]): void {
  for (const token of tokens) {
    assert.equal(text.includes(token), true, `missing contiguous ${token}\n${text}`);
  }
}

function assertFitsOrOverflowsLawfully(text: string, columns: number): void {
  for (const line of text.split("\n")) {
    if (displayColumns(line) <= columns) continue;
    const lawful =
      /task\/[a-z0-9/-]+/u.test(line) ||
      /\/\S+/u.test(line) ||
      !/^[●○!·✓×?] |^(tasks|ready|blocked|query|healthy|namespace|created|task world) |^ {2}/u.test(line);
    assert.equal(lawful, true, `incoherent overflow:\n${line}\n${text}`);
  }
}

test("task parser owns subcommand arity, repeat flags, and selected stdin", () => {
  const multiStart = parseArgv(["task", "start", "task/one", "task/two"]);
  assert.deepEqual(multiStart.command, {
    command: "task",
    action: "start",
    output: "text",
    positionals: ["task/one", "task/two"],
    flags: {},
  });
  assert.throws(() => parseArgv(["tasks", "start", "task/one"]), /usage: keiyaku/u);
  assert.throws(() => parseArgv(["task", "star", "task/one"]), /usage: keiyaku/u);
  assert.deepEqual(
    parseArgv([
      "-C",
      "/tmp/project",
      "task",
      "add",
      "Ship task",
      "--namespace",
      "contract/inside",
      "--state",
      "in_progress",
      "--needs",
      "task/a",
      "--needs",
      "task/b",
      "--json",
    ]),
    {
      cwd: "/tmp/project",
      command: {
        command: "task",
        action: "add",
        output: "json",
        positionals: ["Ship task"],
        flags: { namespace: "contract/inside", state: "in_progress", needs: ["task/a", "task/b"], json: true },
      },
    },
  );
  assert.throws(() => parseArgv(["task", "update", "task/a", "--append", "-"]), /--append requires a value/u);
  assert.throws(() => parseArgv(["task", "update", "task/a", "--note", "-"]), /--note requires a value/u);
  assert.deepEqual(parseArgv(["task", "add", "Ship task", "--actor", "flagship"]).command, {
    command: "task",
    action: "add",
    output: "text",
    positionals: ["Ship task"],
    flags: { actor: "flagship" },
  });
  assert.deepEqual(parseArgv(["task", "add", "--actor", "flagship", "-"]).command, {
    command: "task",
    action: "add",
    output: "text",
    positionals: [],
    flags: { actor: "flagship" },
    stdin: "document",
  });
  assert.deepEqual(parseArgv(["task", "compose", "--actor", "flagship", "-"]).command, {
    command: "task",
    action: "compose",
    output: "text",
    positionals: [],
    flags: { actor: "flagship" },
    stdin: "compose",
  });
  assert.throws(
    () => parseArgv(["task", "update", "task/a", "--title", "X", "--actor", "flagship"]),
    /option --actor is not valid for task update/u,
  );
  assert.throws(
    () => parseArgv(["task", "start", "task/a", "--actor", "flagship"]),
    /option --actor is not valid for task start/u,
  );
  assert.throws(
    () => parseArgv(["task", "done", "task/a", "--actor", "flagship"]),
    /option --actor is not valid for task done/u,
  );
  assert.equal(parseArgv(["task", "compose", "-"]).command.command, "task");
  assert.throws(() => parseArgv(["task", "add", "Title", "-"]), CliUsageError);
  assert.throws(() => parseArgv(["task", "add", "--state", "done", "-"]), CliUsageError);
  assert.throws(() => parseArgv(["task", "ls", "--closed", "--all"]), CliUsageError);
  assert.throws(() => parseArgv(["task", "update", "task/a"]), CliUsageError);
  const query = parseArgv([
    "task",
    "query",
    "--where",
    "priority <= 1 and not state = done",
    "--sort",
    "updated",
    "--limit",
    "10",
  ]);
  assert.equal(query.command.command, "task");
  if (query.command.command === "task") assert.equal(query.command.where?.kind, "and");
  assert.deepEqual(parseTaskQueryExpression("blocks=task/b"), {
    kind: "predicate",
    predicate: { field: "blocks", operator: "=", value: "task/b" },
  });
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
    [["task", "context", "   "], /task context requires a nonblank value/],
    [["task", "context", ""], /task context requires a nonblank value/],
    [["task", "add", "Title", "--namespace", "   "], /--namespace requires a nonblank value/],
    [["task", "add", "Title", "--namespace", ""], /--namespace requires a nonblank value/],
  ];
  assert.deepEqual(parseArgv(["task", "context", "/"]), {
    command: { command: "task", action: "context", output: "text", positionals: ["/"], flags: {} },
  });
  assert.deepEqual(parseArgv(["task", "add", "Title", "--namespace", "/"]), {
    command: { command: "task", action: "add", output: "text", positionals: ["Title"], flags: { namespace: "/" } },
  });
  for (const [argv, pattern] of blankArgv) {
    assert.throws(
      () => parseArgv(argv),
      (error: unknown) => error instanceof CliUsageError && pattern.test(error.message),
    );
  }
});

test("Task commands reject the removed Contract association flags", () => {
  assert.throws(
    () => parseArgv(["task", "add", "Old association", "--contract", "kei/example"]),
    /option --contract is not valid for task add/u,
  );
  assert.throws(
    () => parseArgv(["task", "update", "task/example", "--no-contract"]),
    /option --no-contract is not valid for task update/u,
  );
});
test("plural show is all-or-nothing and preserves input order", async () => {
  const root = world();
  const created: string[] = [];
  for (const title of ["First detail", "Second detail", "Third detail"]) {
    const added = (await invoke(parseArgv(["-C", root, "task", "add", title]))) as TaskInvocationResult;
    assert.equal((added as { kind: string }).kind, "accepted");
    if ((added as { kind: string }).kind === "accepted") created.push((added as { value: { id: string } }).value.id);
  }
  const ids = created as readonly string[];
  const textCommand = parseArgv(["task", "show", ...ids]).command;
  const textResult = (await invoke(parseArgv(["-C", root, "task", "show", ...ids]))) as TaskInvocationResult;
  assert.deepEqual(
    (textResult as readonly { task: { id: string } }[]).map((detail) => detail.task.id),
    ids,
  );
  if (textCommand.command !== "task") throw new Error("not a task command");
  assert.equal(renderTaskText(textCommand, textResult).split("\n\n").length, 3);

  const jsonResult = (await invoke(parseArgv(["-C", root, "task", "show", ...ids, "--json"]))) as TaskInvocationResult;
  assert.deepEqual(
    (jsonResult as readonly { task: { id: string } }[]).map((detail) => detail.task.id),
    ids,
  );

  const missing = (await invoke(
    parseArgv(["-C", root, "task", "show", ids[0], "task/missing", ids[2]]),
  )) as TaskInvocationResult;
  assert.deepEqual(missing, { kind: "refused", refusal: { kind: "task-missing", taskId: "task/missing" } });
  assert.doesNotMatch(renderTaskText(textCommand, missing), /first-detail|third-detail/u);
});
test("task invocation works outside Git and consumes stdin only when selected", async () => {
  const root = world();
  let reads = 0;
  const add = (await invoke(
    parseArgv(["-C", root, "task", "add", "Native CLI", "--state", "on_hold", "--note", "initial"]),
    {
      readStdin: () => {
        reads += 1;
        return "unused";
      },
    },
  )) as TaskInvocationResult;
  assert.equal((add as { kind: string }).kind, "accepted");
  if ((add as { kind: string }).kind !== "accepted") throw new Error("expected task add");
  const nativeId = (add as { value: { id: string } }).value.id;
  assert.equal(reads, 0);
  const update = (await invoke(parseArgv(["-C", root, "task", "update", nativeId, "--body", "-"]), {
    readStdin: () => {
      reads += 1;
      return "body from stdin\n";
    },
  })) as TaskInvocationResult;
  assert.equal((update as { kind: string }).kind, "accepted");
  assert.equal(reads, 1);
  const shown = (await invoke(parseArgv(["-C", root, "task", "show", nativeId]))) as TaskInvocationResult;
  assert.equal((shown as { task: { body: string } }).task.body, "body from stdin\n");
  assert.equal((shown as { task: { state: string } }).task.state, "on_hold");
  assert.equal((shown as { task: { note: string } }).task.note, "initial");

  const noteUpdate = (await invoke(
    parseArgv(["-C", root, "task", "update", nativeId, "--note", "replacement"]),
    {
      readStdin: () => {
        reads += 1;
        return "unused";
      },
    },
  )) as TaskInvocationResult;
  assert.equal((noteUpdate as { kind: string }).kind, "accepted");
  assert.equal(reads, 1);
  const noteShown = (await invoke(parseArgv(["-C", root, "task", "show", nativeId]))) as TaskInvocationResult;
  assert.equal((noteShown as { task: { note: string } }).task.note, "replacement");
  const showCommand = parseArgv(["task", "show", nativeId]).command;
  if (showCommand.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(showCommand, noteShown), /created .* · updated .*/u);
  assert.match(renderTaskText(showCommand, noteShown), /note\n\nreplacement\n/u);
  assert.match(renderTaskText(showCommand, noteShown), new RegExp(`⧗ ${nativeId} · P2 on_hold — Native CLI`));

  const document = "---\ntitle: From document\nstate: done\n---\ncreated closed\n";
  const documentAdd = (await invoke(parseArgv(["-C", root, "task", "add", "-"]), {
    readStdin: () => document,
  })) as TaskInvocationResult;
  assert.equal((documentAdd as { kind: string }).kind, "accepted");
  if ((documentAdd as { kind: string }).kind !== "accepted") throw new Error("expected document add");
  const documentId = (documentAdd as { value: { id: string } }).value.id;
  const documentShown = (await invoke(
    parseArgv(["-C", root, "task", "show", documentId]),
  )) as TaskInvocationResult;
  assert.equal((documentShown as { task: { state: string } }).task.state, "done");

  const priorityOnly = (await invoke(parseArgv(["-C", root, "task", "update", nativeId, "--priority", "1"]), {
    readStdin: () => {
      throw new Error("task update without body must not read stdin");
    },
  })) as TaskInvocationResult;
  assert.equal((priorityOnly as { kind: string }).kind, "accepted");
  const afterPriority = (await invoke(
    parseArgv(["-C", root, "task", "show", nativeId]),
  )) as TaskInvocationResult;
  assert.equal((afterPriority as { task: { body: string; priority: number } }).task.body, "body from stdin\n");
  assert.equal((afterPriority as { task: { body: string; priority: number } }).task.priority, 1);

  await assert.rejects(
    () => invoke(parseArgv(["task", "add", "-"]), { cwd: "/absent/task-blank-stdin", readStdin: () => " \n" }),
    (error: unknown) =>
      error instanceof CliUsageError &&
      /task add requires a nonblank stdin document/.test(error.message) &&
      !/invocation cwd is not an existing directory/u.test(error.message),
  );
  const padded = "  keep body  \n";
  const paddedUpdate = (await invoke(parseArgv(["-C", root, "task", "update", nativeId, "--body", "-"]), {
    readStdin: () => padded,
  })) as TaskInvocationResult;
  assert.equal((paddedUpdate as { kind: string }).kind, "accepted");
  const paddedShown = (await invoke(
    parseArgv(["-C", root, "task", "show", nativeId]),
  )) as TaskInvocationResult;
  assert.equal((paddedShown as { task: { body: string } }).task.body, padded);
});

test("literal slash context selects root; empty and whitespace-only context are usage", async () => {
  const root = world();
  await invoke(parseArgv(["-C", root, "task", "context", "contract/inside"]));
  const added = (await invoke(
    parseArgv(["-C", root, "task", "add", "Rooted", "--namespace", "/"]),
  )) as TaskInvocationResult;
  assert.equal((added as { kind: string }).kind, "accepted");
  const rootedId = (added as { value: { id: string } }).value.id;
  const shown = (await invoke(parseArgv(["-C", root, "task", "show", rootedId]))) as TaskInvocationResult;
  assert.equal((shown as { task: { title: string; id: string } }).task.title, "Rooted");
  assert.equal((shown as { task: { title: string; id: string } }).task.id, rootedId);
  const current = await invoke(parseArgv(["-C", root, "task", "context"]));
  assert.deepEqual(current, {
    kind: "accepted",
    value: { namespace: ["contract", "inside"], source: "local-override" },
  });
  const reset = await invoke(parseArgv(["-C", root, "task", "context", "/"]));
  assert.deepEqual(reset, { kind: "accepted", value: { namespace: [], source: "local-override" } });
  const contextCommand = parseArgv(["task", "context"]).command;
  if (contextCommand.command !== "task") throw new Error("not a task command");
  assert.equal(renderTaskText(contextCommand, current), "context contract/inside · local-override");
  assert.equal(renderTaskText(contextCommand, reset), "context root · local-override");
  await assert.rejects(
    async () => invoke(parseArgv(["-C", root, "task", "context", ""])),
    (error: unknown) => error instanceof CliUsageError && /task context requires a nonblank value/.test(error.message),
  );
  await assert.rejects(
    async () => invoke(parseArgv(["-C", root, "task", "context", "   "])),
    (error: unknown) => error instanceof CliUsageError && /task context requires a nonblank value/.test(error.message),
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

  const added = (await invoke(
    parseArgv(["-C", linked, "task", "add", "Shared worktree task"]),
  )) as TaskInvocationResult;
  assert.equal((added as { kind: string }).kind, "accepted");
  if ((added as { kind: string }).kind !== "accepted") throw new Error("expected task add");
  const sharedId = (added as { value: { id: string } }).value.id;
  const shown = (await invoke(
    parseArgv(["-C", repository.path, "task", "show", sharedId]),
  )) as TaskInvocationResult;
  assert.equal((shown as { task: { title: string } }).task.title, "Shared worktree task");
  assert.equal(existsSync(join(linked, ".keiyaku", "tasks")), false);
  await invoke(parseArgv(["-C", linked, "task", "context", "contract/shared"]));
  const namespace = await invoke(parseArgv(["-C", repository.path, "task", "context"]));
  assert.deepEqual(namespace, { kind: "accepted", value: { namespace: [], source: "default-root" } });

  const settings = await invoke(parseArgv(["-C", linked, "settings"]));
  if (settings.kind !== "settings") throw new Error("expected settings result");
  const primary = realpathSync(repository.path);
  assert.equal(settings.value.scopes.project.path, join(primary, ".keiyaku", "settings.json"));

  const status = await invoke(parseArgv(["-C", linked, "status"]));
  if (status.kind !== "status") throw new Error("expected status result");
  assert.equal(status.report.root, primary);
  assert.equal(status.report.tasks.kind, "present");
  if (status.report.tasks.kind !== "present") throw new Error("expected Task section");
  assert.equal(
    status.report.tasks.value.rows.some((row) => row.id === sharedId),
    true,
  );
});

test("task drop note is passed to each independent lifecycle mutation", async () => {
  const root = world();
  const first = (await invoke(parseArgv(["-C", root, "task", "add", "First"]))) as { value: { id: string } };
  const second = (await invoke(parseArgv(["-C", root, "task", "add", "Second"]))) as { value: { id: string } };
  const firstId = first.value.id;
  const secondId = second.value.id;
  const result = (await invoke(
    parseArgv(["-C", root, "task", "drop", firstId, secondId, "--note", "cancelled"]),
  )) as TaskInvocationResult;
  assert.equal(taskExitCode(result), 0);
  for (const id of [firstId, secondId]) {
    const shown = (await invoke(parseArgv(["-C", root, "task", "show", id]))) as TaskInvocationResult;
    assert.equal((shown as { task: { note: string } }).task.note, "cancelled");
  }
});

test("task done note is passed to each independent lifecycle mutation", async () => {
  const root = world();
  const first = (await invoke(parseArgv(["-C", root, "task", "add", "First"]))) as { value: { id: string } };
  const second = (await invoke(parseArgv(["-C", root, "task", "add", "Second"]))) as { value: { id: string } };
  const firstId = first.value.id;
  const secondId = second.value.id;
  const result = (await invoke(
    parseArgv(["-C", root, "task", "done", firstId, "task/missing", secondId, "--note", "finished"]),
  )) as TaskInvocationResult;
  assert.equal(taskExitCode(result), 1);
  if (!("items" in result)) throw new Error("expected batch result");
  assert.deepEqual(
    result.items.map((item) => item.outcome.kind),
    ["accepted", "refused", "accepted"],
  );
  assert.equal(
    ((await invoke(parseArgv(["-C", root, "task", "show", firstId]))) as { task: { note: string; state: string } })
      .task.note,
    "finished",
  );
  assert.equal(
    (
      (await invoke(parseArgv(["-C", root, "task", "show", secondId]))) as {
        task: { note: string; state: string };
      }
    ).task.state,
    "done",
  );
});

test("task add and compose persist resolved actor only on new documents", async () => {
  const root = world();
  const environment = { KEIYAKU_ACTOR_ID: "env-actor" };
  const unsigned = (await invoke(parseArgv(["-C", root, "task", "add", "Unsigned"]), { environment: {} })) as {
    value: { id: string; createdBy?: string };
  };
  assert.equal("createdBy" in unsigned.value, false);
  const unsignedShown = (await invoke(parseArgv(["-C", root, "task", "show", unsigned.value.id]))) as {
    task: { createdBy?: string };
  };
  assert.equal(unsignedShown.task.createdBy, undefined);

  const added = (await invoke(parseArgv(["-C", root, "task", "add", "Authored", "--actor", "explicit-actor"]), {
    environment,
  })) as { value: { id: string; createdBy: string } };
  assert.equal(added.value.createdBy, "explicit-actor");
  const inherited = (await invoke(parseArgv(["-C", root, "task", "add", "Inherited"]), { environment })) as {
    value: { id: string; createdBy: string };
  };
  assert.equal(inherited.value.createdBy, "env-actor");
  const fromDocument = (await invoke(parseArgv(["-C", root, "task", "add", "--actor", "document-actor", "-"]), {
    environment,
    readStdin: () => "---\ntitle: From stdin\n---\n",
  })) as { value: { id: string; createdBy: string } };
  assert.equal(fromDocument.value.createdBy, "document-actor");
  await assert.rejects(
    () =>
      invoke(parseArgv(["-C", root, "task", "add", "-"]), {
        environment,
        readStdin: () => "---\ntitle: Illegal\ncreatedBy: sneaky\n---\n",
      }),
    /unknown task front matter key/u,
  );
  const composed = (await invoke(parseArgv(["-C", root, "task", "compose", "-"]), {
    environment,
    readStdin: () => ["+ Composed", "as = composed", `@${added.value.id}`, "pri = 0", ""].join("\n"),
  })) as { kind: string };
  assert.equal(composed.kind, "accepted");
  const composedList = (await Tasks.of(await World.at(root)).list({ selection: "all" })) as {
    kind: string;
    value?: { rows: readonly { id: string; title: string }[] };
  };
  const composedId = composedList.value?.rows.find((row) => row.title === "Composed")?.id;
  if (composedId === undefined) throw new Error("composed task missing");
  const composedShown = (await invoke(parseArgv(["-C", root, "task", "show", composedId]))) as {
    task: { createdBy?: string };
  };
  const authoredShown = (await invoke(parseArgv(["-C", root, "task", "show", added.value.id]))) as {
    task: { createdBy?: string; priority: number };
  };
  assert.equal(composedShown.task.createdBy, "env-actor");
  assert.equal(authoredShown.task.createdBy, "explicit-actor");
  const showCommand = parseArgv(["task", "show", added.value.id]).command;
  const unsignedShowCommand = parseArgv(["task", "show", unsigned.value.id]).command;
  const lsCommand = parseArgv(["task", "ls"]).command;
  if (showCommand.command !== "task" || unsignedShowCommand.command !== "task" || lsCommand.command !== "task") {
    throw new Error("not a task command");
  }
  const authoredText = renderTaskText(showCommand, authoredShown);
  assert.match(authoredText, /^created .* · updated .*$/mu);
  assert.match(authoredText, /^created-by explicit-actor$/mu);
  assert.doesNotMatch(authoredText, /createdBy:/u);
  assert.doesNotMatch(renderTaskText(unsignedShowCommand, unsignedShown), /created-by/u);
  const listed = (await invoke(parseArgv(["-C", root, "task", "ls"]))) as TaskInvocationResult;
  assert.doesNotMatch(renderTaskText(lsCommand, listed), /created-by |createdBy/u);
  await invoke(parseArgv(["-C", root, "task", "update", added.value.id, "--note", "later"]));
  await invoke(parseArgv(["-C", root, "task", "start", added.value.id]));
  const afterLifecycle = (await invoke(parseArgv(["-C", root, "task", "show", added.value.id]))) as {
    task: { createdBy?: string };
  };
  assert.equal(afterLifecycle.task.createdBy, "explicit-actor");
  assert.throws(() => parseArgv(["task", "add", "Blank", "--actor", " "]), /--actor requires a nonblank value/u);
});

test("task compose --plan is read-only and exposes the planned order", async () => {
  const root = world();
  const argv = ["-C", root, "task", "compose", "--plan", "-"] as const;
  const result = (await invoke(parseArgv(argv), {
    readStdin: () => ["+ Child", "as = child", "needs = ^parent", "+ Parent", "as = parent", ""].join("\n"),
  })) as TaskInvocationResult;
  assert.equal((result as { kind: string }).kind, "planned");
  const command = parseArgv(["task", "compose", "--plan", "-"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  const text = renderTaskText(command, result);
  assert.match(text, /^compose plan · 2 documents$/mu);
  assert.match(text, /^admit 1 task\/parent-[0-9a-f]{4}$/mu);
  assert.match(text, /^admit 2 task\/child-[0-9a-f]{4}$/mu);
  assert.deepEqual(await invoke(parseArgv(["-C", root, "task", "ls", "--world"])), {
    kind: "present",
    value: { kind: "accepted", value: { rows: [], hasMore: false } },
  });
});

test("task compose and views flow through native results", async () => {
  const root = world();
  const composed = (await invoke(parseArgv(["-C", root, "task", "compose", "-"]), {
    readStdin: () => ["+ Parent", "as = parent", "+ Child", "parent = ^parent", ""].join("\n"),
  })) as TaskInvocationResult;
  assert.equal((composed as { kind: string }).kind, "accepted");
  const composeCommand = parseArgv(["task", "compose", "-"]).command;
  if (composeCommand.command !== "task") throw new Error("not a task command");
  const composedText = renderTaskText(composeCommand, composed);
  assert.match(composedText, /^✓ compose accepted · 2 changed$/mu);
  assert.match(composedText, /^alias \^parent task\/parent-[0-9a-f]{4}$/mu);
  for (const change of (composed as { documentChanges: readonly { taskId: string; documentDiff: string }[] })
    .documentChanges) {
    assert.equal(composedText.includes(`diff ${change.taskId}\n\n${change.documentDiff}\n`), true);
  }
  const listed = (await invoke(parseArgv(["-C", root, "task", "ls"]))) as TaskInvocationResult;
  const command = parseArgv(["task", "ls"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(command, listed), /^tasks · current namespace$/mu);
  assert.match(
    renderTaskText(command, listed),
    /^○ task\/parent-[0-9a-f]{4} · P2 ready · updated .* · no body · children 1 live · 1 total —$/mu,
  );
  assert.equal(taskExitCode(listed), 0);
});

test("task ls accepts exact namespace selectors and bypasses malformed context", async () => {
  const root = world();
  const tasks = Tasks.of(await World.at(root));
  const rootTask = await tasks.add({ title: "Root task", namespace: [] });
  const featureOne = await tasks.add({ title: "Feature one", namespace: ["feature"] });
  const featureTwo = await tasks.add({ title: "Feature two", namespace: ["feature"] });
  await tasks.add({ title: "Nested feature", namespace: ["feature", "ui"] });
  assert.equal(rootTask.kind, "accepted");
  assert.equal(featureOne.kind, "accepted");
  assert.equal(featureTwo.kind, "accepted");
  mkdirSync(join(root, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "namespace", "current"), "bad//context\n");

  const selected = (await invoke(
    parseArgv(["-C", root, "task", "ls", "task/feature/", "--all", "--json", "--limit", "1"]),
  )) as {
    kind: string;
    value: { kind: string; value: { rows: readonly { id: string }[]; hasMore: boolean } };
  };
  assert.equal(selected.kind, "present");
  const featureOneId = (featureOne as { value: { id: string } }).value.id;
  const rootTaskId = (rootTask as { value: { id: string } }).value.id;
  assert.deepEqual(
    selected.value.value.rows.map((row) => row.id),
    [featureOneId],
  );
  assert.equal(selected.value.value.hasMore, true);

  const rootPage = (await invoke(parseArgv(["-C", root, "task", "ls", "task/", "--all", "--json"]))) as {
    kind: string;
    value: { value: { rows: readonly { id: string }[] } };
  };
  assert.deepEqual(
    rootPage.value.value.rows.map((row) => row.id),
    [rootTaskId],
  );
  assert.throws(() => parseArgv(["task", "ls", "task/feature", "--all"]), /Task namespace selector/u);
  assert.throws(() => parseArgv(["task", "ls", "task/Feature/", "--all"]), /Task namespace selector/u);
  assert.throws(() => parseArgv(["task", "ls", "task/../", "--all"]), /Task namespace selector/u);
  assert.throws(() => parseArgv(["task", "ls", "task/feature/", "--world"]), /--world/u);
  assert.throws(() => parseArgv(["task", "ls", "task/feature/", "extra"]), /invalid positional/u);
});

test("task query keeps text and JSON membership on one typed page", async () => {
  const root = world();
  await invoke(parseArgv(["-C", root, "task", "add", "Critical auth", "--priority", "0"]));
  await invoke(parseArgv(["-C", root, "task", "add", "Routine docs", "--priority", "2"]));
  const argv = ["-C", root, "task", "query", "--where", 'priority <= 1 and title ~ "auth"', "--limit", "1"] as const;
  const result = (await invoke(parseArgv(argv))) as TaskInvocationResult;
  const command = parseArgv(argv).command;
  if (command.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(command, result), /^query$/mu);
  assert.match(
    renderTaskText(command, result),
    /^○ task\/critical-auth-[0-9a-f]{4} · P0 ready · updated .* · no body — Critical auth$/mu,
  );
  const hostileArgv = ["-C", root, "task", "query", "--where", 'title ~ "auth\nforged heading"'] as const;
  const hostile = (await invoke(parseArgv(hostileArgv))) as TaskInvocationResult;
  const hostileCommand = parseArgv(hostileArgv).command;
  if (hostileCommand.command !== "task") throw new Error("not a task command");
  assert.equal(renderTaskText(hostileCommand, hostile), "query");
  assert.doesNotMatch(renderTaskText(command, result), /createdAt|updatedAt|parent |needs /u);
  const json = await runMain([...argv, "--json"]);
  assert.equal(json.exit, 0);
  const parsed = JSON.parse(json.stdout) as {
    kind: string;
    value: { kind: string; value: { rows: readonly { id: string }[]; hasMore: boolean } };
  };
  assert.equal(parsed.kind, "present");
  assert.deepEqual(
    parsed.value.value.rows.map((row) => row.id),
    [parsed.value.value.rows[0]!.id],
  );
  assert.equal(parsed.value.value.hasMore, false);
});

test("Task world reads distinguish absent authority from a present empty world", async () => {
  const absent = mkdtempSync(join(tmpdir(), "keiyaku-task-cli-absent-"));
  const present = world();
  const emptyPage = { kind: "accepted", value: { rows: [], hasMore: false } };
  for (const action of ["ls", "ready", "blocked", "query", "doctor"] as const) {
    const command = parseArgv(["task", action]).command;
    if (command.command !== "task") throw new Error("not a task command");

    const missing = (await invoke(parseArgv(["-C", absent, "task", action]))) as TaskInvocationResult;
    assert.deepEqual(missing, { kind: "absent" });
    assert.equal(renderTaskText(command, missing), "task world absent");
    assert.equal(taskExitCode(missing), 1);
    const missingText = await runMain(["-C", absent, "task", action]);
    assert.deepEqual(missingText, { exit: 1, stdout: "task world absent\n", stderr: "" });
    const missingJson = await runMain(["-C", absent, "task", action, "--json"]);
    assert.deepEqual(missingJson, { exit: 1, stdout: '{"kind":"absent"}\n', stderr: "" });

    const observed = (await invoke(parseArgv(["-C", present, "task", action]))) as TaskInvocationResult;
    assert.equal((observed as { kind: string }).kind, "present");
    if ((observed as { kind: string }).kind !== "present") throw new Error("expected present observation");
    const value = (observed as { value: unknown }).value;
    assert.deepEqual(value, action === "doctor" ? { issues: [] } : emptyPage);
    assert.equal(
      renderTaskText(command, observed),
      action === "doctor" ? "healthy" : action === "ls" ? "tasks · current namespace" : action,
    );
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

    const result = (await invoke(parseArgv(["-C", root, "task", action]))) as TaskInvocationResult;
    assert.equal((result as { kind: string }).kind, "failed");
    assert.match(renderTaskText(command, result), /^task world failed\ndiagnostic\n\n/u);
    assert.doesNotMatch(renderTaskText(command, result), /\{/u);
    assert.equal(taskExitCode(result), 3);
    const text = await runMain(["-C", root, "task", action]);
    const rendered = renderTaskText(command, result);
    assert.equal(text.exit, 3);
    assert.equal(rendered.endsWith("\n"), true);
    assert.equal(text.stdout, rendered);
    assert.match(text.stdout, /^task world failed\ndiagnostic\n\n/u);
    assert.equal(text.stderr, "");
    const json = await runMain(["-C", root, "task", action, "--json"]);
    assert.equal(json.exit, 3);
    assert.equal(json.stderr, "");
    assert.equal(JSON.parse(json.stdout).kind, "failed");
  }
});

test("Task row-view limit refusals precede authority observation", async () => {
  const root = world();
  const path = join(root, ".keiyaku", "tasks");
  mkdirSync(path);
  writeFileSync(join(path, "broken.md"), "not Task authority\n");

  for (const action of ["ls", "ready", "blocked", "query"] as const) {
    await assert.rejects(
      invoke(parseArgv(["-C", root, "task", action, "--limit", "501"])),
      (error: unknown) => error instanceof CliUsageError && /integer from 1 to 500/u.test(error.message),
    );
    const output = await runMain(["-C", root, "task", action, "--limit", "501"]);
    assert.equal(output.exit, 1);
    assert.equal(output.stdout, "");
    assert.match(output.stderr, /^limit must be an integer from 1 to 500\nusage: keiyaku task /u);
  }
});

test("task doctor renders graph disease and controls exit status", async () => {
  const root = world();
  const first = (await invoke(parseArgv(["-C", root, "task", "add", "First"]))) as { value: { id: string } };
  const second = (await invoke(parseArgv(["-C", root, "task", "add", "Second"]))) as { value: { id: string } };
  await invoke(parseArgv(["-C", root, "task", "update", first.value.id, "--needs", second.value.id]));
  await invoke(parseArgv(["-C", root, "task", "update", second.value.id, "--needs", first.value.id]));
  const result = (await invoke(parseArgv(["-C", root, "task", "doctor"]))) as TaskInvocationResult;
  const command = parseArgv(["task", "doctor"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(command, result), new RegExp(`^1 issue\\n! cycle needs ${first.value.id} ${second.value.id}$`));
  assert.equal(taskExitCode(result), 1);
});

test("task tree text follows parent children and marks parent cycles", async () => {
  const root = world();
  const area = (await invoke(parseArgv(["-C", root, "task", "add", "Area"]))) as { value: { id: string } };
  const need = (await invoke(parseArgv(["-C", root, "task", "add", "Need"]))) as { value: { id: string } };
  const child = (await invoke(parseArgv(["-C", root, "task", "add", "Child", "--parent", area.value.id]))) as {
    value: { id: string };
  };
  const nested = (await invoke(parseArgv(["-C", root, "task", "add", "Nested", "--parent", child.value.id]))) as {
    value: { id: string };
  };
  await invoke(parseArgv(["-C", root, "task", "update", area.value.id, "--needs", need.value.id]));
  const tree = (await invoke(parseArgv(["-C", root, "task", "tree", area.value.id]))) as TaskInvocationResult;
  const command = parseArgv(["task", "tree", area.value.id]).command;
  if (command.command !== "task") throw new Error("not a task command");
  const text = renderTaskText(command, tree);
  assert.match(text, new RegExp(`^○ ${area.value.id} · P2 open — Area$`, "mu"));
  assert.match(text, new RegExp(`^  ○ ${child.value.id} · P2 open — Child$`, "mu"));
  assert.match(text, new RegExp(`^    ○ ${nested.value.id} · P2 open — Nested$`, "mu"));
  assert.doesNotMatch(text, new RegExp(need.value.id));
  assert.doesNotMatch(text, /reference/u);

  await invoke(parseArgv(["-C", root, "task", "update", area.value.id, "--parent", nested.value.id]));
  const cycled = (await invoke(parseArgv(["-C", root, "task", "tree", area.value.id]))) as TaskInvocationResult;
  const cycledText = renderTaskText(command, cycled);
  assert.match(cycledText, new RegExp(`! ${area.value.id} · cycle`));
  assert.doesNotMatch(cycledText, /reference/u);
  const doctor = (await invoke(parseArgv(["-C", root, "task", "doctor"]))) as TaskInvocationResult;
  const doctorCommand = parseArgv(["task", "doctor"]).command;
  if (doctorCommand.command !== "task") throw new Error("not a task command");
  assert.match(renderTaskText(doctorCommand, doctor), new RegExp(`! cycle parent ${area.value.id} ${child.value.id} ${nested.value.id}`));
});

test("built CLI task tree follows parent decomposition at 36 columns", async () => {
  const root = world();
  const titles = [
    "Alpha parent decomposition root for tree smoke",
    "Need only blocker outside the tree",
    "Child under the alpha parent root",
    "Nested grandchild under the child",
  ] as const;
  const createdIds: string[] = [];
  for (const title of titles) {
    const added = (await invoke(parseArgv(["-C", root, "task", "add", title]))) as {
      kind: string;
      value?: { id: string };
    };
    assert.equal(added.kind, "accepted");
    if (added.kind === "accepted") createdIds.push(added.value.id);
  }
  const ids = {
    root: createdIds[0]!,
    need: createdIds[1]!,
    child: createdIds[2]!,
    nested: createdIds[3]!,
  };
  assert.equal(
    ((await invoke(parseArgv(["-C", root, "task", "update", ids.child, "--parent", ids.root]))) as { kind: string })
      .kind,
    "accepted",
  );
  assert.equal(
    ((await invoke(parseArgv(["-C", root, "task", "update", ids.nested, "--parent", ids.child]))) as { kind: string })
      .kind,
    "accepted",
  );
  assert.equal(
    ((await invoke(parseArgv(["-C", root, "task", "update", ids.root, "--needs", ids.need]))) as { kind: string }).kind,
    "accepted",
  );

  const tree = await runCli(["-C", root, "task", "tree", ids.root], 36);
  assert.equal(tree.code, 0, tree.stderr);
  assert.match(tree.stdout, new RegExp(ids.root.replaceAll("/", "\\/"), "u"));
  assert.match(tree.stdout, new RegExp(`  ○ ${ids.child.replaceAll("/", "\\/")}`, "u"));
  assert.match(tree.stdout, new RegExp(`    ○ ${ids.nested.replaceAll("/", "\\/")}`, "u"));
  assert.doesNotMatch(tree.stdout, new RegExp(ids.need.replaceAll("/", "\\/"), "u"));
  assert.doesNotMatch(tree.stdout, /reference/u);

  const forbidden = await runCli(["-C", root, "task", "tree", "--full", ids.root]);
  assert.notEqual(forbidden.code, 0);
  assert.match(`${forbidden.stdout}\n${forbidden.stderr}`, /option --full is not valid for task tree/u);

  assert.equal(
    ((await invoke(parseArgv(["-C", root, "task", "update", ids.root, "--parent", ids.nested]))) as { kind: string })
      .kind,
    "accepted",
  );
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
    draft: "ns=/\n+ Remaining body=\n",
  };
  assert.equal(renderTaskText(command, result), "");
  assert.equal(
    renderTaskIncompleteDiagnostic(result),
    ["! compose incomplete · 1 admitted", "? stopped busy", "diff task/a", "", "diff bytes", ""].join("\n"),
  );
  assert.equal(taskExitCode(result), 1);
});

test("incomplete compose keeps an unterminated draft byte-exact at the CLI boundary", async () => {
  const command = parseArgv(["task", "compose", "-"]).command;
  if (command.command !== "task") throw new Error("not a task command");
  const result = {
    kind: "incomplete" as const,
    documentChanges: [],
    stopped: { kind: "retry" as const, reason: "busy" as const },
    draft: "ns=/\n+ Remaining",
  };
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
    assert.equal(await writeTask(command, result), 1);
  } finally {
    process.stdout.write = writeStdout;
    process.stderr.write = writeStderr;
  }
  assert.equal(stdout, result.draft);
  assert.equal(stdout.endsWith("\n"), false);
  assert.equal(stderr, "! compose incomplete · 0 admitted\n? stopped busy\n");
});

test("Task list, blocked, show, mutation, and batch text use one scan grammar", async () => {
  const root = world();
  const need = (await invoke(parseArgv(["-C", root, "task", "add", "Need"]))) as { value: { id: string } };
  const blockedTask = (await invoke(parseArgv(["-C", root, "task", "add", "Blocked", "--needs", need.value.id]))) as {
    value: { id: string };
  };
  const ready = (await invoke(parseArgv(["-C", root, "task", "add", "Ready"]))) as { value: { id: string } };
  await invoke(parseArgv(["-C", root, "task", "update", blockedTask.value.id, "--body", "exact body\nbytes"]));

  const lsCommand = parseArgv(["task", "ls"]).command;
  if (lsCommand.command !== "task") throw new Error("not a task command");
  const listed = (await invoke(parseArgv(["-C", root, "task", "ls", "--limit", "1"]))) as TaskInvocationResult;
  const listedText = renderTaskText(lsCommand, listed);
  assert.match(listedText, /^tasks · current namespace$/mu);
  assert.match(listedText, new RegExp(`^‖ ${blockedTask.value.id} · P2 blocked · updated .* — Blocked$`, "mu"));
  assert.match(listedText, /^…$/mu);
  assert.doesNotMatch(listedText, /needs |created |parent /u);

  const blockedCommand = parseArgv(["task", "blocked"]).command;
  if (blockedCommand.command !== "task") throw new Error("not a task command");
  const blocked = (await invoke(parseArgv(["-C", root, "task", "blocked"]))) as TaskInvocationResult;
  const blockedText = renderTaskText(blockedCommand, blocked);
  assert.match(blockedText, /^blocked$/mu);
  assert.match(blockedText, new RegExp(`^‖ ${blockedTask.value.id} · P2 blocked · updated .* — Blocked$`, "mu"));
  assert.match(blockedText, new RegExp(`^  needs ${need.value.id} · open$`, "mu"));

  const openNeed = (await invoke(parseArgv(["-C", root, "task", "add", "Open need"]))) as { value: { id: string } };
  await invoke(parseArgv(["-C", root, "task", "update", blockedTask.value.id, "--needs", openNeed.value.id]));
  await invoke(parseArgv(["-C", root, "task", "done", need.value.id]));

  const showCommand = parseArgv(["task", "show", blockedTask.value.id]).command;
  if (showCommand.command !== "task") throw new Error("not a task command");
  const shown = (await invoke(parseArgv(["-C", root, "task", "show", blockedTask.value.id]))) as TaskInvocationResult;
  const shownText = renderTaskText(showCommand, shown);
  assert.match(shownText, new RegExp(`^○ ${blockedTask.value.id} · P2 open — Blocked$`, "mu"));
  assert.match(shownText, /^created .* · updated .*$/mu);
  assert.match(shownText, new RegExp(`^  ! needs ${openNeed.value.id} · open$`, "mu"));
  assert.match(shownText, new RegExp(`^  ✓ needs ${need.value.id} · done$`, "mu"));
  assert.match(shownText, /body\n\nexact body\nbytes\n/u);
  assert.doesNotMatch(shownText, /\{/u);

  const addCommand = parseArgv(["task", "add", "Fresh"]).command;
  if (addCommand.command !== "task") throw new Error("not a task command");
  const added = (await invoke(parseArgv(["-C", root, "task", "add", "Fresh"]))) as TaskInvocationResult;
  if ((added as { kind: string }).kind !== "accepted") throw new Error("expected task add");
  const freshId = (added as { value: { id: string } }).value.id;
  const addedText = renderTaskText(addCommand, added);
  assert.match(addedText, new RegExp(`^✓ add accepted — ${freshId}$`, "mu"));
  assert.match(addedText, new RegExp(`^○ ${freshId} · P2 open — Fresh$`, "mu"));

  const updateCommand = parseArgv(["task", "update", freshId, "--title", "Fresh title"]).command;
  if (updateCommand.command !== "task") throw new Error("not a task command");
  const updated = (await invoke(
    parseArgv(["-C", root, "task", "update", freshId, "--title", "Fresh title"]),
  )) as TaskInvocationResult;
  const updatedText = renderTaskText(updateCommand, updated);
  assert.match(updatedText, new RegExp(`^✓ update accepted — ${freshId}$`, "mu"));
  assert.match(updatedText, new RegExp(`^○ ${freshId} · P2 open — Fresh title$`, "mu"));
  assert.match(updatedText, /^diff\n\n/mu);
  assert.equal(updatedText.includes((updated as { value: { documentDiff: string } }).value.documentDiff), true);

  const missing = (await invoke(parseArgv(["-C", root, "task", "start", "task/missing"]))) as TaskInvocationResult;
  const startCommand = parseArgv(["task", "start", "task/missing"]).command;
  if (startCommand.command !== "task") throw new Error("not a task command");
  const missingText = renderTaskText(startCommand, missing);
  assert.equal(missingText.split("\n")[0], "! start refused");
  assert.match(missingText, /^task-missing task\/missing$/mu);
  assert.doesNotMatch(missingText, /\{|"kind"/u);

  const batch = (await invoke(
    parseArgv(["-C", root, "task", "done", freshId, "task/missing", ready.value.id]),
  )) as TaskInvocationResult;
  const doneCommand = parseArgv(["task", "done", freshId, "task/missing", ready.value.id]).command;
  if (doneCommand.command !== "task") throw new Error("not a task command");
  assert.equal(
    renderTaskText(doneCommand, batch),
    [`✓ done ${freshId}`, "! done task/missing · task-missing task/missing", `✓ done ${ready.value.id}`].join("\n"),
  );
  assert.equal(taskExitCode(batch), 1);
});

test("singleton hold, done, and drop keep the batch item grammar", async () => {
  const root = world();
  const holdId = ((await invoke(parseArgv(["-C", root, "task", "add", "Hold me"]))) as { value: { id: string } }).value.id;
  const doneId = ((await invoke(parseArgv(["-C", root, "task", "add", "Done me"]))) as { value: { id: string } }).value.id;
  const dropId = ((await invoke(parseArgv(["-C", root, "task", "add", "Drop me"]))) as { value: { id: string } }).value.id;

  const holdCommand = parseArgv(["task", "hold", holdId]).command;
  const doneCommand = parseArgv(["task", "done", doneId]).command;
  const dropCommand = parseArgv(["task", "drop", dropId]).command;
  if (holdCommand.command !== "task" || doneCommand.command !== "task" || dropCommand.command !== "task") {
    throw new Error("not a task command");
  }

  const held = (await invoke(parseArgv(["-C", root, "task", "hold", holdId]))) as TaskInvocationResult;
  const finished = (await invoke(parseArgv(["-C", root, "task", "done", doneId]))) as TaskInvocationResult;
  const dropped = (await invoke(parseArgv(["-C", root, "task", "drop", dropId]))) as TaskInvocationResult;
  assert.equal(renderTaskText(holdCommand, held), `✓ hold ${holdId}`);
  assert.equal(renderTaskText(doneCommand, finished), `✓ done ${doneId}`);
  assert.equal(renderTaskText(dropCommand, dropped), `✓ drop ${dropId}`);

  const missingHold = (await invoke(parseArgv(["-C", root, "task", "hold", "task/missing"]))) as TaskInvocationResult;
  const missingDone = (await invoke(parseArgv(["-C", root, "task", "done", "task/missing"]))) as TaskInvocationResult;
  const missingDrop = (await invoke(parseArgv(["-C", root, "task", "drop", "task/missing"]))) as TaskInvocationResult;
  const holdMissingCommand = parseArgv(["task", "hold", "task/missing"]).command;
  const doneMissingCommand = parseArgv(["task", "done", "task/missing"]).command;
  const dropMissingCommand = parseArgv(["task", "drop", "task/missing"]).command;
  if (
    holdMissingCommand.command !== "task" ||
    doneMissingCommand.command !== "task" ||
    dropMissingCommand.command !== "task"
  ) {
    throw new Error("not a task command");
  }
  assert.equal(renderTaskText(holdMissingCommand, missingHold), "! hold task/missing · task-missing task/missing");
  assert.equal(renderTaskText(doneMissingCommand, missingDone), "! done task/missing · task-missing task/missing");
  assert.equal(renderTaskText(dropMissingCommand, missingDrop), "! drop task/missing · task-missing task/missing");

  const retryHold = {
    items: [{ id: "task/hold-me" as const, outcome: { kind: "retry" as const, reason: "busy" as const } }],
  };
  const retryDone = {
    items: [
      { id: "task/done-me" as const, outcome: { kind: "retry" as const, reason: "concurrent-modification" as const } },
    ],
  };
  const retryDrop = {
    items: [{ id: "task/drop-me" as const, outcome: { kind: "retry" as const, reason: "busy" as const } }],
  };
  assert.equal(renderTaskText(holdCommand, retryHold), "? hold task/hold-me · busy");
  assert.equal(renderTaskText(doneCommand, retryDone), "? done task/done-me · concurrent-modification");
  assert.equal(renderTaskText(dropCommand, retryDrop), "? drop task/drop-me · busy");
  assert.equal(taskExitCode(retryHold), 2);
});

test("task start accepts multiple IDs while preserving singleton output", async () => {
  const root = world();
  const first = ((await invoke(parseArgv(["-C", root, "task", "add", "First start"]))) as { value: { id: string } }).value.id;
  const second = ((await invoke(parseArgv(["-C", root, "task", "add", "Second start"]))) as { value: { id: string } }).value.id;
  const singleCommand = parseArgv(["task", "start", first]).command;
  if (singleCommand.command !== "task") throw new Error("not a task command");
  const single = (await invoke(parseArgv(["-C", root, "task", "start", first]))) as TaskInvocationResult;
  assert.match(renderTaskText(singleCommand, single), new RegExp(`^✓ start accepted — ${first}$`, "mu"));

  const multiCommand = parseArgv(["task", "start", second, "task/missing"]).command;
  if (multiCommand.command !== "task") throw new Error("not a task command");
  const multi = (await invoke(
    parseArgv(["-C", root, "task", "start", second, "task/missing"]),
  )) as TaskInvocationResult;
  assert.equal(
    renderTaskText(multiCommand, multi),
    [`✓ start ${second}`, "! start task/missing · task-missing task/missing"].join("\n"),
  );
  assert.equal(taskExitCode(multi), 1);
});

test("built CLI Task text stays one scan grammar at 80 and 36 columns", async () => {
  const root = world();
  const longTitle = "Deliberately long title that must wrap after the scan unit without splitting identity";
  const added = (await invoke(
    parseArgv([
      "-C",
      root,
      "task",
      "add",
      longTitle,
      "--namespace",
      "wide-namespace-segment",
      "--body",
      "show body bytes",
    ]),
  )) as { kind: string; value: { id: string } };
  assert.equal(added.kind, "accepted");
  const longId = added.value.id;
  const blocker = (await invoke(parseArgv(["-C", root, "task", "add", "Need only blocker outside the tree"]))) as {
    kind: string;
    value: { id: string };
  };
  assert.equal(blocker.kind, "accepted");
  const blockerId = blocker.value.id;
  await invoke(parseArgv(["-C", root, "task", "add", "Child under the alpha parent root"]));
  await invoke(parseArgv(["-C", root, "task", "update", "task/child-under-the-alpha-parent-root", "--parent", longId]));
  const needsUpdate = (await invoke(parseArgv(["-C", root, "task", "update", longId, "--needs", blockerId]))) as {
    kind: string;
  };
  assert.equal(needsUpdate.kind, "accepted");

  const wide = await runCli(["-C", root, "task", "show", longId]);
  assert.notEqual(wide.code, 3, wide.stderr);
  assert.doesNotMatch(wide.stdout, /\{"kind"|TaskId - P/u);
  assertCopyable(wide.stdout, [longId]);

  const narrow = await runCli(["-C", root, "task", "blocked", "--world"], 36);
  assert.notEqual(narrow.code, 3, narrow.stderr);
  assert.doesNotMatch(narrow.stdout, /\{"kind"|TaskId - P/u);
  assertCopyable(narrow.stdout, [longId, blockerId]);
  assert.equal(narrow.stdout.includes(`‖ ${longId} · P2 blocked · updated`), true);
  assertFitsOrOverflowsLawfully(narrow.stdout, 36);

  const empty = world();
  const absent = mkdtempSync(join(tmpdir(), "keiyaku-task-cli-smoke-absent-"));
  const failed = world();
  mkdirSync(join(failed, ".keiyaku", "tasks"));
  writeFileSync(join(failed, ".keiyaku", "tasks", "broken.md"), "not Task authority\n");
  const lsCommand = parseArgv(["task", "ls"]).command;
  if (lsCommand.command !== "task") throw new Error("not a task command");
  const presentEmpty = (await invoke(parseArgv(["-C", empty, "task", "ls"]))) as TaskInvocationResult;
  assert.deepEqual(presentEmpty, {
    kind: "present",
    value: { kind: "accepted", value: { rows: [], hasMore: false } },
  });
  assert.equal(renderTaskText(lsCommand, presentEmpty), "tasks · current namespace");
  assert.equal(taskExitCode(presentEmpty), 0);

  const absentCommand = parseArgv(["task", "ls"]).command;
  const missing = (await invoke(parseArgv(["-C", absent, "task", "ls"]))) as TaskInvocationResult;
  assert.deepEqual(missing, { kind: "absent" });
  assert.equal(renderTaskText(absentCommand, missing), "task world absent");
  assert.equal(taskExitCode(missing), 1);

  const broken = (await invoke(parseArgv(["-C", failed, "task", "ls"]))) as TaskInvocationResult;
  assert.equal((broken as { kind: string }).kind, "failed");
  assert.match(renderTaskText(lsCommand, broken), /^task world failed\ndiagnostic\n\n/u);
  assert.doesNotMatch(renderTaskText(lsCommand, broken), /\{/u);
  assert.equal(taskExitCode(broken), 3);

  const held = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "task-allocation.sqlite"),
    mode: "immediate",
    timeoutMs: 100,
  });
  let incomplete: TaskInvocationResult;
  try {
    incomplete = (await invoke(parseArgv(["-C", root, "task", "compose", "-"]), {
      readStdin: () => ["+ Remaining", "as = remaining", "body <<BODY", "+ literal", "BODY", ""].join("\n"),
    })) as TaskInvocationResult;
  } finally {
    held.close();
  }
  const composeCommand = parseArgv(["task", "compose", "-"]).command;
  if (composeCommand.command !== "task") throw new Error("not a task command");
  assert.equal((incomplete as { kind: string }).kind, "incomplete");
  assert.match((incomplete as { draft: string }).draft, /^ns=\/\n\n\+ Remaining\n/u);
  assert.equal(renderTaskText(composeCommand, incomplete), "");
  assert.match(
    renderTaskIncompleteDiagnostic(incomplete as never),
    /^! compose incomplete · 0 admitted\n\? stopped busy$/mu,
  );
  assert.equal(taskExitCode(incomplete), 1);
});
