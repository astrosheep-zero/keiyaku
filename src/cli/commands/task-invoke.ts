import {
  Tasks,
  type BlockedTaskList,
  type TaskBatchResult,
  type TaskCompositionResult,
  type TaskDecompositionTree,
  type TaskDetail,
  type TaskDoctorReport,
  type TaskId,
  type TaskList,
  type TaskMutationResult,
  type TaskNamespaceResult,
  type TaskPriority,
  type TaskQueryResult,
  type TaskQuerySort,
  type TaskState,
  type TaskUpdateResult,
} from "../../task/index.js";
import type { ParsedTaskCommand } from "./task.js";
import type { WorldRoot } from "../../world.js";

export type TaskInvocationResult = TaskMutationResult | TaskUpdateResult | TaskBatchResult | TaskCompositionResult
  | TaskDetail | TaskList | BlockedTaskList | TaskQueryResult | TaskDecompositionTree | TaskDoctorReport | TaskNamespaceResult
  | TaskWorldObservation;

type TaskWorldRead = TaskList | BlockedTaskList | TaskQueryResult | TaskDoctorReport;
export type TaskWorldObservation =
  | Readonly<{ kind: "present"; value: TaskWorldRead }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

type TaskProduct = ReturnType<typeof Tasks.of>;
type TaskInput = Readonly<{ world: WorldRoot | null; establish(): Promise<WorldRoot>; readStdin(): Promise<string>; actor?: string }>;

function value(command: ParsedTaskCommand, name: string): string | undefined {
  const item = command.flags[name]; return typeof item === "string" ? item : undefined;
}
function values(command: ParsedTaskCommand, name: string): readonly string[] | undefined {
  const item = command.flags[name]; return Array.isArray(item) ? item : undefined;
}
function namespace(raw: string | undefined): readonly string[] | undefined { return raw === undefined ? undefined : raw === "/" ? [] : raw.split("/"); }
function priority(raw: string | undefined): TaskPriority | undefined {
  if (raw === undefined) return undefined;
  const number = Number(raw); return number as TaskPriority;
}
function state(raw: string | undefined): TaskState | undefined { return raw as TaskState | undefined; }
function ids(items: readonly string[] | undefined): readonly TaskId[] | undefined { return items as readonly TaskId[] | undefined; }
function limit(command: ParsedTaskCommand): number | undefined { const raw = value(command, "limit"); return raw === undefined ? undefined : Number(raw); }

async function invokeAdd(tasks: TaskProduct, command: ParsedTaskCommand, input: TaskInput): Promise<TaskMutationResult> {
  const selectedNamespace = namespace(value(command, "namespace"));
  const actor = input.actor;
  if (command.stdin === "document") {
    return tasks.addDocument({
      markdown: await input.readStdin(),
      ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
      ...(actor === undefined ? {} : { actor }),
    });
  }
  const body = value(command, "body"), note = value(command, "note"), initialState = state(value(command, "state")), selectedPriority = priority(value(command, "priority"));
  const needs = ids(values(command, "needs")), parent = value(command, "parent");
  const supersedes = ids(values(command, "supersedes")), relates = ids(values(command, "relates"));
  return tasks.add({
    title: command.positionals[0]!, ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
    ...(body === undefined ? {} : { body }), ...(note === undefined ? {} : { note }), ...(initialState === undefined ? {} : { state: initialState }), ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(needs === undefined ? {} : { needs }), ...(parent === undefined ? {} : { parent: parent as TaskId }),
    ...(supersedes === undefined ? {} : { supersedes }), ...(relates === undefined ? {} : { relates }),
    ...(actor === undefined ? {} : { actor }),
  });
}

async function invokeUpdate(tasks: TaskProduct, command: ParsedTaskCommand, readStdin: () => Promise<string>): Promise<TaskUpdateResult> {
  const body = command.stdin === "body" ? await readStdin() : value(command, "body"), appendBody = command.stdin === "append" ? await readStdin() : value(command, "append");
  const note = command.stdin === "note" ? await readStdin() : value(command, "note");
  const title = value(command, "title"), selectedPriority = priority(value(command, "priority"));
  const addNeeds = ids(values(command, "needs")), dropNeeds = ids(values(command, "drop-needs"));
  const parent = value(command, "parent"), addSupersedes = ids(values(command, "supersedes"));
  const dropSupersedes = ids(values(command, "drop-supersedes")), addRelates = ids(values(command, "relates"));
  const dropRelates = ids(values(command, "drop-relates"));
  return tasks.task({ id: command.positionals[0]! }).update({
    ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(appendBody === undefined ? {} : { appendBody }), ...(note === undefined ? {} : { note }),
    ...(selectedPriority === undefined ? {} : { priority: selectedPriority }), ...(addNeeds === undefined ? {} : { addNeeds }),
    ...(dropNeeds === undefined ? {} : { dropNeeds }), ...(command.flags["no-parent"] === true ? { parent: null } : parent === undefined ? {} : { parent: parent as TaskId }),
    ...(addSupersedes === undefined ? {} : { addSupersedes }), ...(dropSupersedes === undefined ? {} : { dropSupersedes }),
    ...(addRelates === undefined ? {} : { addRelates }), ...(dropRelates === undefined ? {} : { dropRelates }),
  });
}

