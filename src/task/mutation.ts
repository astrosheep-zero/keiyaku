/* eslint-disable max-lines -- Task owns one coherent forwarded mutation boundary. */
import { World, type WorldRoot } from "../world.js";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import { eraseRequestCommand, type ErasedRequestCommand, type RequestCommand } from "../akuma/request-wire.js";
import {
  addTask,
  addTaskDocument,
  batchTasks,
  lifecycleTask,
  updateTask,
  type AddTaskInput,
  type TaskBatchResult,
  type TaskMutationResult,
  type TaskUpdateResult,
  type UpdateTaskInput,
} from "./operations.js";
import { composeTasks, type TaskCompositionResult } from "./compose.js";
import { isTaskSegment } from "./identity.js";
import {
  taskBatchResultSchema,
  taskCompositionResultSchema,
  taskMutationIdSchema,
  taskMutationResultSchema,
  taskUpdateResultSchema,
  isTaskMutationExecutionResult,
  type TaskMutationExecutionResult,
} from "./mutation-result.js";
import { z } from "zod";
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

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const namespaceSchema = z.array(z.string().refine(isTaskSegment)).readonly();
const taskIdsBaseSchema = z.array(taskMutationIdSchema).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "TaskIds must be unique" });
});
const taskIdsSchema = taskIdsBaseSchema.readonly();
const nonemptyTaskIdsSchema = taskIdsBaseSchema.min(1).readonly();
const taskStateSchema = z.enum(["open", "in_progress", "on_hold", "done", "drop"]);
const taskPrioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const addInputSchema = z
  .object({
    title: nonblankTextSchema,
    namespace: namespaceSchema,
    body: z.string().optional(),
    note: z.string().optional(),
    state: taskStateSchema.optional(),
    priority: taskPrioritySchema.optional(),
    needs: taskIdsSchema.optional(),
    parent: taskMutationIdSchema.nullable().optional(),
    supersedes: taskIdsSchema.optional(),
    relates: taskIdsSchema.optional(),
  })
  .strict();
const updateInputSchema = z
  .object({
    title: nonblankTextSchema.optional(),
    body: z.string().optional(),
    appendBody: z.string().optional(),
    note: z.string().optional(),
    priority: taskPrioritySchema.optional(),
    needs: taskIdsSchema.optional(),
    addNeeds: taskIdsSchema.optional(),
    dropNeeds: taskIdsSchema.optional(),
    parent: taskMutationIdSchema.nullable().optional(),
    supersedes: taskIdsSchema.optional(),
    addSupersedes: taskIdsSchema.optional(),
    dropSupersedes: taskIdsSchema.optional(),
    relates: taskIdsSchema.optional(),
    addRelates: taskIdsSchema.optional(),
    dropRelates: taskIdsSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.body !== undefined && input.appendBody !== undefined)
      context.addIssue({ code: "custom", message: "body and appendBody are mutually exclusive" });
    if (Object.values(input).every((value) => value === undefined))
      context.addIssue({ code: "custom", message: "update requires at least one field change" });
  });
const addRequestSchema = z
  .object({ input: addInputSchema })
  .strict()
  .transform(({ input }) => ({ action: "task.add" as const, input }));
const addDocumentRequestSchema = z
  .object({ input: z.object({ markdown: z.string(), namespace: namespaceSchema }).strict() })
  .strict()
  .transform(({ input }) => ({ action: "task.addDocument" as const, input }));
const composeRequestSchema = z
  .object({ markdown: z.string(), namespace: namespaceSchema })
  .strict()
  .transform((request) => ({ action: "task.compose" as const, ...request }));
const updateRequestSchema = z
  .object({ id: taskMutationIdSchema, input: updateInputSchema })
  .strict()
  .transform((request) => ({ action: "task.update" as const, ...request }));
const singleOrBatchRequestSchema = <Action extends "task.start" | "task.hold">(action: Action) =>
  z.union([
    z
      .object({ id: taskMutationIdSchema })
      .strict()
      .transform(({ id }) => ({ action, id })),
    z
      .object({ ids: nonemptyTaskIdsSchema })
      .strict()
      .transform(({ ids }) => ({ action, ids })),
  ]);
