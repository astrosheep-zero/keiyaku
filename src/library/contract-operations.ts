import { contractId, type ContractId } from "../core/facts/types.js";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import { eraseRequestCommand, type ErasedRequestCommand, type RequestCommand } from "../akuma/request-wire.js";
import {
  isForwardedDeliveryReceipt,
  isForwardedReviewReceipt,
  type AttestationVerdict,
  type ForwardedDeliveryReceipt,
  type ForwardedReviewReceipt,
} from "./contract-forwarding.js";
import { isAbsolute, resolve } from "node:path";

type ReturnedContractRequest = Readonly<{ kind: "returned"; result: unknown; requestId: string; action: string }>;

export type ContractRequest =
  | Readonly<{
      action: "contract.deliver";
      repoRoot: string;
      contractId: string;
      message?: string;
      includeDirty: boolean;
      materializeConflict: boolean;
    }>
  | Readonly<{
      action: "contract.review";
      repoRoot: string;
      contractId: string;
      verdict: AttestationVerdict;
      summary?: string;
    }>;
type DeliverRequest = Extract<ContractRequest, { action: "contract.deliver" }>;
type ReviewRequest = Extract<ContractRequest, { action: "contract.review" }>;
export type ContractService =
  | Readonly<{ kind: "accepted-reference"; repoRoot: string; contractId: string; deliveryFactId: string }>
  | Readonly<{ kind: "accepted-reference"; repoRoot: string; contractId: string; reviewFactId: string }>;
export type ContractRequestPort = Readonly<{
  deliver(
    input: DeliverRequest & Readonly<{ requester: string; signal: AbortSignal }>,
  ): Promise<Readonly<{ result: ForwardedDeliveryReceipt; deliveryFactId?: string }>>;
  review(
    input: ReviewRequest & Readonly<{ requester: string; signal: AbortSignal }>,
  ): Promise<Readonly<{ result: ForwardedReviewReceipt; reviewFactId?: string }>>;
}>;
type ContractExecutionContext = Readonly<{ requester: string; signal: AbortSignal; upstream: ContractRequestPort }>;

function decodeContractExecutionContext(value: unknown): ContractExecutionContext {
  const context = contractPayload(value);
  if (
    context === null ||
    typeof context.requester !== "string" ||
    context.requester.trim() === "" ||
    !isAbortSignal(context.signal) ||
    !isContractRequestPort(context.upstream)
  )
    throw new Error("invalid Contract execution context");
  return { requester: context.requester, signal: context.signal, upstream: context.upstream };
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { throwIfAborted?: unknown }).throwIfAborted === "function"
  );
}

function isContractRequestPort(value: unknown): value is ContractRequestPort {
  const port = contractPayload(value);
  return port !== null && (typeof port.deliver === "function" || typeof port.review === "function");
}

