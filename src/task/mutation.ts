import { World, type WorldRoot } from "../world.js";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import {
  eraseRequestCommand,
  type ErasedRequestCommand,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "../akuma/request-wire.js";
import type {
  AddTaskDocumentInput,
  AddTaskInput,
  TaskBatchResult,
  TaskMutationResult,
  TaskUpdateResult,
  UpdateTaskInput,
} from "./operations.js";
import { taskIdsSchema, taskNamespaceSchema } from "./identity.js";
import { taskNonblankTextSchema, taskStateSchema, taskPrioritySchema } from "./document.js";
import {
  taskBatchResultSchema,
  taskMutationIdSchema,
  taskMutationResultSchema,
  taskUpdateResultSchema,
  type TaskMutationExecutionResult,
} from "./mutation-result.js";
import { z } from "zod";

export const TASK_MUTATION_ACTIONS = Object.freeze([
  "task.add",
  "task.addDocument",
  "task.done",
  "task.drop",
  "task.update",
] as const);

const taskMutationActionSchema = z.enum(TASK_MUTATION_ACTIONS);
export type TaskMutationAction = z.infer<typeof taskMutationActionSchema>;

const nonemptyTaskIdsSchema = taskIdsSchema.unwrap().min(1).readonly();
const addInputSchema = z
  .object({
    title: taskNonblankTextSchema,
    namespace: taskNamespaceSchema,
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
    title: taskNonblankTextSchema.optional(),
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
  .object({ input: z.object({ markdown: z.string(), namespace: taskNamespaceSchema }).strict() })
  .strict()
  .transform(({ input }) => ({ action: "task.addDocument" as const, input }));
const updateRequestSchema = z
  .object({ id: taskMutationIdSchema, input: updateInputSchema })
  .strict()
  .transform((request) => ({ action: "task.update" as const, ...request }));
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
  "task.done": terminalRequestSchema("task.done"),
  "task.drop": terminalRequestSchema("task.drop"),
  "task.update": updateRequestSchema,
} as const;

export type TaskMutationRequest = z.infer<(typeof taskRequestSchemas)[TaskMutationAction]>;

const worldPathSchema = z.string().min(1);
const taskBodyRequestSchema = z
  .object({ world: worldPathSchema, request: z.union(Object.values(taskRequestSchemas)) })
  .strict();
export type TaskMutationBodyRequest = z.infer<typeof taskBodyRequestSchema>;

const taskMutationServiceSchema = z.object({ action: taskMutationActionSchema }).strict();
type TaskMutationService = z.infer<typeof taskMutationServiceSchema>;

export const forwardedTaskReferenceSchema = z
  .object({ kind: z.literal("served-reference"), action: taskMutationActionSchema })
  .strict();
export type ForwardedTaskReference = z.infer<typeof forwardedTaskReferenceSchema>;

export type TaskMutationResultForRequest<Request extends TaskMutationRequest> =
  Request extends Readonly<{ action: "task.update" }>
    ? TaskUpdateResult
    : Request extends Readonly<{ ids: readonly string[] }>
      ? TaskBatchResult
      : TaskMutationResult;
export type TaskLifecycleVerb = "done" | "drop";

/**
 * The forced-local Tasks SDK abilities one descriptor execution entry consumes.
 * They are composed at the upper Body edge from the same `Tasks.of(world)`
 * product an ordinary local caller uses; this module never imports that product
 * because the product consumes this descriptor protocol.
 */
export type TaskMutationRequestPort = Readonly<{
  add(input: Readonly<{ world: WorldRoot; options: AddTaskInput }>): Promise<TaskMutationResult>;
  addDocument(input: Readonly<{ world: WorldRoot; document: AddTaskDocumentInput }>): Promise<TaskMutationResult>;
  update(input: Readonly<{ world: WorldRoot; id: string; options: UpdateTaskInput }>): Promise<TaskUpdateResult>;
  lifecycle(
    input: Readonly<{
      world: WorldRoot;
      verb: TaskLifecycleVerb;
      id: string;
      note?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<TaskMutationResult>;
  batch(
    input: Readonly<{
      world: WorldRoot;
      verb: TaskLifecycleVerb;
      ids: readonly string[];
      note?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<TaskBatchResult>;
}>;
function decodeTaskBodyRequest(action: TaskMutationAction, value: unknown): TaskMutationBodyRequest | null {
  const parsed = taskBodyRequestSchema.extend({ request: taskRequestSchemas[action] }).safeParse(value);
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
export function taskMutationRequestProtocol(
  action: TaskMutationAction,
  batch?: boolean,
): RequestProtocol<TaskMutationBodyRequest, TaskMutationExecutionResult, ForwardedTaskReference> {
  return {
    action,
    encodeRequest: (input) => {
      const { action: _action, ...request } = input.request;
      return { world: input.world, request };
    },
    decodeRequest: (value) => decodeTaskBodyRequest(action, value),
    encodeResult: (result) => result,
    decodeResult: (result) => {
      const schema =
        action === "task.update"
          ? taskUpdateResultSchema
          : batch === undefined
            ? z.union([taskMutationResultSchema, taskBatchResultSchema])
            : batch
              ? taskBatchResultSchema
              : taskMutationResultSchema;
      const parsed = schema.safeParse(result);
      if (!parsed.success) throw new Error(`transport integrity: Task ${action} returned an invalid live result`);
      return parsed.data;
    },
    decodeReference: (reference) => decodeTaskReference(action, reference),
    isPermitted: (allowed) => allowed.includes(action),
  };
}

export function taskMutationRequestCommand(
  action: TaskMutationAction,
  port: TaskMutationRequestPort,
): ServiceRequestCommand<
  TaskMutationBodyRequest,
  TaskMutationExecutionResult,
  TaskMutationService,
  ForwardedTaskReference
> {
  return {
    completion: "service",
    protocol: taskMutationRequestProtocol(action),
    encodeService: (service) => service,
    decodeService: (service) => decodeTaskService(action, service),
    projectService: (service) => ({ kind: "served-reference", action: service.action }),
    execute: async (request, facts) => {
      const world = await World.prove(request.world);
      const action = request.request.action;
      let result: TaskMutationExecutionResult;
      switch (action) {
        case "task.add":
          result = await port.add({
            world,
            options: addTaskOptions(request.request.input, facts.requester, facts.signal),
          });
          break;
        case "task.addDocument":
          result = await port.addDocument({
            world,
            document: { ...request.request.input, actor: facts.requester, signal: facts.signal },
          });
          break;
        case "task.update":
          result = await port.update({
            world,
            id: request.request.id,
            options: updateTaskOptions(request.request.input, facts.signal),
          });
          break;
        case "task.done":
        case "task.drop": {
          const verb = action.slice("task.".length) as TaskLifecycleVerb;
          const note = "note" in request.request ? request.request.note : undefined;
          result =
            "ids" in request.request
              ? await port.batch({
                  world,
                  verb,
                  ids: request.request.ids,
                  ...(note === undefined ? {} : { note }),
                  signal: facts.signal,
                })
              : await port.lifecycle({
                  world,
                  verb,
                  id: request.request.id,
                  ...(note === undefined ? {} : { note }),
                  signal: facts.signal,
                });
          break;
        }
      }
      return { kind: "served", result, service: { action } };
    },
  };
}

export function taskMutationRequestCommands(
  port: TaskMutationRequestPort,
): Readonly<Record<TaskMutationAction, ErasedRequestCommand>> {
  return Object.fromEntries(
    TASK_MUTATION_ACTIONS.map((action) => [action, eraseRequestCommand(taskMutationRequestCommand(action, port))]),
  ) as Record<TaskMutationAction, ErasedRequestCommand>;
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
    command: taskMutationRequestProtocol(input.request.action, "ids" in input.request),
    value: { world: input.world, request: input.request },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.kind === "reference") return response.reference;
  return response.result as TaskMutationResultForRequest<Request>;
}

/** Absent optional fields are omitted, never republished as an explicit undefined. */
function definedFields<Input extends object>(
  fields: Readonly<Record<string, unknown>>,
  additions: Readonly<Record<string, unknown>> = {},
): Input {
  const selected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({ ...fields, ...additions })) {
    if (value !== undefined) selected[key] = value;
  }
  return selected as Input;
}

function addTaskOptions(input: z.output<typeof addInputSchema>, actor: string, signal?: AbortSignal): AddTaskInput {
  return definedFields<AddTaskInput>(input, { actor, signal });
}

function updateTaskOptions(input: z.output<typeof updateInputSchema>, signal?: AbortSignal): UpdateTaskInput {
  return definedFields<UpdateTaskInput>(input, { signal });
}
