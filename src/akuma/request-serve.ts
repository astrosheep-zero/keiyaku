import {
  admitRequest,
  isRequestInputConflict,
  readRequest,
  serveRequest as serveChildRequest,
  serveUpstreamRequest,
  voidRequest,
  type RequestFact,
} from "./heart/index.js";
import {
  atomicJson,
  receiptPath,
  type ErasedRequest,
  type ErasedRequestCommand,
  type RequestEnvelope,
} from "./request-wire.js";
import {
  BodyRequestPump as LifecycleBodyRequestPump,
  type PumpInput as LifecyclePumpInput,
} from "./request-lifecycle.js";
export { clearBodyRequestTransport, settleBodyRequests } from "./request-lifecycle.js";

type PumpInput = Omit<LifecyclePumpInput, "upstream"> &
  Readonly<{ upstream?: unknown; commands: Readonly<Record<string, ErasedRequestCommand>> }>;
export type ServeInput = Omit<PumpInput, "bodySequence"> &
  Readonly<{
    directory: string;
    transportId: string;
    claim: RequestEnvelope;
    admissionOpen(): boolean;
  }>;
async function projectCommandReceipt(
  input: ServeInput,
  fact: RequestFact,
  command: ErasedRequest,
  outcome?: Readonly<{ kind: "returned"; result: unknown }>,
): Promise<void> {
  const receipt =
    fact.state === "refused"
      ? { id: fact.id, action: fact.action, state: "refused" as const, diagnostic: fact.diagnostic }
      : fact.state === "voided"
        ? { id: fact.id, action: fact.action, state: "voided" as const, evidence: fact.evidence }
        : outcome === undefined
          ? "serviceJson" in fact
            ? {
                id: fact.id,
                action: fact.action,
                state: "served" as const,
                reference: command.projectServiceJson(fact.serviceJson),
              }
            : "child" in fact
              ? {
                  id: fact.id,
                  action: fact.action,
                  state: "served" as const,
                  reference: command.projectChild(fact.child),
                }
              : null
          : { id: fact.id, action: fact.action, state: "served" as const, outcome };
  if (receipt === null) return;
  try {
    await atomicJson(receiptPath(input.directory, input.transportId), receipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function serveCommand(input: ServeInput, command: ErasedRequestCommand): Promise<boolean> {
  const request = command.resolve(input.claim.payload);
  if (request === null) return false;
  let fact = await admitRequest(input.paths, {
    id: input.claim.id,
    action: input.claim.action,
    payloadJson: request.payloadJson,
    admittedAt: input.now(),
    permitted: request.isPermitted(input.parent.allowed),
  });
  if (fact.state !== "admitted") {
    await projectCommandReceipt(input, fact, request);
    return true;
  }
  if (!input.admissionOpen()) {
    fact = await voidRequest(input.paths, fact.id, "body closed request admission");
    await projectCommandReceipt(input, fact, request);
    return true;
  }
  try {
    const served = await request.execute({
      id: fact.id,
      admittedAt: fact.admittedAt,
      requester: fact.requester,
      signal: input.signal,
      upstream: input.upstream,
      paths: input.paths,
      parent: input.parent,
      spawn: input.spawn,
      admissionOpen: input.admissionOpen,
    });
    fact =
      "child" in served
        ? await serveChildRequest(input.paths, fact.id, served.child)
        : await serveUpstreamRequest(input.paths, fact.id, served.serviceJson);
    await projectCommandReceipt(input, fact, request, { kind: "returned", result: served.result });
  } catch (error) {
    const current = await readRequest(input.paths, fact.id);
    if (current === null) throw error;
    fact =
      current.state === "admitted" || current.state === "reserved"
        ? await voidRequest(input.paths, fact.id, diagnostic(error))
        : current;
    await projectCommandReceipt(input, fact, request);
  }
  return true;
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function serveRequest(input: ServeInput): Promise<void> {
  const command = input.commands[input.claim.action];
  if (command === undefined) {
    await atomicJson(receiptPath(input.directory, input.transportId), {
      id: input.claim.id,
      action: input.claim.action,
      state: "refused",
      diagnostic: `request action ${input.claim.action} is not registered`,
    });
    return;
  }
  if (await serveCommand(input, command)) return;
}

async function serveTransportClaim(input: ServeInput): Promise<void> {
  try {
    await serveRequest(input);
  } catch (error) {
    if (!isRequestInputConflict(error)) throw error;
    await atomicJson(receiptPath(input.directory, input.transportId), {
      id: input.claim.id,
      action: input.claim.action,
      state: "refused",
      diagnostic: error.message,
    });
  }
}

export class BodyRequestPump extends LifecycleBodyRequestPump {
  static async open(input: PumpInput): Promise<BodyRequestPump> {
    return (await LifecycleBodyRequestPump.openWithService(
      input as LifecyclePumpInput,
      async (claim) => await serveTransportClaim({ ...claim, commands: input.commands }),
    )) as BodyRequestPump;
  }
}
