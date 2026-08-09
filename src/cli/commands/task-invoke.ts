import {
  Tasks,
  type BlockedTaskList,
  type TaskBatchResult,
  type TaskCompositionResult,
  type TaskDependencyTree,
  type TaskDetail,
  type TaskDoctorReport,
  type TaskId,
  type TaskList,
  type TaskMutationResult,
  type TaskNamespaceResult,
  type TaskPriority,
  type TaskState,
  type TaskUpdateResult,
} from "../../task/index.js";
import type { ParsedTaskCommand } from "./task.js";

export type TaskInvocationResult = TaskMutationResult | TaskUpdateResult | TaskBatchResult | TaskCompositionResult
  | TaskDetail | TaskList | BlockedTaskList | TaskDependencyTree | TaskDoctorReport | TaskNamespaceResult;

type TaskProduct = ReturnType<typeof Tasks.at>;
type TaskInput = Readonly<{ path?: string; readStdin(): string }>;

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
function state(raw: string | undefined): TaskState | undefined { return raw as TaskState | undefined; }
function ids(items: readonly string[] | undefined): readonly TaskId[] | undefined { return items as readonly TaskId[] | undefined; }

function invokeAdd(tasks: TaskProduct, command: ParsedTaskCommand, readStdin: () => string): Promise<TaskMutationResult> {
  const selectedNamespace = namespace(value(command, "namespace"));
  if (command.stdin === "document") return tasks.addDocument({ markdown: readStdin(), ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }) });
  const body = value(command, "body"), note = value(command, "note"), initialState = state(value(command, "state")), selectedPriority = priority(value(command, "priority"));
  const needs = ids(values(command, "needs")), parent = value(command, "parent");
  const supersedes = ids(values(command, "supersedes")), relates = ids(values(command, "relates")), contractId = value(command, "contract");
  return tasks.add({
    title: command.positionals[0]!, ...(selectedNamespace === undefined ? {} : { namespace: selectedNamespace }),
    ...(body === undefined ? {} : { body }), ...(note === undefined ? {} : { note }), ...(initialState === undefined ? {} : { state: initialState }), ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(needs === undefined ? {} : { needs }), ...(parent === undefined ? {} : { parent: parent as TaskId }),
    ...(supersedes === undefined ? {} : { supersedes }), ...(relates === undefined ? {} : { relates }),
    ...(contractId === undefined ? {} : { contractId }),
  });
}

function invokeUpdate(tasks: TaskProduct, command: ParsedTaskCommand, readStdin: () => string): Promise<TaskUpdateResult> {
  const body = command.stdin === "body" ? readStdin() : value(command, "body"), appendBody = command.stdin === "append" ? readStdin() : value(command, "append");
  const note = command.stdin === "note" ? readStdin() : value(command, "note");
  const title = value(command, "title"), selectedPriority = priority(value(command, "priority"));
  const addNeeds = ids(values(command, "needs")), dropNeeds = ids(values(command, "drop-needs"));
  const parent = value(command, "parent"), addSupersedes = ids(values(command, "supersedes"));
  const dropSupersedes = ids(values(command, "drop-supersedes")), addRelates = ids(values(command, "relates"));
  const dropRelates = ids(values(command, "drop-relates")), contractId = value(command, "contract");
  return tasks.task({ id: command.positionals[0]! }).update({
    ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }), ...(appendBody === undefined ? {} : { appendBody }), ...(note === undefined ? {} : { note }),
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
    case "doctor": return tasks.doctor();
    default: throw new Error(`task action is not a read: ${command.action}`);
  }
}

export async function invokeTask(command: ParsedTaskCommand, input: TaskInput): Promise<TaskInvocationResult> {
  const tasks = input.path === undefined ? Tasks.at() : Tasks.at({ path: input.path });
  if (["show", "ls", "ready", "blocked", "tree", "doctor"].includes(command.action)) return invokeRead(tasks, command);
  if (command.action === "add") return invokeAdd(tasks, command, input.readStdin);
  if (command.action === "update") return invokeUpdate(tasks, command, input.readStdin);
  const id = command.positionals[0]!;
  switch (command.action) {
    case "start": return tasks.task({ id }).start();
    case "stop": return tasks.task({ id }).stop();
    case "resume": return tasks.task({ id }).resume();
    case "hold": return tasks.batch({ verb: "hold", ids: command.positionals });
    case "done": return tasks.batch({ verb: "done", ids: command.positionals });
    case "drop": {
      const note = value(command, "note");
      return tasks.batch({ verb: "drop", ids: command.positionals, ...(note === undefined ? {} : { note }) });
    }
    case "namespace": {
      const selected = namespace(command.positionals[0]);
      if (selected !== undefined) await tasks.setNamespace({ namespace: selected });
      return tasks.namespace();
    }
    case "compose": return tasks.compose({ markdown: input.readStdin() });
    default: throw new Error(`task action has no invocation: ${command.action}`);
  }
}