const singleRequestSchema = <Action extends "task.stop" | "task.resume">(action: Action) =>
  z
    .object({ id: taskMutationIdSchema })
    .strict()
    .transform((request) => ({ action, ...request }));
const terminalRequestSchema = <Action extends "task.done" | "task.drop">(action: Action) =>
  z.union([
    z
      .object({ id: taskMutationIdSchema, note: z.string().optional() })
      .strict()
      .transform(({ id, note }) => ({ action, id, ...(note === undefined ? {} : { note }) })),
    z
      .object({ ids: nonemptyTaskIdsSchema, note: z.string().optional() })
      .strict()
      .transform(({ ids, note }) => ({ action, ids, ...(note === undefined ? {} : { note }) })),
  ]);
const taskRequestSchemas = {
  "task.add": addRequestSchema,
  "task.addDocument": addDocumentRequestSchema,
  "task.compose": composeRequestSchema,
  "task.done": terminalRequestSchema("task.done"),
  "task.drop": terminalRequestSchema("task.drop"),
  "task.hold": singleOrBatchRequestSchema("task.hold"),
  "task.resume": singleRequestSchema("task.resume"),
  "task.start": singleOrBatchRequestSchema("task.start"),
  "task.stop": singleRequestSchema("task.stop"),
  "task.update": updateRequestSchema,
} as const;

export const taskMutationRequestSchema = z.union([
  taskRequestSchemas["task.add"],
  taskRequestSchemas["task.addDocument"],
  taskRequestSchemas["task.compose"],
  taskRequestSchemas["task.done"],
  taskRequestSchemas["task.drop"],
  taskRequestSchemas["task.hold"],
  taskRequestSchemas["task.resume"],
  taskRequestSchemas["task.start"],
  taskRequestSchemas["task.stop"],
  taskRequestSchemas["task.update"],
]);
export type TaskMutationRequest = z.infer<typeof taskMutationRequestSchema>;

const worldPathSchema = z.string().min(1);
const taskBodyRequestSchemas = {
  "task.add": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.add"] }).strict(),
  "task.addDocument": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.addDocument"] }).strict(),
  "task.compose": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.compose"] }).strict(),
  "task.done": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.done"] }).strict(),
  "task.drop": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.drop"] }).strict(),
  "task.hold": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.hold"] }).strict(),
  "task.resume": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.resume"] }).strict(),
  "task.start": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.start"] }).strict(),
  "task.stop": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.stop"] }).strict(),
  "task.update": z.object({ world: worldPathSchema, request: taskRequestSchemas["task.update"] }).strict(),
} as const;
export const taskMutationBodyRequestSchema = z
  .object({ world: worldPathSchema, request: taskMutationRequestSchema })
  .strict();
export type TaskMutationBodyRequest = z.infer<typeof taskMutationBodyRequestSchema>;

export const taskMutationServiceSchema = z.object({ action: z.enum(TASK_MUTATION_ACTIONS) }).strict();
export type TaskMutationService = z.infer<typeof taskMutationServiceSchema>;

export const forwardedTaskReferenceSchema = z
  .object({ kind: z.literal("served-reference"), action: z.enum(TASK_MUTATION_ACTIONS) })
  .strict();
export type ForwardedTaskReference = z.infer<typeof forwardedTaskReferenceSchema>;

export type TaskMutationResultForRequest<Request extends TaskMutationRequest> =
  Request extends Readonly<{ action: "task.compose" }>
    ? TaskCompositionResult
    : Request extends Readonly<{ action: "task.update" }>
      ? TaskUpdateResult
      : Request extends Readonly<{ ids: readonly string[] }>
        ? TaskBatchResult
        : TaskMutationResult;
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

