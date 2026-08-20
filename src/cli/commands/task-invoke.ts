import {
  Tasks,
  observeTaskDetails,
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
import { injectedBodyRequests, requestBodyTask } from "../../akuma/requests.js";
import { decodeTaskMutationRequest, type TaskMutationRequest } from "../../task/mutation.js";
import { resolveTaskNamespaceContext, writeTaskNamespaceContext } from "../../task/context.js";
import { CliUsageError } from "../usage.js";

export type TaskShowResult = TaskDetail | readonly TaskDetail[] | Extract<TaskMutationResult, { kind: "refused" }>;
export type TaskInvocationResult = TaskMutationResult | TaskUpdateResult | TaskBatchResult | TaskCompositionResult
  | TaskShowResult | TaskList | BlockedTaskList | TaskQueryResult | TaskDecompositionTree | TaskDoctorReport | TaskNamespaceResult
  | TaskWorldObservation;

type TaskWorldRead = TaskList | BlockedTaskList | TaskQueryResult | TaskDoctorReport;
export type TaskWorldObservation =
  | Readonly<{ kind: "present"; value: TaskWorldRead }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

type TaskProduct = ReturnType<typeof Tasks.of>;
type TaskInput = Readonly<{ world: WorldRoot | null; context: Readonly<{ directory: string; boundary: string }>; establish(): Promise<WorldRoot>; readStdin(): Promise<string>; actor?: string }>;

export async function invokeTaskFromEdge(input: Readonly<{
  parsed: ParsedTaskCommand;
  world: WorldRoot | null;
  context: Readonly<{ directory: string; boundary: string }>;
  establish: () => Promise<WorldRoot>;
  readStdin: () => Promise<string>;
  actor: string | undefined;
}>): Promise<TaskInvocationResult> {
  try {
    return await invokeTask(input.parsed, {
      world: input.world,
      context: input.context,
      establish: input.establish,
      readStdin: input.readStdin,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}

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

async function invokeAdd(tasks: TaskProduct, command: ParsedTaskCommand, input: TaskInput, current: readonly string[]): Promise<TaskMutationResult> {
  const selectedNamespace = namespace(value(command, "namespace")) ?? current;
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

async function addMutationRequest(command: ParsedTaskCommand, input: TaskInput, current: readonly string[]): Promise<TaskMutationRequest> {
  const selectedNamespace = namespace(value(command, "namespace")) ?? current;
  if (command.stdin === "document") return { action: "task.addDocument", input: {
    markdown: await input.readStdin(),
    namespace: selectedNamespace,
  } };
  const body = value(command, "body"), note = value(command, "note");
  const initialState = state(value(command, "state")), selectedPriority = priority(value(command, "priority"));
  const needs = ids(values(command, "needs")), parent = value(command, "parent");
  const supersedes = ids(values(command, "supersedes")), relates = ids(values(command, "relates"));
  return { action: "task.add", input: {
    title: command.positionals[0]!, namespace: selectedNamespace,
    ...(body === undefined ? {} : { body }), ...(note === undefined ? {} : { note }),
    ...(initialState === undefined ? {} : { state: initialState }),
    ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(needs === undefined ? {} : { needs }), ...(parent === undefined ? {} : { parent: parent as TaskId }),
    ...(supersedes === undefined ? {} : { supersedes }), ...(relates === undefined ? {} : { relates }),
  } };
}

async function updateMutationRequest(command: ParsedTaskCommand, input: TaskInput): Promise<TaskMutationRequest> {
  const body = command.stdin === "body" ? await input.readStdin() : value(command, "body");
  const appendBody = command.stdin === "append" ? await input.readStdin() : value(command, "append");
  const note = command.stdin === "note" ? await input.readStdin() : value(command, "note");
  const title = value(command, "title"), selectedPriority = priority(value(command, "priority"));
  const addNeeds = ids(values(command, "needs")), dropNeeds = ids(values(command, "drop-needs"));
  const parent = value(command, "parent"), addSupersedes = ids(values(command, "supersedes"));
  const dropSupersedes = ids(values(command, "drop-supersedes")), addRelates = ids(values(command, "relates"));
  const dropRelates = ids(values(command, "drop-relates"));
  return { action: "task.update", id: command.positionals[0]! as TaskId, input: {
    ...(title === undefined ? {} : { title }), ...(body === undefined ? {} : { body }),
    ...(appendBody === undefined ? {} : { appendBody }), ...(note === undefined ? {} : { note }),
    ...(selectedPriority === undefined ? {} : { priority: selectedPriority }),
    ...(addNeeds === undefined ? {} : { addNeeds }), ...(dropNeeds === undefined ? {} : { dropNeeds }),
    ...(command.flags["no-parent"] === true ? { parent: null }
      : parent === undefined ? {} : { parent: parent as TaskId }),
    ...(addSupersedes === undefined ? {} : { addSupersedes }),
    ...(dropSupersedes === undefined ? {} : { dropSupersedes }),
    ...(addRelates === undefined ? {} : { addRelates }), ...(dropRelates === undefined ? {} : { dropRelates }),
  } };
}

function lifecycleMutationRequest(command: ParsedTaskCommand): TaskMutationRequest {
  const id = command.positionals[0]! as TaskId;
  switch (command.action) {
    case "start": return { action: "task.start", id };
    case "stop": return { action: "task.stop", id };
    case "resume": return { action: "task.resume", id };
    case "hold": return { action: "task.hold", ids: command.positionals as readonly TaskId[] };
    case "done": return { action: "task.done", ids: command.positionals as readonly TaskId[], ...(value(command, "note") === undefined ? {} : { note: value(command, "note")! }) };
    case "drop": return { action: "task.drop", ids: command.positionals as readonly TaskId[], ...(value(command, "note") === undefined ? {} : { note: value(command, "note")! }) };
    default: throw new Error(`task action cannot forward: ${command.action}`);
  }
}

async function mutationRequest(command: ParsedTaskCommand, input: TaskInput, current: readonly string[]): Promise<TaskMutationRequest> {
  if (command.action === "add") return await addMutationRequest(command, input, current);
  if (command.action === "compose") return { action: "task.compose", markdown: await input.readStdin(), namespace: current };
  if (command.action === "update") return await updateMutationRequest(command, input);
  return lifecycleMutationRequest(command);
}

function validatedMutationRequest(request: TaskMutationRequest): TaskMutationRequest {
  switch (request.action) {
    case "task.add":
    case "task.addDocument": return decodeTaskMutationRequest(request.action, { input: request.input });
    case "task.compose": return decodeTaskMutationRequest(request.action, { markdown: request.markdown, namespace: request.namespace });
    case "task.update": return decodeTaskMutationRequest(request.action, { id: request.id, input: request.input });
    case "task.start":
    case "task.stop":
    case "task.resume": return decodeTaskMutationRequest(request.action, { id: request.id });
    case "task.hold": return decodeTaskMutationRequest(request.action, { ids: request.ids });
    case "task.done":
    case "task.drop": return decodeTaskMutationRequest(request.action, { ids: request.ids, ...(request.note === undefined ? {} : { note: request.note }) });
  }
}

function readScope(command: ParsedTaskCommand, current?: readonly string[]): Readonly<{ scope: "world" }> | Readonly<{ namespace: readonly string[] }> {
  return command.flags.world === true ? { scope: "world" } : { namespace: current ?? [] };
}

async function invokeRead(tasks: TaskProduct, command: ParsedTaskCommand, current?: readonly string[]): Promise<TaskInvocationResult> {
  const id = command.positionals[0]!;
  switch (command.action) {
    case "show": {
      const ids = command.positionals.map((taskId) => tasks.task({ id: taskId }).id);
      const observed = await observeTaskDetails(tasks.root, ids);
      if (observed.kind !== "accepted") return observed;
      return command.output === "json" || observed.value.length > 1 ? observed.value : observed.value[0]!;
    }
    case "ls": return tasks.list({ selection: command.flags.all === true ? "all" : command.flags.closed === true ? "closed" : "active", ...readScope(command, current), ...(limit(command) === undefined ? {} : { limit: limit(command)! }) });
    case "ready": return tasks.ready({ ...readScope(command, current), ...(value(command, "parent") === undefined ? {} : { parent: value(command, "parent")! }), ...(limit(command) === undefined ? {} : { limit: limit(command)! }) });
    case "blocked": return tasks.blocked({ ...readScope(command, current), ...(value(command, "parent") === undefined ? {} : { parent: value(command, "parent")! }), ...(limit(command) === undefined ? {} : { limit: limit(command)! }) });
    case "query": return tasks.query({ ...(command.where === undefined ? {} : { where: command.where }), ...readScope(command, current), ...(value(command, "sort") === undefined ? {} : { sort: value(command, "sort") as TaskQuerySort }), ...(limit(command) === undefined ? {} : { limit: limit(command)! }) });
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

async function observeWorldRead(tasks: TaskProduct, command: ParsedTaskCommand, current?: readonly string[]): Promise<TaskWorldObservation> {
  try { return { kind: "present", value: await invokeRead(tasks, command, current) as TaskWorldRead }; }
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

async function invokeLocalMutation(
  tasks: TaskProduct,
  command: ParsedTaskCommand,
  input: TaskInput,
  current?: readonly string[],
): Promise<TaskInvocationResult> {
  if (isWorldObservation(command)) return observeWorldRead(tasks, command, current);
  if (command.action === "show" || command.action === "tree") return invokeRead(tasks, command, current);
  if (command.action === "add") return await invokeAdd(tasks, command, input, current ?? []);
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
      if (selected !== undefined) await writeTaskNamespaceContext(input.context.directory, selected);
      return { kind: "accepted", value: selected ?? current ?? [] };
    }
    case "compose": return tasks.compose({ markdown: await input.readStdin(), namespace: current ?? [], ...(input.actor === undefined ? {} : { actor: input.actor }) });
    default: throw new Error(`task action has no invocation: ${command.action}`);
  }
}

function establishesWorld(command: ParsedTaskCommand): boolean {
  return command.action === "add" || command.action === "compose"
    || (command.action === "namespace" && command.positionals.length > 0);
}

function forwardsMutation(command: ParsedTaskCommand): boolean {
  return command.action !== "show" && command.action !== "tree"
    && command.action !== "namespace" && !isWorldObservation(command);
}

export async function invokeTask(command: ParsedTaskCommand, input: TaskInput): Promise<TaskInvocationResult> {
  const world = input.world ?? (establishesWorld(command) ? await input.establish() : null);
  if (world === null) return missingWorld(command);
  const tasks = Tasks.of(world);
  const contextSensitive = command.action === "namespace" || command.action === "add" || command.action === "compose"
    || ((command.action === "ls" || command.action === "ready" || command.action === "blocked" || command.action === "query") && command.flags.world !== true);
  let current: readonly string[] | undefined;
  if (contextSensitive) {
    const resolved = await resolveTaskNamespaceContext(input.context);
    if (typeof resolved === "object" && "kind" in resolved) return { kind: "refused", refusal: resolved };
    current = resolved;
  }
  const requests = injectedBodyRequests();
  if (requests !== null && forwardsMutation(command)) {
    const request = validatedMutationRequest(await mutationRequest(command, input, current ?? []));
    return await requestBodyTask({ directory: requests, world, request }) as TaskInvocationResult;
  }
  return await invokeLocalMutation(tasks, command, input, current);
}
