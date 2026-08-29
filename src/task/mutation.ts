import type { WorldRoot } from "../world.js";
import { isAbsolute, resolve } from "node:path";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import { eraseRequestCommand, type ErasedRequestCommand, type RequestCommand } from "../akuma/request-wire.js";
import { addInput, closed, namespace, record, taskId, taskIds, text, updateInput } from "./input.js";
import {
  addTask,
  addTaskDocument,
  batchTasks,
  lifecycleTask,
  updateTask,
  type AddTaskDocumentInput,
  type AddTaskInput,
  type UpdateTaskInput,
} from "./operations.js";
import { composeTasks, type TaskCompositionResult } from "./compose.js";
import type { TaskId } from "./identity.js";
import { isTaskMutationExecutionResult, type TaskMutationExecutionResult } from "./mutation-result.js";
import type { TaskBatchResult, TaskMutationResult, TaskUpdateResult } from "./operations.js";
export type { TaskMutationExecutionResult } from "./mutation-result.js";

export const TASK_MUTATION_ACTIONS = Object.freeze([
  "task.add",
  "task.addDocument",
  "task.compose",
  "task.done",
  "task.drop",
  "task.hold",
  "task.resume",
  "task.start",
  "task.stop",
  "task.update",
] as const);

export type TaskMutationAction = (typeof TASK_MUTATION_ACTIONS)[number];
const TASK_MUTATION_ACTION_SET: ReadonlySet<string> = new Set(TASK_MUTATION_ACTIONS);

export function isTaskMutationAction(value: unknown): value is TaskMutationAction {
  return typeof value === "string" && TASK_MUTATION_ACTION_SET.has(value);
}

export type TaskMutationRequest =
  | Readonly<{
      action: "task.add";
      input: Omit<AddTaskInput, "actor" | "signal" | "namespace"> & Readonly<{ namespace: readonly string[] }>;
    }>
  | Readonly<{
      action: "task.addDocument";
      input: Omit<AddTaskDocumentInput, "actor" | "signal" | "namespace"> & Readonly<{ namespace: readonly string[] }>;
    }>
  | Readonly<{ action: "task.compose"; markdown: string; namespace: readonly string[] }>
  | Readonly<{ action: "task.update"; id: TaskId; input: Omit<UpdateTaskInput, "signal"> }>
  | Readonly<{ action: "task.start"; id: TaskId }>
  | Readonly<{ action: "task.start"; ids: readonly TaskId[] }>
  | Readonly<{ action: "task.stop"; id: TaskId }>
  | Readonly<{ action: "task.resume"; id: TaskId }>
  | Readonly<{ action: "task.hold"; id: TaskId }>
  | Readonly<{ action: "task.hold"; ids: readonly TaskId[] }>
  | Readonly<{ action: "task.done"; id: TaskId; note?: string }>
  | Readonly<{ action: "task.done"; ids: readonly TaskId[]; note?: string }>
  | Readonly<{ action: "task.drop"; id: TaskId; note?: string }>
  | Readonly<{ action: "task.drop"; ids: readonly TaskId[]; note?: string }>;

export type TaskMutationResultForRequest<Request extends TaskMutationRequest> =
  Request extends Readonly<{
    action: "task.compose";
  }>
    ? TaskCompositionResult
    : Request extends Readonly<{ action: "task.update" }>
      ? TaskUpdateResult
      : Request extends Readonly<{ ids: readonly TaskId[] }>
        ? TaskBatchResult
        : TaskMutationResult;

export type ForwardedTaskReference = Readonly<{ kind: "served-reference"; action: TaskMutationAction }>;
export type TaskMutationService = Readonly<{ action: TaskMutationAction }>;
export type TaskMutationBodyRequest = Readonly<{
  action: TaskMutationAction;
  world: WorldRoot;
  request: TaskMutationRequest;
}>;
export type TaskMutationRequestPort = Readonly<{
  task(
    input: Readonly<{ world: WorldRoot; request: TaskMutationRequest; requester: string; signal: AbortSignal }>,
  ): Promise<TaskMutationExecutionResult>;
}>;
type TaskMutationExecutionContext = Readonly<{
  requester: string;
  signal: AbortSignal;
  upstream: TaskMutationRequestPort;
}>;