async function invokeRead(tasks: TaskProduct, command: ParsedTaskCommand): Promise<TaskInvocationResult> {
  const id = command.positionals[0]!;
  switch (command.action) {
    case "show": {
      const detail = await tasks.task({ id }).read();
      return detail ?? { kind: "refused", refusal: { kind: "task-missing", taskId: id as TaskId } };
    }
    case "ls": return tasks.list({ selection: command.flags.all === true ? "all" : command.flags.closed === true ? "closed" : "active", ...(command.flags.world === true ? { scope: "world" } : {}), ...(limit(command) === undefined ? {} : { limit: limit(command)! }) });
    case "ready": return tasks.ready({ ...(command.flags.world === true ? { scope: "world" as const } : {}), ...(value(command, "parent") === undefined ? {} : { parent: value(command, "parent")! }), ...(limit(command) === undefined ? {} : { limit: limit(command)! }) });
    case "blocked": return tasks.blocked({ ...(command.flags.world === true ? { scope: "world" as const } : {}), ...(value(command, "parent") === undefined ? {} : { parent: value(command, "parent")! }), ...(limit(command) === undefined ? {} : { limit: limit(command)! }) });
    case "query": return tasks.query({ ...(command.where === undefined ? {} : { where: command.where }), ...(command.flags.world === true ? { scope: "world" as const } : {}), ...(value(command, "sort") === undefined ? {} : { sort: value(command, "sort") as TaskQuerySort }), ...(limit(command) === undefined ? {} : { limit: limit(command)! }) });
    case "tree": return tasks.task({ id }).tree();
    case "doctor": return tasks.doctor();
    default: throw new Error(`task action is not a read: ${command.action}`);
  }
}

function isWorldObservation(command: ParsedTaskCommand): command is ParsedTaskCommand & Readonly<{
  action: "ls" | "ready" | "blocked" | "query" | "doctor";
}> {
  return command.action === "ls" || command.action === "ready" || command.action === "blocked"
    || command.action === "query" || command.action === "doctor";
}

function diagnostic(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function observeWorldRead(tasks: TaskProduct, command: ParsedTaskCommand): Promise<TaskWorldObservation> {
  try { return { kind: "present", value: await invokeRead(tasks, command) as TaskWorldRead }; }
  catch (error) { return { kind: "failed", failure: { message: diagnostic(error) } }; }
}

function missingWorld(command: ParsedTaskCommand): TaskInvocationResult {
  const missing = (id: string): TaskMutationResult => ({
    kind: "refused",
    refusal: { kind: "task-missing", taskId: id as TaskId },
  });
  if (isWorldObservation(command)) return { kind: "absent" };
  if (command.action === "namespace") return { kind: "accepted", value: [] };
  if (command.action === "hold" || command.action === "done" || command.action === "drop") {
    return { items: command.positionals.map((id) => ({ id: id as TaskId, outcome: missing(id) })) };
  }
  return missing(command.positionals[0]!);
}

export async function invokeTask(command: ParsedTaskCommand, input: TaskInput): Promise<TaskInvocationResult> {
  let world = input.world;
  if (world === null && (command.action === "add" || command.action === "compose"
    || (command.action === "namespace" && command.positionals.length > 0))) {
    world = await input.establish();
  }
  if (world === null) return missingWorld(command);
  const tasks = Tasks.of(world);
  if (isWorldObservation(command)) return observeWorldRead(tasks, command);
  if (command.action === "show" || command.action === "tree") return invokeRead(tasks, command);
  if (command.action === "add") return await invokeAdd(tasks, command, input);
  if (command.action === "update") return await invokeUpdate(tasks, command, input.readStdin);
  const id = command.positionals[0]!;
  switch (command.action) {
    case "start": return tasks.task({ id }).start();
    case "stop": return tasks.task({ id }).stop();
    case "resume": return tasks.task({ id }).resume();
    case "hold": return tasks.batch({ verb: "hold", ids: command.positionals });
    case "done": {
      const note = value(command, "note");
      return tasks.batch({ verb: "done", ids: command.positionals, ...(note === undefined ? {} : { note }) });
    }
    case "drop": {
      const note = value(command, "note");
      return tasks.batch({ verb: "drop", ids: command.positionals, ...(note === undefined ? {} : { note }) });
    }
    case "namespace": {
      const selected = namespace(command.positionals[0]);
      if (selected !== undefined) await tasks.setNamespace({ namespace: selected });
      return tasks.namespace();
    }
    case "compose": return tasks.compose({ markdown: await input.readStdin(), ...(input.actor === undefined ? {} : { actor: input.actor }) });
    default: throw new Error(`task action has no invocation: ${command.action}`);
  }
}
