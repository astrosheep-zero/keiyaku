import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { decodeAllowedActions } from "./allowed.js";
import { archetypeName, parseAkuId, type AkuId } from "./identity.js";
import { decodeProviderOptions, decodeReadonlyRestraint, type ReadonlyRestraint } from "./provider-recipe.js";
import { decodeProviderExecution } from "./providers/index.js";
import {
  decodeTaskMutationRequest,
  isTaskMutationAction,
  type TaskMutationAction,
  type TaskMutationRequest,
} from "../task/mutation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type RequestRecipe = Readonly<{
  description?: string;
  allowed: readonly string[];
  provider: ReturnType<typeof decodeProviderExecution>;
  options: ReturnType<typeof decodeProviderOptions>;
  readonly?: ReadonlyRestraint;
}>;

export type CallRequestClaim = Readonly<{
  id: string;
  action: "akuma.call";
  world: string;
  archetype: string;
  body: string;
  cwd?: string;
  recipe: RequestRecipe;
}>;
export type WaitRequestClaim = Readonly<{
  id: string;
  action: "akuma.wait";
  targets: readonly AkuId[];
  completion: "any" | "all";
  timeoutMs?: number;
}>;
export type TellRequestClaim = Readonly<{
  id: string;
  action: "akuma.tell";
  target: AkuId;
  body: string;
}>;
export type KillRequestClaim = Readonly<{
  id: string;
  action: "akuma.kill";
  targets: readonly AkuId[];
}>;
export type DeliverRequestClaim = Readonly<{
  id: string;
  action: "contract.deliver";
  repoRoot: string;
  contractId: string;
  message?: string;
  includeDirty: boolean;
  materializeConflict: boolean;
}>;
export type ReviewRequestClaim = Readonly<{
  id: string;
  action: "contract.review";
  repoRoot: string;
  contractId: string;
  verdict: "satisfied" | "unsatisfied";
  summary?: string;
}>;
export type TaskRequestClaim = Readonly<{
  id: string;
  action: TaskMutationAction;
  world: string;
  request: TaskMutationRequest;
}>;
export type RequestClaim =
  | CallRequestClaim
  | WaitRequestClaim
  | TellRequestClaim
  | KillRequestClaim
  | DeliverRequestClaim
  | ReviewRequestClaim
  | TaskRequestClaim;
export type StructuralRequestClaim =
  | (Omit<CallRequestClaim, "recipe"> & Readonly<{ recipe: unknown }>)
  | Exclude<RequestClaim, CallRequestClaim>;

export type UpstreamRequestFailure =
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
type ReceiptBase<A extends RequestClaim["action"], S extends string> = Readonly<{
  id: string;
  action: A;
  state: S;
}>;
export type RequestReceipt =
  | (ReceiptBase<"akuma.call", "served"> & Readonly<{ child: AkuId }>)
  | (ReceiptBase<"contract.deliver", "served"> & Readonly<{ reference: ForwardedDeliveryReference }>)
  | (ReceiptBase<"contract.review", "served"> & Readonly<{ reference: ForwardedReviewReference }>)
  | (ReceiptBase<TaskMutationAction, "served"> & Readonly<{ reference: ForwardedTaskReference }>)
  | (ReceiptBase<Exclude<RequestClaim["action"], "akuma.call">, "served"> &
      Readonly<{ outcome: UpstreamRequestOutcome }>)
  | (ReceiptBase<RequestClaim["action"], "refused"> & Readonly<{ diagnostic: string }>)
  | (ReceiptBase<RequestClaim["action"], "voided"> & Readonly<{ evidence: string }>);

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

export function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

export function canonicalAkuId(value: unknown): AkuId | null {
  if (typeof value !== "string") return null;
  try {
    const id = parseAkuId(value).id;
    return id === value ? id : null;
  } catch {
    return null;
  }
}

