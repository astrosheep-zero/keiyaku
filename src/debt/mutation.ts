import { World, type WorldRoot } from "../world.js";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import {
  eraseRequestCommand,
  type ErasedRequestCommand,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "../akuma/request-wire.js";
import type {
  AddDebtDocumentInput,
  AddDebtInput,
  DebtBatchResult,
  DebtMutationResult,
  DebtUpdateResult,
  UpdateDebtInput,
} from "./operations.js";
import { debtIdsSchema, debtNamespaceSchema } from "./identity.js";
import { debtNonblankTextSchema, debtStateSchema, debtPrioritySchema } from "./document.js";
import {
  debtBatchResultSchema,
  debtMutationIdSchema,
  debtMutationResultSchema,
  debtUpdateResultSchema,
  type DebtMutationExecutionResult,
} from "./mutation-result.js";
import { z } from "zod";

export const DEBT_MUTATION_ACTIONS = Object.freeze([
  "debt.add",
  "debt.addDocument",
  "debt.done",
  "debt.drop",
  "debt.update",
] as const);

const debtMutationActionSchema = z.enum(DEBT_MUTATION_ACTIONS);
export type DebtMutationAction = z.infer<typeof debtMutationActionSchema>;

const nonemptyDebtIdsSchema = debtIdsSchema.unwrap().min(1).readonly();
const addInputSchema = z
  .object({
    title: debtNonblankTextSchema,
    namespace: debtNamespaceSchema,
    body: z.string().optional(),
    note: z.string().optional(),
    state: debtStateSchema.optional(),
    priority: debtPrioritySchema.optional(),
    needs: debtIdsSchema.optional(),
    parent: debtMutationIdSchema.nullable().optional(),
    supersedes: debtIdsSchema.optional(),
    relates: debtIdsSchema.optional(),
  })
  .strict();
const updateInputSchema = z
  .object({
    title: debtNonblankTextSchema.optional(),
    body: z.string().optional(),
    appendBody: z.string().optional(),
    note: z.string().optional(),
    priority: debtPrioritySchema.optional(),
    needs: debtIdsSchema.optional(),
    addNeeds: debtIdsSchema.optional(),
    dropNeeds: debtIdsSchema.optional(),
    parent: debtMutationIdSchema.nullable().optional(),
    supersedes: debtIdsSchema.optional(),
    addSupersedes: debtIdsSchema.optional(),
    dropSupersedes: debtIdsSchema.optional(),
    relates: debtIdsSchema.optional(),
    addRelates: debtIdsSchema.optional(),
    dropRelates: debtIdsSchema.optional(),
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
  .transform(({ input }) => ({ action: "debt.add" as const, input }));
const addDocumentRequestSchema = z
  .object({ input: z.object({ markdown: z.string(), namespace: debtNamespaceSchema }).strict() })
  .strict()
  .transform(({ input }) => ({ action: "debt.addDocument" as const, input }));
const updateRequestSchema = z
  .object({ id: debtMutationIdSchema, input: updateInputSchema })
  .strict()
  .transform((request) => ({ action: "debt.update" as const, ...request }));
const terminalRequestSchema = <Action extends "debt.done" | "debt.drop">(action: Action) =>
  z.union([
    z
      .object({ id: debtMutationIdSchema, note: z.string().optional() })
      .strict()
      .transform(({ id, note }) => ({ action, id, ...(note === undefined ? {} : { note }) })),
    z
      .object({ ids: nonemptyDebtIdsSchema, note: z.string().optional() })
      .strict()
      .transform(({ ids, note }) => ({ action, ids, ...(note === undefined ? {} : { note }) })),
  ]);
const debtRequestSchemas = {
  "debt.add": addRequestSchema,
  "debt.addDocument": addDocumentRequestSchema,
  "debt.done": terminalRequestSchema("debt.done"),
  "debt.drop": terminalRequestSchema("debt.drop"),
  "debt.update": updateRequestSchema,
} as const;

export type DebtMutationRequest = z.infer<(typeof debtRequestSchemas)[DebtMutationAction]>;

const worldPathSchema = z.string().min(1);
const debtBodyRequestSchema = z
  .object({ world: worldPathSchema, request: z.union(Object.values(debtRequestSchemas)) })
  .strict();
export type DebtMutationBodyRequest = z.infer<typeof debtBodyRequestSchema>;

const debtMutationServiceSchema = z.object({ action: debtMutationActionSchema }).strict();
type DebtMutationService = z.infer<typeof debtMutationServiceSchema>;

export const forwardedDebtReferenceSchema = z
  .object({ kind: z.literal("served-reference"), action: debtMutationActionSchema })
  .strict();
export type ForwardedDebtReference = z.infer<typeof forwardedDebtReferenceSchema>;

export type DebtMutationResultForRequest<Request extends DebtMutationRequest> =
  Request extends Readonly<{ action: "debt.update" }>
    ? DebtUpdateResult
    : Request extends Readonly<{ ids: readonly string[] }>
      ? DebtBatchResult
      : DebtMutationResult;
export type DebtLifecycleVerb = "done" | "drop";

/**
 * The forced-local Debts SDK abilities one descriptor execution entry consumes.
 * They are composed at the upper Body edge from the same `Debts.of(world)`
 * product an ordinary local caller uses; this module never imports that product
 * because the product consumes this descriptor protocol.
 */
export type DebtMutationRequestPort = Readonly<{
  add(input: Readonly<{ world: WorldRoot; options: AddDebtInput }>): Promise<DebtMutationResult>;
  addDocument(input: Readonly<{ world: WorldRoot; document: AddDebtDocumentInput }>): Promise<DebtMutationResult>;
  update(input: Readonly<{ world: WorldRoot; id: string; options: UpdateDebtInput }>): Promise<DebtUpdateResult>;
  lifecycle(
    input: Readonly<{
      world: WorldRoot;
      verb: DebtLifecycleVerb;
      id: string;
      note?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<DebtMutationResult>;
  batch(
    input: Readonly<{
      world: WorldRoot;
      verb: DebtLifecycleVerb;
      ids: readonly string[];
      note?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<DebtBatchResult>;
}>;
function decodeDebtBodyRequest(action: DebtMutationAction, value: unknown): DebtMutationBodyRequest | null {
  const parsed = debtBodyRequestSchema.extend({ request: debtRequestSchemas[action] }).safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeDebtService(action: DebtMutationAction, value: unknown): DebtMutationService {
  const parsed = debtMutationServiceSchema.safeParse(value);
  if (!parsed.success || parsed.data.action !== action)
    throw new Error(`malformed stored Debt service evidence for ${action}`);
  return parsed.data;
}

function decodeDebtReference(action: DebtMutationAction, value: unknown): ForwardedDebtReference {
  const parsed = forwardedDebtReferenceSchema.safeParse(value);
  if (!parsed.success || parsed.data.action !== action)
    throw new Error(`malformed Debt service reference for ${action}`);
  return parsed.data;
}

/** Debt owns forwarded mutation payload, live result, and durable service evidence. */
export function debtMutationRequestProtocol(
  action: DebtMutationAction,
  batch?: boolean,
): RequestProtocol<DebtMutationBodyRequest, DebtMutationExecutionResult, ForwardedDebtReference> {
  return {
    action,
    encodeRequest: (input) => {
      const { action: _action, ...request } = input.request;
      return { world: input.world, request };
    },
    decodeRequest: (value) => decodeDebtBodyRequest(action, value),
    encodeResult: (result) => result,
    decodeResult: (result) => {
      const schema =
        action === "debt.update"
          ? debtUpdateResultSchema
          : batch === undefined
            ? z.union([debtMutationResultSchema, debtBatchResultSchema])
            : batch
              ? debtBatchResultSchema
              : debtMutationResultSchema;
      const parsed = schema.safeParse(result);
      if (!parsed.success) throw new Error(`transport integrity: Debt ${action} returned an invalid live result`);
      return parsed.data;
    },
    decodeReference: (reference) => decodeDebtReference(action, reference),
    isPermitted: (allowed) => allowed.includes(action),
  };
}

export function debtMutationRequestCommand(
  action: DebtMutationAction,
  port: DebtMutationRequestPort,
): ServiceRequestCommand<
  DebtMutationBodyRequest,
  DebtMutationExecutionResult,
  DebtMutationService,
  ForwardedDebtReference
> {
  return {
    completion: "service",
    protocol: debtMutationRequestProtocol(action),
    encodeService: (service) => service,
    decodeService: (service) => decodeDebtService(action, service),
    projectService: (service) => ({ kind: "served-reference", action: service.action }),
    execute: async (request, facts) => {
      const world = await World.prove(request.world);
      const action = request.request.action;
      let result: DebtMutationExecutionResult;
      switch (action) {
        case "debt.add":
          result = await port.add({
            world,
            options: addDebtOptions(request.request.input, facts.requester, facts.signal),
          });
          break;
        case "debt.addDocument":
          result = await port.addDocument({
            world,
            document: { ...request.request.input, actor: facts.requester, signal: facts.signal },
          });
          break;
        case "debt.update":
          result = await port.update({
            world,
            id: request.request.id,
            options: updateDebtOptions(request.request.input, facts.signal),
          });
          break;
        case "debt.done":
        case "debt.drop": {
          const verb = action.slice("debt.".length) as DebtLifecycleVerb;
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

export function debtMutationRequestCommands(
  port: DebtMutationRequestPort,
): Readonly<Record<DebtMutationAction, ErasedRequestCommand>> {
  return Object.fromEntries(
    DEBT_MUTATION_ACTIONS.map((action) => [action, eraseRequestCommand(debtMutationRequestCommand(action, port))]),
  ) as Record<DebtMutationAction, ErasedRequestCommand>;
}

export function requestForwardedDebt<Request extends DebtMutationRequest>(
  input: Readonly<{
    directory: string;
    id?: never;
    world: WorldRoot;
    request: Request;
    signal?: AbortSignal;
  }>,
): Promise<DebtMutationResultForRequest<Request>>;
export function requestForwardedDebt<Request extends DebtMutationRequest>(
  input: Readonly<{
    directory: string;
    id: string;
    world: WorldRoot;
    request: Request;
    signal?: AbortSignal;
  }>,
): Promise<DebtMutationResultForRequest<Request> | ForwardedDebtReference>;
export async function requestForwardedDebt<Request extends DebtMutationRequest>(
  input: Readonly<{
    directory: string;
    id?: string;
    world: WorldRoot;
    request: Request;
    signal?: AbortSignal;
  }>,
): Promise<DebtMutationResultForRequest<Request> | ForwardedDebtReference> {
  const response = await requestBodyCommand({
    directory: input.directory,
    ...(input.id === undefined ? {} : { id: input.id }),
    command: debtMutationRequestProtocol(input.request.action, "ids" in input.request),
    value: { world: input.world, request: input.request },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.kind === "reference") return response.reference;
  return response.result as DebtMutationResultForRequest<Request>;
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

function addDebtOptions(input: z.output<typeof addInputSchema>, actor: string, signal?: AbortSignal): AddDebtInput {
  return definedFields<AddDebtInput>(input, { actor, signal });
}

function updateDebtOptions(input: z.output<typeof updateInputSchema>, signal?: AbortSignal): UpdateDebtInput {
  return definedFields<UpdateDebtInput>(input, { signal });
}
