import {
  admitRequest,
  beginRequest,
  isRequestInputConflict,
  readRequest,
  serveRequest as serveChildRequest,
  serveUpstreamRequest,
  voidRequest,
  unproveRequest,
  type RequestFact,
} from "./heart/index.js";
import {
  atomicJson,
  receiptPath,
  type ErasedRequestCommand,
  type ExecutionFacts,
  type RequestEnvelope,
} from "./request-wire.js";
import {
  BodyRequestPump as LifecycleBodyRequestPump,
  type PumpInput as LifecyclePumpInput,
} from "./request-lifecycle.js";
export { clearBodyRequestTransport, settleBodyRequests } from "./request-lifecycle.js";

type PumpInput = LifecyclePumpInput & Readonly<{ commands: Readonly<Record<string, ErasedRequestCommand>> }>;
export type ServeInput = Omit<PumpInput, "bodySequence"> &
  Readonly<{
    directory: string;
    transportId: string;
    claim: RequestEnvelope;
    admissionOpen(): boolean;
  }>;

type ResolvedRequest = Readonly<{
  payloadJson: string;
  isPermitted(allowed: readonly string[]): boolean;
  encodeFailure(error: unknown): unknown | null;
}>;

type ExecutedRequest = Readonly<{
  fact: RequestFact;
  outcome: Readonly<{ kind: "returned"; result: unknown }>;
}>;

type ExecuteRequest = (
  fact: Extract<RequestFact, { state: "admitted" }>,
  facts: ExecutionFacts,
) => Promise<ExecutedRequest>;

function replayReference(fact: RequestFact, command: ErasedRequestCommand): unknown {
  if (fact.state !== "served") {
    throw new Error(`request ${fact.id} completion corruption: cannot replay ${fact.state} request`);
  }
  switch (command.completion) {
    case "child":
      if (!("child" in fact)) {
        throw new Error(`request ${fact.id} completion corruption: child command has a service settlement`);
      }
      return command.projectChild(fact.child);
    case "service":
      if (!("serviceJson" in fact)) {
        throw new Error(`request ${fact.id} completion corruption: service command has a child settlement`);
      }
      return command.projectServiceJson(fact.serviceJson);
  }
}

async function projectCommandReceipt(
  input: ServeInput,
  fact: RequestFact,
  command: ErasedRequestCommand,
  outcome?: Readonly<{ kind: "returned"; result: unknown }>,
  failure?: unknown,
): Promise<void> {
  const receipt =
    fact.state === "refused"
      ? { id: fact.id, action: fact.action, state: "refused" as const, diagnostic: fact.diagnostic }
      : fact.state === "voided"
        ? {
            id: fact.id,
            action: fact.action,
            state: "voided" as const,
            evidence: fact.evidence,
            ...(failure === undefined ? {} : { failure }),
          }
        : fact.state === "unproven"
          ? {
              id: fact.id,
              action: fact.action,
              state: "unproven" as const,
              evidence: fact.evidence,
              ...(failure === undefined ? {} : { failure }),
            }
          : outcome === undefined
            ? {
                id: fact.id,
                action: fact.action,
                state: "served" as const,
                reference: replayReference(fact, command),
              }
            : { id: fact.id, action: fact.action, state: "served" as const, outcome };
  try {
    await atomicJson(receiptPath(input.directory, input.transportId), receipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function serveResolvedCommand(
  input: ServeInput,
  command: ErasedRequestCommand,
  request: ResolvedRequest,
  execute: ExecuteRequest,
): Promise<boolean> {
  let fact = await admitRequest(input.paths, {
    id: input.claim.id,
    action: input.claim.action,
    payloadJson: request.payloadJson,
    admittedAt: input.now(),
    permitted: request.isPermitted(input.allowed),
  });
  if (fact.state !== "admitted") {
    await projectCommandReceipt(input, fact, command);
    return true;
  }
  if (!input.admissionOpen()) {
    fact = await voidRequest(input.paths, fact.id, "body closed request admission");
    await projectCommandReceipt(input, fact, command);
    return true;
  }
  try {
    const facts: ExecutionFacts = {
      id: fact.id,
      admittedAt: fact.admittedAt,
      requester: fact.requester,
      signal: input.signal,
      admissionOpen: input.admissionOpen,
    };
    const served = await execute(fact, facts);
    fact = served.fact;
    await projectCommandReceipt(input, fact, command, served.outcome);
  } catch (error) {
    const failure = encodedFailure(request, error);
    const current = await readRequest(input.paths, fact.id);
    if (current === null) throw error;
    fact =
      current.state === "admitted" || current.state === "reserved"
        ? await voidRequest(input.paths, fact.id, diagnostic(error))
        : current.state === "begun"
          ? provesNoProductEffect(failure)
            ? await voidRequest(input.paths, fact.id, diagnostic(error))
            : await unproveRequest(input.paths, fact.id, diagnostic(error))
          : current;
    await projectCommandReceipt(input, fact, command, undefined, failure);
  }
  return true;
}

async function serveChildCommand(
  input: ServeInput,
  command: Extract<ErasedRequestCommand, { completion: "child" }>,
): Promise<boolean> {
  const request = command.resolve(input.claim.payload);
  if (request === null) throw new Error(`registered request action ${input.claim.action} rejected its payload`);
  return await serveResolvedCommand(input, command, request, async (fact, facts) => {
    const served = await request.execute(facts);
    return {
      fact: await serveChildRequest(input.paths, fact.id, served.child),
      outcome: { kind: "returned", result: served.result },
    };
  });
}

async function serveServiceCommand(
  input: ServeInput,
  command: Extract<ErasedRequestCommand, { completion: "service" }>,
): Promise<boolean> {
  const request = command.resolve(input.claim.payload);
  if (request === null) throw new Error(`registered request action ${input.claim.action} rejected its payload`);
  return await serveResolvedCommand(input, command, request, async (fact, facts) => {
    await beginRequest(input.paths, fact.id);
    const served = await request.execute(facts);
    return {
      fact: await serveUpstreamRequest(input.paths, fact.id, served.serviceJson),
      outcome: { kind: "returned", result: served.result },
    };
  });
}

async function serveCommand(input: ServeInput, command: ErasedRequestCommand): Promise<boolean> {
  switch (command.completion) {
    case "child":
      return await serveChildCommand(input, command);
    case "service":
      return await serveServiceCommand(input, command);
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodedFailure(
  request: Readonly<{ encodeFailure(error: unknown): unknown | null }>,
  error: unknown,
): unknown | undefined {
  try {
    const failure = request.encodeFailure(error);
    return failure === null ? undefined : failure;
  } catch {
    return undefined;
  }
}

function provesNoProductEffect(failure: unknown): boolean {
  return failure !== null && typeof failure === "object" && (failure as { kind?: unknown }).kind === "refused";
}

export async function serveRequest(input: ServeInput): Promise<boolean> {
  const command = input.commands[input.claim.action];
  if (command === undefined) {
    await atomicJson(receiptPath(input.directory, input.transportId), {
      id: input.claim.id,
      action: input.claim.action,
      state: "refused",
      diagnostic: `request action ${input.claim.action} is not registered`,
    });
    return true;
  }
  return await serveCommand(input, command);
}

async function serveTransportClaim(input: ServeInput): Promise<boolean> {
  try {
    return await serveRequest(input);
  } catch (error) {
    if (!isRequestInputConflict(error)) throw error;
    await atomicJson(receiptPath(input.directory, input.transportId), {
      id: input.claim.id,
      action: input.claim.action,
      state: "refused",
      diagnostic: error.message,
    });
    return true;
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