function canonicalTargets(value: unknown): readonly AkuId[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids: AkuId[] = [];
  for (const item of value) {
    const id = canonicalAkuId(item);
    if (id === null || (ids.length > 0 && Buffer.compare(Buffer.from(ids.at(-1)!), Buffer.from(id)) >= 0)) return null;
    ids.push(id);
  }
  return ids;
}

export function decodeRecipe(value: unknown): RequestRecipe | null {
  const recipe = object(value);
  if (recipe === null) return null;
  const expected = [
    "allowed",
    "options",
    "provider",
    ...(recipe.description === undefined ? [] : ["description"]),
    ...(recipe.readonly === undefined ? [] : ["readonly"]),
  ];
  if (
    !exactKeys(recipe, expected) ||
    (recipe.description !== undefined &&
      (typeof recipe.description !== "string" || recipe.description.trim().length === 0))
  )
    return null;
  try {
    const options = decodeProviderOptions(recipe.options);
    const readonly = recipe.readonly === undefined ? undefined : decodeReadonlyRestraint(recipe.readonly);
    if ((options.readonly === true) !== (readonly !== undefined)) return null;
    return Object.freeze({
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
      allowed: decodeAllowedActions(recipe.allowed),
      provider: decodeProviderExecution(recipe.provider),
      options,
      ...(readonly === undefined ? {} : { readonly }),
    });
  } catch {
    return null;
  }
}

function contractId(value: unknown): string | null {
  return typeof value === "string" && /^kei\/[^/\s]+$/u.test(value) ? value : null;
}

function decodeCall(id: string, payload: Readonly<Record<string, unknown>>): StructuralRequestClaim | null {
  const expected = ["archetype", "body", "recipe", "world", ...(payload.cwd === undefined ? [] : ["cwd"])];
  if (
    !exactKeys(payload, expected) ||
    typeof payload.body !== "string" ||
    !absolute(payload.world) ||
    (payload.cwd !== undefined && !absolute(payload.cwd))
  )
    return null;
  try {
    archetypeName(payload.archetype as string);
  } catch {
    return null;
  }
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

function decodeWait(id: string, payload: Readonly<Record<string, unknown>>): WaitRequestClaim | null {
  const targets = canonicalTargets(payload.targets);
  const expected = ["completion", "targets", ...(payload.timeoutMs === undefined ? [] : ["timeoutMs"])];
  if (
    !exactKeys(payload, expected) ||
    targets === null ||
    (payload.completion !== "any" && payload.completion !== "all") ||
    (payload.timeoutMs !== undefined && (!Number.isSafeInteger(payload.timeoutMs) || (payload.timeoutMs as number) < 0))
  )
    return null;
  return {
    id,
    action: "akuma.wait",
    targets,
    completion: payload.completion,
    ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs as number }),
  };
}

function decodeTell(id: string, payload: Readonly<Record<string, unknown>>): TellRequestClaim | null {
  const target = canonicalAkuId(payload.target);
  return exactKeys(payload, ["body", "target"]) && target !== null && typeof payload.body === "string"
    ? { id, action: "akuma.tell", target, body: payload.body }
    : null;
}

function decodeKill(id: string, payload: Readonly<Record<string, unknown>>): KillRequestClaim | null {
  const targets = canonicalTargets(payload.targets);
  return exactKeys(payload, ["targets"]) && targets !== null ? { id, action: "akuma.kill", targets } : null;
}

function decodeDeliver(id: string, payload: Readonly<Record<string, unknown>>): DeliverRequestClaim | null {
  const valid = exactKeys(payload, [
    "contractId",
    "includeDirty",
    "materializeConflict",
    "repoRoot",
    ...(payload.message === undefined ? [] : ["message"]),
  ]);
  const selected = contractId(payload.contractId);
  return valid &&
    selected !== null &&
    absolute(payload.repoRoot) &&
    typeof payload.includeDirty === "boolean" &&
    typeof payload.materializeConflict === "boolean" &&
    (payload.message === undefined || (typeof payload.message === "string" && payload.message.trim().length > 0))
    ? {
        id,
        action: "contract.deliver",
        repoRoot: payload.repoRoot,
        contractId: selected,
        includeDirty: payload.includeDirty,
        materializeConflict: payload.materializeConflict,
        ...(payload.message === undefined ? {} : { message: payload.message as string }),
      }
    : null;
}