function decodeTaskMutationExecutionContext(value: unknown): TaskMutationExecutionContext {
  const context = resultRecord(value);
  if (
    context === null ||
    typeof context.requester !== "string" ||
    context.requester.trim() === "" ||
    !isAbortSignal(context.signal) ||
    !isTaskMutationRequestPort(context.upstream)
  )
    throw new Error("invalid Task execution context");
  return { requester: context.requester, signal: context.signal, upstream: context.upstream };
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { throwIfAborted?: unknown }).throwIfAborted === "function"
  );
}

function isTaskMutationRequestPort(value: unknown): value is TaskMutationRequestPort {
  const port = resultRecord(value);
  return port !== null && typeof port.task === "function";
}

function resultRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function mutationObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const decoded = record(value, label);
  closed(decoded, keys, label);
  return decoded;
}

function canonicalWorld(value: unknown): WorldRoot | null {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value ? (value as WorldRoot) : null;
}

function decodeTaskBodyRequest(action: TaskMutationAction, value: unknown): TaskMutationBodyRequest | null {
  try {
    const input = mutationObject(value, ["request", "world"], `${action} body request`);
    const world = canonicalWorld(input.world);
    if (world === null) return null;
    return { action, world, request: decodeTaskMutationRequest(action, input.request) };
  } catch {
    return null;
  }
}

function decodeTaskService(action: TaskMutationAction, value: unknown): TaskMutationService {
  try {
    const service = mutationObject(value, ["action"], `${action} service evidence`);
    if (service.action !== action) throw new TypeError("action mismatch");
    return { action };
  } catch {
    throw new Error(`malformed stored Task service evidence for ${action}`);
  }
}

function decodeTaskReference(action: TaskMutationAction, value: unknown): ForwardedTaskReference {
  try {
    const reference = mutationObject(value, ["action", "kind"], `${action} service reference`);
    if (reference.kind !== "served-reference" || reference.action !== action) throw new TypeError("action mismatch");
    return { kind: "served-reference", action };
  } catch {
    throw new Error(`malformed Task service reference for ${action}`);
  }
}

/** Task owns forwarded mutation payload, live result, and durable service evidence. */
export function taskMutationRequestCommand(
  action: TaskMutationAction,
): RequestCommand<
  TaskMutationBodyRequest,
  TaskMutationExecutionResult,
  TaskMutationService,
  ForwardedTaskReference,
  TaskMutationExecutionContext
> {
  return {
    action,
    encodeRequest: (input) => {
      const { action: _action, ...request } = input.request;
      return { world: input.world, request };
    },
    decodeRequest: (value) => decodeTaskBodyRequest(action, value),
    encodeResult: (result) => result,
    decodeResult: (result) => {
      if (!isTaskMutationExecutionResult(result)) {
        throw new Error(`transport integrity: Task ${action} returned an invalid live result`);
      }
      return result;
    },
    encodeService: (service) => service,
    decodeService: (service) => decodeTaskService(action, service),
    projectService: (service) => ({ kind: "served-reference", action: service.action }),
    decodeReference: (reference) => decodeTaskReference(action, reference),
    isPermitted: (allowed) => allowed.includes(action),
    decodeExecutionContext: decodeTaskMutationExecutionContext,
    execute: async (request, context) => {
      return {
        result: await context.upstream.task({
          world: request.world,
          request: request.request,
          requester: context.requester,
          signal: context.signal,
        }),
        service: { action: request.action },
      };
    },
  };
}

export function taskMutationRequestCommands(): Readonly<Record<TaskMutationAction, ErasedRequestCommand>> {
  return {
    "task.add": eraseRequestCommand(taskMutationRequestCommand("task.add")),
    "task.addDocument": eraseRequestCommand(taskMutationRequestCommand("task.addDocument")),
    "task.compose": eraseRequestCommand(taskMutationRequestCommand("task.compose")),
    "task.done": eraseRequestCommand(taskMutationRequestCommand("task.done")),
    "task.drop": eraseRequestCommand(taskMutationRequestCommand("task.drop")),
    "task.hold": eraseRequestCommand(taskMutationRequestCommand("task.hold")),
    "task.resume": eraseRequestCommand(taskMutationRequestCommand("task.resume")),
    "task.start": eraseRequestCommand(taskMutationRequestCommand("task.start")),
    "task.stop": eraseRequestCommand(taskMutationRequestCommand("task.stop")),
    "task.update": eraseRequestCommand(taskMutationRequestCommand("task.update")),
  };
}

