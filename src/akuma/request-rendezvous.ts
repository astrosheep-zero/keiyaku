import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { abortableDelay } from "./abort.js";
import { atomicJson, decodeReceiptEnvelope, receiptPath, requestPath, type RequestProtocol } from "./request-wire.js";

const POLL_MS = 100;

export class AkumaBodyRequestError extends Error {
  readonly kind = "akuma-body-request";
  constructor(
    readonly action: string,
    readonly outcome: "refused" | "voided" | "unproven" | "unknown",
    readonly diagnostic: string,
    readonly requestId: string,
  ) {
    super(`${action} ${outcome === "refused" ? "refused" : outcome}: ${diagnostic}`);
    this.name = "AkumaBodyRequestError";
  }
}

function throwVoidedRequestFailure(
  action: string,
  evidence: string,
  failure: unknown | undefined,
  decodeFailure: ((failure: unknown) => Error | null) | undefined,
  requestId: string,
): never {
  const ownerFailure = decodeVoidedOwnerFailure(failure, decodeFailure);
  if (ownerFailure !== null) throw ownerFailure;
  throw new AkumaBodyRequestError(action, "voided", evidence, requestId);
}

function throwUnprovenRequestFailure(action: string, evidence: string, requestId: string): never {
  throw new AkumaBodyRequestError(action, "unproven", evidence, requestId);
}

function decodeVoidedOwnerFailure(
  failure: unknown | undefined,
  decodeFailure: ((failure: unknown) => Error | null) | undefined,
): Error | null {
  if (failure === undefined || decodeFailure === undefined) return null;
  try {
    return decodeFailure(failure);
  } catch {
    return null;
  }
}

function withRequestMetadata<Response extends object>(
  response: Response,
  id: string,
  action: string,
): Response & Readonly<{ requestId: string; action: string }> {
  Object.defineProperties(response, {
    requestId: { value: id, enumerable: false },
    action: { value: action, enumerable: false },
  });
  return response as Response & Readonly<{ requestId: string; action: string }>;
}

type RequestResponse<Output, Reference> =
  | Readonly<{ kind: "returned"; result: Output; requestId: string; action: string }>
  | Readonly<{ kind: "reference"; reference: Reference; requestId: string; action: string }>;

async function readRequestReceipt<Input, Output, Reference>(
  input: Readonly<{ command: RequestProtocol<Input, Output, Reference> }>,
  path: string,
  id: string,
): Promise<RequestResponse<Output, Reference> | undefined> {
  try {
    const receipt = decodeReceiptEnvelope(await readFile(path, "utf8"), id, input.command.action);
    if (receipt === null) throw new Error(`Akuma body request ${id} has an invalid receipt`);
    if (receipt.state === "refused") {
      throw new AkumaBodyRequestError(receipt.action, "refused", receipt.diagnostic, receipt.id);
    }
    if (receipt.state === "voided") {
      throwVoidedRequestFailure(
        receipt.action,
        receipt.evidence,
        receipt.failure,
        input.command.decodeFailure,
        receipt.id,
      );
    }
    if (receipt.state === "unproven") throwUnprovenRequestFailure(receipt.action, receipt.evidence, receipt.id);
    if ("reference" in receipt) {
      let reference: Reference;
      try {
        reference = input.command.decodeReference(receipt.reference);
      } catch (error) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        throw new Error(
          `transport integrity: request ${id} action ${input.command.action} returned an invalid durable reference: ${diagnostic}`,
        );
      }
      return withRequestMetadata({ kind: "reference" as const, reference }, id, input.command.action);
    }
    if (receipt.outcome.kind === "failed") {
      const failure = receipt.outcome.failure;
      throw new Error(failure.kind === "failed" ? failure.diagnostic : `Akuma ${failure.id} was not born`);
    }
    let result: Output;
    try {
      result = input.command.decodeResult(receipt.outcome.result);
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      throw new Error(
        `transport integrity: request ${id} action ${input.command.action} returned an invalid live result: ${diagnostic}`,
      );
    }
    return withRequestMetadata({ kind: "returned" as const, result }, id, input.command.action);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Generic rendezvous only: operation owners supply their own request and result codecs. */
export async function requestBodyCommand<Input, Output, Reference>(
  input: Readonly<{
    directory: string;
    id?: string;
    command: RequestProtocol<Input, Output, Reference>;
    value: Input;
    signal?: AbortSignal;
  }>,
): Promise<RequestResponse<Output, Reference>> {
  const id = input.id ?? randomUUID();
  input.signal?.throwIfAborted();
  const transportId = randomUUID();
  await atomicJson(requestPath(input.directory, transportId), {
    id,
    action: input.command.action,
    payload: input.command.encodeRequest(input.value),
  });
  const path = receiptPath(input.directory, transportId);
  for (;;) {
    const response = await readRequestReceipt(input, path, id);
    if (response !== undefined) return response;
    if (
      !(await access(input.directory).then(
        () => true,
        () => false,
      ))
    ) {
      throw new AkumaBodyRequestError(
        input.command.action,
        "unknown",
        "parent request channel closed before a receipt",
        id,
      );
    }
    await abortableDelay(POLL_MS, input.signal);
  }
}
