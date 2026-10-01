import { z } from "zod";
import { AkumaNotBornError, AkumaObservationError } from "./akuma-errors.js";
import type { AkumaStatus } from "./akuma.js";
import type { KillEvidence } from "./heart/index.js";
import { akumaIdSchema } from "./identity.js";
import { requestBodyCommand } from "./request-rendezvous.js";
import {
  eraseRequestCommand,
  type ErasedRequestCommand,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "./request-wire.js";
import type { Schema } from "./schema.js";
import { schemaJsonText } from "./schema.js";
import {
  selectionResultSchemas,
  type AkumaAskResult,
  type AkumaKillResult,
  type AkumaTellResult,
  type AkumaWaitResult,
} from "./selection-observation.js";

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const selectionTargetsSchema = z
  .array(akumaIdSchema)
  .min(1)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "expected a deduplicated target set" });
  })
  .readonly();
const waitRequestSchema = z
  .object({
    targets: selectionTargetsSchema,
    completion: z.enum(["any", "all"]),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .transform(({ timeoutMs, ...request }) => ({
    action: "akuma.wait" as const,
    ...request,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }));
const tellRequestSchema = z
  .object({
    target: akumaIdSchema,
    body: z.string(),
    initiator: nonblankTextSchema.optional(),
    interrupt: z.boolean().optional(),
  })
  .strict()
  .transform((request) => ({ action: "akuma.tell" as const, ...request }));
const askRequestSchema = z
  .object({
    target: akumaIdSchema,
    body: z.string(),
    timeoutMs: z.number().int().nonnegative().optional(),
    schemaJson: nonblankTextSchema.optional(),
    initiator: nonblankTextSchema.optional(),
    interrupt: z.boolean().optional(),
  })
  .strict()
  .transform((request) => ({ action: "akuma.ask" as const, ...request }));
const killRequestSchema = z
  .object({ targets: selectionTargetsSchema })
  .strict()
  .transform((request) => ({ action: "akuma.kill" as const, ...request }));
const waitServiceSchema = z.object({ action: z.literal("akuma.wait") }).strict();
const tellServiceSchema = z
  .object({ action: z.literal("akuma.tell"), target: akumaIdSchema, tellId: nonblankTextSchema })
  .strict();
const askServiceSchema = z
  .object({ action: z.literal("akuma.ask"), target: akumaIdSchema, tellId: nonblankTextSchema })
  .strict();
const killServiceSchema = z
  .object({
    action: z.literal("akuma.kill"),
    results: z
      .array(z.object({ id: akumaIdSchema, evidence: selectionResultSchemas.killEvidence }).strict())
      .readonly(),
  })
  .strict();

/**
 * A forwarded Selection request leaves selection and observation to the parent, so
 * the parent's typed refusal is the only evidence the child can classify on.
 * Transporting it is the codec's own duty: an unencoded failure reaches the
 * caller as an anonymous request error and loses the identity it names.
 *
 * The transport voids a begun request only when the encoded failure proves no
 * product effect. A refused selection or an unreadable observation never
 * reached an action, so Selection proves that through the same refusal envelope
 * the Contract codec uses; a genuinely failed action stays unencoded and
 * keeps its existing anonymous classification.
 */
const selectionRefusalSchema = z.union([
  z.object({ kind: z.literal("akuma-not-born"), id: akumaIdSchema }).strict(),
  z.object({ kind: z.literal("akuma-observation"), id: akumaIdSchema, diagnostic: z.string() }).strict(),
]);
const selectionLiveFailureSchema = z.object({ kind: z.literal("refused"), failure: selectionRefusalSchema }).strict();

export function encodeSelectionLiveFailure(error: unknown): unknown | null {
  const failure =
    error instanceof AkumaNotBornError
      ? { kind: "akuma-not-born" as const, id: error.id }
      : error instanceof AkumaObservationError
        ? { kind: "akuma-observation" as const, id: error.id, diagnostic: error.diagnostic }
        : null;
  return failure === null ? null : { kind: "refused", failure };
}

export function decodeSelectionLiveFailure(value: unknown): Error | null {
  const parsed = selectionLiveFailureSchema.safeParse(value);
  if (!parsed.success) return null;
  const failure = parsed.data.failure;
  return failure.kind === "akuma-not-born"
    ? new AkumaNotBornError(failure.id as AkumaStatus["id"])
    : new AkumaObservationError(failure.id as AkumaStatus["id"], failure.diagnostic);
}

export type SelectionRequest =
  | z.infer<typeof waitRequestSchema>
  | z.infer<typeof tellRequestSchema>
  | z.infer<typeof askRequestSchema>
  | z.infer<typeof killRequestSchema>;
export type SelectionService =
  | z.infer<typeof waitServiceSchema>
  | z.infer<typeof tellServiceSchema>
  | z.infer<typeof askServiceSchema>
  | z.infer<typeof killServiceSchema>;
type SelectionResult = AkumaWaitResult | AkumaTellResult | AkumaAskResult | AkumaKillResult;

export type SelectionRequestPort = Readonly<{
  wait(
    input: Readonly<{
      targets: readonly AkumaStatus["id"][];
      completion: "any" | "all";
      timeoutMs?: number;
      signal: AbortSignal;
    }>,
  ): Promise<AkumaWaitResult>;
  tell(
    input: Readonly<{
      target: AkumaStatus["id"];
      body: string;
      tellId: string;
      recordedAt: string;
      initiator?: string;
      interrupt?: boolean;
      signal: AbortSignal;
    }>,
  ): Promise<AkumaTellResult>;
  ask?(
    input: Readonly<{
      target: AkumaStatus["id"];
      body: string;
      tellId: string;
      recordedAt: string;
      timeoutMs?: number;
      schemaJson?: string;
      initiator?: string;
      interrupt?: boolean;
      signal: AbortSignal;
    }>,
  ): Promise<AkumaAskResult>;
  kill(input: Readonly<{ targets: readonly AkumaStatus["id"][]; signal: AbortSignal }>): Promise<
    | AkumaKillResult
    | Readonly<{
        result: AkumaKillResult;
        service: readonly Readonly<{ id: AkumaStatus["id"]; evidence: KillEvidence }>[];
      }>
  >;
}>;

function decodeSelectionRequest(action: SelectionRequest["action"], value: unknown): SelectionRequest | null {
  const schema =
    action === "akuma.wait"
      ? waitRequestSchema
      : action === "akuma.tell"
        ? tellRequestSchema
        : action === "akuma.ask"
          ? askRequestSchema
          : killRequestSchema;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeSelectionService(action: SelectionRequest["action"], value: unknown): SelectionService {
  const schema =
    action === "akuma.wait"
      ? waitServiceSchema
      : action === "akuma.tell"
        ? tellServiceSchema
        : action === "akuma.ask"
          ? askServiceSchema
          : killServiceSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("malformed stored Selection service evidence");
  return parsed.data;
}

function decodedSelectionResult(action: SelectionRequest["action"], value: unknown): SelectionResult {
  const schema =
    action === "akuma.wait"
      ? selectionResultSchemas.wait
      : action === "akuma.tell"
        ? selectionResultSchemas.tell
        : action === "akuma.ask"
          ? selectionResultSchemas.ask
          : selectionResultSchemas.kill;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Akuma body request returned an invalid live result for ${action}`);
  return parsed.data;
}

/** Akuma owns Body Request payload, live result, and durable service codecs for wait/tell/kill. */
export function selectionRequestProtocol<Result extends SelectionResult = SelectionResult>(
  action: SelectionRequest["action"],
): RequestProtocol<SelectionRequest, Result, SelectionService> {
  return {
    action,
    supportsCancellation: true,
    encodeRequest: (request) => {
      const { action: _action, ...payload } = request;
      return payload;
    },
    decodeRequest: (payload) => decodeSelectionRequest(action, payload),
    encodeResult: (result) => result,
    decodeResult: (result) => decodedSelectionResult(action, result) as Result,
    encodeFailure: encodeSelectionLiveFailure,
    decodeFailure: decodeSelectionLiveFailure,
    decodeReference: (reference) => decodeSelectionService(action, reference),
    isPermitted: (allowed) =>
      action === "akuma.wait" ||
      ((action === "akuma.tell" || action === "akuma.ask") && allowed.includes("akuma.tell")) ||
      (action === "akuma.kill" && allowed.includes("akuma.kill")),
  };
}

export function selectionRequestCommand(
  action: SelectionRequest["action"],
  port: SelectionRequestPort,
): ServiceRequestCommand<SelectionRequest, SelectionResult, SelectionService, SelectionService> {
  return {
    completion: "service",
    protocol: selectionRequestProtocol(action),
    encodeService: (service) => service,
    decodeService: (service) => decodeSelectionService(action, service),
    projectService: (service) => service,
    execute: async (request, facts) => {
      if (request.action === "akuma.wait") {
        return {
          kind: "served",
          result: await port.wait({ ...request, signal: facts.signal }),
          service: { action: request.action },
        };
      }
      if (request.action === "akuma.tell") {
        return {
          kind: "served",
          result: await port.tell({
            target: request.target,
            body: request.body,
            tellId: facts.id,
            ...(request.initiator === undefined ? {} : { initiator: request.initiator }),
            ...(request.interrupt === undefined ? {} : { interrupt: request.interrupt }),
            recordedAt: facts.admittedAt,
            signal: facts.signal,
          }),
          service: { action: request.action, target: request.target, tellId: facts.id },
        };
      }
      if (request.action === "akuma.ask") {
        if (port.ask === undefined) throw new Error("bounded Tell Selection port is unavailable");
        return {
          kind: "served",
          result: await port.ask({
            target: request.target,
            body: request.body,
            tellId: facts.id,
            recordedAt: facts.admittedAt,
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
            ...(request.schemaJson === undefined ? {} : { schemaJson: request.schemaJson }),
            ...(request.initiator === undefined ? {} : { initiator: request.initiator }),
            ...(request.interrupt === undefined ? {} : { interrupt: request.interrupt }),
            signal: facts.signal,
          }),
          service: { action: request.action, target: request.target, tellId: facts.id },
        };
      }
      const result = await port.kill({ targets: request.targets, signal: facts.signal });
      if ("result" in result)
        return { kind: "served", result: result.result, service: { action: request.action, results: result.service } };
      return {
        kind: "served",
        result,
        service: { action: request.action, results: result.results.map(({ id, evidence }) => ({ id, evidence })) },
      };
    },
  };
}

export function selectionRequestCommands(
  port: SelectionRequestPort,
): Readonly<Record<"akuma.wait" | "akuma.tell" | "akuma.ask" | "akuma.kill", ErasedRequestCommand>> {
  return {
    "akuma.wait": eraseRequestCommand(selectionRequestCommand("akuma.wait", port)),
    "akuma.tell": eraseRequestCommand(selectionRequestCommand("akuma.tell", port)),
    "akuma.ask": eraseRequestCommand(selectionRequestCommand("akuma.ask", port)),
    "akuma.kill": eraseRequestCommand(selectionRequestCommand("akuma.kill", port)),
  };
}

type ForwardedSelectionResponse<Result, Service> =
  | Readonly<{ kind: "returned"; result: Result }>
  | Readonly<{ kind: "reference"; reference: Service }>;

/**
 * The one terminal guard for every forwarded Selection operation: a returned
 * live result is the operation's own answer, and a durable reference can never
 * reproduce an expired live result.
 */
function forwardedSelectionResult<Result, Service>(response: ForwardedSelectionResponse<Result, Service>): Result {
  if (response.kind === "returned") return response.result;
  throw new Error("Akuma body request terminal Selection reference cannot reproduce an expired live result");
}

export async function requestForwardedSelectionWait(
  input: Readonly<{
    directory: string;
    targets: readonly AkumaStatus["id"][];
    completion: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
  }>,
): Promise<AkumaWaitResult> {
  const response = await requestBodyCommand({
    directory: input.directory,
    command: selectionRequestProtocol<AkumaWaitResult>("akuma.wait"),
    value: {
      action: "akuma.wait",
      targets: input.targets,
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return forwardedSelectionResult<AkumaWaitResult, SelectionService>(response);
}

export async function requestForwardedSelectionTell(
  input: Readonly<{
    directory: string;
    target: AkumaStatus["id"];
    body: string;
    initiator?: string;
    interrupt?: boolean;
    signal?: AbortSignal;
  }>,
): Promise<AkumaTellResult> {
  const response = await requestBodyCommand({
    directory: input.directory,
    command: selectionRequestProtocol<AkumaTellResult>("akuma.tell"),
    value: {
      action: "akuma.tell",
      target: input.target,
      body: input.body,
      ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      ...(input.interrupt === true ? { interrupt: true } : {}),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return forwardedSelectionResult<AkumaTellResult, SelectionService>(response);
}

export async function requestForwardedSelectionAsk(
  input: Readonly<{
    directory: string;
    target: AkumaStatus["id"];
    body: string;
    timeoutMs?: number;
    schema?: Schema<unknown>;
    initiator?: string;
    interrupt?: boolean;
    signal?: AbortSignal;
  }>,
): Promise<AkumaAskResult> {
  const response = await requestBodyCommand({
    directory: input.directory,
    command: selectionRequestProtocol<AkumaAskResult>("akuma.ask"),
    value: {
      action: "akuma.ask",
      target: input.target,
      body: input.body,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.schema === undefined ? {} : { schemaJson: schemaJsonText(input.schema) }),
      ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt }),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return forwardedSelectionResult<AkumaAskResult, SelectionService>(response);
}

export async function requestForwardedSelectionKill(
  input: Readonly<{
    directory: string;
    targets: readonly AkumaStatus["id"][];
    signal?: AbortSignal;
  }>,
): Promise<AkumaKillResult> {
  const response = await requestBodyCommand({
    directory: input.directory,
    command: selectionRequestProtocol<AkumaKillResult>("akuma.kill"),
    value: { action: "akuma.kill", targets: input.targets },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return forwardedSelectionResult<AkumaKillResult, SelectionService>(response);
}
