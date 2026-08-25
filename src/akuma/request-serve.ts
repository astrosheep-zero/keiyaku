import {
  admitRequest,
  readRequest,
  refuseRequest,
  reserveRequest,
  serveRequest as serveChildRequest,
  serveUpstreamRequest,
  voidRequest,
  type KillEvidence,
  type RequestFact,
  type UpstreamRequestService,
} from "./heart/index.js";
import { worldRootForAkumaPaths, type AkuId } from "./identity.js";
import { publishAkuma } from "./publication.js";
import {
  atomicJson,
  canonicalAkuId,
  decodeRecipe,
  receiptPath,
  type RequestReceipt,
  type StructuralRequestClaim,
  type TaskRequestClaim,
  type UpstreamRequestFailure,
  type UpstreamRequestOutcome,
} from "./request-wire.js";
import { isTaskMutationAction, type TaskMutationRequest } from "../task/mutation.js";
import { executeRequest } from "./request-execution.js";
import {
  BodyRequestPump as LifecycleBodyRequestPump,
  type RequestChildLaunch as LifecycleRequestChildLaunch,
  type PumpInput as LifecyclePumpInput,
} from "./request-lifecycle.js";
export { clearBodyRequestTransport, settleBodyRequests } from "./request-lifecycle.js";

export type RequestChildLaunch = LifecycleRequestChildLaunch;

type UpstreamCall = Readonly<{ signal: AbortSignal }>;
type RequesterCall = UpstreamCall & Readonly<{ requester: AkuId }>;
type ContractCall = RequesterCall & Readonly<{ repoRoot: string; contractId: string }>;
export type UpstreamExecutionPort = Readonly<{
  wait(
    input: UpstreamCall &
      Readonly<{
        targets: readonly AkuId[];
        completion: "any" | "all";
        timeoutMs?: number;
      }>,
  ): Promise<unknown>;
  tell(
    input: UpstreamCall &
      Readonly<{
        target: AkuId;
        body: string;
        tellId: string;
        recordedAt: string;
      }>,
  ): Promise<unknown>;
  kill(input: Readonly<{ targets: readonly AkuId[]; signal: AbortSignal }>): Promise<
    Readonly<{
      result: unknown;
      service: readonly Readonly<{ id: AkuId; evidence: KillEvidence }>[];
    }>
  >;
  deliver(
    input: ContractCall &
      Readonly<{
        message?: string;
        includeDirty: boolean;
        materializeConflict: boolean;
      }>,
  ): Promise<Readonly<{ result: unknown; deliveryFactId?: string }>>;
  review(
    input: ContractCall &
      Readonly<{
        verdict: "satisfied" | "unsatisfied";
        summary?: string;
      }>,
  ): Promise<Readonly<{ result: unknown; reviewFactId?: string }>>;
  task(
    input: RequesterCall &
      Readonly<{
        world: string;
        request: TaskMutationRequest;
      }>,
  ): Promise<unknown>;
}>;

type PumpInput = Omit<LifecyclePumpInput, "upstream"> & Readonly<{ upstream?: UpstreamExecutionPort }>;
export type ServeInput = Omit<PumpInput, "bodySequence"> &
  Readonly<{
    directory: string;
    transportId: string;
    claim: StructuralRequestClaim;
    admissionOpen(): boolean;
  }>;
export type UpstreamFact = Exclude<
  Extract<RequestFact, { state: "admitted" }>,
  Extract<RequestFact, { action: "akuma.call" }>
>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTask(value: Readonly<{ action: string }>): value is TaskRequestClaim {
  return isTaskMutationAction(value.action);
}

