import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { abortableDelay } from "./abort.js";
import { atomicJson, decodeReceiptEnvelope, receiptPath, requestPath, type RequestCommand } from "./request-wire.js";

const POLL_MS = 100;

export class AkumaBodyRequestError extends Error {
  readonly kind = "akuma-body-request";
  constructor(
    readonly action: string,
    readonly outcome: "refused" | "voided",
    readonly diagnostic: string,
  ) {
    super(`${action} ${outcome === "voided" ? "failed" : "refused"}: ${diagnostic}`);
    this.name = "AkumaBodyRequestError";
  }
}

/** Generic rendezvous only: operation owners supply their own request and result codecs. */
export async function requestBodyCommand<Input, Output, Service, Reference = Service>(
  input: Readonly<{
    directory: string;
    id?: string;
    command: RequestCommand<Input, Output, Service, Reference>;
    value: Input;
    signal?: AbortSignal;
  }>,
): Promise<
  | Readonly<{ kind: "returned"; result: Output; requestId: string; action: string }>
  | Readonly<{ kind: "reference"; reference: Reference; requestId: string; action: string }>
> {
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
    try {
      const receipt = decodeReceiptEnvelope(await readFile(path, "utf8"), id, input.command.action);
      if (receipt === null) throw new Error(`Akuma body request ${id} has an invalid receipt`);
      if (receipt.state === "refused") throw new AkumaBodyRequestError(receipt.action, "refused", receipt.diagnostic);
      if (receipt.state === "voided") throw new AkumaBodyRequestError(receipt.action, "voided", receipt.evidence);
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
        const response = {
          kind: "reference" as const,
          reference,
        };
        Object.defineProperties(response, {
          requestId: { value: id, enumerable: false },
          action: { value: input.command.action, enumerable: false },
        });
        return response as Readonly<{ kind: "reference"; reference: Reference; requestId: string; action: string }>;
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
      const response = { kind: "returned" as const, result };
      Object.defineProperties(response, {
        requestId: { value: id, enumerable: false },
        action: { value: input.command.action, enumerable: false },
      });
      return response as Readonly<{ kind: "returned"; result: Output; requestId: string; action: string }>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      !(await access(input.directory).then(
        () => true,
        () => false,
      ))
    ) {
      throw new AkumaBodyRequestError(input.command.action, "voided", "parent request channel closed before a receipt");
    }
    await abortableDelay(POLL_MS, input.signal);
  }
}