function decodeReview(id: string, payload: Readonly<Record<string, unknown>>): ReviewRequestClaim | null {
  const valid = exactKeys(payload, [
    "contractId",
    "repoRoot",
    "verdict",
    ...(payload.summary === undefined ? [] : ["summary"]),
  ]);
  const selected = contractId(payload.contractId);
  return valid &&
    selected !== null &&
    absolute(payload.repoRoot) &&
    (payload.verdict === "satisfied" || payload.verdict === "unsatisfied") &&
    (payload.summary === undefined || (typeof payload.summary === "string" && payload.summary.trim().length > 0))
    ? {
        id,
        action: "contract.review",
        repoRoot: payload.repoRoot,
        contractId: selected,
        verdict: payload.verdict,
        ...(payload.summary === undefined ? {} : { summary: payload.summary as string }),
      }
    : null;
}

function decodeTask(id: string, action: string, payload: Readonly<Record<string, unknown>>): TaskRequestClaim | null {
  if (!isTaskMutationAction(action) || !exactKeys(payload, ["request", "world"]) || !absolute(payload.world))
    return null;
  try {
    return {
      id,
      action,
      world: payload.world,
      request: decodeTaskMutationRequest(action, payload.request),
    };
  } catch {
    return null;
  }
}

const CLAIM_DECODERS: Readonly<
  Record<string, (id: string, payload: Readonly<Record<string, unknown>>) => StructuralRequestClaim | null>
> = {
  "akuma.call": decodeCall,
  "akuma.wait": decodeWait,
  "akuma.tell": decodeTell,
  "akuma.kill": decodeKill,
  "contract.deliver": decodeDeliver,
  "contract.review": decodeReview,
};

export function decodeClaim(bytes: string, fileId: string): StructuralRequestClaim | null {
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
    value.id !== fileId ||
    typeof value.id !== "string" ||
    !UUID.test(value.id)
  )
    return null;
  const payload = object(value.payload);
  if (payload === null || typeof value.action !== "string") return null;
  const decoder = CLAIM_DECODERS[value.action];
  return decoder === undefined ? decodeTask(value.id, value.action, payload) : decoder(value.id, payload);
}

function outcome(value: unknown): UpstreamRequestOutcome | null {
  const input = object(value);
  if (input?.kind === "returned" && exactKeys(input, ["kind", "result"])) {
    return { kind: input.kind, result: input.result };
  }
  const failure = object(input?.failure);
  if (input?.kind !== "failed" || !exactKeys(input, ["failure", "kind"]) || failure === null) return null;
  if (failure.kind === "akuma-not-born" && exactKeys(failure, ["id", "kind"])) {
    const id = canonicalAkuId(failure.id);
    return id === null ? null : { kind: input.kind, failure: { kind: failure.kind, id } };
  }
  return failure.kind === "failed" &&
    exactKeys(failure, ["diagnostic", "kind"]) &&
    typeof failure.diagnostic === "string"
    ? { kind: input.kind, failure: { kind: failure.kind, diagnostic: failure.diagnostic } }
    : null;
}