function decodeTaskBodyRequest(action: TaskMutationAction, value: unknown): TaskMutationBodyRequest | null {
  const parsed = taskBodyRequestSchemas[action].safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeTaskService(action: TaskMutationAction, value: unknown): TaskMutationService {
  const parsed = taskMutationServiceSchema.safeParse(value);
  if (!parsed.success || parsed.data.action !== action)
    throw new Error(`malformed stored Task service evidence for ${action}`);
  return parsed.data;
}

function decodeTaskReference(action: TaskMutationAction, value: unknown): ForwardedTaskReference {
  const parsed = forwardedTaskReferenceSchema.safeParse(value);
  if (!parsed.success || parsed.data.action !== action)
    throw new Error(`malformed Task service reference for ${action}`);
  return parsed.data;
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
    encodeService: (service) => decodeTaskService(action, service),
    decodeService: (service) => decodeTaskService(action, service),
    projectService: (service) => decodeTaskReference(action, { kind: "served-reference", action: service.action }),
    decodeReference: (reference) => decodeTaskReference(action, reference),
    isPermitted: (allowed) => allowed.includes(action),
    decodeExecutionContext: decodeTaskMutationExecutionContext,
    execute: async (request, context) => {
      const world = await World.at(request.world);
      return {
        result: await context.upstream.task({
          world,
          request: request.request,
          requester: context.requester,
          signal: context.signal,
        }),
        service: { action: request.request.action },
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
  const schema =
    request.action === "task.compose"
      ? taskCompositionResultSchema
      : request.action === "task.update"
        ? taskUpdateResultSchema
        : "ids" in request
          ? taskBatchResultSchema
          : taskMutationResultSchema;
  return schema.safeParse(value).success;
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
    value: { world: input.world, request: input.request },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.kind === "reference") return response.reference;
  if (!taskResultForRequest(input.request, response.result)) {
    throw new Error(`transport integrity: request Task ${input.request.action} returned an invalid live result`);
  }
  return response.result;
}

export function decodeTaskMutationRequest(action: TaskMutationAction, value: unknown): TaskMutationRequest {
  const parsed = taskRequestSchemas[action].safeParse(value);
  if (!parsed.success) throw new TypeError(`invalid ${action} request`);
  return parsed.data;
}

function addTaskOptions(input: z.output<typeof addInputSchema>, actor: string, signal?: AbortSignal): AddTaskInput {
  const { body, note, state, priority, needs, parent, supersedes, relates, ...required } = input;
  return {
    ...required,
    actor,
    ...(body === undefined ? {} : { body }),
    ...(note === undefined ? {} : { note }),
    ...(state === undefined ? {} : { state }),
    ...(priority === undefined ? {} : { priority }),
    ...(needs === undefined ? {} : { needs }),
    ...(parent === undefined ? {} : { parent }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(relates === undefined ? {} : { relates }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function updateTaskOptions(input: z.output<typeof updateInputSchema>, signal?: AbortSignal): UpdateTaskInput {
  const {
    title,
    body,
    appendBody,
    note,
    priority,
    needs,
    addNeeds,
    dropNeeds,
    parent,
    supersedes,
    addSupersedes,
    dropSupersedes,
    relates,
    addRelates,
    dropRelates,
  } = input;
  return {
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    ...(appendBody === undefined ? {} : { appendBody }),
    ...(note === undefined ? {} : { note }),
    ...(priority === undefined ? {} : { priority }),
    ...(needs === undefined ? {} : { needs }),
    ...(addNeeds === undefined ? {} : { addNeeds }),
    ...(dropNeeds === undefined ? {} : { dropNeeds }),
    ...(parent === undefined ? {} : { parent }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(addSupersedes === undefined ? {} : { addSupersedes }),
    ...(dropSupersedes === undefined ? {} : { dropSupersedes }),
    ...(relates === undefined ? {} : { relates }),
    ...(addRelates === undefined ? {} : { addRelates }),
    ...(dropRelates === undefined ? {} : { dropRelates }),
    ...(signal === undefined ? {} : { signal }),
  };
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
      return await addTask(input.world, addTaskOptions(request.input, input.requester, signal));
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
      return await updateTask(input.world, request.id, updateTaskOptions(request.input, signal));
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
