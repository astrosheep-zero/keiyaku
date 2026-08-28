import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type RequestEnvelope = Readonly<{ id: string; action: string; payload: unknown }>;
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
export type UpstreamRequestFailure =
  | Readonly<{ kind: "akuma-not-born"; id: string }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;
export type ReturnedEnvelope =
  | Readonly<{ kind: "returned"; result: unknown }>
  | Readonly<{ kind: "failed"; failure: UpstreamRequestFailure }>;
export type ReceiptEnvelope =
  | (Readonly<{ id: string; action: string; state: "served" }> & Readonly<{ outcome: ReturnedEnvelope }>)
  | (Readonly<{ id: string; action: string; state: "served" }> & Readonly<{ reference: unknown }>)
  | Readonly<{ id: string; action: string; state: "refused"; diagnostic: string }>
  | Readonly<{ id: string; action: string; state: "voided"; evidence: string }>;

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function decodeEnvelope(bytes: string, fileId: string): RequestEnvelope | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes);
  } catch {
    return null;
  }
  const value = object(decoded);
  if (
    value === null ||
    !exactKeys(value, ["action", "id", "payload"]) ||
    !UUID.test(fileId) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    typeof value.action !== "string" ||
    value.action.trim() === ""
  )
    return null;
  return { id: value.id, action: value.action, payload: value.payload };
}

function decodeOutcome(value: unknown): ReturnedEnvelope | null {
  const envelope = object(value);
  if (envelope?.kind === "returned" && exactKeys(envelope, ["kind", "result"])) {
    return { kind: "returned", result: envelope.result };
  }
  const failure = object(envelope?.failure);
  if (envelope?.kind !== "failed" || !exactKeys(envelope, ["failure", "kind"]) || failure === null) return null;
  if (failure.kind === "akuma-not-born" && exactKeys(failure, ["id", "kind"]) && typeof failure.id === "string") {
    return { kind: "failed", failure: { kind: "akuma-not-born", id: failure.id } };
  }
  if (
    failure.kind === "failed" &&
    exactKeys(failure, ["diagnostic", "kind"]) &&
    typeof failure.diagnostic === "string"
  ) {
    return { kind: "failed", failure: { kind: "failed", diagnostic: failure.diagnostic } };
  }
  return null;
}

export function decodeReceiptEnvelope(bytes: string, id: string, action: string): ReceiptEnvelope | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes);
  } catch {
    return null;
  }
  const value = object(decoded);
  if (value === null || value.id !== id || value.action !== action || typeof value.state !== "string") return null;
  if (
    value.state === "refused" &&
    exactKeys(value, ["action", "diagnostic", "id", "state"]) &&
    typeof value.diagnostic === "string"
  ) {
    return { id, action, state: "refused", diagnostic: value.diagnostic };
  }
  if (
    value.state === "voided" &&
    exactKeys(value, ["action", "evidence", "id", "state"]) &&
    typeof value.evidence === "string"
  ) {
    return { id, action, state: "voided", evidence: value.evidence };
  }
  if (value.state === "served" && exactKeys(value, ["action", "id", "reference", "state"])) {
    return { id, action, state: "served", reference: value.reference };
  }
  if (value.state === "served" && exactKeys(value, ["action", "id", "outcome", "state"])) {
    const outcome = decodeOutcome(value.outcome);
    return outcome === null ? null : { id, action, state: "served", outcome };
  }
  return null;
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
