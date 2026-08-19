import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { abortableDelay } from "./abort.js";
import {
  HeldAkumaLeash,
  admitRequest,
  readNonterminalRequests,
  readRequest,
  readSoul,
  refuseRequest,
  reserveRequest,
  serveRequest,
  serveUpstreamRequest,
  voidRequest,
  type KillEvidence,
  type RequestFact,
  type Soul,
  type UpstreamRequestService,
} from "./heart/index.js";
import {
  pathsForAkuId,
  worldRootForAkumaPaths,
  type AkuId,
  type AkumaPaths,
} from "./identity.js";
import { BIRTH_TIMEOUT_MS, publishAkuma } from "./publication.js";
import {
  atomicJson,
  canonicalAkuId,
  decodeClaim,
  decodeRecipe,
  receiptPath,
  type RequestReceipt,
  type StructuralRequestClaim,
  type TaskRequestClaim,
  type UpstreamRequestFailure,
  type UpstreamRequestOutcome,
} from "./request-wire.js";
import { isTaskMutationAction, type TaskMutationRequest } from "../task/mutation.js";

const POLL_MS = 25;

export type RequestChildLaunch = Readonly<{
  paths: AkumaPaths;
  seed: Omit<Soul, "createdAt">;
  initialBody: string;
}>;

type UpstreamCall = Readonly<{ signal: AbortSignal }>;
type RequesterCall = UpstreamCall & Readonly<{ requester: AkuId }>;
type ContractCall = RequesterCall & Readonly<{ repoRoot: string; contractId: string }>;
export type UpstreamExecutionPort = Readonly<{
  wait(input: UpstreamCall & Readonly<{
    targets: readonly AkuId[]; completion: "any" | "all"; timeoutMs?: number;
  }>): Promise<unknown>;
  tell(input: UpstreamCall & Readonly<{
    target: AkuId; body: string; tellId: string; recordedAt: string;
  }>): Promise<unknown>;
  kill(input: Readonly<{ targets: readonly AkuId[]; signal: AbortSignal }>): Promise<Readonly<{
    result: unknown; service: readonly Readonly<{ id: AkuId; evidence: KillEvidence }>[];
  }>>;
  deliver(input: ContractCall & Readonly<{
    message?: string; includeDirty: boolean;
  }>): Promise<Readonly<{ result: unknown; deliveryFactId?: string }>>;
  review(input: ContractCall & Readonly<{
    verdict: "satisfied" | "unsatisfied"; summary?: string;
  }>): Promise<Readonly<{ result: unknown; reviewFactId?: string }>>;
  task(input: RequesterCall & Readonly<{
    world: string; request: TaskMutationRequest;
  }>): Promise<unknown>;
}>;

