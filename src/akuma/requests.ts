import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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
  type RequestRecipe,
  type Soul,
  type UpstreamRequestService,
} from "./heart/index.js";
import type { TaskRequestInput } from "./heart/facts.js";
import {
  parseAkuId,
  pathsForAkuId,
  archetypeName,
  worldRootForAkumaPaths,
  type AkuId,
  type AkumaPaths,
} from "./identity.js";
import { BIRTH_TIMEOUT_MS, publishAkuma } from "./publication.js";
import { abortableDelay } from "./abort.js";
import { AKUMA_REQUESTS_ENV } from "./provider.js";
import { decodeProviderOptions, decodeReadonlyRestraint } from "./provider-recipe.js";
import { resolveProviderExecution } from "./providers/index.js";
import { decodeAllowedActions } from "./allowed.js";
import {
  decodeTaskMutationRequest,
  isTaskMutationAction,
  type TaskMutationAction,
  type TaskMutationRequest,
} from "../task/mutation.js";

const POLL_MS = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type CallRequestClaim = Readonly<{
  id: string;
  action: "akuma.call";
  world: string;
  archetype: string;
  body: string;
  cwd?: string;
  recipe: RequestRecipe;
}>;

type WaitRequestClaim = Readonly<{
  id: string;
  action: "akuma.wait";
  targets: readonly AkuId[];
  completion: "any" | "all";
  timeoutMs?: number;
}>;

type TellRequestClaim = Readonly<{
  id: string;
  action: "akuma.tell";
  target: AkuId;
  body: string;
}>;

type KillRequestClaim = Readonly<{
  id: string;
  action: "akuma.kill";
  targets: readonly AkuId[];
}>;

type DeliverRequestClaim = Readonly<{
  id: string;
  action: "contract.deliver";
  repoRoot: string;
  contractId: string;
  message?: string;
  includeDirty: boolean;
}>;

type ReviewRequestClaim = Readonly<{
  id: string;
  action: "contract.review";
  repoRoot: string;
  contractId: string;
  verdict: "satisfied" | "unsatisfied";
  summary?: string;
}>;

type TaskRequestClaim = TaskRequestInput;

type RequestClaim = CallRequestClaim | WaitRequestClaim | TellRequestClaim | KillRequestClaim
  | DeliverRequestClaim | ReviewRequestClaim | TaskRequestClaim;
type StructuralRequestClaim = (Omit<CallRequestClaim, "recipe"> & Readonly<{ recipe: unknown }>)
  | WaitRequestClaim
  | TellRequestClaim
  | KillRequestClaim
  | DeliverRequestClaim
  | ReviewRequestClaim
  | TaskRequestClaim;

type UpstreamRequestFailure =
  | Readonly<{ kind: "akuma-not-born"; id: AkuId }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type UpstreamRequestOutcome =
  | Readonly<{ kind: "returned"; result: unknown }>
  | Readonly<{ kind: "failed"; failure: UpstreamRequestFailure }>;

export type ForwardedDeliveryReference = Readonly<{
  kind: "accepted-reference";
  repoRoot: string;
  contractId: string;
  deliveryFactId: string;
}>;

export type ForwardedReviewReference = Readonly<{
  kind: "accepted-reference";
  repoRoot: string;
  contractId: string;
  reviewFactId: string;
}>;

export type ForwardedTaskReference = Readonly<{
  kind: "served-reference";
  action: TaskMutationAction;
}>;

export type UpstreamExecutionPort = Readonly<{
  wait(input: Omit<WaitRequestClaim, "id" | "action"> & Readonly<{ signal: AbortSignal }>): Promise<unknown>;
  tell(input: Omit<TellRequestClaim, "id" | "action"> & Readonly<{
    tellId: string;
    recordedAt: string;
    signal: AbortSignal;
  }>): Promise<unknown>;
  kill(input: Omit<KillRequestClaim, "id" | "action"> & Readonly<{ signal: AbortSignal }>): Promise<Readonly<{
    result: unknown;
    service: readonly Readonly<{ id: AkuId; evidence: KillEvidence }>[];
  }>>;
  deliver(input: Omit<DeliverRequestClaim, "id" | "action"> & Readonly<{
    requester: AkuId;
    signal: AbortSignal;
  }>): Promise<Readonly<{ result: unknown; deliveryFactId?: string }>>;
  review(input: Omit<ReviewRequestClaim, "id" | "action"> & Readonly<{
    requester: AkuId;
    signal: AbortSignal;
  }>): Promise<Readonly<{ result: unknown; reviewFactId?: string }>>;
  task(input: Readonly<{
    world: string;
    request: TaskMutationRequest;
    requester: AkuId;
    signal: AbortSignal;
  }>): Promise<unknown>;
}>;

type RequestReceipt =
  | Readonly<{ id: string; action: "akuma.call"; state: "served"; child: AkuId }>
  | Readonly<{
      id: string;
      action: "contract.deliver";
      state: "served";
      reference: ForwardedDeliveryReference;
    }>
  | Readonly<{
      id: string;
      action: "contract.review";
      state: "served";
      reference: ForwardedReviewReference;
    }>
  | Readonly<{
      id: string;
      action: TaskMutationAction;
      state: "served";
      reference: ForwardedTaskReference;
    }>
  | Readonly<{
      id: string;
      action: Exclude<RequestClaim["action"], "akuma.call">;
      state: "served";
      outcome: UpstreamRequestOutcome;
    }>
  | Readonly<{ id: string; action: RequestClaim["action"]; state: "refused"; diagnostic: string }>
  | Readonly<{ id: string; action: RequestClaim["action"]; state: "voided"; evidence: string }>;

