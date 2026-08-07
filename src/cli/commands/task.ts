import {
  Tasks,
  type BlockedTaskList,
  type TaskBatchResult,
  type TaskCompositionResult,
  type TaskCycleReport,
  type TaskDependencyTree,
  type TaskDetail,
  type TaskId,
  type TaskList,
  type TaskMutationResult,
  type TaskPriority,
  type TaskUpdateResult,
} from "../../task/index.js";

type TaskAction = "add" | "show" | "ls" | "ready" | "blocked" | "tree" | "cycles" | "update"
  | "start" | "stop" | "hold" | "resume" | "done" | "drop" | "namespace" | "compose";
type TaskFlagValue = string | true | readonly string[];
type TaskStdin = "document" | "body" | "append" | "compose";

export type ParsedTaskCommand = Readonly<{
  command: "task";
  action: TaskAction;
  output: "text" | "json";
  positionals: readonly string[];
  flags: Readonly<Record<string, TaskFlagValue>>;
  stdin?: TaskStdin;
}>;

type TaskCommandSpec = Readonly<{
  arity: readonly [minimum: number, maximum: number];
  flags: Readonly<Record<string, "boolean" | "value" | "repeat">>;
  stdin?: "document" | "compose";
}>;

const COMMON = { json: "boolean" } as const;
const SPECS: Readonly<Record<TaskAction, TaskCommandSpec>> = {
  add: { arity: [0, 1], stdin: "document", flags: { ...COMMON, namespace: "value", priority: "value", needs: "repeat", parent: "value", supersedes: "repeat", relates: "repeat", contract: "value", body: "value" } },
  show: { arity: [1, 1], flags: COMMON },
  ls: { arity: [0, 0], flags: { ...COMMON, closed: "boolean", all: "boolean", world: "boolean" } },
  ready: { arity: [0, 0], flags: { ...COMMON, world: "boolean" } },
  blocked: { arity: [0, 0], flags: { ...COMMON, world: "boolean" } },
  tree: { arity: [1, 1], flags: { ...COMMON, full: "boolean" } },
  cycles: { arity: [0, 0], flags: COMMON },
  update: { arity: [1, 1], flags: { ...COMMON, title: "value", body: "value", append: "value", priority: "value", needs: "repeat", "drop-needs": "repeat", parent: "value", "no-parent": "boolean", supersedes: "repeat", "drop-supersedes": "repeat", relates: "repeat", "drop-relates": "repeat", contract: "value", "no-contract": "boolean" } },
  start: { arity: [1, 1], flags: COMMON }, stop: { arity: [1, 1], flags: COMMON },
  hold: { arity: [1, Number.POSITIVE_INFINITY], flags: COMMON }, resume: { arity: [1, 1], flags: COMMON },
  done: { arity: [1, Number.POSITIVE_INFINITY], flags: COMMON }, drop: { arity: [1, Number.POSITIVE_INFINITY], flags: COMMON },
  namespace: { arity: [0, 1], flags: COMMON },
  compose: { arity: [0, 0], stdin: "compose", flags: COMMON },
};

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
  if (next === "-" && input.action === "update" && (name === "body" || name === "append")) {
    if (input.index + 1 !== input.argv.length - 1 || input.stdin !== undefined) fail("stdin body marker '-' must be final");
    input.flags[name] = ""; return { index: input.index + 1, stdin: name };
  }
  if (kind !== "boolean" && (next === undefined || next.startsWith("--") || next === "-")) fail(`--${name} requires a value`);
  setFlag(input.flags, name, kind, next, fail);
  return { index: input.index + (kind === "boolean" ? 0 : 1), ...(input.stdin === undefined ? {} : { stdin: input.stdin }) };
}

function scanTaskArgv(action: TaskAction, argv: readonly string[], fail: (message: string) => never): ScannedTask {
  const spec = SPECS[action], positionals: string[] = [], flags: Record<string, TaskFlagValue> = {};
  let stdin: TaskStdin | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "-") {
      if (index !== argv.length - 1 || stdin !== undefined || spec.stdin === undefined) fail("stdin marker '-' is not valid here");
      stdin = spec.stdin; continue;
    }
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const scanned = scanTaskOption({ action, spec, argv, index, flags, ...(stdin === undefined ? {} : { stdin }) }, fail);
    index = scanned.index; stdin = scanned.stdin;
  }
  return { positionals, flags, ...(stdin === undefined ? {} : { stdin }) };
}