function envelope(
  value: Readonly<Record<string, unknown>>,
  id: string,
  action: RequestClaim["action"],
): RequestReceipt | null {
  if (
    value.state === "refused" &&
    exactKeys(value, ["action", "diagnostic", "id", "state"]) &&
    typeof value.diagnostic === "string"
  ) {
    return { id, action, state: value.state, diagnostic: value.diagnostic };
  }
  if (
    value.state === "voided" &&
    exactKeys(value, ["action", "evidence", "id", "state"]) &&
    typeof value.evidence === "string"
  ) {
    return { id, action, state: value.state, evidence: value.evidence };
  }
  if (action !== "akuma.call" && value.state === "served" && exactKeys(value, ["action", "id", "outcome", "state"])) {
    const decoded = outcome(value.outcome);
    return decoded === null ? null : { id, action, state: value.state, outcome: decoded };
  }
  return null;
}

function reference(
  value: unknown,
  action: "contract.deliver" | "contract.review",
): ForwardedDeliveryReference | ForwardedReviewReference | null {
  const input = object(value);
  const field = action === "contract.deliver" ? "deliveryFactId" : "reviewFactId";
  if (
    input === null ||
    !exactKeys(input, ["contractId", field, "kind", "repoRoot"]) ||
    input.kind !== "accepted-reference" ||
    !absolute(input.repoRoot) ||
    contractId(input.contractId) === null ||
    typeof input[field] !== "string" ||
    input[field].trim().length === 0
  )
    return null;
  return action === "contract.deliver"
    ? {
        kind: input.kind,
        repoRoot: input.repoRoot,
        contractId: input.contractId as string,
        deliveryFactId: input.deliveryFactId as string,
      }
    : {
        kind: input.kind,
        repoRoot: input.repoRoot,
        contractId: input.contractId as string,
        reviewFactId: input.reviewFactId as string,
      };
}

function decodeCallReceipt(value: Readonly<Record<string, unknown>>, id: string): RequestReceipt | null {
  if (value.state !== "served" || !exactKeys(value, ["action", "child", "id", "state"])) return null;
  const child = canonicalAkuId(value.child);
  return child === null ? null : { id, action: "akuma.call", state: value.state, child };
}

function decodeContractReceipt(
  value: Readonly<Record<string, unknown>>,
  id: string,
  action: "contract.deliver" | "contract.review",
): RequestReceipt | null {
  if (value.state !== "served" || !exactKeys(value, ["action", "id", "reference", "state"])) return null;
  const selected = reference(value.reference, action);
  if (selected === null) return null;
  return action === "contract.deliver"
    ? { id, action, state: value.state, reference: selected as ForwardedDeliveryReference }
    : { id, action, state: value.state, reference: selected as ForwardedReviewReference };
}

function decodeTaskReceipt(
  value: Readonly<Record<string, unknown>>,
  id: string,
  action: TaskMutationAction,
): RequestReceipt | null {
  if (value.state !== "served" || !exactKeys(value, ["action", "id", "reference", "state"])) return null;
  const selected = object(value.reference);
  if (
    selected === null ||
    !exactKeys(selected, ["action", "kind"]) ||
    selected.kind !== "served-reference" ||
    selected.action !== action
  )
    return null;
  return { id, action, state: value.state, reference: { kind: selected.kind, action } };
}

export function decodeReceipt(bytes: string, id: string, action: RequestClaim["action"]): RequestReceipt | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes);
  } catch {
    return null;
  }
  const value = object(decoded);
  if (value === null || value.id !== id || value.action !== action) return null;
  const shared = envelope(value, id, action);
  if (shared !== null) return shared;
  if (action === "akuma.call") return decodeCallReceipt(value, id);
  if (action === "contract.deliver" || action === "contract.review") return decodeContractReceipt(value, id, action);
  if (isTaskMutationAction(action)) return decodeTaskReceipt(value, id, action);
  return null;
}

export function requestPayload(claim: RequestClaim): unknown {
  if (isTaskMutationAction(claim.action)) {
    const task = claim as TaskRequestClaim;
    const { action: _action, ...request } = task.request;
    return { world: task.world, request };
  }
  const { id: _id, action: _action, ...payload } = claim;
  return payload;
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