function acceptedReceipt(
  fact: Extract<RequestFact, { state: "served" }>,
  service: Extract<
    UpstreamRequestService,
    {
      action: "contract.deliver" | "contract.review";
    }
  >,
): RequestReceipt {
  return {
    id: fact.id,
    action: fact.action as "contract.deliver" | "contract.review",
    state: fact.state,
    reference:
      service.action === "contract.deliver"
        ? {
            kind: "accepted-reference",
            repoRoot: service.repoRoot,
            contractId: service.contractId,
            deliveryFactId: service.deliveryFactId,
          }
        : {
            kind: "accepted-reference",
            repoRoot: service.repoRoot,
            contractId: service.contractId,
            reviewFactId: service.reviewFactId,
          },
  } as RequestReceipt;
}

function receiptFor(fact: RequestFact): RequestReceipt | null {
  if (fact.state === "refused") {
    return { id: fact.id, action: fact.action, state: fact.state, diagnostic: fact.diagnostic };
  }
  if (fact.state === "voided") {
    return { id: fact.id, action: fact.action, state: fact.state, evidence: fact.evidence };
  }
  if (fact.action === "akuma.call" && fact.state === "served") {
    return { id: fact.id, action: fact.action, state: fact.state, child: fact.child };
  }
  if (fact.state !== "served") return null;
  if (fact.action === "contract.deliver") {
    return acceptedReceipt(fact, fact.service as Extract<UpstreamRequestService, { action: "contract.deliver" }>);
  }
  if (fact.action === "contract.review") {
    return acceptedReceipt(fact, fact.service as Extract<UpstreamRequestService, { action: "contract.review" }>);
  }
  if (isTask(fact)) {
    return {
      id: fact.id,
      action: fact.action,
      state: fact.state,
      reference: { kind: "served-reference", action: fact.action },
    };
  }
  return null;
}

