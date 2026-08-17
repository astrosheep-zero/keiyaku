import { CliUsageError, isBlankInput, usageLine, withJsonAutomationHelp } from "../usage.js";
import {
  parseTaskQueryExpression,
  validateTaskLimit,
  validateTaskParent,
  type TaskQueryExpression,
} from "./task-query.js";

export type TaskAction = "add" | "show" | "ls" | "ready" | "blocked" | "tree" | "doctor" | "update"
  | "query" | "start" | "stop" | "hold" | "resume" | "done" | "drop" | "namespace" | "compose";
type TaskFlagValue = string | true | readonly string[];
type TaskStdin = "document" | "body" | "append" | "note" | "compose";

export type ParsedTaskCommand = Readonly<{
  command: "task";
  action: TaskAction;
  output: "text" | "json";
  positionals: readonly string[];
  flags: Readonly<Record<string, TaskFlagValue>>;
  stdin?: TaskStdin;
  where?: TaskQueryExpression;
}>;

type TaskCommandSpec = Readonly<{
  arity: readonly [minimum: number, maximum: number];
  flags: Readonly<Record<string, "boolean" | "value" | "repeat">>;
  stdin?: "document" | "compose";
  usage: string;
  purpose: string;
}>;

const COMMON = { json: "boolean" } as const;
const TASK_COMMAND_SPECS: Readonly<Record<TaskAction, TaskCommandSpec>> = {
  add: {
    arity: [0, 1], stdin: "document", flags: { ...COMMON, namespace: "value", state: "value", priority: "value", needs: "repeat", parent: "value", supersedes: "repeat", relates: "repeat", body: "value", note: "value", actor: "value" },
    usage: `task add <TITLE> [--namespace <ns>] [--priority 0..3]
  [--state open|in_progress|on_hold|done|drop]
  [--note <text>] [--actor <actor>]
  [--needs <TaskId>]... [--parent <TaskId>]
  [--supersedes <TaskId>]... [--relates <TaskId>]...
  [--body <text>] [--json]
task add [--namespace <ns>] [--actor <actor>] [--json] -`,
    purpose: "Create one Task from flags or a canonical stdin document.",
  },
  show: { arity: [1, 1], flags: COMMON, usage: "task show <TaskId> [--json]", purpose: "Read one Task and its relationships." },
  ls: { arity: [0, 0], flags: { ...COMMON, closed: "boolean", all: "boolean", world: "boolean", limit: "value" }, usage: "task ls [--closed | --all] [--world] [--limit <n>] [--json]", purpose: "List Tasks in the selected scope." },
  ready: { arity: [0, 0], flags: { ...COMMON, world: "boolean", parent: "value", limit: "value" }, usage: "task ready [--world] [--parent <TaskId>] [--limit <n>] [--json]", purpose: "List open Tasks whose every need is terminal." },
  blocked: { arity: [0, 0], flags: { ...COMMON, world: "boolean", parent: "value", limit: "value" }, usage: "task blocked [--world] [--parent <TaskId>] [--limit <n>] [--json]", purpose: "List Tasks blocked by dependencies." },
  query: { arity: [0, 0], flags: { ...COMMON, where: "value", world: "boolean", sort: "value", limit: "value" }, usage: `task query [--where <expression>] [--world]
  [--sort priority|created|updated|id] [--limit <n>] [--json]`, purpose: "Query Task facts with a typed boolean expression." },
  tree: { arity: [1, 1], flags: COMMON, usage: "task tree <TaskId> [--json]", purpose: "Read one Task parent decomposition tree." },
  doctor: { arity: [0, 0], flags: COMMON, usage: "task doctor [--json]", purpose: "Inspect Task authority without repairing it." },
  update: {
    arity: [1, 1], flags: { ...COMMON, title: "value", body: "value", append: "value", note: "value", priority: "value", needs: "repeat", "drop-needs": "repeat", parent: "value", "no-parent": "boolean", supersedes: "repeat", "drop-supersedes": "repeat", relates: "repeat", "drop-relates": "repeat" },
    usage: `task update <TaskId> [--title <text>] [--body <text>|- | --append <text>|-]
  [--note <text>|-]
  [--priority 0..3] [--needs <TaskId>]... [--drop-needs <TaskId>]...
  [--parent <TaskId> | --no-parent]
  [--supersedes <TaskId>]... [--drop-supersedes <TaskId>]...
  [--relates <TaskId>]... [--drop-relates <TaskId>]... [--json]`,
    purpose: "Apply one or more patches to a Task.",
  },
  start: { arity: [1, 1], flags: COMMON, usage: "task start <TaskId> [--json]", purpose: "Move one open Task into progress." },
  stop: { arity: [1, 1], flags: COMMON, usage: "task stop <TaskId> [--json]", purpose: "Return one in-progress Task to open." },
  hold: { arity: [1, Number.POSITIVE_INFINITY], flags: COMMON, usage: "task hold <TaskId>... [--json]", purpose: "Put one or more Tasks on hold." },
  resume: { arity: [1, 1], flags: COMMON, usage: "task resume <TaskId> [--json]", purpose: "Return one held Task to open." },
  done: { arity: [1, Number.POSITIVE_INFINITY], flags: { ...COMMON, note: "value" }, usage: "task done <TaskId>... [--note <text>] [--json]", purpose: "Mark one or more Tasks done." },
  drop: { arity: [1, Number.POSITIVE_INFINITY], flags: { ...COMMON, note: "value" }, usage: "task drop <TaskId>... [--note <text>] [--json]", purpose: "Drop one or more Tasks." },
  namespace: { arity: [0, 1], flags: COMMON, usage: "task namespace [<namespace>] [--json]", purpose: "Read or replace the current Task namespace." },
  compose: { arity: [0, 0], stdin: "compose", flags: { ...COMMON, actor: "value" }, usage: "task compose [--actor <actor>] [--json] -", purpose: "Admit Task documents independently; partial admission has no cross-file atomicity or rollback." },
};