export type RequestChildLaunch = Readonly<{
  paths: AkumaPaths;
  seed: Omit<Soul, "createdAt">;
  initialBody: string;
}>;

export class AkumaBodyRequestError extends Error {
  readonly kind = "akuma-body-request";
  constructor(
    readonly outcome: "refused" | "voided",
    readonly diagnostic: string,
  ) {
    super(`Akuma body request ${outcome}: ${diagnostic}`);
    this.name = "AkumaBodyRequestError";
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function decodeRecipe(value: unknown): RequestRecipe | null {
  const recipe = object(value);
  if (recipe === null) return null;
  const expectedKeys = [
    ...(recipe.description === undefined ? [] : ["description"]),
    "allowed",
    "options",
    "provider",
    ...(recipe.readonly === undefined ? [] : ["readonly"]),
  ];
  if (!exactKeys(recipe, expectedKeys)) return null;
  if (recipe.description !== undefined
    && (typeof recipe.description !== "string" || recipe.description.trim().length === 0)) return null;
  try {
    const provider = resolveProviderExecution(recipe.provider).execution;
    const decodedOptions = decodeProviderOptions(recipe.options);
    const readonly = recipe.readonly === undefined ? undefined : decodeReadonlyRestraint(recipe.readonly);
    if ((decodedOptions.readonly === true) !== (readonly !== undefined)) return null;
    return Object.freeze({
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
      allowed: decodeAllowedActions(recipe.allowed),
      provider,
      options: decodedOptions,
      ...(readonly === undefined ? {} : { readonly }),
    });
  } catch {
    return null;
  }
}

function canonicalAkuId(value: unknown): AkuId | null {
  if (typeof value !== "string") return null;
  try {
    const id = parseAkuId(value).id;
    return id === value ? id : null;
  } catch { return null; }
}

function canonicalTargets(value: unknown): readonly AkuId[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids: AkuId[] = [];
  for (const item of value) {
    const id = canonicalAkuId(item);
    if (id === null) return null;
    if (ids.length > 0 && Buffer.compare(Buffer.from(ids.at(-1)!), Buffer.from(id)) >= 0) return null;
    ids.push(id);
  }
  return ids;
}

function decodeCallClaim(
  id: string,
  payload: Readonly<Record<string, unknown>>,
): StructuralRequestClaim | null {
  const expected = [
    "archetype",
    "body",
    ...(payload.cwd === undefined ? [] : ["cwd"]),
    "recipe",
    "world",
  ];
  if (!exactKeys(payload, expected)
    || typeof payload.body !== "string"
    || !absolute(payload.world)) return null;
  if (payload.cwd !== undefined && !absolute(payload.cwd)) return null;
  try { archetypeName(payload.archetype as string); } catch { return null; }
  return {
    id,
    action: "akuma.call",
    world: payload.world,
    archetype: payload.archetype as string,
    body: payload.body,
    recipe: payload.recipe,
    ...(payload.cwd === undefined ? {} : { cwd: payload.cwd }),
  };
}

function decodeWaitClaim(
  id: string,
  payload: Readonly<Record<string, unknown>>,
): WaitRequestClaim | null {
  const expected = [
    "completion",
    "targets",
    ...(payload.timeoutMs === undefined ? [] : ["timeoutMs"]),
  ];
  const targets = canonicalTargets(payload.targets);
  if (!exactKeys(payload, expected)
    || targets === null
    || (payload.completion !== "any" && payload.completion !== "all")) return null;
  if (payload.timeoutMs !== undefined
    && (!Number.isSafeInteger(payload.timeoutMs) || (payload.timeoutMs as number) < 0)) return null;
  return {
    id,
    action: "akuma.wait",
    targets,
    completion: payload.completion,
    ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs as number }),
  };
}

function decodeTellClaim(
  id: string,
  payload: Readonly<Record<string, unknown>>,
): TellRequestClaim | null {
  const target = canonicalAkuId(payload.target);
  if (!exactKeys(payload, ["body", "target"])
    || target === null
    || typeof payload.body !== "string") return null;
  return { id, action: "akuma.tell", target, body: payload.body };
}

function decodeKillClaim(
  id: string,
  payload: Readonly<Record<string, unknown>>,
): KillRequestClaim | null {
  const targets = canonicalTargets(payload.targets);
  return exactKeys(payload, ["targets"]) && targets !== null
    ? { id, action: "akuma.kill", targets }
    : null;
}

function canonicalContractId(value: unknown): string | null {
  return typeof value === "string" && /^kei\/[^/\s]+$/u.test(value) ? value : null;
}

function decodeDeliverClaim(
  id: string,
  payload: Readonly<Record<string, unknown>>,
): DeliverRequestClaim | null {
  const expected = ["contractId", "includeDirty", ...(payload.message === undefined ? [] : ["message"]), "repoRoot"];
  const contract = canonicalContractId(payload.contractId);
  if (!exactKeys(payload, expected)
    || contract === null
    || !absolute(payload.repoRoot)
    || typeof payload.includeDirty !== "boolean"
    || (payload.message !== undefined
      && (typeof payload.message !== "string" || payload.message.trim().length === 0))) return null;
  return {
    id,
    action: "contract.deliver",
    repoRoot: payload.repoRoot,
    contractId: contract,
    includeDirty: payload.includeDirty,
    ...(payload.message === undefined ? {} : { message: payload.message as string }),
  };
}