async function projectReceipt(
  directory: string,
  transportId: string,
  fact: RequestFact,
  outcome?: UpstreamRequestOutcome,
): Promise<void> {
  const receipt =
    outcome === undefined
      ? receiptFor(fact)
      : fact.action === "akuma.call"
        ? null
        : { id: fact.id, action: fact.action, state: "served" as const, outcome };
  if (receipt === null) return;
  try {
    await atomicJson(receiptPath(directory, transportId), receipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function serveCall(
  input: ServeInput &
    Readonly<{
      claim: Extract<StructuralRequestClaim, { action: "akuma.call" }>;
    }>,
): Promise<void> {
  input.signal.throwIfAborted();
  if (!input.admissionOpen()) return;
  const recipe = decodeRecipe(input.claim.recipe);
  if (recipe === null) return;
  let fact = await admitRequest(input.paths, { ...input.claim, recipe, admittedAt: input.now() } as never);
  const existing = receiptFor(fact);
  if (existing !== null) {
    await projectReceipt(input.directory, input.transportId, fact);
    return;
  }
  if (!input.admissionOpen()) {
    fact = await voidRequest(input.paths, input.claim.id, "body closed request admission");
    await projectReceipt(input.directory, input.transportId, fact);
    return;
  }
  if (fact.action !== "akuma.call" || fact.state !== "admitted") {
    throw new Error(`Akuma request ${fact.id} cannot be replayed from ${fact.state}`);
  }
  const request = fact;
  const world = worldRootForAkumaPaths(input.paths);
  if (request.world !== world) {
    fact = await refuseRequest(input.paths, request.id, `request world ${request.world} does not match ${world}`);
    await projectReceipt(input.directory, input.transportId, fact);
    return;
  }
  try {
    const published = await publishAkuma({
      worldPath: world,
      archetype: request.archetype,
      signal: input.signal,
      launch: async (allocated) => {
        if (!input.admissionOpen()) throw new Error("body closed request admission");
        fact = await reserveRequest(input.paths, request.id, allocated.id);
        return await input.spawn({
          paths: allocated.paths,
          seed: {
            id: allocated.id,
            archetype: allocated.archetype,
            ...(request.recipe.description === undefined ? {} : { description: request.recipe.description }),
            provider: request.recipe.provider,
            options: request.recipe.options,
            ...(request.recipe.readonly === undefined ? {} : { readonly: request.recipe.readonly }),
            allowed: request.recipe.allowed,
            cwd: request.cwd ?? input.parent.cwd,
            origin: {
              kind: "request",
              parent: input.parent.id,
              requestId: request.id,
            },
          },
          initialBody: request.body,
        });
      },
    });
    fact = await serveChildRequest(input.paths, request.id, published.id);
  } catch (error) {
    const current = await readRequest(input.paths, request.id);
    if (current === null) throw error;
    fact =
      current.state === "admitted" || current.state === "reserved"
        ? await voidRequest(input.paths, request.id, diagnostic(error))
        : current;
  }
  await projectReceipt(input.directory, input.transportId, fact);
}

function failure(error: unknown): UpstreamRequestFailure {
  const value = error !== null && typeof error === "object" ? (error as Readonly<Record<string, unknown>>) : null;
  if (value?.kind === "akuma-not-born") {
    const id = canonicalAkuId(value.id);
    if (id !== null) return { kind: "akuma-not-born", id };
  }
  return { kind: "failed", diagnostic: diagnostic(error) };
}

function pendingService(request: UpstreamFact): UpstreamRequestService | undefined {
  if (request.action === "akuma.wait") return { action: request.action };
  if (request.action === "akuma.tell") {
    return { action: request.action, target: request.target, tellId: request.id };
  }
  return request.action === "akuma.kill" ? { action: request.action, results: [] } : undefined;
}

async function serveUpstream(
  input: ServeInput &
    Readonly<{
      claim: Exclude<StructuralRequestClaim, { action: "akuma.call" }>;
    }>,
): Promise<void> {
  input.signal.throwIfAborted();
  let fact = await admitRequest(input.paths, {
    ...input.claim,
    admittedAt: input.now(),
  } as never);
  const existing = receiptFor(fact);
  if (existing !== null) {
    await projectReceipt(input.directory, input.transportId, fact);
    return;
  }
  if (fact.state === "served") {
    await projectReceipt(input.directory, input.transportId, fact, {
      kind: "failed",
      failure: {
        kind: "failed",
        diagnostic: "served request receipt is no longer available",
      },
    });
    return;
  }
  if (!input.admissionOpen()) {
    fact = await voidRequest(input.paths, input.claim.id, "body closed request admission");
    await projectReceipt(input.directory, input.transportId, fact);
    return;
  }
  if (fact.state !== "admitted" || fact.action === "akuma.call") {
    throw new Error(`Akuma request ${fact.id} cannot be served from ${fact.state}`);
  }
  const request = fact as UpstreamFact;
  let outcome: UpstreamRequestOutcome;
  let service = pendingService(request);
  try {
    const served = await executeRequest(input, request);
    outcome = { kind: "returned", result: served.result };
    if (served.service !== undefined) service = served.service;
  } catch (error) {
    outcome = { kind: "failed", failure: failure(error) };
    fact = await voidRequest(input.paths, request.id, "body failed before serving the request");
    await projectReceipt(input.directory, input.transportId, fact);
    return;
  }
  fact =
    service === undefined
      ? await voidRequest(input.paths, request.id, "body completed without a durable Contract fact reference")
      : await serveUpstreamRequest(input.paths, request.id, service);
  await projectReceipt(input.directory, input.transportId, fact, outcome);
}

export async function serveRequest(input: ServeInput): Promise<void> {
  return input.claim.action === "akuma.call"
    ? await serveCall({ ...input, claim: input.claim })
    : await serveUpstream({ ...input, claim: input.claim });
}

export class BodyRequestPump extends LifecycleBodyRequestPump {
  static async open(input: PumpInput): Promise<BodyRequestPump> {
    return (await LifecycleBodyRequestPump.openWithService(
      input as LifecyclePumpInput,
      async (claim) => await serveRequest(claim as ServeInput),
    )) as BodyRequestPump;
  }
}
