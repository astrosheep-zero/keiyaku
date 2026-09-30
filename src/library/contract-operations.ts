import { materializedConflictSchema } from "../protocol/deliver.js";
import {
  decodeExecutionObservation,
  observeExecution,
  type ExecutionObserver,
} from "../protocol/execution-observation.js";
import { contractIdSchema } from "../protocol/operations.js";
import { AkumaBodyRequestError, requestBodyCommand } from "../akuma/request-rendezvous.js";
import {
  eraseRequestCommand,
  type ErasedRequestCommand,
  type ExecutionFacts,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "../akuma/request-wire.js";
import type { AuditReport } from "../protocol/audit.js";
import {
  auditReportSchema,
  outcomeSchema,
  reviewSchema,
  decodeFailureWire,
  encodeFailureWire,
  KeiyakuError,
  InvocationAccumulator,
  project,
} from "./outcome.js";
import { deliveryValueSchema } from "./delivery.js";
import type { ActorId } from "../core/facts/types.js";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

type DeliveryResult = import("./keiyaku.js").DeliverOutcome;
type ReviewResult = import("./keiyaku.js").ReviewOutcome;
type AuditResult = import("./keiyaku.js").AuditOutcome;
type ContractResult = DeliveryResult | ReviewResult | AuditResult;
type ContractRequester = ActorId;

const absolutePathSchema = z.string().refine((value) => isAbsolute(value) && resolve(value) === value);
const nonblankStringSchema = z.string().refine((value) => value.trim() !== "");
const contractRequestBaseSchema = z.object({ repoRoot: absolutePathSchema, contractId: contractIdSchema }).strict();
const auditRequestSchema = contractRequestBaseSchema
  .extend({
    includeDirty: z.boolean(),
    showDiff: z.boolean(),
  })
  .transform((request) => ({ action: "contract.audit" as const, ...request }));
const deliverRequestSchema = contractRequestBaseSchema
  .extend({
    includeDirty: z.boolean(),
    materializeConflict: z.boolean(),
    overwrite: z.boolean().optional(),
    message: nonblankStringSchema.optional(),
  })
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
const materializedHandoffReferenceSchema = materializedConflictSchema;
const materializedHandoffServiceSchema = materializedConflictSchema
  .extend({
    kind: z.literal("materialized-handoff"),
    repoRoot: absolutePathSchema,
    contractId: contractIdSchema,
  })
  .strict();
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
    input: AuditRequest & Readonly<{ requester: ContractRequester; signal: AbortSignal; observe?: ExecutionObserver }>,
  ): Promise<Readonly<{ result: AuditResult; auditReport?: AuditReport }>>;
  deliver(
    input: DeliverRequest &
      Readonly<{ requester: ContractRequester; signal: AbortSignal; observe?: ExecutionObserver }>,
  ): Promise<Readonly<{ result: DeliveryResult; deliveryFactId?: string }>>;
  review(
    input: ReviewRequest & Readonly<{ requester: ContractRequester; signal: AbortSignal; observe?: ExecutionObserver }>,
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
  return parsed.data as unknown as ContractService;
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

function executionObservation(facts: ExecutionFacts): Readonly<{ observe?: ExecutionObserver }> {
  if (facts.progress === undefined) return {};
  return { observe: (event) => facts.progress?.(event) };
}

function servedContractReference(
  result: ContractResult,
  service: Extract<ContractService, { kind: "accepted-reference" }>,
): import("../akuma/request-wire.js").ServiceCompletion<ContractResult, ContractService> {
  return { kind: "served", result, service };
}

async function executeContractRequest(
  request: ContractRequest,
  facts: ExecutionFacts,
  port: ContractRequestPort,
): Promise<import("../akuma/request-wire.js").ServiceCompletion<ContractResult, ContractService>> {
  const observation = executionObservation(facts);
  if (request.action === "contract.audit") {
    const served = await port.audit({
      ...request,
      ...observation,
      requester: facts.requester as ContractRequester,
      signal: facts.signal,
    });
    if (served.result.kind !== "accepted") return { kind: "voided", outcome: served.result };
    if (served.auditReport === undefined)
      throw new Error(`Contract ${request.action} completed without durable service evidence`);
    return {
      kind: "served",
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
      ...observation,
      overwrite: request.overwrite ?? false,
      requester: facts.requester as ContractRequester,
      signal: facts.signal,
    });
    if (served.result.kind === "refused" || served.result.kind === "retry")
      return { kind: "voided", outcome: served.result };
    if (served.result.kind === "handoff") {
      return {
        kind: "served",
        result: served.result,
        service: {
          kind: "materialized-handoff",
          repoRoot: request.repoRoot,
          contractId: request.contractId,
          targetHead: served.result.value.targetHead,
          handoffBase: served.result.value.handoffBase,
          recovery: served.result.value.recovery,
          conflictPaths: served.result.value.conflictPaths,
          workspace: served.result.value.workspace,
        },
      };
    }
    if (served.deliveryFactId === undefined)
      throw new Error(`Contract ${request.action} completed without durable service evidence`);
    return servedContractReference(served.result, {
      kind: "accepted-reference",
      repoRoot: request.repoRoot,
      contractId: request.contractId,
      deliveryFactId: served.deliveryFactId,
    });
  }
  const served = await port.review({
    ...request,
    ...observation,
    requester: facts.requester as ContractRequester,
    signal: facts.signal,
  });
  if (served.result.kind !== "accepted") return { kind: "voided", outcome: served.result };
  if (served.reviewFactId === undefined)
    throw new Error(`Contract ${request.action} completed without durable service evidence`);
  return servedContractReference(served.result, {
    kind: "accepted-reference",
    repoRoot: request.repoRoot,
    contractId: request.contractId,
    reviewFactId: served.reviewFactId,
  });
}