function decodeReviewClaim(
  id: string,
  payload: Readonly<Record<string, unknown>>,
): ReviewRequestClaim | null {
  const expected = ["contractId", "repoRoot", "verdict", ...(payload.summary === undefined ? [] : ["summary"])];
  const contract = canonicalContractId(payload.contractId);
  if (!exactKeys(payload, expected)
    || contract === null
    || !absolute(payload.repoRoot)
    || (payload.verdict !== "satisfied" && payload.verdict !== "unsatisfied")
    || (payload.summary !== undefined
      && (typeof payload.summary !== "string" || payload.summary.trim().length === 0))) return null;
  return {
    id,
    action: "contract.review",
    repoRoot: payload.repoRoot,
    contractId: contract,
    verdict: payload.verdict,
    ...(payload.summary === undefined ? {} : { summary: payload.summary as string }),
  };
}

function isTaskClaim<T extends Readonly<{ action: string }>>(value: T): value is T & TaskRequestClaim {
  return isTaskMutationAction(value.action);
}

function decodeTaskClaim(
  id: string,
  action: TaskMutationAction,
  payload: Readonly<Record<string, unknown>>,
): TaskRequestClaim | null {
  if (!exactKeys(payload, ["request", "world"]) || !absolute(payload.world)) return null;
  try {
    return {
      id,
      action,
      world: payload.world,
      request: decodeTaskMutationRequest(action, payload.request),
    };
  } catch { return null; }
}

function decodeClaim(bytes: string, fileId: string): StructuralRequestClaim | null {
  let decoded: unknown;
  try { decoded = JSON.parse(bytes); } catch { return null; }
  const value = object(decoded);
  if (value === null
    || !exactKeys(value, ["action", "id", "payload"])
    || value.id !== fileId
    || typeof value.id !== "string"
    || !UUID.test(value.id)) return null;
  const payload = object(value.payload);
  if (payload === null) return null;
  if (value.action === "akuma.call") return decodeCallClaim(value.id, payload);
  if (value.action === "akuma.wait") return decodeWaitClaim(value.id, payload);
  if (value.action === "akuma.tell") return decodeTellClaim(value.id, payload);
  if (value.action === "akuma.kill") return decodeKillClaim(value.id, payload);
  if (value.action === "contract.deliver") return decodeDeliverClaim(value.id, payload);
  if (value.action === "contract.review") return decodeReviewClaim(value.id, payload);
  if (isTaskMutationAction(value.action)) return decodeTaskClaim(value.id, value.action, payload);
  return null;
}

function decodeUpstreamFailure(value: unknown): UpstreamRequestFailure | null {
  const failure = object(value);
  if (failure === null) return null;
  if (failure.kind === "akuma-not-born" && exactKeys(failure, ["id", "kind"])) {
    const id = canonicalAkuId(failure.id);
    return id === null ? null : { kind: failure.kind, id };
  }
  if (failure.kind === "failed"
    && exactKeys(failure, ["diagnostic", "kind"])
    && typeof failure.diagnostic === "string") {
    return { kind: failure.kind, diagnostic: failure.diagnostic };
  }
  return null;
}

function decodeUpstreamOutcome(value: unknown): UpstreamRequestOutcome | null {
  const outcome = object(value);
  if (outcome?.kind === "returned" && exactKeys(outcome, ["kind", "result"])) {
    return { kind: outcome.kind, result: outcome.result };
  }
  if (outcome?.kind !== "failed" || !exactKeys(outcome, ["failure", "kind"])) return null;
  const failure = decodeUpstreamFailure(outcome.failure);
  return failure === null ? null : { kind: outcome.kind, failure };
}

function decodeDeliveryReferenceReceipt(
  value: Readonly<Record<string, unknown>>,
  requestId: string,
): Extract<RequestReceipt, { reference: ForwardedDeliveryReference }> | null {
  if (value.state !== "served" || !exactKeys(value, ["action", "id", "reference", "state"])) return null;
  const reference = object(value.reference);
  if (reference === null
    || !exactKeys(reference, ["contractId", "deliveryFactId", "kind", "repoRoot"])
    || reference.kind !== "accepted-reference"
    || !absolute(reference.repoRoot)
    || canonicalContractId(reference.contractId) === null
    || typeof reference.deliveryFactId !== "string"
    || reference.deliveryFactId.trim().length === 0) return null;
  return {
    id: requestId,
    action: "contract.deliver",
    state: value.state,
    reference: {
      kind: reference.kind,
      repoRoot: reference.repoRoot,
      contractId: reference.contractId as string,
      deliveryFactId: reference.deliveryFactId,
    },
  };
}