function validateUpdate(scanned: ScannedTask, fail: (message: string) => never): void {
  const flags = scanned.flags;
  if (flags.body !== undefined && flags.append !== undefined) fail("--body and --append are mutually exclusive");
  if (flags.parent !== undefined && flags["no-parent"] === true) fail("--parent and --no-parent are mutually exclusive");
  if (flags.contract !== undefined && flags["no-contract"] === true) fail("--contract and --no-contract are mutually exclusive");
  if (Object.keys(flags).every((name) => name === "json")) fail("task update requires at least one patch option");
}

function validateTaskScan(action: TaskAction, scanned: ScannedTask, fail: (message: string) => never): void {
  const spec = SPECS[action], { positionals, flags, stdin } = scanned;
  if (positionals.length < spec.arity[0] || positionals.length > spec.arity[1]) fail(`task ${action} has invalid positional arguments`);
  if (action === "add" && (stdin === "document") === (positionals.length === 1)) fail("task add requires either TITLE or final '-' input");
  if (action === "compose" && stdin !== "compose") fail("task compose requires final '-' input");
  if (action === "ls" && flags.closed === true && flags.all === true) fail("--closed and --all are mutually exclusive");
  if (action === "update") validateUpdate(scanned, fail);
}

export function parseTaskCommand(argv: readonly string[], fail: (message: string) => never): ParsedTaskCommand {
  const candidate = argv[0];
  if (candidate === undefined || !Object.hasOwn(SPECS, candidate)) fail(`unknown task command: ${candidate ?? ""}`);
  const action = candidate as TaskAction, scanned = scanTaskArgv(action, argv, fail);
  validateTaskScan(action, scanned, fail);
  return { command: "task", action, output: scanned.flags.json === true ? "json" : "text", ...scanned };
}

function value(command: ParsedTaskCommand, name: string): string | undefined {
  const item = command.flags[name]; return typeof item === "string" ? item : undefined;
}
function values(command: ParsedTaskCommand, name: string): readonly string[] | undefined {
  const item = command.flags[name]; return Array.isArray(item) ? item : undefined;
}
function namespace(raw: string | undefined): readonly string[] | undefined { return raw === undefined ? undefined : raw === "" ? [] : raw.split("/"); }
function priority(raw: string | undefined): TaskPriority | undefined {
  if (raw === undefined) return undefined;
  const number = Number(raw); return number as TaskPriority;
}
function ids(items: readonly string[] | undefined): readonly TaskId[] | undefined { return items as readonly TaskId[] | undefined; }

export type TaskInvocationResult = TaskMutationResult | TaskUpdateResult | TaskBatchResult | TaskCompositionResult
  | TaskDetail | TaskList | BlockedTaskList | TaskDependencyTree | TaskCycleReport | readonly string[];

type TaskProduct = ReturnType<typeof Tasks.at>;
type TaskInput = Readonly<{ path?: string; readStdin(): string }>;

function invokeAdd(tasks: TaskProduct, command: ParsedTaskCommand, readStdin: () => string): Promise<TaskMutationResult> {
  const selectedNamespace = namespace(value(command, "namespace"));
  if (command.stdin === "document") return tasks.addDocument({ markdown: readStdin(), ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }) });
  const body = value(command, "body"), selectedPriority = priority(value(command, "priority"));
  const needs = ids(values(command, "needs")), parent = value(command, "parent");
  const supersedes = ids(values(command, "supersedes")), relates = ids(values(command, "relates")), contractId = value(command, "contract");
  return tasks.add({
    title: command.positionals[0]!, ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
    ...(body === undefined ? {} : { body }), ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(needs === undefined ? {} : { needs }), ...(parent === undefined ? {} : { parent: parent as TaskId }),
    ...(supersedes === undefined ? {} : { supersedes }), ...(relates === undefined ? {} : { relates }),
    ...(contractId === undefined ? {} : { contractId }),
  });
}

