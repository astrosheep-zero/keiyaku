import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import { executionChannel, type ExecutionContext } from "../akuma/requests.js";
import {
  eraseRequestCommand,
  type ErasedRequestCommand,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "../akuma/request-wire.js";
import { contractIdSchema } from "../protocol/operations.js";
import { decodeFailureWire, encodeFailureWire } from "./outcome.js";
import {
  contractWaitResultSchema,
  waitContractLocal,
  type ContractWaitResult,
  type ValidatedWait,
} from "./contract-wait.js";

const requestSchema = z
  .object({
    repoRoot: z.string().refine((value) => isAbsolute(value) && resolve(value) === value),
    contracts: z
      .array(contractIdSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length),
    completion: z.enum(["any", "all"]),
    timeoutMs: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .transform((value) => ({ action: "contract.wait" as const, ...value }));
type Request = z.infer<typeof requestSchema>;
const serviceSchema = z.object({ action: z.literal("contract.wait") }).strict();
type Service = z.infer<typeof serviceSchema>;

function protocol(): RequestProtocol<Request, ContractWaitResult, Service> {
  return {
    action: "contract.wait",
    supportsCancellation: true,
    encodeRequest: ({ action: _action, ...request }) => request,
    decodeRequest: (value) => {
      const parsed = requestSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    encodeResult: (value) => value,
    decodeResult: (value) => contractWaitResultSchema.parse(value),
    encodeFailure: encodeFailureWire,
    decodeFailure: decodeFailureWire,
    decodeReference: (value) => serviceSchema.parse(value),
  };
}

export function contractWaitRequestCommand(
  port: (request: Request, signal: AbortSignal) => Promise<ContractWaitResult>,
): ErasedRequestCommand {
  const command: ServiceRequestCommand<Request, ContractWaitResult, Service, Service> = {
    completion: "service",
    protocol: protocol(),
    encodeService: (value) => value,
    decodeService: (value) => serviceSchema.parse(value),
    projectService: (value) => value,
    execute: async (request, facts) => ({
      kind: "served",
      result: await port(request, facts.signal),
      service: { action: "contract.wait" },
    }),
  };
  return eraseRequestCommand(command);
}

export async function waitContractRouted(
  input: ValidatedWait,
  execution: ExecutionContext,
): Promise<ContractWaitResult> {
  const channel = executionChannel(execution);
  if (channel.kind === "local") return await waitContractLocal(input);
  const directory = channel.directory;
  const response = await requestBodyCommand({
    directory,
    command: protocol(),
    value: {
      action: "contract.wait",
      repoRoot: input.scope.primaryWorktree,
      contracts: [...input.ids],
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.kind === "reference")
    throw new Error(
      `transport integrity: request ${response.requestId} returned a reference without a live Contract wait result`,
    );
  return response.result;
}
