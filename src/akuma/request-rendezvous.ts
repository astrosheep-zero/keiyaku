import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { abortableDelay } from "./abort.js";
import {
  publishRequestCancellation,
  readRequestProgress,
  type RequestProgressSnapshot,
} from "./request-observation.js";
import { atomicJson, decodeReceiptEnvelope, receiptPath, requestPath, type RequestProtocol } from "./request-wire.js";

const POLL_MS = 100;

export class AkumaBodyRequestError extends Error {
  readonly kind = "akuma-body-request";
  constructor(
    readonly action: string,
    readonly outcome: "refused" | "voided" | "unproven" | "unknown",
    readonly diagnostic: string,
    readonly requestId: string,
    options?: ErrorOptions,
  ) {
    super(`${action} ${outcome === "refused" ? "refused" : outcome}: ${diagnostic}`, options);
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
  const ownerFailure = decodeOwnerFailure(failure, decodeFailure);
  if (ownerFailure !== null) throw withRequestMetadata(ownerFailure, requestId, action);
  throw new AkumaBodyRequestError(action, "voided", evidence, requestId);
}

function throwUnprovenRequestFailure(
  action: string,
  evidence: string,
  requestId: string,
  ownerFailure: Error | null,
): never {
  throw new AkumaBodyRequestError(
    action,
    "unproven",
    evidence,
    requestId,
    ownerFailure === null ? undefined : { cause: ownerFailure },
  );
}

function decodeOwnerFailure(
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

type RequestCommandInput<Input, Output, Reference> = Readonly<{
  directory: string;
  id?: string;
  command: RequestProtocol<Input, Output, Reference>;
  value: Input;
  signal?: AbortSignal;
  onProgress?(value: unknown): void;
  onProgressGap?(dropped: number): void;
}>;

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
    if (receipt.state === "unproven") {
      throwUnprovenRequestFailure(
        receipt.action,
        receipt.evidence,
        receipt.id,
        decodeOwnerFailure(receipt.failure, input.command.decodeFailure),
      );
    }
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
  input: RequestCommandInput<Input, Output, Reference>,
): Promise<RequestResponse<Output, Reference>> {
  const id = input.id ?? randomUUID();
  input.signal?.throwIfAborted();
  const transportId = randomUUID();
  const payload = input.command.encodeRequest(input.value);
  try {
    await atomicJson(
      requestPath(input.directory, transportId),
      {
        id,
        action: input.command.action,
        payload,
      },
      input.signal,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (input.signal?.aborted) input.signal.throwIfAborted();
    throw new AkumaBodyRequestError(
      input.command.action,
      "unknown",
      "parent request channel closed before request publication",
      id,
    );
  }
  const path = receiptPath(input.directory, transportId);
  return await observePublishedRequest(input, id, transportId, path);
}

async function observePublishedRequest<Input, Output, Reference>(
  input: RequestCommandInput<Input, Output, Reference>,
  id: string,
  transportId: string,
  path: string,
): Promise<RequestResponse<Output, Reference>> {
  let observedSequence = 0;
  const consumeProgress = async (): Promise<void> => {
    const snapshot = await readRequestProgress({
      directory: input.directory,
      transportId,
      id,
      action: input.command.action,
    });
    observedSequence = consumeSnapshot(snapshot, observedSequence, input.onProgress, input.onProgressGap);
  };
  const publishCancellation = (): void => {
    void publishRequestCancellation({ directory: input.directory, transportId, id, action: input.command.action });
  };
  const cancellable = input.command.supportsCancellation === true;
  if (cancellable && input.signal !== undefined) {
    input.signal.addEventListener("abort", publishCancellation, { once: true });
    if (input.signal.aborted) publishCancellation();
  }
  try {
    for (;;) {
      // The service flushes this bounded snapshot before its receipt, including fast commands.
      await consumeProgress();
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
      try {
        await abortableDelay(POLL_MS, cancellable ? undefined : input.signal);
      } catch (error) {
        if (input.signal?.aborted) {
          throw new AkumaBodyRequestError(
            input.command.action,
            "unknown",
            "request was cancelled after publication and before a receipt",
            id,
          );
        }
        throw error;
      }
    }
  } finally {
    if (cancellable && input.signal !== undefined) input.signal.removeEventListener("abort", publishCancellation);
  }
}

function consumeSnapshot(
  snapshot: RequestProgressSnapshot | undefined,
  observedSequence: number,
  onProgress: ((value: unknown) => void) | undefined,
  onProgressGap: ((dropped: number) => void) | undefined,
): number {
  if (snapshot === undefined) return observedSequence;
  const events = snapshot.events.filter((event) => event.sequence > observedSequence);
  const latestSequence = snapshot.nextSequence - 1;
  const firstAvailable = events[0]?.sequence ?? latestSequence + 1;
  const gap = firstAvailable - observedSequence - 1;
  if (gap > 0) {
    notifyObserver(onProgressGap, gap);
  }
  if (events.length === 0) return Math.max(observedSequence, latestSequence);
  for (const event of events) {
    observedSequence = event.sequence;
    notifyObserver(onProgress, event.value);
  }
  return observedSequence;
}

function notifyObserver<Value>(observer: ((value: Value) => void) | undefined, value: Value): void {
  if (observer === undefined) return;
  try {
    void Promise.resolve(observer(value)).catch(() => {
      // A caller observation failure cannot affect its in-flight request.
    });
  } catch {
    // A caller observation failure cannot affect its in-flight request.
  }
}
