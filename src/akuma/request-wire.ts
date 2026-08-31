import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const requestIdSchema = z.string().regex(UUID);
const actionSchema = z.string().refine((value) => value.trim() !== "");

const requestEnvelopeSchema = z.object({ id: requestIdSchema, action: actionSchema, payload: z.unknown() }).strict();

const upstreamRequestFailureSchema = z.union([
  z.object({ kind: z.literal("akuma-not-born"), id: z.string() }).strict(),
  z.object({ kind: z.literal("failed"), diagnostic: z.string() }).strict(),
]);

const returnedEnvelopeSchema = z.union([
  z.object({ kind: z.literal("returned"), result: z.unknown() }).strict(),
  z.object({ kind: z.literal("failed"), failure: upstreamRequestFailureSchema }).strict(),
]);

const receiptEnvelopeSchema = z.union([
  z
    .object({ id: requestIdSchema, action: actionSchema, state: z.literal("served"), outcome: returnedEnvelopeSchema })
    .strict(),
  z.object({ id: requestIdSchema, action: actionSchema, state: z.literal("served"), reference: z.unknown() }).strict(),
  z.object({ id: requestIdSchema, action: actionSchema, state: z.literal("refused"), diagnostic: z.string() }).strict(),
  z
    .object({
      id: requestIdSchema,
      action: actionSchema,
      state: z.literal("voided"),
      evidence: z.string(),
      failure: z.unknown().optional(),
    })
    .strict(),
]);

export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
/**
 * A Body Request operation is owned by the verb that defines its public
 * values.  Transport only carries the opaque values produced here.
 */
export type RequestProtocol<Input, Output, Reference> = Readonly<{
  action: string;
  encodeRequest(input: Input): unknown;
  decodeRequest(payload: unknown): Input | null;
  encodeResult(result: Output): unknown;
  decodeResult(result: unknown): Output;
  encodeFailure?(error: unknown): unknown | null;
  decodeFailure?(failure: unknown): Error | null;
  decodeReference(reference: unknown): Reference;
  isPermitted(allowed: readonly string[]): boolean;
}>;

export type ExecutionFacts = Readonly<{
  id: string;
  admittedAt: string;
  requester: string;
  signal: AbortSignal;
  admissionOpen(): boolean;
}>;

export type ChildRequestCommand<Input, Output, Reference> = Readonly<{
  completion: "child";
  protocol: RequestProtocol<Input, Output, Reference>;
  projectChild(child: string): Reference;
  execute(input: Input, facts: ExecutionFacts): Promise<Readonly<{ result: Output; child: string }>>;
}>;

export type ServiceRequestCommand<Input, Output, Service, Reference> = Readonly<{
  completion: "service";
  protocol: RequestProtocol<Input, Output, Reference>;
  encodeService(service: Service): unknown;
  decodeService(service: unknown): Service;
  projectService(service: Service): Reference;
  execute(input: Input, facts: ExecutionFacts): Promise<Readonly<{ result: Output; service: Service }>>;
}>;

type ErasedRequest = Readonly<{
  payloadJson: string;
  isPermitted(allowed: readonly string[]): boolean;
  encodeFailure(error: unknown): unknown | null;
}>;

type ErasedChildRequest = ErasedRequest &
  Readonly<{
    execute(facts: ExecutionFacts): Promise<Readonly<{ result: unknown; child: string }>>;
  }>;

type ErasedServiceRequest = ErasedRequest &
  Readonly<{
    execute(facts: ExecutionFacts): Promise<Readonly<{ result: unknown; serviceJson: string }>>;
  }>;

export type ErasedRequestCommand =
  | Readonly<{
      action: string;
      completion: "child";
      projectChild(child: string): unknown;
      resolve(payload: unknown): ErasedChildRequest | null;
    }>
  | Readonly<{
      action: string;
      completion: "service";
      projectServiceJson(serviceJson: string): unknown;
      resolve(payload: unknown): ErasedServiceRequest | null;
    }>;

/** Erases only static TypeScript parameters; each operation codec remains captured by its owner descriptor. */
export function eraseRequestCommand<Input, Output, Reference>(
  command: ChildRequestCommand<Input, Output, Reference>,
): ErasedRequestCommand;
export function eraseRequestCommand<Input, Output, Service, Reference>(
  command: ServiceRequestCommand<Input, Output, Service, Reference>,
): ErasedRequestCommand;
export function eraseRequestCommand<Input, Output, Service, Reference>(
  command: ChildRequestCommand<Input, Output, Reference> | ServiceRequestCommand<Input, Output, Service, Reference>,
): ErasedRequestCommand {
  const { protocol } = command;
  switch (command.completion) {
    case "child":
      return {
        action: protocol.action,
        completion: "child",
        projectChild: command.projectChild,
        resolve: (payload) => {
          const input = protocol.decodeRequest(payload);
          if (input === null) return null;
          return {
            payloadJson: JSON.stringify(protocol.encodeRequest(input)),
            isPermitted: (allowed) => protocol.isPermitted(allowed),
            execute: async (facts) => {
              const served = await command.execute(input, facts);
              return { result: protocol.encodeResult(served.result), child: served.child };
            },
            encodeFailure: (error) => protocol.encodeFailure?.(error) ?? null,
          };
        },
      };
    case "service":
      return {
        action: protocol.action,
        completion: "service",
        projectServiceJson: (serviceJson) => command.projectService(command.decodeService(JSON.parse(serviceJson))),
        resolve: (payload) => {
          const input = protocol.decodeRequest(payload);
          if (input === null) return null;
          return {
            payloadJson: JSON.stringify(protocol.encodeRequest(input)),
            isPermitted: (allowed) => protocol.isPermitted(allowed),
            execute: async (facts) => {
              const served = await command.execute(input, facts);
              return {
                result: protocol.encodeResult(served.result),
                serviceJson: JSON.stringify(command.encodeService(served.service)),
              };
            },
            encodeFailure: (error) => protocol.encodeFailure?.(error) ?? null,
          };
        },
      };
  }
}

export function composeRequestCommands(
  ...maps: readonly Readonly<Record<string, ErasedRequestCommand>>[]
): Readonly<Record<string, ErasedRequestCommand>> {
  const commands: Record<string, ErasedRequestCommand> = Object.create(null);
  for (const map of maps) {
    for (const [action, command] of Object.entries(map)) {
      if (Object.hasOwn(commands, action)) throw new Error(`duplicate request command action: ${action}`);
      commands[action] = command;
    }
  }
  return commands;
}
export type UpstreamRequestFailure = z.infer<typeof upstreamRequestFailureSchema>;
export type ReturnedEnvelope = z.infer<typeof returnedEnvelopeSchema>;
export type ReceiptEnvelope = z.infer<typeof receiptEnvelopeSchema>;

export function decodeEnvelope(bytes: string, fileId: string): RequestEnvelope | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes);
  } catch {
    return null;
  }
  const parsed = requestEnvelopeSchema.safeParse(decoded);
  return UUID.test(fileId) && parsed.success ? parsed.data : null;
}

export function decodeReceiptEnvelope(bytes: string, id: string, action: string): ReceiptEnvelope | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes);
  } catch {
    return null;
  }
  const parsed = receiptEnvelopeSchema.safeParse(decoded);
  return parsed.success && parsed.data.id === id && parsed.data.action === action ? parsed.data : null;
}

export function requestPath(directory: string, id: string): string {
  return join(directory, `${id}.request.json`);
}

export function receiptPath(directory: string, id: string): string {
  return join(directory, `${id}.receipt.json`);
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
