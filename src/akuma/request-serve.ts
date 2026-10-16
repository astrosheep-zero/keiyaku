import {
  admitRequest,
  beginRequest,
  isRequestInputConflict,
  readHeart,
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
import { observeRequestCancellation, publishRequestProgress } from "./request-observation.js";
import {
  BodyRequestPump as LifecycleBodyRequestPump,
  settleReserved,
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
  supportsCancellation: boolean;
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
  const identity = { id: fact.id, action: fact.action };
  const receipt =
    fact.state === "refused"
      ? { ...identity, state: fact.state, diagnostic: fact.diagnostic }
      : fact.state === "voided" || fact.state === "unproven"
        ? {
            ...identity,
            state: fact.state,
            evidence: fact.evidence,
            ...(failure === undefined ? {} : { failure }),
            ...(fact.state === "voided" && outcome !== undefined ? { outcome: outcome.result } : {}),
          }
        : {
            ...identity,
            state: "served",
            ...(outcome === undefined ? { reference: replayReference(fact, command) } : { outcome }),
          };
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
): Promise<void> {
  let fact = await admitRequest(input.paths, {
    id: input.claim.id,
    action: input.claim.action,
    payloadJson: request.payloadJson,
    admittedAt: input.now(),
    permitted: request.isPermitted(input.allowed),
  });
  if (fact.state === "admitted" && !input.admissionOpen()) {
    fact = await voidRequest(input.paths, fact.id, "body closed request admission");
  }
  if (fact.state !== "admitted") {
    await projectCommandReceipt(input, fact, command);
    return;
  }
  const observation = {
    directory: input.directory,
    transportId: input.transportId,
    id: fact.id,
    action: fact.action,
  };
  const progress = publishRequestProgress(observation);
  const cancellation =
    command.completion === "service" && request.supportsCancellation
      ? observeRequestCancellation(observation)
      : undefined;
  let outcome: ExecutedRequest["outcome"] | undefined;
  let failure: unknown;
  try {
    const served = await execute(fact, {
      id: fact.id,
      admittedAt: fact.admittedAt,
      requester: fact.requester,
      signal: cancellation === undefined ? input.signal : AbortSignal.any([input.signal, cancellation.signal]),
      admissionOpen: input.admissionOpen,
      progress: progress.progress,
    });
    fact = served.fact;
    outcome = served.outcome;
  } catch (error) {
    failure = encodedFailure(request, error);
    const current = await readRequest(input.paths, fact.id);
    if (current === null) throw error;
    if (current.state === "reserved") {
      const parent = (await readHeart(input.paths)).soul;
      if (parent === null) throw new Error("reserved request settlement requires a born parent Soul");
      if (!(await settleReserved(input.paths, parent, current, input.now, input.signal))) return;
      fact = (await readRequest(input.paths, fact.id)) ?? current;
    } else {
      fact =
        current.state === "admitted"
          ? await voidRequest(input.paths, fact.id, diagnostic(error))
          : current.state === "begun"
            ? provesNoProductEffect(failure)
              ? await voidRequest(input.paths, fact.id, diagnostic(error))
              : await unproveRequest(input.paths, fact.id, diagnostic(error))
            : current;
    }
  } finally {
    try {
      await progress.close();
    } finally {
      await cancellation?.close();
    }
  }
  // Transport failure cannot re-enter execution settlement.
  await projectCommandReceipt(input, fact, command, outcome, failure);
}

async function serveCommand(input: ServeInput, command: ErasedRequestCommand): Promise<void> {
  const { completion, request } =
    command.completion === "child"
      ? { completion: "child" as const, request: command.resolve(input.claim.payload) }
      : { completion: "service" as const, request: command.resolve(input.claim.payload) };
  if (request === null) throw new Error(`registered request action ${input.claim.action} rejected its payload`);
  return await serveResolvedCommand(input, command, request, async (fact, facts) => {
    if (completion === "child") {
      const served = await request.execute(facts);
      return {
        fact: await serveChildRequest(input.paths, fact.id, served.child),
        outcome: { kind: "returned", result: served.result },
      };
    }
    await beginRequest(input.paths, fact.id);
    const served = await request.execute(facts);
    return served.kind === "voided"
      ? {
          fact: await voidRequest(input.paths, fact.id, "returned owner outcome was voided"),
          outcome: { kind: "returned", result: served.outcome },
        }
      : {
          fact: await serveUpstreamRequest(input.paths, fact.id, served.serviceJson),
          outcome: { kind: "returned", result: served.result },
        };
  });
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

export async function serveRequest(input: ServeInput): Promise<void> {
  const command = input.commands[input.claim.action];
  let diagnostic = `request action ${input.claim.action} is not registered`;
  if (command !== undefined) {
    try {
      return await serveCommand(input, command);
    } catch (error) {
      if (!isRequestInputConflict(error)) throw error;
      diagnostic = error.message;
    }
  }
  await atomicJson(receiptPath(input.directory, input.transportId), {
    id: input.claim.id,
    action: input.claim.action,
    state: "refused",
    diagnostic,
  });
}

export class BodyRequestPump extends LifecycleBodyRequestPump {
  static async open(input: PumpInput): Promise<BodyRequestPump> {
    return (await LifecycleBodyRequestPump.openWithService(
      input as LifecyclePumpInput,
      async (claim) => await serveRequest({ ...claim, commands: input.commands }),
    )) as BodyRequestPump;
  }
}