function taskResultForRequest<Request extends TaskMutationRequest>(
  request: Request,
  value: unknown,
): value is TaskMutationResultForRequest<Request> {
  if (!isTaskMutationExecutionResult(value)) return false;
  const result = resultRecord(value);
  if (result === null) return false;
  if (request.action === "task.compose") {
    return (
      result.kind === "planned" ||
      result.kind === "incomplete" ||
      (result.kind === "accepted" && Array.isArray(result.aliases))
    );
  }
  if (request.action === "task.update") {
    const accepted = result.kind === "accepted" ? resultRecord(result.value) : null;
    return result.kind !== "accepted" || (accepted !== null && typeof accepted.documentDiff === "string");
  }
  if ("ids" in request) return Array.isArray(result.items);
  return !Array.isArray(result.items);
}

export function requestForwardedTask<Request extends TaskMutationRequest>(
  input: Readonly<{
    directory: string;
    id?: never;
    world: WorldRoot;
    request: Request;
    signal?: AbortSignal;
  }>,
): Promise<TaskMutationResultForRequest<Request>>;
export function requestForwardedTask<Request extends TaskMutationRequest>(
  input: Readonly<{
    directory: string;
    id: string;
    world: WorldRoot;
    request: Request;
    signal?: AbortSignal;
  }>,
): Promise<TaskMutationResultForRequest<Request> | ForwardedTaskReference>;
export async function requestForwardedTask<Request extends TaskMutationRequest>(
  input: Readonly<{
    directory: string;
    id?: string;
    world: WorldRoot;
    request: Request;
    signal?: AbortSignal;
  }>,
): Promise<TaskMutationResultForRequest<Request> | ForwardedTaskReference> {
  const response = await requestBodyCommand({
    directory: input.directory,
    ...(input.id === undefined ? {} : { id: input.id }),
    command: taskMutationRequestCommand(input.request.action),
    value: { action: input.request.action, world: input.world, request: input.request },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.kind === "reference") return response.reference;
  if (!taskResultForRequest(input.request, response.result)) {
    throw new Error(`transport integrity: Task ${input.request.action} returned an invalid result`);
  }
  return response.result;
}

function decodeTaskSingleOrBatchRequest(action: "task.start" | "task.hold", value: unknown): TaskMutationRequest {
  const request = mutationObject(value, ["id", "ids"], `${action} request`);
  if (request.id !== undefined && request.ids !== undefined)
    throw new TypeError(`${action} request has both id and ids`);
  if (request.id !== undefined) {
    const id = taskId(request.id);
    return action === "task.start" ? { action: "task.start", id } : { action: "task.hold", id };
  }
  const ids = taskIds(request.ids, "ids");
  if (ids === undefined || ids.length === 0) throw new TypeError(`${action} request requires at least one TaskId`);
  return action === "task.start" ? { action: "task.start", ids } : { action: "task.hold", ids };
}

function decodeTaskTerminalRequest(action: "task.done" | "task.drop", value: unknown): TaskMutationRequest {
  const request = mutationObject(value, ["id", "ids", "note"], `${action} request`);
  if (request.id !== undefined && request.ids !== undefined)
    throw new TypeError(`${action} request has both id and ids`);
  const note = text(request.note, "note");
  if (request.id !== undefined) {
    const id = taskId(request.id);
    return action === "task.done"
      ? { action: "task.done", id, ...(note === undefined ? {} : { note }) }
      : { action: "task.drop", id, ...(note === undefined ? {} : { note }) };
  }
  const ids = taskIds(request.ids, "ids");
  if (ids === undefined || ids.length === 0) throw new TypeError(`${action} request requires at least one TaskId`);
  return action === "task.done"
    ? { action: "task.done", ids, ...(note === undefined ? {} : { note }) }
    : { action: "task.drop", ids, ...(note === undefined ? {} : { note }) };
}

export function decodeTaskMutationRequest(action: TaskMutationAction, value: unknown): TaskMutationRequest {
  switch (action) {
    case "task.add": {
      const input = mutationObject(value, ["input"], "task.add request");
      const raw = mutationObject(
        input.input,
        ["title", "namespace", "body", "note", "state", "priority", "needs", "parent", "supersedes", "relates"],
        "task.add input",
      );
      const decoded = addInput(raw);
      if (decoded.namespace === undefined) throw new TypeError("task.add request namespace is required");
      return { action, input: { ...decoded, namespace: decoded.namespace } };
    }
    case "task.addDocument": {
      const input = mutationObject(value, ["input"], "task.addDocument request");
      const raw = mutationObject(input.input, ["markdown", "namespace"], "task.addDocument input");
      const markdown = text(raw.markdown, "markdown");
      if (markdown === undefined) throw new TypeError("markdown is required");
      const selected = namespace(raw.namespace);
      if (selected === undefined) throw new TypeError("task.addDocument request namespace is required");
      return { action, input: { markdown, namespace: selected } };
    }
    case "task.compose": {
      const input = mutationObject(value, ["markdown", "namespace"], "task.compose request");
      const markdown = text(input.markdown, "markdown");
      if (markdown === undefined) throw new TypeError("markdown is required");
      const selected = namespace(input.namespace);
      if (selected === undefined) throw new TypeError("task.compose request namespace is required");
      return { action, markdown, namespace: selected };
    }
    case "task.update": {
      const request = mutationObject(value, ["id", "input"], "task.update request");
      const raw = mutationObject(
        request.input,
        [
          "title",
          "body",
          "appendBody",
          "note",
          "priority",
          "needs",
          "addNeeds",
          "dropNeeds",
          "parent",
          "supersedes",
          "addSupersedes",
          "dropSupersedes",
          "relates",
          "addRelates",
          "dropRelates",
        ],
        "task.update input",
      );
      return { action, id: taskId(request.id), input: updateInput(raw) };
    }
    case "task.start":
      return decodeTaskSingleOrBatchRequest("task.start", value);
    case "task.stop": {
      const request = mutationObject(value, ["id"], `${action} request`);
      return { action, id: taskId(request.id) };
    }
    case "task.resume": {
      const request = mutationObject(value, ["id"], `${action} request`);
      return { action, id: taskId(request.id) };
    }
    case "task.hold": {
      return decodeTaskSingleOrBatchRequest("task.hold", value);
    }
    case "task.done":
    case "task.drop": {
      return decodeTaskTerminalRequest(action, value);
    }
  }
}

export async function executeTaskMutation(
  input: Readonly<{
    world: WorldRoot;
    request: TaskMutationRequest;
    requester: string;
    signal?: AbortSignal;
  }>,
): Promise<TaskMutationExecutionResult> {
  const { request, signal } = input;
  const withSignal = signal === undefined ? {} : { signal };
  switch (request.action) {
    case "task.add":
      return await addTask(input.world, { ...request.input, actor: input.requester, ...withSignal });
    case "task.addDocument":
      return await addTaskDocument(input.world, { ...request.input, actor: input.requester, ...withSignal });
    case "task.compose":
      return await composeTasks({
        world: input.world,
        markdown: request.markdown,
        defaultNamespace: request.namespace,
        actor: input.requester,
        planOnly: false,
        ...withSignal,
      });
    case "task.update":
      return await updateTask(input.world, request.id, { ...request.input, ...withSignal });
    case "task.start":
      if ("ids" in request) return await batchTasks(input.world, "start", request.ids, signal);
      return await lifecycleTask(input.world, request.id, "start", signal);
    case "task.stop":
      return await lifecycleTask(input.world, request.id, "stop", signal);
    case "task.resume":
      return await lifecycleTask(input.world, request.id, "resume", signal);
    case "task.hold":
      if ("ids" in request) return await batchTasks(input.world, "hold", request.ids, signal);
      return await lifecycleTask(input.world, request.id, "hold", signal);
    case "task.done":
      if ("ids" in request) return await batchTasks(input.world, "done", request.ids, signal, request.note);
      return await lifecycleTask(input.world, request.id, "done", signal, request.note);
    case "task.drop":
      if ("ids" in request) return await batchTasks(input.world, "drop", request.ids, signal, request.note);
      return await lifecycleTask(input.world, request.id, "drop", signal, request.note);
  }
}