type PumpInput = Readonly<{
  paths: AkumaPaths; parent: Soul; bodySequence: number; now(): string;
  spawn(launch: RequestChildLaunch): Promise<void>;
  upstream?: UpstreamExecutionPort; signal: AbortSignal;
}>;
type ServeInput = Omit<PumpInput, "bodySequence"> & Readonly<{
  directory: string; claim: StructuralRequestClaim;
  admissionOpen(): boolean;
}>;
type UpstreamFact = Exclude<
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
  service: Extract<UpstreamRequestService, {
    action: "contract.deliver" | "contract.review";
  }>,
): RequestReceipt {
  return {
    id: fact.id,
    action: fact.action as "contract.deliver" | "contract.review",
    state: fact.state,
    reference: service.action === "contract.deliver"
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
    return acceptedReceipt(fact, fact.service as Extract<
      UpstreamRequestService,
      { action: "contract.deliver" }
    >);
  }
  if (fact.action === "contract.review") {
    return acceptedReceipt(fact, fact.service as Extract<
      UpstreamRequestService,
      { action: "contract.review" }
    >);
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
  fact: RequestFact,
  outcome?: UpstreamRequestOutcome,
): Promise<void> {
  const receipt = outcome === undefined
    ? receiptFor(fact)
    : fact.action === "akuma.call"
      ? null
      : { id: fact.id, action: fact.action, state: "served" as const, outcome };
  if (receipt === null) return;
  try {
    await atomicJson(receiptPath(directory, fact.id), receipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function serveCall(
  input: ServeInput & Readonly<{
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
    await projectReceipt(input.directory, fact);
    return;
  }
  if (!input.admissionOpen()) {
    fact = await voidRequest(input.paths, input.claim.id, "body closed request admission");
    await projectReceipt(input.directory, fact);
    return;
  }
  if (fact.action !== "akuma.call" || fact.state !== "admitted") {
    throw new Error(`Akuma request ${fact.id} cannot be replayed from ${fact.state}`);
  }
  const request = fact;
  const world = worldRootForAkumaPaths(input.paths);
  if (request.world !== world) {
    fact = await refuseRequest(input.paths, request.id, `request world ${request.world} does not match ${world}`);
    await projectReceipt(input.directory, fact);
    return;
  }
  try {
    const published = await publishAkuma({
      worldPath: world,
      archetype: request.archetype,
      signal: input.signal,
      reserve: async (allocated) => {
        if (!input.admissionOpen()) throw new Error("body closed request admission");
        fact = await reserveRequest(input.paths, request.id, allocated.id);
      },
      launch: async (allocated) => {
        if (!input.admissionOpen()) throw new Error("body closed request admission");
        await input.spawn({
          paths: allocated.paths,
          seed: {
            id: allocated.id,
            archetype: allocated.archetype,
            ...(request.recipe.description === undefined
              ? {}
              : { description: request.recipe.description }),
            provider: request.recipe.provider,
            options: request.recipe.options,
            ...(request.recipe.readonly === undefined
              ? {}
              : { readonly: request.recipe.readonly }),
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
    fact = await serveRequest(input.paths, request.id, published.id);
  } catch (error) {
    const current = await readRequest(input.paths, request.id);
    if (current === null) throw error;
    fact = current.state === "admitted" || current.state === "reserved"
      ? await voidRequest(input.paths, request.id, diagnostic(error))
      : current;
  }
  await projectReceipt(input.directory, fact);
}

function failure(error: unknown): UpstreamRequestFailure {
  const value = error !== null && typeof error === "object" ? error as Readonly<Record<string, unknown>> : null;
  if (value?.kind === "akuma-not-born") {
    const id = canonicalAkuId(value.id);
    if (id !== null) return { kind: "akuma-not-born", id };
  }
  return { kind: "failed", diagnostic: diagnostic(error) };
}

async function execute(
  input: ServeInput,
  request: UpstreamFact,
): Promise<Readonly<{ result: unknown; service?: UpstreamRequestService }>> {
  if (input.upstream === undefined) throw new Error("upstream execution port is unavailable");
  if (request.action === "akuma.wait") {
    const result = await input.upstream.wait({
      targets: request.targets,
      completion: request.completion,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      signal: input.signal,
    });
    return { result, service: { action: request.action } };
  }
  if (request.action === "akuma.tell") {
    const result = await input.upstream.tell({
      target: request.target,
      body: request.body,
      tellId: request.id,
      recordedAt: request.admittedAt,
      signal: input.signal,
    });
    return {
      result,
      service: { action: request.action, target: request.target, tellId: request.id },
    };
  }
  if (request.action === "akuma.kill") {
    const served = await input.upstream.kill({
      targets: request.targets,
      signal: input.signal,
    });
    return {
      result: served.result,
      service: { action: request.action, results: served.service },
    };
  }
  if (request.action === "contract.deliver") {
    return await executeDeliver(input, request);
  }
  if (request.action === "contract.review") {
    return await executeReview(input, request);
  }
  const task = request as TaskRequestClaim & Readonly<{ requester: AkuId }>;
  const result = await input.upstream.task({
    world: task.world,
    request: task.request,
    requester: task.requester,
    signal: input.signal,
  });
  return { result, service: { action: task.action } };
}

async function executeDeliver(
  input: ServeInput,
  request: Extract<UpstreamFact, { action: "contract.deliver" }>,
): Promise<Readonly<{ result: unknown; service?: UpstreamRequestService }>> {
  if (input.upstream === undefined) throw new Error("upstream execution port is unavailable");
  const served = await input.upstream.deliver({
    repoRoot: request.repoRoot,
    contractId: request.contractId,
    ...(request.message === undefined ? {} : { message: request.message }),
    includeDirty: request.includeDirty,
    requester: request.requester,
    signal: input.signal,
  });
  return {
    result: served.result,
    ...(served.deliveryFactId === undefined ? {} : {
      service: {
        action: request.action,
        repoRoot: request.repoRoot,
        contractId: request.contractId,
        deliveryFactId: served.deliveryFactId,
      },
    }),
  };
}

async function executeReview(
  input: ServeInput,
  request: Extract<UpstreamFact, { action: "contract.review" }>,
): Promise<Readonly<{ result: unknown; service?: UpstreamRequestService }>> {
  if (input.upstream === undefined) throw new Error("upstream execution port is unavailable");
  const served = await input.upstream.review({
    repoRoot: request.repoRoot,
    contractId: request.contractId,
    verdict: request.verdict,
    ...(request.summary === undefined ? {} : { summary: request.summary }),
    requester: request.requester,
    signal: input.signal,
  });
  return {
    result: served.result,
    ...(served.reviewFactId === undefined ? {} : {
      service: {
        action: request.action,
        repoRoot: request.repoRoot,
        contractId: request.contractId,
        reviewFactId: served.reviewFactId,
      },
    }),
  };
}

function pendingService(request: UpstreamFact): UpstreamRequestService | undefined {
  if (request.action === "akuma.wait") return { action: request.action };
  if (request.action === "akuma.tell") {
    return { action: request.action, target: request.target, tellId: request.id };
  }
  return request.action === "akuma.kill" ? { action: request.action, results: [] } : undefined;
}

async function serveUpstream(
  input: ServeInput & Readonly<{
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
    await projectReceipt(input.directory, fact);
    return;
  }
  if (fact.state === "served") {
    await projectReceipt(input.directory, fact, {
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
    await projectReceipt(input.directory, fact);
    return;
  }
  if (fact.state !== "admitted" || fact.action === "akuma.call") {
    throw new Error(`Akuma request ${fact.id} cannot be served from ${fact.state}`);
  }
  const request = fact as UpstreamFact;
  let outcome: UpstreamRequestOutcome;
  let service = pendingService(request);
  try {
    const served = await execute(input, request);
    outcome = { kind: "returned", result: served.result };
    if (served.service === undefined) {
      fact = await voidRequest(
        input.paths,
        request.id,
        "body completed without a durable Contract fact reference",
      );
      await projectReceipt(input.directory, fact);
      return;
    }
    service = served.service;
  } catch (error) {
    outcome = { kind: "failed", failure: failure(error) };
    fact = await voidRequest(
      input.paths,
      request.id,
      "body failed before serving the request",
    );
    await projectReceipt(input.directory, fact);
    return;
  }
  fact = service === undefined
    ? await voidRequest(
        input.paths,
        request.id,
        "body completed without a durable Contract fact reference",
      )
    : await serveUpstreamRequest(input.paths, request.id, service);
  await projectReceipt(input.directory, fact, outcome);
}

async function serve(input: ServeInput): Promise<void> {
  return input.claim.action === "akuma.call"
    ? await serveCall({ ...input, claim: input.claim })
    : await serveUpstream({ ...input, claim: input.claim });
}

async function requestFiles(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => name.endsWith(".request.json"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export class BodyRequestPump {
  readonly directory: string;
  readonly failure: Promise<never>;
  private readonly closeSignal = new AbortController();
  private readonly executionSignal = new AbortController();
  private readonly handled = new Set<string>();
  private readonly running: Promise<void>;
  private readonly cancelBody: () => void;
  private admissionClosed = false;

  private constructor(private readonly input: PumpInput) {
    this.directory = join(input.paths.directory, "requests", String(input.bodySequence));
    this.cancelBody = () => {
      this.stopAdmission();
      if (!this.executionSignal.signal.aborted) {
        this.executionSignal.abort(input.signal.reason);
      }
    };
    input.signal.addEventListener("abort", this.cancelBody, { once: true });
    if (input.signal.aborted) this.cancelBody();
    this.running = this.run();
    this.failure = this.running.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => Promise.reject(error),
    );
  }

  static async open(input: PumpInput): Promise<BodyRequestPump> {
    await mkdir(join(input.paths.directory, "requests", String(input.bodySequence)), { recursive: true });
    return new BodyRequestPump(input);
  }

  private async run(): Promise<void> {
    try {
      while (!this.closeSignal.signal.aborted) {
        for (const name of await requestFiles(this.directory)) {
          if (this.closeSignal.signal.aborted) return;
          const id = name.slice(0, -".request.json".length);
          if (this.handled.has(id)) continue;
          const claim = decodeClaim(await readFile(join(this.directory, name), "utf8"), id);
          if (claim !== null && !this.admissionClosed) {
            await serve({
              directory: this.directory,
              claim,
              ...this.input,
              signal: this.executionSignal.signal,
              admissionOpen: () => !this.admissionClosed,
            });
          }
          this.handled.add(id);
        }
        try {
          await abortableDelay(POLL_MS, this.closeSignal.signal);
        } catch {
          return;
        }
      }
    } catch {
      // Request transport loss is recovered from Heart on the next Body.
    }
  }

  async close(): Promise<void> {
    this.stopAdmission();
    try {
      await this.running;
    } finally {
      this.input.signal.removeEventListener("abort", this.cancelBody);
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  stopAdmission(): void {
    this.admissionClosed = true;
    if (!this.closeSignal.signal.aborted) {
      this.closeSignal.abort(new Error("Body request pump closed"));
    }
  }
}

export async function clearBodyRequestTransport(paths: AkumaPaths): Promise<void> {
  await rm(join(paths.directory, "requests"), { recursive: true, force: true });
}

function matchingRequestOrigin(soul: Soul, parent: AkuId, id: string): boolean {
  return soul.origin.kind === "request"
    && soul.origin.parent === parent
    && soul.origin.requestId === id;
}

async function settleReservedSoul(
  paths: AkumaPaths,
  parent: Soul,
  request: Extract<RequestFact, { state: "reserved" }>,
  soul: Soul,
): Promise<void> {
  await (matchingRequestOrigin(soul, parent.id, request.id)
    ? serveRequest(paths, request.id, request.child)
    : voidRequest(
        paths,
        request.id,
        "reserved child origin does not match the request",
      ));
}

async function settleReserved(
  paths: AkumaPaths,
  parent: Soul,
  request: Extract<RequestFact, { state: "reserved" }>,
  now: () => string,
  signal?: AbortSignal,
): Promise<boolean> {
  const childPaths = pathsForAkuId(request.world, request.child);
  const deadline = performance.now() + BIRTH_TIMEOUT_MS;
  for (;;) {
    signal?.throwIfAborted();
    if (!await access(childPaths.directory).then(() => true, () => false)) {
      await voidRequest(paths, request.id, "reserved child directory is absent");
      return true;
    }
    const soul = await readSoul(childPaths);
    if (soul !== null) {
      await settleReservedSoul(paths, parent, request, soul);
      return true;
    }
    const leash = await HeldAkumaLeash.try(childPaths);
    if (leash !== null) {
      try {
        const settled = await readSoul(childPaths);
        if (settled !== null) {
          await settleReservedSoul(paths, parent, request, settled);
        } else {
          await leash.sealIfUnborn(childPaths, {
            evidence: "request settlement",
            at: now(),
          });
          await voidRequest(paths, request.id, "reserved child was sealed unborn");
        }
      } finally {
        leash.release();
      }
      return true;
    }
    if (performance.now() >= deadline) return false;
    await abortableDelay(POLL_MS, signal);
  }
}

export async function settleBodyRequests(
  paths: AkumaPaths,
  parent: Soul,
  now: () => string,
  signal?: AbortSignal,
): Promise<"settled" | "pending"> {
  let pending = false;
  for (const request of await readNonterminalRequests(paths)) {
    signal?.throwIfAborted();
    if (request.state === "admitted") {
      await voidRequest(paths, request.id, "body died before serving the request");
    } else if (
      request.state === "reserved"
      && !await settleReserved(paths, parent, request, now, signal)
    ) pending = true;
  }
  return pending ? "pending" : "settled";
}
