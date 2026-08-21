import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { abortableDelay } from "./abort.js";
import { AKUMA_REQUESTS_ENV } from "./provider.js";
import {
  absolute,
  atomicJson,
  decodeReceipt,
  receiptPath,
  requestPath,
  requestPayload,
  type CallRequestClaim,
  type DeliverRequestClaim,
  type ForwardedDeliveryReference,
  type ForwardedReviewReference,
  type KillRequestClaim,
  type RequestClaim,
  type RequestReceipt,
  type ReviewRequestClaim,
  type TellRequestClaim,
  type UpstreamRequestOutcome,
  type WaitRequestClaim,
} from "./request-wire.js";
import { isTaskMutationAction, type TaskMutationRequest } from "../task/mutation.js";

export type { UpstreamRequestOutcome } from "./request-wire.js";

const POLL_MS = 100;

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

export function injectedBodyRequests(): string | null {
  const directory = process.env[AKUMA_REQUESTS_ENV];
  if (directory === undefined) return null;
  if (!absolute(directory)) throw new Error(`${AKUMA_REQUESTS_ENV} must be an absolute normalized path`);
  return directory;
}

async function requestBody(
  input: Readonly<{
    directory: string;
    claim: RequestClaim;
    signal?: AbortSignal;
  }>,
): Promise<RequestReceipt> {
  input.signal?.throwIfAborted();
  await atomicJson(requestPath(input.directory, input.claim.id), {
    id: input.claim.id,
    action: input.claim.action,
    payload: requestPayload(input.claim),
  });
  const path = receiptPath(input.directory, input.claim.id);
  for (;;) {
    try {
      const receipt = decodeReceipt(await readFile(path, "utf8"), input.claim.id, input.claim.action);
      if (receipt === null) throw new Error(`Akuma body request ${input.claim.id} has an invalid receipt`);
      if (receipt.state === "refused") throw new AkumaBodyRequestError("refused", receipt.diagnostic);
      if (receipt.state === "voided") throw new AkumaBodyRequestError("voided", receipt.evidence);
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      !(await access(input.directory).then(
        () => true,
        () => false,
      ))
    ) {
      throw new AkumaBodyRequestError("voided", "parent request channel closed before a receipt");
    }
    await abortableDelay(POLL_MS, input.signal);
  }
}

export async function requestBodyCall(
  input: Omit<CallRequestClaim, "action"> & Readonly<{ directory: string }>,
): Promise<import("./identity.js").AkuId> {
  const { directory, ...claim } = input;
  const receipt = await requestBody({ directory, claim: { ...claim, action: "akuma.call" } });
  if (receipt.action !== "akuma.call" || receipt.state !== "served") {
    throw new Error(`Akuma body request ${input.id} returned the wrong action`);
  }
  return receipt.child;
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
  return receipt.outcome;
}

export async function requestBodyTask(
  input: Readonly<{
    directory: string;
    world: string;
    request: TaskMutationRequest;
    id?: string;
  }>,
): Promise<unknown> {
  const id = input.id ?? randomUUID();
  const receipt = await requestBody({
    directory: input.directory,
    claim: { id, action: input.request.action, world: input.world, request: input.request },
  });
  if (!isTaskMutationAction(receipt.action) || receipt.action !== input.request.action || receipt.state !== "served") {
    throw new Error(`Akuma body request ${id} returned the wrong action`);
  }
  if ("reference" in receipt) return receipt.reference;
  if (receipt.outcome.kind === "returned") return receipt.outcome.result;
  throw new Error(
    receipt.outcome.failure.kind === "failed"
      ? receipt.outcome.failure.diagnostic
      : "Akuma body request parent is not born",
  );
}

export async function requestBodyWait(
  input: Omit<WaitRequestClaim, "action" | "id"> & Readonly<{ directory: string; id?: string }>,
): Promise<UpstreamRequestOutcome> {
  const { directory, id = randomUUID(), ...claim } = input;
  return await requestUpstream(directory, { ...claim, id, action: "akuma.wait" });
}

export async function requestBodyTell(
  input: Omit<TellRequestClaim, "action" | "id"> & Readonly<{ directory: string; id?: string }>,
): Promise<UpstreamRequestOutcome> {
  const { directory, id = randomUUID(), ...claim } = input;
  return await requestUpstream(directory, { ...claim, id, action: "akuma.tell" });
}

export async function requestBodyKill(
  input: Omit<KillRequestClaim, "action" | "id"> & Readonly<{ directory: string; id?: string }>,
): Promise<UpstreamRequestOutcome> {
  const { directory, id = randomUUID(), ...claim } = input;
  return await requestUpstream(directory, { ...claim, id, action: "akuma.kill" });
}

type ContractRequestInput<T extends DeliverRequestClaim | ReviewRequestClaim> = Omit<T, "action" | "id"> &
  Readonly<{ directory: string; signal?: AbortSignal }>;
type ContractClaim<T extends "contract.deliver" | "contract.review"> = Extract<RequestClaim, { action: T }>;

async function requestContract<T extends "contract.deliver" | "contract.review">(
  input: ContractRequestInput<ContractClaim<T>> & Readonly<{ id?: string }>,
  action: T,
): Promise<
  UpstreamRequestOutcome | (T extends "contract.deliver" ? ForwardedDeliveryReference : ForwardedReviewReference)
> {
  const { directory, id = randomUUID(), signal, ...claim } = input;
  const receipt = await requestBody({
    directory,
    claim: { ...claim, id, action } as ContractClaim<T>,
    ...(signal === undefined ? {} : { signal }),
  });
  if (receipt.action !== action || receipt.state !== "served") {
    throw new Error(`Akuma body request ${id} returned the wrong action`);
  }
  return "reference" in receipt
    ? (receipt.reference as T extends "contract.deliver" ? ForwardedDeliveryReference : ForwardedReviewReference)
    : receipt.outcome;
}

type BodyDeliverInput = ContractRequestInput<DeliverRequestClaim>;
export function requestBodyDeliver(input: BodyDeliverInput & Readonly<{ id?: never }>): Promise<UpstreamRequestOutcome>;
export function requestBodyDeliver(
  input: BodyDeliverInput & Readonly<{ id: string }>,
): Promise<UpstreamRequestOutcome | ForwardedDeliveryReference>;
export async function requestBodyDeliver(
  input: BodyDeliverInput & Readonly<{ id?: string }>,
): Promise<UpstreamRequestOutcome | ForwardedDeliveryReference> {
  return await requestContract(input, "contract.deliver");
}

type BodyReviewInput = ContractRequestInput<ReviewRequestClaim>;
export function requestBodyReview(input: BodyReviewInput & Readonly<{ id?: never }>): Promise<UpstreamRequestOutcome>;
export function requestBodyReview(
  input: BodyReviewInput & Readonly<{ id: string }>,
): Promise<UpstreamRequestOutcome | ForwardedReviewReference>;
export async function requestBodyReview(
  input: BodyReviewInput & Readonly<{ id?: string }>,
): Promise<UpstreamRequestOutcome | ForwardedReviewReference> {
  return await requestContract(input, "contract.review");
}
