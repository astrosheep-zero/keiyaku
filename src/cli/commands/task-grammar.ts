import { CliUsageError, TASK_FAMILY_USAGE_GUIDE, unknownCommandGuide, type CliUsageGuide } from "../usage.js";
import { scanArgs, type ScanFlagKind, type ScanSpec, type ScannedArgs } from "../scan.js";
import { parseTaskNamespaceSelector } from "../../task/catalog.js";
import { parseTaskId } from "../../task/identity.js";
import {
  parseTaskQueryExpression,
  validateTaskLimit,
  validateTaskParent,
  type TaskQueryExpression,
} from "./task-query.js";

export type TaskAction =
  | "add"
  | "show"
  | "ls"
  | "ready"
  | "blocked"
  | "tree"
  | "doctor"
  | "update"
  | "query"
  | "done"
  | "drop"
  | "context";
type TaskFlagValue = string | true | readonly string[];
type TaskStdin = "document" | "body" | "append" | "note";

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
  flags: Readonly<Record<string, ScanFlagKind>>;
  stdin?: "document";
  usage: string;
  purpose: string;
  details?: string;
}>;

const COMMON = { json: "boolean" } as const;
const TASK_COMMAND_SPECS: Readonly<Record<TaskAction, TaskCommandSpec>> = {
  add: {
    arity: [0, 1],
    stdin: "document",
    flags: {
      ...COMMON,
      namespace: "value",
      state: "value",
      priority: "value",
      needs: "repeat",
      parent: "value",
      supersedes: "repeat",
      relates: "repeat",
      body: "value",
      note: "value",
      actor: "value",
    },
    usage: `task add <TITLE> [--namespace <ns>] [--priority 0..3]
  [--state open|done|drop]
  [--note <text>] [--actor <actor>]
  [--needs <TaskId>]... [--parent <TaskId>]
  [--supersedes <TaskId>]... [--relates <TaskId>]...
  [--body <text>]
task add [--namespace <ns>] [--actor <actor>] -`,
    purpose: "Create a Task from flags or a Task document on stdin.",
    details:
      "The stdin document is YAML front matter (title, state, priority, needs, parent, supersedes, relates, note) followed by a Markdown body.",
  },
  show: {
    arity: [1, Number.POSITIVE_INFINITY],
    flags: COMMON,
    usage: "task show <TaskId>...",
    purpose: "Read one or more Tasks and their relationships.",
  },
  ls: {
    arity: [0, 1],
    flags: { ...COMMON, closed: "boolean", all: "boolean", world: "boolean", limit: "value" },
    usage: "task ls [<namespace-selector>] [--closed | --all] [--world] [--limit <n>]",
    purpose: "List Tasks in the selected namespace.",
    details: [
      "With no selector, lists the current directory Task context.",
      "task/ selects the root namespace; --world lists every namespace in the current Task world.",
    ].join("\n"),
  },
  ready: {
    arity: [0, 0],
    flags: { ...COMMON, world: "boolean", parent: "value", limit: "value" },
    usage: "task ready [--world] [--parent <TaskId>] [--limit <n>]",
    purpose: "List open Tasks whose every dependency is complete or dropped.",
    details: "--world lists every namespace in the current Task world.",
  },
  blocked: {
    arity: [0, 0],
    flags: { ...COMMON, world: "boolean", parent: "value", limit: "value" },
    usage: "task blocked [--world] [--parent <TaskId>] [--limit <n>]",
    purpose: "List Tasks with unmet dependencies.",
    details: "--world lists every namespace in the current Task world.",
  },
  query: {
    arity: [0, 0],
    flags: {
      ...COMMON,
      where: "value",
      world: "boolean",
      closed: "boolean",
      all: "boolean",
      sort: "value",
      limit: "value",
    },
    usage: `task query [--where <expression>] [--closed | --all] [--world]
  [--sort priority|created|updated|id] [--limit <n>]`,
    purpose: "Filter and sort Tasks with a boolean expression.",
    details: [
      "fields: state priority title id parent under needs blocks ready blocked created updated",
      "operators: = != < > <= >= ~ and or not ( )",
      "sort: priority and created ascend; updated descends; id is lexical. Default: priority.",
      "--world lists every namespace in the current Task world.",
      "By default only active Tasks match; --closed selects terminal Tasks, --all includes both.",
      "examples:",
      "  keiyaku task query --where 'priority <= 1 and ready' --world",
      "  keiyaku task query --where 'updated < 2026-08-06T00:00:00.000Z' --world",
    ].join("\n"),
  },
  tree: {
    arity: [1, 1],
    flags: COMMON,
    usage: "task tree <TaskId>",
    purpose: "Show a Task and its parent/child breakdown.",
  },
  doctor: {
    arity: [0, 0],
    flags: COMMON,
    usage: "task doctor",
    purpose: "Check Tasks for inconsistencies without changing them.",
  },
  update: {
    arity: [1, 1],
    flags: {
      ...COMMON,
      title: "value",
      body: "value",
      append: "value",
      note: "value",
      priority: "value",
      needs: "repeat",
      "drop-needs": "repeat",
      parent: "value",
      "no-parent": "boolean",
      supersedes: "repeat",
      "drop-supersedes": "repeat",
      relates: "repeat",
      "drop-relates": "repeat",
    },
    usage: `task update <TaskId> [--title <text>] [--body <text>|- | --append <text>]
  [--note <text>]
  [--priority 0..3] [--needs <TaskId>]... [--drop-needs <TaskId>]...
  [--parent <TaskId> | --no-parent]
  [--supersedes <TaskId>]... [--drop-supersedes <TaskId>]...
  [--relates <TaskId>]... [--drop-relates <TaskId>]...`,
    purpose: "Change a Task's fields and relationships.",
    details: [
      "--body replaces the body; --append adds text after it, separated by a newline when needed.",
      "--body - reads replacement body text from stdin.",
    ].join("\n"),
  },
  done: {
    arity: [1, Number.POSITIVE_INFINITY],
    flags: { ...COMMON, note: "value" },
    usage: "task done <TaskId>... [--note <text>]",
    purpose: "Mark one or more Tasks done.",
  },
  drop: {
    arity: [1, Number.POSITIVE_INFINITY],
    flags: { ...COMMON, note: "value" },
    usage: "task drop <TaskId>... [--note <text>]",
    purpose: "Mark one or more Tasks as no longer needed.",
  },
  context: {
    arity: [0, 1],
    flags: COMMON,
    usage: "task context [<namespace>]",
    purpose: "Set or read the default Task namespace for this directory.",
    details: "Omit <namespace> to read the current context; use / to reset it to the root namespace.",
  },
};