function decodeDeliverReceipt(
  value: Readonly<Record<string, unknown>>,
  requestId: string,
): RequestReceipt | null {
  const reference = decodeDeliveryReferenceReceipt(value, requestId);
  if (reference !== null) return reference;
  if (value.state === "served" && exactKeys(value, ["action", "id", "outcome", "state"])) {
    const outcome = decodeUpstreamOutcome(value.outcome);
    return outcome === null
      ? null
      : { id: requestId, action: "contract.deliver", state: value.state, outcome };
  }
  if (value.state === "refused"
    && exactKeys(value, ["action", "diagnostic", "id", "state"])
    && typeof value.diagnostic === "string") {
    return { id: requestId, action: "contract.deliver", state: value.state, diagnostic: value.diagnostic };
  }
  if (value.state === "voided"
    && exactKeys(value, ["action", "evidence", "id", "state"])
    && typeof value.evidence === "string") {
    return { id: requestId, action: "contract.deliver", state: value.state, evidence: value.evidence };
  }
  return null;
}

function decodeReviewReceipt(
  value: Readonly<Record<string, unknown>>,
  requestId: string,
): RequestReceipt | null {
  if (value.state === "served" && exactKeys(value, ["action", "id", "reference", "state"])) {
    const reference = object(value.reference);
    if (reference !== null
      && exactKeys(reference, ["contractId", "kind", "repoRoot", "reviewFactId"])
      && reference.kind === "accepted-reference"
      && absolute(reference.repoRoot)
      && canonicalContractId(reference.contractId) !== null
      && typeof reference.reviewFactId === "string"
      && reference.reviewFactId.trim().length > 0) {
      return {
        id: requestId,
        action: "contract.review",
        state: value.state,
        reference: {
          kind: reference.kind,
          repoRoot: reference.repoRoot,
          contractId: reference.contractId as string,
          reviewFactId: reference.reviewFactId,
        },
      };
    }
  }
  if (value.state === "served" && exactKeys(value, ["action", "id", "outcome", "state"])) {
    const outcome = decodeUpstreamOutcome(value.outcome);
    return outcome === null
      ? null
      : { id: requestId, action: "contract.review", state: value.state, outcome };
  }
  if (value.state === "refused"
    && exactKeys(value, ["action", "diagnostic", "id", "state"])
    && typeof value.diagnostic === "string") {
    return { id: requestId, action: "contract.review", state: value.state, diagnostic: value.diagnostic };
  }
  if (value.state === "voided"
    && exactKeys(value, ["action", "evidence", "id", "state"])
    && typeof value.evidence === "string") {
    return { id: requestId, action: "contract.review", state: value.state, evidence: value.evidence };
  }
  return null;
}

const CONTRACT_RECEIPT_DECODERS: Partial<Record<RequestClaim["action"], (
  value: Readonly<Record<string, unknown>>,
  requestId: string,
) => RequestReceipt | null>> = {
  "contract.deliver": decodeDeliverReceipt,
  "contract.review": decodeReviewReceipt,
};

function decodeTaskReceipt(
  value: Readonly<Record<string, unknown>>,
  requestId: string,
  action: TaskMutationAction,
): RequestReceipt | null {
  if (value.state === "served" && exactKeys(value, ["action", "id", "reference", "state"])) {
    const reference = object(value.reference);
    if (reference === null
      || !exactKeys(reference, ["action", "kind"])
      || reference.kind !== "served-reference"
      || reference.action !== action) return null;
    return { id: requestId, action, state: "served", reference: { kind: reference.kind, action } };
  }
  if (value.state === "served" && exactKeys(value, ["action", "id", "outcome", "state"])) {
    const outcome = decodeUpstreamOutcome(value.outcome);
    return outcome === null ? null : { id: requestId, action, state: value.state, outcome };
  }
  if (value.state === "refused"
    && exactKeys(value, ["action", "diagnostic", "id", "state"])
    && typeof value.diagnostic === "string") return { id: requestId, action, state: value.state, diagnostic: value.diagnostic };
  if (value.state === "voided"
    && exactKeys(value, ["action", "evidence", "id", "state"])
    && typeof value.evidence === "string") return { id: requestId, action, state: value.state, evidence: value.evidence };
  return null;
}

function decodeOrdinaryReceipt(
  value: Readonly<Record<string, unknown>>,
  requestId: string,
  action: Exclude<RequestClaim["action"], "akuma.call">,
): RequestReceipt | null {
  if (value.state === "served" && exactKeys(value, ["action", "id", "outcome", "state"])) {
    const outcome = decodeUpstreamOutcome(value.outcome);
    return outcome === null ? null : { id: requestId, action, state: value.state, outcome };
  }
  if (value.state === "refused" && exactKeys(value, ["action", "diagnostic", "id", "state"])
    && typeof value.diagnostic === "string") {
    return { id: requestId, action, state: value.state, diagnostic: value.diagnostic };
  }
  if (value.state === "voided" && exactKeys(value, ["action", "evidence", "id", "state"])
    && typeof value.evidence === "string") {
    return { id: requestId, action, state: value.state, evidence: value.evidence };
  }
  return null;
}

function decodeCallReceipt(
  value: Readonly<Record<string, unknown>>,
  requestId: string,
): RequestReceipt | null {
  if (value.state === "served"
    && exactKeys(value, ["action", "child", "id", "state"])) {
    const child = canonicalAkuId(value.child);
    return child === null ? null : { id: requestId, action: "akuma.call", state: value.state, child };
  }
  if (value.state === "refused" && exactKeys(value, ["action", "diagnostic", "id", "state"])
    && typeof value.diagnostic === "string") {
    return { id: requestId, action: "akuma.call", state: value.state, diagnostic: value.diagnostic };
  }
  if (value.state === "voided" && exactKeys(value, ["action", "evidence", "id", "state"])
    && typeof value.evidence === "string") {
    return { id: requestId, action: "akuma.call", state: value.state, evidence: value.evidence };
  }
  return null;
}

