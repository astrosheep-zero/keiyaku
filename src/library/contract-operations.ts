import { contractId, snapshotId } from "../core/facts/types.js";
import { requestBodyCommand } from "../akuma/request-rendezvous.js";
import {
  eraseRequestCommand,
  type ErasedRequestCommand,
  type ExecutionFacts,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "../akuma/request-wire.js";
import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { DeliveryValue } from "./delivery.js";
import {
  auditReportSchema,
  auditResultSchema,
  deliveryResultSchema,
  reviewResultSchema,
  type MutationResult,
} from "./mutation.js";
import { decodeContractLiveFailure, encodeContractLiveFailure } from "./refusal.js";
import type { DeliveryExecutionInput, Review } from "./contract-forwarding.js";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

type DeliveryResult = MutationResult<DeliveryValue> | IntegrationConflictMaterialized;
type ReviewResult = MutationResult<Review>;
type AuditResult = MutationResult<AuditReport>;
type ContractResult = DeliveryResult | ReviewResult | AuditResult;
type ContractRequester = NonNullable<DeliveryExecutionInput["actor"]>;

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
const snapshotIdSchema = z.string().transform((value, context) => {
  try {
    return snapshotId(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected SnapshotId" });
    return z.NEVER;
  }
});
const contractRequestBaseSchema = z.object({ repoRoot: absolutePathSchema, contractId: contractIdSchema }).strict();
const auditRequestSchema = contractRequestBaseSchema
  .extend({
    includeDirty: z.boolean(),
    showDiff: z.boolean(),
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
const materializedHandoffServiceSchema = z
  .object({
    kind: z.literal("materialized-handoff"),
    repoRoot: absolutePathSchema,
    contractId: contractIdSchema,
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(nonblankStringSchema).transform((paths) => Object.freeze(paths) as readonly string[]),
    workspace: z.object({ kind: z.literal("worktree"), path: nonblankStringSchema }).strict(),
  })
  .strict();
const materializedHandoffReferenceSchema = z
  .object({
    kind: z.literal("integration-conflict-materialized"),
    targetHead: snapshotIdSchema,
    conflictPaths: z.array(nonblankStringSchema).transform((paths) => Object.freeze(paths) as readonly string[]),
    workspace: z.object({ kind: z.literal("worktree"), path: nonblankStringSchema }).strict(),
  })
  .strict() satisfies z.ZodType<IntegrationConflictMaterialized>;
const contractServiceSchema = z.union([
  auditServiceSchema,
  deliveryReferenceSchema,
  materializedHandoffServiceSchema,
  reviewReferenceSchema,
]);
export type ContractService = z.infer<typeof contractServiceSchema>;
type ContractReference = ContractService | z.infer<typeof materializedHandoffReferenceSchema>;
export type ContractRequestPort = Readonly<{
  audit(
    input: AuditRequest & Readonly<{ requester: ContractRequester; signal: AbortSignal }>,
  ): Promise<Readonly<{ result: AuditResult; auditReport?: AuditReport }>>;
  deliver(
    input: DeliverRequest & Readonly<{ requester: ContractRequester; signal: AbortSignal }>,
  ): Promise<Readonly<{ result: DeliveryResult; deliveryFactId?: string }>>;
  review(
    input: ReviewRequest & Readonly<{ requester: ContractRequester; signal: AbortSignal }>,
  ): Promise<Readonly<{ result: ReviewResult; reviewFactId?: string }>>;
}>;
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
        ? z.union([deliveryReferenceSchema, materializedHandoffServiceSchema])
        : reviewReferenceSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`malformed stored Contract service evidence for ${action}`);
  return parsed.data;
}

function projectContractService(action: ContractRequest["action"], service: ContractService): ContractReference {
  if (action === "contract.deliver" && service.kind === "materialized-handoff") {
    const { kind: _kind, repoRoot: _repoRoot, contractId: _contractId, ...handoff } = service;
    return { kind: "integration-conflict-materialized", ...handoff };
  }
  return service;
}

function decodeContractReference(action: ContractRequest["action"], value: unknown): ContractReference {
  if (action !== "contract.deliver") return decodeContractService(action, value);
  const parsed = z.union([deliveryReferenceSchema, materializedHandoffReferenceSchema]).safeParse(value);
  if (!parsed.success) throw new Error(`malformed stored Contract service evidence for ${action}`);
  return parsed.data;
}

async function executeContractRequest(
  request: ContractRequest,
  facts: ExecutionFacts,
  port: ContractRequestPort,
): Promise<Readonly<{ result: ContractResult; service: ContractService }>> {
  if (request.action === "contract.audit") {
    const served = await port.audit({
      ...request,
      requester: facts.requester as ContractRequester,
      signal: facts.signal,
    });
    if (served.auditReport === undefined)
      throw new Error(`Contract ${request.action} completed without durable service evidence`);
    return {
      result: served.result,
      service: {
        kind: "audit-report",
        repoRoot: request.repoRoot,
        contractId: request.contractId,
        report: served.auditReport,
      },
    };
  }
  if (request.action === "contract.deliver") {
    const served = await port.deliver({
      ...request,
      requester: facts.requester as ContractRequester,
      signal: facts.signal,
    });
    if ("kind" in served.result && served.result.kind === "integration-conflict-materialized") {
      return {
        result: served.result,
        service: {
          kind: "materialized-handoff",
          repoRoot: request.repoRoot,
          contractId: request.contractId,
          targetHead: served.result.targetHead,
          conflictPaths: served.result.conflictPaths,
          workspace: served.result.workspace,
        },
      };
    }
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
  const served = await port.review({
    ...request,
    requester: facts.requester as ContractRequester,
    signal: facts.signal,
  });
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

export function contractRequestProtocol(
  action: ContractRequest["action"],
): RequestProtocol<ContractRequest, ContractResult, ContractReference> {
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
    decodeReference: (reference) => decodeContractReference(action, reference),
    isPermitted: (allowed) => allowed.includes(action),
  };
}

export function contractRequestCommand(
  action: ContractRequest["action"],
  port: ContractRequestPort,
): ServiceRequestCommand<ContractRequest, ContractResult, ContractService, ContractReference> {
  return {
    completion: "service",
    protocol: contractRequestProtocol(action),
    encodeService: (service) => service,
    decodeService: (service) => decodeContractService(action, service),
    projectService: (service) => projectContractService(action, service),
    execute: async (request, facts) => await executeContractRequest(request, facts, port),
  };
}

export function contractRequestCommands(
  port: ContractRequestPort,
): Readonly<Record<"contract.audit" | "contract.deliver" | "contract.review", ErasedRequestCommand>> {
  return {
    "contract.audit": eraseRequestCommand(contractRequestCommand("contract.audit", port)),
    "contract.deliver": eraseRequestCommand(contractRequestCommand("contract.deliver", port)),
    "contract.review": eraseRequestCommand(contractRequestCommand("contract.review", port)),
  };
}

export async function requestForwardedContractLive<Action extends ContractRequest["action"]>(
  input: Readonly<{
    directory: string;
    action: Action;
    request: ContractRequestFor<Action>;
    signal?: AbortSignal;
  }>,
): Promise<ContractResultFor<Action>> {
  const command = contractRequestProtocol(input.action);
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