export function isTaskAction(value: string | undefined): value is TaskAction {
  return value !== undefined && Object.hasOwn(TASK_COMMAND_SPECS, value);
}

export function renderTaskHelp(action?: TaskAction): string {
  if (action !== undefined) {
    const spec = TASK_COMMAND_SPECS[action];
    return withJsonAutomationHelp(`${spec.purpose}\n\n${usageLine(spec.usage)}`);
  }
  return withJsonAutomationHelp([
    "usage: keiyaku task <command> ...",
    "",
    "commands:",
    ...Object.values(TASK_COMMAND_SPECS).flatMap((spec) => spec.usage.split("\n").map((line) => `  ${line}`).concat(`    ${spec.purpose}`)),
  ].join("\n"));
}

export function renderTaskUsage(action: TaskAction): string {
  return usageLine(TASK_COMMAND_SPECS[action].usage);
}

function setFlag(
  flags: Record<string, TaskFlagValue>,
  name: string,
  kind: "boolean" | "value" | "repeat",
  value: string | undefined,
  fail: (message: string) => never,
): void {
  if (flags[name] !== undefined && kind !== "repeat") fail(`duplicate option: --${name}`);
  if (kind === "boolean") { flags[name] = true; return; }
  if (value === undefined) fail(`--${name} requires a value`);
  if (isBlankInput(value)) fail(`--${name} requires a nonblank value`);
  if (kind === "repeat") {
    const current = flags[name]; flags[name] = [...(Array.isArray(current) ? current : []), value];
  } else flags[name] = value;
}

type ScannedTask = Readonly<{ positionals: readonly string[]; flags: Readonly<Record<string, TaskFlagValue>>; stdin?: TaskStdin }>;

function scanTaskOption(input: Readonly<{
  action: TaskAction; spec: TaskCommandSpec; argv: readonly string[]; index: number;
  flags: Record<string, TaskFlagValue>; stdin?: TaskStdin;
}>, fail: (message: string) => never): Readonly<{ index: number; stdin?: TaskStdin }> {
  const token = input.argv[input.index]!, name = token.slice(2), kind = input.spec.flags[name];
  if (kind === undefined) fail(`option ${token} is not valid for task ${input.action}`);
  const next = kind === "boolean" ? undefined : input.argv[input.index + 1];
  if (next === "-" && input.action === "update" && (name === "body" || name === "append" || name === "note")) {
    if (input.index + 1 !== input.argv.length - 1 || input.stdin !== undefined) fail("stdin update marker '-' must be final");
    input.flags[name] = ""; return { index: input.index + 1, stdin: name };
  }
  if (kind !== "boolean" && (next === undefined || next.startsWith("--") || next === "-")) fail(`--${name} requires a value`);
  setFlag(input.flags, name, kind, next, fail);
  return { index: input.index + (kind === "boolean" ? 0 : 1), ...(input.stdin === undefined ? {} : { stdin: input.stdin }) };
}