function decodeReceipt(bytes: string, requestId: string, action: RequestClaim["action"]): RequestReceipt | null {
  let decoded: unknown;
  try { decoded = JSON.parse(bytes); } catch { return null; }
  const value = object(decoded);
  if (value === null || value.id !== requestId || value.action !== action) return null;
  const contractDecoder = CONTRACT_RECEIPT_DECODERS[action];
  if (contractDecoder !== undefined) return contractDecoder(value, requestId);
  if (isTaskMutationAction(action)) return decodeTaskReceipt(value, requestId, action);
  return action === "akuma.call"
    ? decodeCallReceipt(value, requestId)
    : decodeOrdinaryReceipt(value, requestId, action);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function receiptFor(fact: RequestFact): RequestReceipt | null {
  if (fact.action === "akuma.call" && fact.state === "served") {
    return { id: fact.id, action: fact.action, state: fact.state, child: fact.child };
  }
  if (fact.state === "refused") {
    return { id: fact.id, action: fact.action, state: fact.state, diagnostic: fact.diagnostic };
  }
  if (fact.state === "voided") return { id: fact.id, action: fact.action, state: fact.state, evidence: fact.evidence };
  if (fact.action === "contract.deliver" && fact.state === "served") {
    const service = fact.service as Extract<UpstreamRequestService, { action: "contract.deliver" }>;
    return {
      id: fact.id,
      action: fact.action,
      state: fact.state,
      reference: {
        kind: "accepted-reference",
        repoRoot: service.repoRoot,
        contractId: service.contractId,
        deliveryFactId: service.deliveryFactId,
      },
    };
  }
  if (fact.action === "contract.review" && fact.state === "served") {
    const service = fact.service as Extract<UpstreamRequestService, { action: "contract.review" }>;
    return {
      id: fact.id,
      action: fact.action,
      state: fact.state,
      reference: {
        kind: "accepted-reference",
        repoRoot: service.repoRoot,
        contractId: service.contractId,
        reviewFactId: service.reviewFactId,
      },
    };
  }
  if (isTaskClaim(fact) && fact.state === "served") {
    return {
      id: fact.id,
      action: fact.action,
      state: fact.state,
      reference: {
        kind: "served-reference",
        action: fact.action as TaskMutationAction,
      },
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
      : { id: fact.id, action: fact.action, state: "served", outcome } as RequestReceipt;
  if (receipt !== null) await atomicJson(join(directory, `${fact.id}.receipt.json`), receipt);
}

export function injectedBodyRequests(): string | null {
  const directory = process.env[AKUMA_REQUESTS_ENV];
  if (directory === undefined) return null;
  if (!absolute(directory)) throw new Error(`${AKUMA_REQUESTS_ENV} must be an absolute normalized path`);
  return directory;
}

async function requestBody(input: Readonly<{
  directory: string;
  claim: RequestClaim;
  signal?: AbortSignal;
}>): Promise<RequestReceipt> {
  const { id, action, ...payload } = input.claim;
  input.signal?.throwIfAborted();
  const requestPayload = isTaskClaim(input.claim)
    ? (() => {
        const { action: ignoredAction, ...request } = input.claim.request;
        return { world: input.claim.world, request };
      })()
    : payload;
  await atomicJson(join(input.directory, `${id}.request.json`), { id, action, payload: requestPayload });
  const receiptPath = join(input.directory, `${id}.receipt.json`);
  for (;;) {
    try {
      const receipt = decodeReceipt(await readFile(receiptPath, "utf8"), id, action);
      if (receipt === null) throw new Error(`Akuma body request ${id} has an invalid receipt`);
      if (receipt.state === "refused") throw new AkumaBodyRequestError("refused", receipt.diagnostic);
      if (receipt.state === "voided") throw new AkumaBodyRequestError("voided", receipt.evidence);
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!await access(input.directory).then(() => true, () => false)) {
      throw new AkumaBodyRequestError("voided", "parent request channel closed before a receipt");
    }
    await abortableDelay(POLL_MS, input.signal);
  }
}

export async function requestBodyCall(
  input: Omit<CallRequestClaim, "action"> & Readonly<{ directory: string }>,
): Promise<AkuId> {
  const { directory, ...claim } = input;
  const receipt = await requestBody({ directory, claim: { ...claim, action: "akuma.call" } });
  if (receipt.action !== "akuma.call" || receipt.state !== "served") {
    throw new Error(`Akuma body request ${input.id} returned the wrong action`);
  }
  return (receipt as Extract<RequestReceipt, { action: "akuma.call"; state: "served" }>).child;
}

async function requestUpstream(
  directory: string,
  claim: WaitRequestClaim | TellRequestClaim | KillRequestClaim,
  signal?: AbortSignal,
): Promise<UpstreamRequestOutcome> {
  const receipt = await requestBody({ directory, claim, ...(signal === undefined ? {} : { signal }) });
  if (receipt.action === "akuma.call" || receipt.state !== "served" || !("outcome" in receipt)) {
    throw new Error(`Akuma body request ${claim.id} returned the wrong action`);
  }
  return (receipt as Extract<RequestReceipt, { state: "served" }> & Readonly<{ outcome: UpstreamRequestOutcome }>).outcome;
}

export async function requestBodyTask(input: Readonly<{
  directory: string;
  world: string;
  request: TaskMutationRequest;
  id?: string;
}>): Promise<unknown> {
  const requestId = input.id ?? randomUUID();
  const receipt = await requestBody({
    directory: input.directory,
    claim: {
      id: requestId,
      action: input.request.action,
      world: input.world,
      request: input.request,
    },
  });
  if (!isTaskMutationAction(receipt.action) || receipt.action !== input.request.action || receipt.state !== "served") {
    throw new Error(`Akuma body request ${requestId} returned the wrong action`);
  }
  if ("reference" in receipt) return receipt.reference;
  return receipt.outcome.kind === "returned"
    ? receipt.outcome.result
    : (() => { throw new Error(receipt.outcome.failure.kind === "failed" ? receipt.outcome.failure.diagnostic : "Akuma body request parent is not born"); })();
}

export async function requestBodyWait(
  input: Omit<WaitRequestClaim, "action" | "id"> & Readonly<{
    directory: string;
    id?: string;
  }>,
): Promise<UpstreamRequestOutcome> {
  const { directory, id = randomUUID(), ...claim } = input;
  return await requestUpstream(directory, { ...claim, id, action: "akuma.wait" });
}

export async function requestBodyTell(
  input: Omit<TellRequestClaim, "action" | "id"> & Readonly<{
    directory: string;
    id?: string;
  }>,
): Promise<UpstreamRequestOutcome> {
  const { directory, id = randomUUID(), ...claim } = input;
  return await requestUpstream(directory, { ...claim, id, action: "akuma.tell" });
}

export async function requestBodyKill(
  input: Omit<KillRequestClaim, "action" | "id"> & Readonly<{
    directory: string;
    id?: string;
  }>,
): Promise<UpstreamRequestOutcome> {
  const { directory, id = randomUUID(), ...claim } = input;
  return await requestUpstream(directory, { ...claim, id, action: "akuma.kill" });
}

type BodyDeliverInput = Omit<DeliverRequestClaim, "action" | "id"> & Readonly<{
  directory: string;
  signal?: AbortSignal;
}>;

export function requestBodyDeliver(
  input: BodyDeliverInput & Readonly<{ id?: never }>,
): Promise<UpstreamRequestOutcome>;
export function requestBodyDeliver(
  input: BodyDeliverInput & Readonly<{ id: string }>,
): Promise<UpstreamRequestOutcome | ForwardedDeliveryReference>;
export async function requestBodyDeliver(
  input: Omit<DeliverRequestClaim, "action" | "id"> & Readonly<{
    directory: string;
    id?: string;
    signal?: AbortSignal;
  }>,
): Promise<UpstreamRequestOutcome | ForwardedDeliveryReference> {
  const { directory, id = randomUUID(), signal, ...claim } = input;
  const receipt = await requestBody({
    directory,
    claim: { ...claim, id, action: "contract.deliver" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (receipt.action !== "contract.deliver" || receipt.state !== "served") {
    throw new Error(`Akuma body request ${id} returned the wrong action`);
  }
  return "reference" in receipt && "repoRoot" in receipt.reference
    ? receipt.reference
    : (receipt as Extract<RequestReceipt, { state: "served" }> & Readonly<{ outcome: UpstreamRequestOutcome }>).outcome;
}

type BodyReviewInput = Omit<ReviewRequestClaim, "action" | "id"> & Readonly<{
  directory: string;
  signal?: AbortSignal;
}>;

export function requestBodyReview(
  input: BodyReviewInput & Readonly<{ id?: never }>,
): Promise<UpstreamRequestOutcome>;
export function requestBodyReview(
  input: BodyReviewInput & Readonly<{ id: string }>,
): Promise<UpstreamRequestOutcome | ForwardedReviewReference>;
export async function requestBodyReview(
  input: Omit<ReviewRequestClaim, "action" | "id"> & Readonly<{
    directory: string;
    id?: string;
    signal?: AbortSignal;
  }>,
): Promise<UpstreamRequestOutcome | ForwardedReviewReference> {
  const { directory, id = randomUUID(), signal, ...claim } = input;
  const receipt = await requestBody({
    directory,
    claim: { ...claim, id, action: "contract.review" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (receipt.action !== "contract.review" || receipt.state !== "served") {
    throw new Error(`Akuma body request ${id} returned the wrong action`);
  }
  return "reference" in receipt ? receipt.reference : receipt.outcome;
}

type ServeRequestInput = Readonly<{
  directory: string;
  claim: StructuralRequestClaim;
  paths: AkumaPaths;
  parent: Soul;
  now(): string;
  spawn(launch: RequestChildLaunch): Promise<void>;
  upstream?: UpstreamExecutionPort;
  signal: AbortSignal;
}>;

async function serveCallClaim(
  input: ServeRequestInput & Readonly<{
    claim: Extract<StructuralRequestClaim, { action: "akuma.call" }>;
  }>,
): Promise<void> {
  input.signal.throwIfAborted();
  const cwd = input.claim.cwd ?? input.parent.cwd;
  const recipe = decodeRecipe(input.claim.recipe);
  if (recipe === null) return;
  let fact = await admitRequest(input.paths, { ...input.claim, recipe, admittedAt: input.now() });
  const existing = receiptFor(fact);
  if (existing !== null) {
    if (!input.signal.aborted) await projectReceipt(input.directory, fact);
    return;
  }
  if (fact.action !== "akuma.call" || fact.state !== "admitted") {
    throw new Error(`Akuma request ${fact.id} cannot be replayed from ${fact.state}`);
  }
  const request = fact as Extract<RequestFact, { action: "akuma.call"; state: "admitted" }>;
  const servingWorld = worldRootForAkumaPaths(input.paths);
  if (request.world !== servingWorld) {
    fact = await refuseRequest(
      input.paths,
      request.id,
      `request world ${request.world} does not match ${servingWorld}`,
    );
    await projectReceipt(input.directory, fact);
    return;
  }
  let child: AkuId;
  try {
    input.signal.throwIfAborted();
    const published = await publishAkuma({
      worldPath: servingWorld,
      archetype: request.archetype,
      reserve: async (allocated) => { fact = await reserveRequest(input.paths, request.id, allocated.id); },
      signal: input.signal,
      launch: async (allocated) => await input.spawn({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: allocated.archetype,
          ...(request.recipe.description === undefined ? {} : { description: request.recipe.description }),
          provider: request.recipe.provider,
          options: request.recipe.options,
          ...(request.recipe.readonly === undefined ? {} : { readonly: request.recipe.readonly }),
          allowed: request.recipe.allowed,
          cwd,
          origin: { kind: "request", parent: input.parent.id, requestId: request.id },
        },
        initialBody: request.body,
      }),
    });
    child = published.id;
  } catch (error) {
    if (input.signal.aborted) return;
    const current = await readRequest(input.paths, request.id);
    if (current === null) throw error;
    fact = current.state === "admitted" || current.state === "reserved"
      ? await voidRequest(input.paths, request.id, diagnostic(error))
      : current;
    await projectReceipt(input.directory, fact);
    return;
  }
  fact = await serveRequest(input.paths, request.id, child);
  await projectReceipt(input.directory, fact);
}

function upstreamFailure(error: unknown): UpstreamRequestFailure {
  const value = object(error);
  if (value?.kind === "akuma-not-born") {
    const id = canonicalAkuId(value.id);
    if (id !== null) return { kind: "akuma-not-born", id };
  }
  return { kind: "failed", diagnostic: diagnostic(error) };
}

async function executeTaskClaim(
  upstream: UpstreamExecutionPort,
  signal: AbortSignal,
  task: TaskRequestClaim & Readonly<{ requester: AkuId }>,
): Promise<Readonly<{ result: unknown; service: UpstreamRequestService }>> {
  const result = await upstream.task({
    world: task.world,
    request: task.request,
    requester: task.requester,
    signal,
  });
  return { result, service: { action: task.action } };
}

async function executeUpstreamClaim(
  input: ServeRequestInput,
  request: Exclude<Extract<RequestFact, { state: "admitted" }>, Extract<RequestFact, { action: "akuma.call" }>>,
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
    const served = await input.upstream.kill({ targets: request.targets, signal: input.signal });
    return { result: served.result, service: { action: request.action, results: served.service } };
  }
  if (request.action === "contract.review") {
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
  if (isTaskClaim(request)) {
    return await executeTaskClaim(
      input.upstream,
      input.signal,
      request as TaskRequestClaim & Readonly<{ requester: AkuId }>,
    );
  }
  const delivery = request as Extract<RequestFact, { action: "contract.deliver"; state: "admitted" }>;
  const served = await input.upstream.deliver({
    repoRoot: delivery.repoRoot,
    contractId: delivery.contractId,
    ...(delivery.message === undefined ? {} : { message: delivery.message }),
    includeDirty: delivery.includeDirty,
    requester: delivery.requester,
    signal: input.signal,
  });
  return {
    result: served.result,
    ...(served.deliveryFactId === undefined ? {} : {
      service: {
        action: delivery.action,
        repoRoot: delivery.repoRoot,
        contractId: delivery.contractId,
        deliveryFactId: served.deliveryFactId,
      },
    }),
  };
}

function pendingService(
  request: Exclude<Extract<RequestFact, { state: "admitted" }>, Extract<RequestFact, { action: "akuma.call" }>>,
): UpstreamRequestService | undefined {
  if (request.action === "akuma.wait") return { action: request.action };
  if (request.action === "akuma.tell") {
    return { action: request.action, target: request.target, tellId: request.id };
  }
  if (request.action === "akuma.kill") return { action: request.action, results: [] };
  return undefined;
}

async function serveUpstreamClaim(
  input: ServeRequestInput & Readonly<{
    claim: Exclude<StructuralRequestClaim, { action: "akuma.call" }>;
  }>,
): Promise<void> {
  input.signal.throwIfAborted();
  let fact = await admitRequest(input.paths, { ...input.claim, admittedAt: input.now() });
  const existing = receiptFor(fact);
  if (existing !== null) {
    if (!input.signal.aborted) await projectReceipt(input.directory, fact);
    return;
  }
  if (fact.state === "served") {
    await projectReceipt(input.directory, fact, {
      kind: "failed",
      failure: { kind: "failed", diagnostic: "served request receipt is no longer available" },
    });
    return;
  }
  if (fact.state !== "admitted" || fact.action === "akuma.call") {
    throw new Error(`Akuma request ${fact.id} cannot be served from ${fact.state}`);
  }
  const request = fact as Exclude<
    Extract<RequestFact, { state: "admitted" }>,
    Extract<RequestFact, { action: "akuma.call" }>
  >;

  let outcome: UpstreamRequestOutcome;
  let service = pendingService(request);
  try {
    const served = await executeUpstreamClaim(input, request);
    outcome = { kind: "returned", result: served.result };
    if (served.service === undefined) {
      fact = await voidRequest(input.paths, request.id, "body completed without a durable Contract fact reference");
      await projectReceipt(input.directory, fact, outcome);
      return;
    }
    service = served.service;
  } catch (error) {
    if (input.signal.aborted) return;
    outcome = { kind: "failed", failure: upstreamFailure(error) };
    if (request.action === "contract.deliver" || request.action === "contract.review") {
      fact = await voidRequest(input.paths, request.id, "body failed before serving the request");
      await projectReceipt(input.directory, fact, outcome);
      return;
    }
  }
  input.signal.throwIfAborted();
  if (service === undefined) {
    fact = await voidRequest(input.paths, request.id, "body completed without a durable Contract fact reference");
  } else {
    fact = await serveUpstreamRequest(input.paths, request.id, service);
  }
  await projectReceipt(input.directory, fact, outcome);
}

async function serveClaim(input: ServeRequestInput): Promise<void> {
  return input.claim.action === "akuma.call"
    ? await serveCallClaim({ ...input, claim: input.claim })
    : await serveUpstreamClaim({ ...input, claim: input.claim });
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
  private readonly handled = new Set<string>();
  private readonly running: Promise<void>;
  private readonly cancelAdmission: () => void;

  private constructor(private readonly input: Readonly<{
    paths: AkumaPaths;
    parent: Soul;
    bodySequence: number;
    now(): string;
    spawn(launch: RequestChildLaunch): Promise<void>;
    upstream?: UpstreamExecutionPort;
    signal: AbortSignal;
  }>) {
    this.directory = join(input.paths.directory, "requests", String(input.bodySequence));
    this.cancelAdmission = () => this.stopAdmission();
    input.signal.addEventListener("abort", this.cancelAdmission, { once: true });
    if (input.signal.aborted) this.cancelAdmission();
    this.running = this.run();
    this.failure = this.running.then(
      () => new Promise<never>(() => {}),
      (error: unknown) => Promise.reject(error),
    );
  }

  static async open(input: Readonly<{
    paths: AkumaPaths;
    parent: Soul;
    bodySequence: number;
    now(): string;
    spawn(launch: RequestChildLaunch): Promise<void>;
    upstream?: UpstreamExecutionPort;
    signal: AbortSignal;
  }>): Promise<BodyRequestPump> {
    const directory = join(input.paths.directory, "requests", String(input.bodySequence));
    await mkdir(directory, { recursive: true });
    return new BodyRequestPump(input);
  }

  private async run(): Promise<void> {
    while (!this.closeSignal.signal.aborted) {
      for (const name of await requestFiles(this.directory)) {
        if (this.closeSignal.signal.aborted) return;
        const id = name.slice(0, -".request.json".length);
        if (this.handled.has(id)) continue;
        const claim = decodeClaim(await readFile(join(this.directory, name), "utf8"), id);
        if (claim === null) { this.handled.add(id); continue; }
        await serveClaim({ directory: this.directory, claim, ...this.input, signal: this.closeSignal.signal });
        this.handled.add(id);
      }
      try { await abortableDelay(POLL_MS, this.closeSignal.signal); }
      catch { return; }
    }
  }

  async close(): Promise<void> {
    this.stopAdmission();
    try { await this.running; }
    finally {
      this.input.signal.removeEventListener("abort", this.cancelAdmission);
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  stopAdmission(): void {
    if (!this.closeSignal.signal.aborted) this.closeSignal.abort(new Error("Body request pump closed"));
  }
}

export async function clearBodyRequestTransport(paths: AkumaPaths): Promise<void> {
  await rm(join(paths.directory, "requests"), { recursive: true, force: true });
}

function matchingRequestOrigin(soul: Soul, parent: AkuId, requestId: string): boolean {
  return soul.origin.kind === "request"
    && soul.origin.parent === parent
    && soul.origin.requestId === requestId;
}

async function settleObservedSoul(
  paths: AkumaPaths,
  parent: Soul,
  request: Extract<RequestFact, { state: "reserved" }>,
  soul: Soul,
): Promise<void> {
  if (matchingRequestOrigin(soul, parent.id, request.id)) await serveRequest(paths, request.id, request.child);
  else await voidRequest(paths, request.id, "reserved child origin does not match the request");
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
    const childSoul = await readSoul(childPaths);
    if (childSoul !== null) {
      await settleObservedSoul(paths, parent, request, childSoul);
      return true;
    }
    const leash = await HeldAkumaLeash.try(childPaths);
    if (leash !== null) {
      try {
        const settledSoul = await readSoul(childPaths);
        if (settledSoul !== null) {
          await settleObservedSoul(paths, parent, request, settledSoul);
        } else {
          await leash.sealIfUnborn(childPaths, { evidence: "request settlement", at: now() });
          await voidRequest(paths, request.id, "reserved child was sealed unborn");
        }
      } finally { leash.release(); }
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
    } else if (request.state === "reserved"
      && !await settleReserved(paths, parent, request, now, signal)) pending = true;
  }
  return pending ? "pending" : "settled";
}