function contractPayload(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function exactContractKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function absolute(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function contractRequestBase(
  input: Readonly<Record<string, unknown>>,
): Readonly<{ repoRoot: string; contractId: ContractId }> | null {
  if (!absolute(input.repoRoot) || typeof input.contractId !== "string") return null;
  let id: ContractId;
  try {
    id = contractId(input.contractId);
  } catch {
    return null;
  }
  return { repoRoot: input.repoRoot, contractId: id };
}

function optionalPayloadText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function decodeDeliverRequest(input: Readonly<Record<string, unknown>>): DeliverRequest | null {
  const message = optionalPayloadText(input.message);
  if (
    message === null ||
    !exactContractKeys(input, [
      "contractId",
      "includeDirty",
      "materializeConflict",
      "repoRoot",
      ...(message === undefined ? [] : ["message"]),
    ]) ||
    typeof input.includeDirty !== "boolean" ||
    typeof input.materializeConflict !== "boolean"
  )
    return null;
  const base = contractRequestBase(input);
  return base === null
    ? null
    : {
        action: "contract.deliver",
        ...base,
        includeDirty: input.includeDirty,
        materializeConflict: input.materializeConflict,
        ...(message === undefined ? {} : { message }),
      };
}

function decodeReviewRequest(input: Readonly<Record<string, unknown>>): ReviewRequest | null {
  const summary = optionalPayloadText(input.summary);
  if (
    summary === null ||
    !exactContractKeys(input, ["contractId", "repoRoot", "verdict", ...(summary === undefined ? [] : ["summary"])]) ||
    (input.verdict !== "satisfied" && input.verdict !== "unsatisfied")
  )
    return null;
  const base = contractRequestBase(input);
  return base === null
    ? null
    : { action: "contract.review", ...base, verdict: input.verdict, ...(summary === undefined ? {} : { summary }) };
}

function decodeContractRequest(action: ContractRequest["action"], value: unknown): ContractRequest | null {
  const input = contractPayload(value);
  if (input === null) return null;
  return action === "contract.deliver" ? decodeDeliverRequest(input) : decodeReviewRequest(input);
}

function decodeContractService(action: ContractRequest["action"], value: unknown): ContractService {
  const service = contractPayload(value);
  const field = action === "contract.deliver" ? "deliveryFactId" : "reviewFactId";
  if (
    service === null ||
    !exactContractKeys(service, ["contractId", "kind", "repoRoot", field]) ||
    service.kind !== "accepted-reference" ||
    !absolute(service.repoRoot) ||
    typeof service.contractId !== "string" ||
    typeof service[field] !== "string" ||
    service[field].trim().length === 0
  )
    throw new Error(`malformed stored Contract service evidence for ${action}`);
  return action === "contract.deliver"
    ? {
        kind: service.kind,
        repoRoot: service.repoRoot,
        contractId: contractId(service.contractId),
        deliveryFactId: service.deliveryFactId as string,
      }
    : {
        kind: service.kind,
        repoRoot: service.repoRoot,
        contractId: contractId(service.contractId),
        reviewFactId: service.reviewFactId as string,
      };
}

export function contractRequestCommand(
  action: ContractRequest["action"],
): RequestCommand<ContractRequest, unknown, ContractService, ContractService, ContractExecutionContext> {
  return {
    action,
    encodeRequest: (request) => {
      const { action: _action, ...payload } = request;
      return payload;
    },
    decodeRequest: (value) => decodeContractRequest(action, value),
    encodeResult: (value) => value,
    decodeResult: (value) => {
      const valid = action === "contract.deliver" ? isForwardedDeliveryReceipt(value) : isForwardedReviewReceipt(value);
      if (!valid) throw new Error(`transport integrity: Contract ${action} returned an invalid live result`);
      return value;
    },
    encodeService: (service) => service,
    decodeService: (service) => decodeContractService(action, service),
    projectService: (service) => service,
    decodeReference: (reference) => decodeContractService(action, reference),
    isPermitted: (allowed) => allowed.includes(action),
    decodeExecutionContext: decodeContractExecutionContext,
    execute: async (request, context) => {
      if (request.action === "contract.deliver") {
        if (typeof context.upstream.deliver !== "function") throw new Error("invalid Contract execution context");
        const served = await context.upstream.deliver({
          ...request,
          requester: context.requester,
          signal: context.signal,
        });
        const factId = served.deliveryFactId;
        if (factId === undefined)
          throw new Error(`Contract ${request.action} completed without durable service evidence`);
        return {
          result: served.result,
          service: {
            kind: "accepted-reference" as const,
            repoRoot: request.repoRoot,
            contractId: request.contractId,
            deliveryFactId: factId,
          },
        };
      }
      if (typeof context.upstream.review !== "function") throw new Error("invalid Contract execution context");
      const served = await context.upstream.review({
        ...request,
        requester: context.requester,
        signal: context.signal,
      });
      const factId = served.reviewFactId;
      if (factId === undefined)
        throw new Error(`Contract ${request.action} completed without durable service evidence`);
      return {
        result: served.result,
        service: {
          kind: "accepted-reference" as const,
          repoRoot: request.repoRoot,
          contractId: request.contractId,
          reviewFactId: factId,
        },
      };
    },
  };
}

export function contractRequestCommands(): Readonly<
  Record<"contract.deliver" | "contract.review", ErasedRequestCommand>
> {
  return {
    "contract.deliver": eraseRequestCommand(contractRequestCommand("contract.deliver")),
    "contract.review": eraseRequestCommand(contractRequestCommand("contract.review")),
  };
}

export async function requestForwardedContract(
  input: Readonly<{
    directory: string;
    id?: string;
    action: ContractRequest["action"];
    request: ContractRequest;
    signal?: AbortSignal;
  }>,
): Promise<ReturnedContractRequest | ContractService> {
  const command = contractRequestCommand(input.action);
  const response = await requestBodyCommand({
    directory: input.directory,
    ...(input.id === undefined ? {} : { id: input.id }),
    command,
    value: input.request,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return response.kind === "reference" ? response.reference : response;
}

export {
  executeLocalDelivery,
  executeLocalReview,
  executeForwardedDeliver,
  executeForwardedReview,
  forwardedDeliveryReceipt,
  forwardedReviewReceipt,
  requireForwarded,
} from "./contract-forwarding.js";
export type {
  AttestationVerdict,
  DeliveryExecutionInput,
  ForwardedDeliveryReceipt,
  ForwardedMutationReceipt,
  ForwardedReviewReceipt,
  Review,
  ReviewExecutionInput,
} from "./contract-forwarding.js";