export function isTaskAction(value: string | undefined): value is TaskAction {
  return value !== undefined && Object.hasOwn(TASK_COMMAND_SPECS, value);
}

export function renderTaskHelp(action?: TaskAction): string {
  if (action !== undefined) {
    const spec = TASK_COMMAND_SPECS[action];
    return `${spec.purpose}\n\n${renderTaskUsage(action)}${spec.details === undefined ? "" : `\n\n${spec.details}`}`;
  }
  const nameWidth = Math.max(...Object.keys(TASK_COMMAND_SPECS).map((name) => name.length));
  return [
    "usage  keiyaku task <command> ...",
    "      keiyaku task <command> --help   shows that command's complete usage",
    "",
    ...Object.entries(TASK_COMMAND_SPECS).map(([name, spec]) => `  ${name.padEnd(nameWidth)}  ${spec.purpose}`),
  ].join("\n");
}

function renderTaskUsage(action: TaskAction): string {
  return TASK_COMMAND_SPECS[action].usage
    .split("\n")
    .map((line, index) => {
      if (index === 0 || line.trimStart().startsWith("task ")) {
        const command = line.trimStart().startsWith("task ") ? `keiyaku ${line.trim()}` : `keiyaku ${line}`;
        return `${index === 0 ? "usage  " : "      "}${command}`;
      }
      return `      ${line.trim()}`;
    })
    .join("\n");
}

function taskUsage(action: TaskAction): string {
  const lines = TASK_COMMAND_SPECS[action].usage.split("\n");
  return lines
    .map((line, index) => {
      if (index === 0 || line.trimStart().startsWith("task ")) return `keiyaku ${line.trim()}`;
      return `           ${line.trim()}`;
    })
    .join("\n");
}

export function taskUsageGuide(action: TaskAction): CliUsageGuide {
  return {
    scope: `keiyaku task ${action}`,
    accepts: taskUsage(action),
    help: `keiyaku task ${action} --help`,
  };
}

type ScannedTask = ScannedArgs<TaskStdin>;

/** One scan spec per Task action: `-` reads the document, or `--body -` replaces an update body. */
function scanSpec(action: TaskAction, spec: TaskCommandSpec): ScanSpec<TaskStdin> {
  return {
    subject: `task ${action}`,
    flags: spec.flags,
    ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
    stdinRefusal: "stdin marker '-' is not valid here",
    ...(action === "update" ? { stdinValue: "body" } : {}),
  };
}