function decodedContractResult(action: ContractRequest["action"], value: unknown): ContractResult {
  const schema =
    action === "contract.audit"
      ? outcomeSchema("audit", auditReportSchema)
      : action === "contract.deliver"
        ? outcomeSchema("deliver", deliveryValueSchema, materializedHandoffReferenceSchema)
        : outcomeSchema("review", reviewSchema);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`transport integrity: Contract ${action} returned an invalid live result`);
  return parsed.data as unknown as ContractResult;
}

export function contractRequestProtocol(
  action: ContractRequest["action"],
): RequestProtocol<ContractRequest, ContractResult, ContractReference> {
  return {
    action,
    supportsCancellation: true,
    encodeRequest: (request) => {
      const { action: _action, ...payload } = request;
      return payload;
    },
    decodeRequest: (value) => decodeContractRequest(action, value),
    encodeResult: (value) => value,
    decodeResult: (value) => decodedContractResult(action, value),
    encodeFailure: encodeFailureWire,
    decodeFailure: (value) => decodeFailureWire(value),
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
    observe?: ExecutionObserver;
  }>,
): Promise<ContractResultFor<Action>> {
  const command = contractRequestProtocol(input.action);
  const response = await requestBodyCommand({
    directory: input.directory,
    command,
    value: input.request,
    onProgress: (value) => {
      try {
        observeExecution(input.observe, decodeExecutionObservation(value));
      } catch {
        observeExecution(input.observe, { kind: "progress-dropped", count: 1 });
      }
    },
    onProgressGap: (count) => observeExecution(input.observe, { kind: "progress-dropped", count }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }).catch((error: unknown) => mapForwardedContractFailure(error, input.request));
  if (response.kind === "reference") {
    throw new Error(
      `transport integrity: request ${response.requestId} action ${response.action} returned a durable reference without a live result`,
    );
  }
  return response.result as ContractResultFor<Action>;
}

/** Map durable request disposition without reconstructing an expired owner answer. */
export function mapForwardedContractFailure(error: unknown, request: ContractRequest) {
  if (error instanceof AkumaBodyRequestError && error.outcome === "voided") {
    const operation =
      request.action === "contract.audit" ? "audit" : request.action === "contract.review" ? "review" : "deliver";
    const projected = project(operation, new InvocationAccumulator().snapshot(), {
      kind: "retry",
      contract: request.contractId,
      reason: { kind: "owner-reason-unavailable", diagnostic: error.diagnostic },
    });
    if (projected.kind === "failed") throw projected.error;
    return { kind: "returned" as const, result: projected.outcome };
  }
  if (
    error instanceof AkumaBodyRequestError &&
    error.outcome === "unproven" &&
    error.cause instanceof Error &&
    error.cause instanceof KeiyakuError
  ) {
    Object.defineProperties(error.cause, {
      requestId: { value: error.requestId, enumerable: false },
      action: { value: error.action, enumerable: false },
      requestOutcome: { value: error.outcome, enumerable: false },
    });
    throw error.cause;
  }
  throw error;
}
