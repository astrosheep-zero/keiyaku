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
export type RequestCommand<Input, Output, Service, Reference = Service, Context = unknown> = Readonly<{
  action: string;
  encodeRequest(input: Input): unknown;
  decodeRequest(payload: unknown): Input | null;
  encodeResult(result: Output): unknown;
  decodeResult(result: unknown): Output;
  encodeFailure?(error: unknown): unknown | null;
  decodeFailure?(failure: unknown): Error | null;
  encodeService(service: Service): unknown;
  decodeService(service: unknown): Service;
  projectService(service: Service): Reference;
  projectChild?(child: string): Reference;
  decodeReference(reference: unknown): Reference;
  /** The operation owner proves the Body-owned execution capability before use. */
  decodeExecutionContext(value: unknown): Context;
  isPermitted(allowed: readonly string[]): boolean;
  execute(
    input: Input,
    context: Context,
  ): Promise<Readonly<{ result: Output }> & (Readonly<{ service: Service }> | Readonly<{ child: string }>)>;
}>;

export type ErasedRequestCommand = Readonly<{
  action: string;
  resolve(payload: unknown): ErasedRequest | null;
}>;

export type ErasedRequest = Readonly<{
  payloadJson: string;
  isPermitted(allowed: readonly string[]): boolean;
  execute(context: unknown): Promise<ErasedRequestExecution>;
  encodeFailure(error: unknown): unknown | null;
  projectServiceJson(serviceJson: string): unknown;
  projectChild(child: string): unknown;
}>;

export type ErasedRequestExecution =
  | Readonly<{ result: unknown; serviceJson: string }>
  | Readonly<{ result: unknown; child: string }>;

/** Erases only static TypeScript parameters; each operation codec remains captured by its owner descriptor. */
export function eraseRequestCommand<Input, Output, Service, Reference, Context>(
  command: RequestCommand<Input, Output, Service, Reference, Context>,
): ErasedRequestCommand {
  return {
    action: command.action,
    resolve: (payload) => {
      const input = command.decodeRequest(payload);
      if (input === null) return null;
      return {
        payloadJson: JSON.stringify(command.encodeRequest(input)),
        isPermitted: (allowed) => command.isPermitted(allowed),
        execute: async (context) => {
          const served = await command.execute(input, command.decodeExecutionContext(context));
          return "child" in served
            ? { result: command.encodeResult(served.result), child: served.child }
            : {
                result: command.encodeResult(served.result),
                serviceJson: JSON.stringify(command.encodeService(served.service)),
              };
        },
        encodeFailure: (error) => command.encodeFailure?.(error) ?? null,
        projectServiceJson: (serviceJson) => command.projectService(command.decodeService(JSON.parse(serviceJson))),
        projectChild: (child) => {
          if (command.projectChild === undefined)
            throw new Error(`request ${command.action} has no child reference codec`);
          return command.projectChild(child);
        },
      };
    },
  };
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