function validateUpdate(scanned: ScannedTask, fail: (message: string) => never): void {
  const flags = scanned.flags;
  if (flags.body !== undefined && flags.append !== undefined) fail("--body and --append are mutually exclusive");
  if (flags.parent !== undefined && flags["no-parent"] === true)
    fail("--parent and --no-parent are mutually exclusive");
  if (Object.keys(flags).every((name) => name === "json")) fail("task update requires at least one patch option");
}

function validateTaskReadFlags(
  action: TaskAction,
  flags: Readonly<Record<string, TaskFlagValue>>,
  fail: (message: string) => never,
): void {
  if ((action === "ls" || action === "query") && flags.closed === true && flags.all === true)
    fail("--closed and --all are mutually exclusive");
  if (action === "ls" && flags.world === true) {
    // An explicit selector is checked below, after positional shape is known.
  }
  if (typeof flags.limit === "string") {
    try {
      validateTaskLimit(flags.limit);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (
    typeof flags.sort === "string" &&
    flags.sort !== "priority" &&
    flags.sort !== "created" &&
    flags.sort !== "updated" &&
    flags.sort !== "id"
  ) {
    fail("--sort must be priority, created, updated, or id");
  }
  if ((action === "ready" || action === "blocked") && typeof flags.parent === "string") {
    try {
      validateTaskParent(flags.parent);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Actions whose positionals are all addressed TaskIds validated by the native owner. */
const TASK_ID_ACTIONS: ReadonlySet<TaskAction> = new Set(["show", "tree", "update", "done", "drop"]);

/** Validate every addressed TaskId positional through the native owner before any read or write. */
function validateTaskIdPositionals(positionals: readonly string[], fail: (message: string) => never): void {
  for (const taskId of positionals) {
    try {
      parseTaskId(taskId);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Validate an explicit `task ls` namespace selector through the native owner. */
function validateListSelector(selector: string, fail: (message: string) => never): void {
  if (selector !== "task/" && (!selector.startsWith("task/") || !selector.endsWith("/")))
    fail(`invalid Task namespace selector: ${selector}`);
  if (selector === "task/") return;
  try {
    parseTaskNamespaceSelector(selector);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function validateTaskScan(action: TaskAction, scanned: ScannedTask, fail: (message: string) => never): void {
  const spec = TASK_COMMAND_SPECS[action],
    { positionals, flags, stdin } = scanned;
  if (positionals.length < spec.arity[0])
    fail(spec.arity[1] === 1 ? `task ${action} requires a TaskId` : `task ${action} requires at least one TaskId`);
  if (positionals.length > spec.arity[1])
    fail(
      spec.arity[1] === 0
        ? `task ${action} accepts no positional arguments`
        : `task ${action} accepts at most ${spec.arity[1]} positional argument${spec.arity[1] === 1 ? "" : "s"}`,
    );
  if (action === "add" && (stdin === "document") === (positionals.length === 1))
    fail("task add requires either TITLE or '-' input");
  if (
    action === "add" &&
    stdin === "document" &&
    Object.keys(flags).some((name) => name !== "json" && name !== "namespace" && name !== "actor")
  )
    fail("task add document input owns its creation fields");
  if (TASK_ID_ACTIONS.has(action)) validateTaskIdPositionals(positionals, fail);
  if (action === "ls" && positionals.length === 1) {
    validateListSelector(positionals[0]!, fail);
    if (flags.world === true) fail("--world cannot be combined with an explicit Task namespace selector");
  }
  validateTaskReadFlags(action, flags, fail);
  if (action === "update") validateUpdate(scanned, fail);
}

export function parseTaskCommand(argv: readonly string[]): ParsedTaskCommand {
  const candidate = argv[0];
  if (!isTaskAction(candidate)) {
    throw new CliUsageError(
      `unknown task command: ${candidate ?? ""}`,
      unknownCommandGuide(TASK_FAMILY_USAGE_GUIDE, candidate ?? ""),
    );
  }
  const action = candidate;
  const fail = (message: string): never => {
    throw new CliUsageError(message, taskUsageGuide(action));
  };
  const scanned = scanArgs(argv, scanSpec(action, TASK_COMMAND_SPECS[action]), fail);
  validateTaskScan(action, scanned, fail);
  let where: TaskQueryExpression | undefined;
  if (action === "query" && typeof scanned.flags.where === "string") {
    try {
      where = parseTaskQueryExpression(scanned.flags.where);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    command: "task",
    action,
    output: scanned.flags.json === true ? "json" : "text",
    ...scanned,
    ...(where === undefined ? {} : { where }),
  };
}
