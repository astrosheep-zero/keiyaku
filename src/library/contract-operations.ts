import { contractId } from "../core/facts/types.js";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import { eraseRequestCommand, type ErasedRequestCommand, type RequestCommand } from "../akuma/request-wire.js";
import {
  auditReportSchema,
  auditResultSchema,
  decodeContractLiveFailure,
  deliveryResultSchema,
  encodeContractLiveFailure,
  reviewResultSchema,
} from "./contract-forwarding-result.js";
import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { DeliveryValue } from "./delivery.js";
import type { MutationResult } from "./mutation.js";
import type { Review } from "./contract-forwarding.js";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

type DeliveryResult = MutationResult<DeliveryValue> | IntegrationConflictMaterialized;
type ReviewResult = MutationResult<Review>;
type AuditResult = MutationResult<AuditReport>;
type ContractResult = DeliveryResult | ReviewResult | AuditResult;

const absolutePathSchema = z.string().refine((value) => isAbsolute(value) && resolve(value) === value);
const nonblankStringSchema = z.string().refine((value) => value.trim() !== "");
const contractIdSchema = z.string().transform((value, context) => {
  try {
    return contractId(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected ContractId" });
    return z.NEVER;
  }
});
const contractRequestBaseSchema = z.object({ repoRoot: absolutePathSchema, contractId: contractIdSchema }).strict();
const auditRequestSchema = contractRequestBaseSchema
  .extend({
    includeDirty: z.boolean(),
    showDiff: z.boolean(),
    requireBranchesToBeUpToDate: z.boolean(),
  })
  .transform((request) => ({ action: "contract.audit" as const, ...request }));
const deliverRequestSchema = contractRequestBaseSchema
  .extend({ includeDirty: z.boolean(), materializeConflict: z.boolean(), message: nonblankStringSchema.optional() })
  .transform((request) => ({ action: "contract.deliver" as const, ...request }));
const reviewRequestSchema = contractRequestBaseSchema
  .extend({ verdict: z.enum(["satisfied", "unsatisfied"]), summary: nonblankStringSchema.optional() })
  .transform((request) => ({ action: "contract.review" as const, ...request }));

export type ContractRequest =
  | z.infer<typeof auditRequestSchema>
  | z.infer<typeof deliverRequestSchema>
  | z.infer<typeof reviewRequestSchema>;
type DeliverRequest = Extract<ContractRequest, { action: "contract.deliver" }>;
type ReviewRequest = Extract<ContractRequest, { action: "contract.review" }>;
type AuditRequest = Extract<ContractRequest, { action: "contract.audit" }>;
type ContractResultFor<Action extends ContractRequest["action"]> = Action extends "contract.deliver"
  ? DeliveryResult
  : Action extends "contract.review"
    ? ReviewResult
    : AuditResult;
type ContractRequestFor<Action extends ContractRequest["action"]> = Extract<ContractRequest, { action: Action }>;
const auditServiceSchema = z
  .object({
    kind: z.literal("audit-report"),
    repoRoot: absolutePathSchema,
    contractId: contractIdSchema,
    report: auditReportSchema,
  })
  .strict();
const deliveryReferenceSchema = z
  .object({
    kind: z.literal("accepted-reference"),
    repoRoot: absolutePathSchema,
    contractId: contractIdSchema,
    deliveryFactId: nonblankStringSchema,
  })
  .strict();
const reviewReferenceSchema = z
  .object({
    kind: z.literal("accepted-reference"),
    repoRoot: absolutePathSchema,
    contractId: contractIdSchema,
    reviewFactId: nonblankStringSchema,
  })
  .strict();
const contractServiceSchema = z.union([auditServiceSchema, deliveryReferenceSchema, reviewReferenceSchema]);
export type ContractService = z.infer<typeof contractServiceSchema>;
export type ContractRequestPort = Readonly<{
  audit(
    input: AuditRequest & Readonly<{ requester: string; signal: AbortSignal }>,
  ): Promise<Readonly<{ result: AuditResult; auditReport?: AuditReport }>>;
  deliver(
    input: DeliverRequest & Readonly<{ requester: string; signal: AbortSignal }>,
  ): Promise<Readonly<{ result: DeliveryResult; deliveryFactId?: string }>>;
  review(
    input: ReviewRequest & Readonly<{ requester: string; signal: AbortSignal }>,
  ): Promise<Readonly<{ result: ReviewResult; reviewFactId?: string }>>;
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
  return (
    port !== null &&
    (typeof port.audit === "function" || typeof port.deliver === "function" || typeof port.review === "function")
  );
}

function contractPayload(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function decodeContractRequest(action: ContractRequest["action"], value: unknown): ContractRequest | null {
  const schema =
    action === "contract.audit"
      ? auditRequestSchema
      : action === "contract.deliver"
        ? deliverRequestSchema
        : reviewRequestSchema;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeContractService(action: ContractRequest["action"], value: unknown): ContractService {
  const schema =
    action === "contract.audit"
      ? auditServiceSchema
      : action === "contract.deliver"
        ? deliveryReferenceSchema
        : reviewReferenceSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`malformed stored Contract service evidence for ${action}`);
  return parsed.data;
}

async function executeContractRequest(
  request: ContractRequest,
  context: ContractExecutionContext,
): Promise<Readonly<{ result: ContractResult; service: ContractService }>> {
  if (request.action === "contract.audit") {
    if (typeof context.upstream.audit !== "function") throw new Error("invalid Contract execution context");
    const served = await context.upstream.audit({ ...request, requester: context.requester, signal: context.signal });
    if (served.auditReport === undefined)
      throw new Error(`Contract ${request.action} completed without durable service evidence`);
    return {
      result: served.result,
      service: {
        kind: "audit-report",
        repoRoot: request.repoRoot,
        contractId: request.contractId,
        report: auditReportSchema.parse(served.auditReport),
      },
    };
  }
  if (request.action === "contract.deliver") {
    if (typeof context.upstream.deliver !== "function") throw new Error("invalid Contract execution context");
    const served = await context.upstream.deliver({ ...request, requester: context.requester, signal: context.signal });
    if (served.deliveryFactId === undefined)
      throw new Error(`Contract ${request.action} completed without durable service evidence`);
    return {
      result: served.result,
      service: {
        kind: "accepted-reference",
        repoRoot: request.repoRoot,
        contractId: request.contractId,
        deliveryFactId: served.deliveryFactId,
      },
    };
  }
  if (typeof context.upstream.review !== "function") throw new Error("invalid Contract execution context");
  const served = await context.upstream.review({ ...request, requester: context.requester, signal: context.signal });
  if (served.reviewFactId === undefined)
    throw new Error(`Contract ${request.action} completed without durable service evidence`);
  return {
    result: served.result,
    service: {
      kind: "accepted-reference",
      repoRoot: request.repoRoot,
      contractId: request.contractId,
      reviewFactId: served.reviewFactId,
    },
  };
}

function decodedContractResult(action: ContractRequest["action"], value: unknown): ContractResult {
  const schema =
    action === "contract.audit"
      ? auditResultSchema
      : action === "contract.deliver"
        ? deliveryResultSchema
        : reviewResultSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`transport integrity: Contract ${action} returned an invalid live result`);
  return parsed.data;
}

export function contractRequestCommand(
  action: ContractRequest["action"],
): RequestCommand<ContractRequest, ContractResult, ContractService, ContractService, ContractExecutionContext> {
  return {
    action,
    encodeRequest: (request) => {
      const { action: _action, ...payload } = request;
      return payload;
    },
    decodeRequest: (value) => decodeContractRequest(action, value),
    encodeResult: (value) => value,
    decodeResult: (value) => decodedContractResult(action, value),
    encodeFailure: encodeContractLiveFailure,
    decodeFailure: decodeContractLiveFailure,
    encodeService: (service) => decodeContractService(action, service),
    decodeService: (service) => decodeContractService(action, service),
    projectService: (service) => decodeContractService(action, service),
    decodeReference: (reference) => decodeContractService(action, reference),
    isPermitted: (allowed) => allowed.includes(action),
    decodeExecutionContext: decodeContractExecutionContext,
    execute: executeContractRequest,
  };
}

export function contractRequestCommands(): Readonly<
  Record<"contract.audit" | "contract.deliver" | "contract.review", ErasedRequestCommand>
> {
  return {
    "contract.audit": eraseRequestCommand(contractRequestCommand("contract.audit")),
    "contract.deliver": eraseRequestCommand(contractRequestCommand("contract.deliver")),
    "contract.review": eraseRequestCommand(contractRequestCommand("contract.review")),
  };
}

export async function requestForwardedContract<Action extends ContractRequest["action"]>(
  input: Readonly<{
    directory: string;
    id?: string;
    action: Action;
    request: ContractRequestFor<Action>;
    signal?: AbortSignal;
  }>,
): Promise<ContractResultFor<Action> | ContractService> {
  const command = contractRequestCommand(input.action);
  const response = await requestBodyCommand({
    directory: input.directory,
    ...(input.id === undefined ? {} : { id: input.id }),
    command,
    value: input.request,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.kind === "reference") return response.reference;
  return response.result as ContractResultFor<Action>;
}

export async function requestForwardedContractLive<Action extends ContractRequest["action"]>(
  input: Readonly<{
    directory: string;
    action: Action;
    request: ContractRequestFor<Action>;
    signal?: AbortSignal;
  }>,
): Promise<ContractResultFor<Action>> {
  const command = contractRequestCommand(input.action);
  const response = await requestBodyCommand({
    directory: input.directory,
    command,
    value: input.request,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (response.kind === "reference") {
    throw new Error(
      `transport integrity: request ${response.requestId} action ${response.action} returned a durable reference without a live result`,
    );
  }
  return response.result as ContractResultFor<Action>;
}

export {
  executeLocalDelivery,
  executeLocalReview,
  executeForwardedAudit,
  executeForwardedDeliver,
  executeForwardedReview,
} from "./contract-forwarding.js";
export type {
  AttestationVerdict,
  DeliveryExecutionInput,
  Review,
  ReviewExecutionInput,
} from "./contract-forwarding.js";