function scanTaskArgv(action: TaskAction, argv: readonly string[], fail: (message: string) => never): ScannedTask {
  const spec = TASK_COMMAND_SPECS[action], positionals: string[] = [], flags: Record<string, TaskFlagValue> = {};
  let stdin: TaskStdin | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-") {
      if (index !== argv.length - 1 || stdin !== undefined || spec.stdin === undefined) fail("stdin marker '-' is not valid here");
      stdin = spec.stdin; continue;
    }
    if (!token.startsWith("--")) {
      if (isBlankInput(token)) fail(`task ${action} requires a nonblank value`);
      positionals.push(token);
      continue;
    }
    const scanned = scanTaskOption({ action, spec, argv, index, flags, ...(stdin === undefined ? {} : { stdin }) }, fail);
    index = scanned.index; stdin = scanned.stdin;
  }
  return { positionals, flags, ...(stdin === undefined ? {} : { stdin }) };
}

function validateUpdate(scanned: ScannedTask, fail: (message: string) => never): void {
  const flags = scanned.flags;
  if (flags.body !== undefined && flags.append !== undefined) fail("--body and --append are mutually exclusive");
  if (flags.parent !== undefined && flags["no-parent"] === true) fail("--parent and --no-parent are mutually exclusive");
  if (Object.keys(flags).every((name) => name === "json")) fail("task update requires at least one patch option");
}

function validateTaskReadFlags(
  action: TaskAction,
  flags: Readonly<Record<string, TaskFlagValue>>,
  fail: (message: string) => never,
): void {
  if (action === "ls" && flags.closed === true && flags.all === true) fail("--closed and --all are mutually exclusive");
  if (typeof flags.limit === "string") {
    try { validateTaskLimit(flags.limit); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  }
  if (typeof flags.sort === "string" && flags.sort !== "priority" && flags.sort !== "created" && flags.sort !== "updated" && flags.sort !== "id") {
    fail("--sort must be priority, created, updated, or id");
  }
  if ((action === "ready" || action === "blocked") && typeof flags.parent === "string") {
    try { validateTaskParent(flags.parent); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  }
}

function validateTaskScan(action: TaskAction, scanned: ScannedTask, fail: (message: string) => never): void {
  const spec = TASK_COMMAND_SPECS[action], { positionals, flags, stdin } = scanned;
  if (positionals.length < spec.arity[0] || positionals.length > spec.arity[1]) fail(`task ${action} has invalid positional arguments`);
  if (action === "add" && (stdin === "document") === (positionals.length === 1)) fail("task add requires either TITLE or final '-' input");
  if (action === "add" && stdin === "document" && Object.keys(flags).some((name) => name !== "json" && name !== "namespace" && name !== "actor")) fail("task add document input owns its creation fields");
  if (action === "compose" && stdin !== "compose") fail("task compose requires final '-' input");
  validateTaskReadFlags(action, flags, fail);
  if (action === "update") validateUpdate(scanned, fail);
}

export function parseTaskCommand(argv: readonly string[]): ParsedTaskCommand {
  const candidate = argv[0];
  if (!isTaskAction(candidate)) throw new CliUsageError(`unknown task command: ${candidate ?? ""}`, renderTaskHelp());
  const action = candidate;
  const fail = (message: string): never => { throw new CliUsageError(message, renderTaskUsage(action)); };
  const scanned = scanTaskArgv(action, argv, fail);
  validateTaskScan(action, scanned, fail);
  let where: TaskQueryExpression | undefined;
  if (action === "query" && typeof scanned.flags.where === "string") {
    try { where = parseTaskQueryExpression(scanned.flags.where); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  }
  return { command: "task", action, output: scanned.flags.json === true ? "json" : "text", ...scanned, ...(where === undefined ? {} : { where }) };
}
