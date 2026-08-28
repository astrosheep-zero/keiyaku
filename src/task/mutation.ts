import type { WorldRoot } from "../world.js";
import { isAbsolute, resolve } from "node:path";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import { eraseRequestCommand, type ErasedRequestCommand, type RequestCommand } from "../akuma/request-wire.js";
import { addInput, closed, namespace, record, taskId, taskIds, text, updateInput } from "./input.js";
import type { AddTaskDocumentInput, AddTaskInput, UpdateTaskInput } from "./operations.js";
import type { TaskId } from "./identity.js";
import { isTaskMutationExecutionResult, type TaskMutationExecutionResult } from "./mutation-result.js";
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
  | Readonly<{ action: "task.stop" | "task.resume"; id: TaskId }>
  | Readonly<{ action: "task.hold"; ids: readonly TaskId[] }>
  | Readonly<{ action: "task.done" | "task.drop"; ids: readonly TaskId[]; note?: string }>;

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

export function requestForwardedTask(
  input: Readonly<{
    directory: string;
    id?: never;
    world: WorldRoot;
    request: TaskMutationRequest;
    signal?: AbortSignal;
  }>,
): Promise<TaskMutationExecutionResult>;
export function requestForwardedTask(
  input: Readonly<{
    directory: string;
    id: string;
    world: WorldRoot;
    request: TaskMutationRequest;
    signal?: AbortSignal;
  }>,
): Promise<TaskMutationExecutionResult | ForwardedTaskReference>;
export async function requestForwardedTask(
  input: Readonly<{
    directory: string;
    id?: string;
    world: WorldRoot;
    request: TaskMutationRequest;
    signal?: AbortSignal;
  }>,
): Promise<TaskMutationExecutionResult | ForwardedTaskReference> {
  const response = await requestBodyCommand({
    directory: input.directory,
    ...(input.id === undefined ? {} : { id: input.id }),
    command: taskMutationRequestCommand(input.request.action),
    value: { action: input.request.action, world: input.world, request: input.request },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return response.kind === "returned" ? response.result : response.reference;
}

function decodeTaskStartRequest(value: unknown): Extract<TaskMutationRequest, { action: "task.start" }> {
  const action = "task.start";
  const request = mutationObject(value, ["id", "ids"], `${action} request`);
  if (request.id !== undefined && request.ids !== undefined)
    throw new TypeError(`${action} request has both id and ids`);
  if (request.id !== undefined) return { action, id: taskId(request.id) };
  const ids = taskIds(request.ids, "ids");
  if (ids === undefined || ids.length === 0) throw new TypeError(`${action} request requires at least one TaskId`);
  return { action, ids };
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
      return decodeTaskStartRequest(value);
    case "task.stop":
    case "task.resume": {
      const request = mutationObject(value, ["id"], `${action} request`);
      return { action, id: taskId(request.id) };
    }
    case "task.hold": {
      const request = mutationObject(value, ["ids"], "task.hold request");
      return { action, ids: taskIds(request.ids, "ids") ?? [] };
    }
    case "task.done":
    case "task.drop": {
      const request = mutationObject(value, ["ids", "note"], `${action} request`);
      const note = text(request.note, "note");
      return { action, ids: taskIds(request.ids, "ids") ?? [], ...(note === undefined ? {} : { note }) };
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
  const { Tasks } = await import("./index.js");
  const tasks = Tasks.of(input.world);
  const { request, signal } = input;
  const withSignal = signal === undefined ? {} : { signal };
  switch (request.action) {
    case "task.add":
      return await tasks.add({ ...request.input, actor: input.requester, ...withSignal });
    case "task.addDocument":
      return await tasks.addDocument({ ...request.input, actor: input.requester, ...withSignal });
    case "task.compose":
      return await tasks.compose({
        markdown: request.markdown,
        namespace: request.namespace,
        actor: input.requester,
        ...withSignal,
      });
    case "task.update":
      return await tasks.task({ id: request.id }).update({ ...request.input, ...withSignal });
    case "task.start":
      if ("ids" in request) return await tasks.batch({ verb: "start", ids: request.ids, ...withSignal });
      return await tasks.task({ id: request.id }).start(withSignal);
    case "task.stop":
      return await tasks.task({ id: request.id }).stop(withSignal);
    case "task.resume":
      return await tasks.task({ id: request.id }).resume(withSignal);
    case "task.hold":
      return await tasks.batch({ verb: "hold", ids: request.ids, ...withSignal });
    case "task.done":
      return await tasks.batch({
        verb: "done",
        ids: request.ids,
        ...withSignal,
        ...(request.note === undefined ? {} : { note: request.note }),
      });
    case "task.drop":
      return await tasks.batch({
        verb: "drop",
        ids: request.ids,
        ...withSignal,
        ...(request.note === undefined ? {} : { note: request.note }),
      });
  }
}
