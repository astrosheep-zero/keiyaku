import { akumaIdSchema } from "./akuma.js";
import type { KillEvidence } from "./heart/index.js";
import { requestBodyCommand } from "./request-rendezvous.js";
import {
  eraseRequestCommand,
  type ErasedRequestCommand,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "./request-wire.js";
import type { AkumaStatus } from "./akuma.js";
import {
  fleetResultSchemas,
  isKillResult,
  isTellResult,
  isWaitResult,
  type AkumaKillResult,
  type AkumaTellResult,
  type AkumaWaitResult,
} from "./fleet-observation.js";
import { z } from "zod";

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const fleetTargetsSchema = z
  .array(akumaIdSchema)
  .min(1)
  .superRefine((ids, context) => {
    if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id))
      context.addIssue({ code: "custom", message: "expected a strictly ordered target set" });
  });
const waitRequestSchema = z
  .object({
    targets: fleetTargetsSchema,
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
  .object({ target: akumaIdSchema, body: z.string() })
  .strict()
  .transform((request) => ({ action: "akuma.tell" as const, ...request }));
const killRequestSchema = z
  .object({ targets: fleetTargetsSchema })
  .strict()
  .transform((request) => ({ action: "akuma.kill" as const, ...request }));
const waitServiceSchema = z.object({ action: z.literal("akuma.wait") }).strict();
const tellServiceSchema = z
  .object({ action: z.literal("akuma.tell"), target: akumaIdSchema, tellId: nonblankTextSchema })
  .strict();
const killServiceSchema = z
  .object({
    action: z.literal("akuma.kill"),
    results: z.array(z.object({ id: akumaIdSchema, evidence: fleetResultSchemas.killEvidence }).strict()),
  })
  .strict();

export type FleetRequest =
  | (Omit<z.infer<typeof waitRequestSchema>, "targets"> & Readonly<{ targets: readonly AkumaStatus["id"][] }>)
  | z.infer<typeof tellRequestSchema>
  | (Omit<z.infer<typeof killRequestSchema>, "targets"> & Readonly<{ targets: readonly AkumaStatus["id"][] }>);
export type FleetService =
  | z.infer<typeof waitServiceSchema>
  | z.infer<typeof tellServiceSchema>
  | (Omit<z.infer<typeof killServiceSchema>, "results"> &
      Readonly<{ results: readonly Readonly<{ id: AkumaStatus["id"]; evidence: KillEvidence }>[] }>);

export type FleetRequestPort = Readonly<{
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
      signal: AbortSignal;
    }>,
  ): Promise<AkumaTellResult>;
  kill(
    input: Readonly<{ targets: readonly AkumaStatus["id"][]; signal: AbortSignal }>,
  ): Promise<
    | AkumaKillResult
    | Readonly<{ result: unknown; service: readonly Readonly<{ id: AkumaStatus["id"]; evidence: KillEvidence }>[] }>
  >;
}>;