function invokeUpdate(tasks: TaskProduct, command: ParsedTaskCommand, readStdin: () => string): Promise<TaskUpdateResult> {
  const body = command.stdin === "body" ? readStdin() : value(command, "body"), appendBody = command.stdin === "append" ? readStdin() : value(command, "append");
  const title = value(command, "title"), selectedPriority = priority(value(command, "priority"));
  const addNeeds = ids(values(command, "needs")), dropNeeds = ids(values(command, "drop-needs"));
  const parent = value(command, "parent"), addSupersedes = ids(values(command, "supersedes"));
  const dropSupersedes = ids(values(command, "drop-supersedes")), addRelates = ids(values(command, "relates"));
  const dropRelates = ids(values(command, "drop-relates")), contractId = value(command, "contract");
  return tasks.task({ id: command.positionals[0]! }).update({
    ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(appendBody === undefined ? {} : { appendBody }),
    ...(selectedPriority === undefined ? {} : { priority: selectedPriority }), ...(addNeeds === undefined ? {} : { addNeeds }),
    ...(dropNeeds === undefined ? {} : { dropNeeds }), ...(command.flags["no-parent"] === true ? { parent: null } : parent === undefined ? {} : { parent: parent as TaskId }),
    ...(addSupersedes === undefined ? {} : { addSupersedes }), ...(dropSupersedes === undefined ? {} : { dropSupersedes }),
    ...(addRelates === undefined ? {} : { addRelates }), ...(dropRelates === undefined ? {} : { dropRelates }),
    ...(command.flags["no-contract"] === true ? { contractId: null } : contractId === undefined ? {} : { contractId }),
  });
}

async function invokeRead(tasks: TaskProduct, command: ParsedTaskCommand): Promise<TaskInvocationResult> {
  const id = command.positionals[0]!;
  switch (command.action) {
    case "show": {
      const detail = await tasks.task({ id }).read();
      return detail ?? { kind: "refused", refusal: { kind: "task-missing", taskId: id as TaskId } };
    }
    case "ls": return tasks.list({ selection: command.flags.all === true ? "all" : command.flags.closed === true ? "closed" : "active", ...(command.flags.world === true ? { scope: "world" } : {}) });
    case "ready": return tasks.ready(command.flags.world === true ? { scope: "world" } : {});
    case "blocked": return tasks.blocked(command.flags.world === true ? { scope: "world" } : {});
    case "tree": return tasks.task({ id }).tree(command.flags.full === true ? { full: true } : {});
    case "cycles": return tasks.cycles();
    default: throw new Error(`task action is not a read: ${command.action}`);
  }
}

export async function invokeTask(command: ParsedTaskCommand, input: TaskInput): Promise<TaskInvocationResult> {
  const tasks = input.path === undefined ? Tasks.at() : Tasks.at({ path: input.path });
  if (["show", "ls", "ready", "blocked", "tree", "cycles"].includes(command.action)) return invokeRead(tasks, command);
  if (command.action === "add") return invokeAdd(tasks, command, input.readStdin);
  if (command.action === "update") return invokeUpdate(tasks, command, input.readStdin);
  const id = command.positionals[0]!;
  switch (command.action) {
    case "start": return tasks.task({ id }).start();
    case "stop": return tasks.task({ id }).stop();
    case "resume": return tasks.task({ id }).resume();
    case "hold": return tasks.batch({ verb: "hold", ids: command.positionals });
    case "done": return tasks.batch({ verb: "done", ids: command.positionals });
    case "drop": return tasks.batch({ verb: "drop", ids: command.positionals });
    case "namespace": {
      const selected = namespace(command.positionals[0]);
      if (selected !== undefined) await tasks.setNamespace({ namespace: selected });
      return tasks.namespace();
    }
    case "compose": return tasks.compose({ markdown: input.readStdin() });
    default: throw new Error(`task action has no invocation: ${command.action}`);
  }
}