function decodeFleetRequest(action: FleetRequest["action"], value: unknown): FleetRequest | null {
  const schema =
    action === "akuma.wait" ? waitRequestSchema : action === "akuma.tell" ? tellRequestSchema : killRequestSchema;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeFleetService(action: FleetRequest["action"], value: unknown): FleetService {
  const schema =
    action === "akuma.wait" ? waitServiceSchema : action === "akuma.tell" ? tellServiceSchema : killServiceSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("malformed stored Fleet service evidence");
  return parsed.data;
}

function decodedFleetResult(action: FleetRequest["action"], value: unknown): unknown {
  const schema =
    action === "akuma.wait"
      ? fleetResultSchemas.wait
      : action === "akuma.tell"
        ? fleetResultSchemas.tell
        : fleetResultSchemas.kill;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Akuma body request returned an invalid live result for ${action}`);
  return parsed.data;
}

/** Akuma owns Body Request payload, live result, and durable service codecs for wait/tell/kill. */
export function fleetRequestProtocol(
  action: FleetRequest["action"],
): RequestProtocol<FleetRequest, unknown, FleetService> {
  return {
    action,
    encodeRequest: (request) => {
      const { action: _action, ...payload } = request;
      return payload;
    },
    decodeRequest: (payload) => decodeFleetRequest(action, payload),
    encodeResult: (result) => result,
    decodeResult: (result) => decodedFleetResult(action, result),
    decodeReference: (reference) => decodeFleetService(action, reference),
    isPermitted: (allowed) => action === "akuma.wait" || allowed.includes(action),
  };
}

export function fleetRequestCommand(
  action: FleetRequest["action"],
  port: FleetRequestPort,
): ServiceRequestCommand<FleetRequest, unknown, FleetService, FleetService> {
  return {
    completion: "service",
    protocol: fleetRequestProtocol(action),
    encodeService: (service) => decodeFleetService(action, service),
    decodeService: (service) => decodeFleetService(action, service),
    projectService: (service) => decodeFleetService(action, service),
    execute: async (request, facts) => {
      if (request.action === "akuma.wait") {
        return {
          result: await port.wait({ ...request, signal: facts.signal }),
          service: { action: request.action },
        };
      }
      if (request.action === "akuma.tell") {
        return {
          result: await port.tell({
            target: request.target,
            body: request.body,
            tellId: facts.id,
            recordedAt: facts.admittedAt,
            signal: facts.signal,
          }),
          service: { action: request.action, target: request.target, tellId: facts.id },
        };
      }
      const result = await port.kill({ targets: request.targets, signal: facts.signal });
      if ("result" in result)
        return { result: result.result, service: { action: request.action, results: result.service } };
      return {
        result,
        service: { action: request.action, results: result.results.map(({ id, evidence }) => ({ id, evidence })) },
      };
    },
  };
}

export function fleetRequestCommands(
  port: FleetRequestPort,
): Readonly<Record<"akuma.wait" | "akuma.tell" | "akuma.kill", ErasedRequestCommand>> {
  return {
    "akuma.wait": eraseRequestCommand(fleetRequestCommand("akuma.wait", port)),
    "akuma.tell": eraseRequestCommand(fleetRequestCommand("akuma.tell", port)),
    "akuma.kill": eraseRequestCommand(fleetRequestCommand("akuma.kill", port)),
  };
}

function forwardedFleetCommandResult(
  response: Awaited<ReturnType<typeof requestBodyCommand<FleetRequest, unknown, FleetService>>>,
  action: "akuma.wait",
): AkumaWaitResult;
function forwardedFleetCommandResult(
  response: Awaited<ReturnType<typeof requestBodyCommand<FleetRequest, unknown, FleetService>>>,
  action: "akuma.tell",
): AkumaTellResult;
function forwardedFleetCommandResult(
  response: Awaited<ReturnType<typeof requestBodyCommand<FleetRequest, unknown, FleetService>>>,
  action: "akuma.kill",
): AkumaKillResult;
function forwardedFleetCommandResult(
  response: Awaited<ReturnType<typeof requestBodyCommand<FleetRequest, unknown, FleetService>>>,
  action: FleetRequest["action"],
): AkumaWaitResult | AkumaTellResult | AkumaKillResult {
  if (response.kind === "returned") {
    if (action === "akuma.wait" && isWaitResult(response.result)) return response.result;
    if (action === "akuma.tell" && isTellResult(response.result)) return response.result;
    if (action === "akuma.kill" && isKillResult(response.result)) return response.result;
    throw new Error(`transport integrity: request Fleet ${action} returned an invalid live result`);
  }
  throw new Error("Akuma body request terminal Fleet reference cannot reproduce an expired live result");
}

export async function requestForwardedFleetWait(
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
    command: fleetRequestProtocol("akuma.wait"),
    value: {
      action: "akuma.wait",
      targets: input.targets,
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return forwardedFleetCommandResult(response, "akuma.wait");
}

export async function requestForwardedFleetTell(
  input: Readonly<{
    directory: string;
    target: AkumaStatus["id"];
    body: string;
    signal?: AbortSignal;
  }>,
): Promise<AkumaTellResult> {
  const response = await requestBodyCommand({
    directory: input.directory,
    command: fleetRequestProtocol("akuma.tell"),
    value: { action: "akuma.tell", target: input.target, body: input.body },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return forwardedFleetCommandResult(response, "akuma.tell");
}

export async function requestForwardedFleetKill(
  input: Readonly<{
    directory: string;
    targets: readonly AkumaStatus["id"][];
    signal?: AbortSignal;
  }>,
): Promise<AkumaKillResult> {
  const response = await requestBodyCommand({
    directory: input.directory,
    command: fleetRequestProtocol("akuma.kill"),
    value: { action: "akuma.kill", targets: input.targets },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return forwardedFleetCommandResult(response, "akuma.kill");
}
