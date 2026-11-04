import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { AkumaBodyRequestError, requestBodyCommand } from "../akuma/request-rendezvous.js";
import {
  eraseRequestCommand,
  type ErasedRequestCommand,
  type ExecutionFacts,
  type RequestProtocol,
  type ServiceRequestCommand,
} from "../akuma/request-wire.js";
import type { ActorId } from "../core/facts/types.js";
import { deliveryPreviewReportSchema } from "../protocol/delivery-preview.js";
import { materializedConflictSchema } from "../protocol/deliver.js";
import { observationSchema, observeExecution, type ExecutionObserver } from "../protocol/execution-observation.js";
import { contractIdSchema, entryUlidSchema, snapshotIdSchema, verificationStopSchema } from "../protocol/operations.js";
import { deliveryValueSchema } from "./delivery.js";
import { InvocationAccumulator } from "./invocation.js";
import {
  decodeFailureWire,
  encodeFailureWire,
  KeiyakuError,
  outcomeSchema,
  project,
  reviewSchema,
  verifySchema,
} from "./outcome.js";

type DeliveryResult = import("./contract-outcomes.js").DeliverOutcome;
type ReviewResult = import("./contract-outcomes.js").ReviewOutcome;
type DeliveryPreviewResult = import("./contract-outcomes.js").DeliveryPreviewOutcome;
type VerificationResult = import("./contract-outcomes.js").VerifyOutcome;
type ContractResult = DeliveryResult | ReviewResult | DeliveryPreviewResult | VerificationResult;
type ContractRequester = ActorId;

const absolutePathSchema = z.string().refine((value) => isAbsolute(value) && resolve(value) === value);
const nonblankStringSchema = z.string().refine((value) => value.trim() !== "");
const contractRequestBaseSchema = z.object({ repoRoot: absolutePathSchema, contractId: contractIdSchema }).strict();
const previewRequestSchema = contractRequestBaseSchema
  .extend({
    includeDirty: z.boolean(),
    showDiff: z.boolean(),
  })
  .transform((request) => ({ action: "contract.preview-delivery" as const, ...request }));
const deliverRequestSchema = contractRequestBaseSchema
  .extend({
    includeDirty: z.boolean(),
    materializeConflict: z.boolean(),
    overwrite: z.boolean().optional(),
    message: nonblankStringSchema.optional(),
  })
  .transform((request) => ({ action: "contract.deliver" as const, ...request }));
const verifyRequestSchema = contractRequestBaseSchema
  .extend({ index: z.number().int().positive().optional(), includeDirty: z.boolean() })
  .transform((request) => ({ action: "contract.verify" as const, ...request }));
const reviewRequestSchema = contractRequestBaseSchema
  .extend({
    verdict: z.enum(["satisfied", "unsatisfied"]),
    summary: nonblankStringSchema.optional(),
    actor: z.string().optional(),
  })
  .transform((request) => ({ action: "contract.review" as const, ...request }));

export type ContractRequest =
  | z.infer<typeof previewRequestSchema>
  | z.infer<typeof deliverRequestSchema>
  | z.infer<typeof verifyRequestSchema>
  | z.infer<typeof reviewRequestSchema>;
type DeliverRequest = Extract<ContractRequest, { action: "contract.deliver" }>;
type VerifyRequest = Extract<ContractRequest, { action: "contract.verify" }>;
type ReviewRequest = Extract<ContractRequest, { action: "contract.review" }>;
type DeliveryPreviewRequest = Extract<ContractRequest, { action: "contract.preview-delivery" }>;
type ContractResultFor<Action extends ContractRequest["action"]> = Action extends "contract.deliver"
  ? DeliveryResult
  : Action extends "contract.verify"
    ? VerificationResult
    : Action extends "contract.review"
      ? ReviewResult
      : DeliveryPreviewResult;
type ContractRequestFor<Action extends ContractRequest["action"]> = Extract<ContractRequest, { action: Action }>;
const previewServiceSchema = z
  .object({
    kind: z.literal("delivery-preview-report"),
    repoRoot: absolutePathSchema,
    contractId: contractIdSchema,
    report: deliveryPreviewReportSchema,
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
const verificationCoordinateSchema = z.object({
  index: z.number().int().positive(),
  requirement: nonblankStringSchema,
});
const verificationServiceSchema = z
  .object({
    kind: z.literal("verification-completed"),
    repoRoot: absolutePathSchema,
    contractId: contractIdSchema,
    snapshot: snapshotIdSchema,
    checks: z
      .array(
        z.union([
          verificationCoordinateSchema
            .extend({
              kind: z.enum(["admitted", "reused"]),
              entry: entryUlidSchema,
            })
            .strict(),
          verificationCoordinateSchema
            .extend({
              kind: z.literal("stopped"),
              stage: z.enum(["execution", "admission"]),
              stop: verificationStopSchema,
            })
            .strict(),
        ]),
      )
      .readonly(),
  })
  .strict();
const contractServiceSchema = z.union([
  verificationServiceSchema,
  previewServiceSchema,
  deliveryReferenceSchema,
  materializedHandoffServiceSchema,
  reviewReferenceSchema,
]);
type ContractService = z.infer<typeof contractServiceSchema>;
type ContractReference = ContractService | z.infer<typeof materializedHandoffReferenceSchema>;
export type ContractRequestPort = Readonly<{
  verify(
    input: VerifyRequest & Readonly<{ requester: ContractRequester; signal: AbortSignal; observe?: ExecutionObserver }>,
  ): Promise<VerificationResult>;
  previewDelivery(
    input: DeliveryPreviewRequest &
      Readonly<{ requester: ContractRequester; signal: AbortSignal; observe?: ExecutionObserver }>,
  ): Promise<DeliveryPreviewResult>;
  deliver(
    input: DeliverRequest &
      Readonly<{ requester: ContractRequester; signal: AbortSignal; observe?: ExecutionObserver }>,
  ): Promise<DeliveryResult>;
  review(
    input: ReviewRequest & Readonly<{ requester: ContractRequester; signal: AbortSignal; observe?: ExecutionObserver }>,
  ): Promise<ReviewResult>;
}>;
function decodeContractRequest(action: ContractRequest["action"], value: unknown): ContractRequest | null {
  const schema =
    action === "contract.preview-delivery"
      ? previewRequestSchema
      : action === "contract.deliver"
        ? deliverRequestSchema
        : action === "contract.verify"
          ? verifyRequestSchema
          : reviewRequestSchema;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function decodeContractService(action: ContractRequest["action"], value: unknown): ContractService {
  const schema =
    action === "contract.preview-delivery"
      ? previewServiceSchema
      : action === "contract.deliver"
        ? z.union([deliveryReferenceSchema, materializedHandoffServiceSchema])
        : action === "contract.verify"
          ? verificationServiceSchema
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

function acceptedDeliveryEvidence(result: Extract<DeliveryResult, { kind: "accepted" }>): string {
  const leading = result.value.leading;
  if (leading === undefined) throw new Error("accepted delivery is missing its leading admission evidence");
  return leading.fact;
}

function acceptedReviewEvidence(
  result: Extract<ReviewResult, { kind: "accepted" }>,
  contractId: ContractRequest["contractId"],
): string {
  const review = result.facts.findLast(
    (fact) => fact.contract === contractId && fact.kind === "attestation" && fact.data.gate === "reviewed",
  );
  if (review === undefined) throw new Error("accepted review is missing its addressed journal fact");
  return review.entry;
}

async function executeVerificationRequest(
  request: VerifyRequest,
  facts: ExecutionFacts,
  port: ContractRequestPort,
): Promise<import("../akuma/request-wire.js").ServiceCompletion<VerificationResult, ContractService>> {
  const result = await port.verify({
    ...request,
    ...executionObservation(facts),
    requester: facts.requester as ContractRequester,
    signal: facts.signal,
  });
  if (result.kind !== "accepted") return { kind: "voided", outcome: result };
  return {
    kind: "served",
    result,
    service: {
      kind: "verification-completed",
      repoRoot: request.repoRoot,
      contractId: request.contractId,
      snapshot: result.value.snapshot,
      checks: result.value.checks.map((check) => {
        const coordinate = { index: check.index, requirement: check.requirement };
        if (check.kind === "stopped")
          return { ...coordinate, kind: "stopped" as const, stage: "execution" as const, stop: check.stop };
        const admission = check.admission;
        return admission.kind === "stopped"
          ? { ...coordinate, kind: "stopped" as const, stage: "admission" as const, stop: admission.stop }
          : { ...coordinate, kind: admission.kind, entry: admission.entry };
      }),
    },
  };
}

async function executeContractRequest(
  request: ContractRequest,
  facts: ExecutionFacts,
  port: ContractRequestPort,
): Promise<import("../akuma/request-wire.js").ServiceCompletion<ContractResult, ContractService>> {
  const observation = executionObservation(facts);
  if (request.action === "contract.preview-delivery") {
    const result = await port.previewDelivery({
      ...request,
      ...observation,
      requester: facts.requester as ContractRequester,
      signal: facts.signal,
    });
    if (result.kind !== "accepted") return { kind: "voided", outcome: result };
    return {
      kind: "served",
      result,
      service: {
        kind: "delivery-preview-report",
        repoRoot: request.repoRoot,
        contractId: request.contractId,
        report: result.value,
      },
    };
  }
  if (request.action === "contract.deliver") {
    const result = await port.deliver({
      ...request,
      ...observation,
      overwrite: request.overwrite ?? false,
      requester: facts.requester as ContractRequester,
      signal: facts.signal,
    });
    if (result.kind === "refused" || result.kind === "retry") return { kind: "voided", outcome: result };
    if (result.kind === "handoff") {
      return {
        kind: "served",
        result,
        service: {
          kind: "materialized-handoff",
          repoRoot: request.repoRoot,
          contractId: request.contractId,
          targetHead: result.value.targetHead,
          handoffBase: result.value.handoffBase,
          recovery: result.value.recovery,
          conflictPaths: result.value.conflictPaths,
          workspace: result.value.workspace,
        },
      };
    }
    return {
      kind: "served",
      result,
      service: {
        kind: "accepted-reference",
        repoRoot: request.repoRoot,
        contractId: request.contractId,
        deliveryFactId: acceptedDeliveryEvidence(result),
      },
    };
  }
  if (request.action === "contract.verify") return await executeVerificationRequest(request, facts, port);
  const result = await port.review({
    ...request,
    ...observation,
    requester: facts.requester as ContractRequester,
    signal: facts.signal,
  });
  if (result.kind !== "accepted") return { kind: "voided", outcome: result };
  return {
    kind: "served",
    result,
    service: {
      kind: "accepted-reference",
      repoRoot: request.repoRoot,
      contractId: request.contractId,
      reviewFactId: acceptedReviewEvidence(result, request.contractId),
    },
  };
}

function decodedContractResult(action: ContractRequest["action"], value: unknown): ContractResult {
  const schema =
    action === "contract.preview-delivery"
      ? outcomeSchema("deliver-preview", deliveryPreviewReportSchema)
      : action === "contract.deliver"
        ? outcomeSchema("deliver", deliveryValueSchema, materializedHandoffReferenceSchema)
        : action === "contract.verify"
          ? outcomeSchema("verify", verifySchema)
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
): Readonly<Record<ContractRequest["action"], ErasedRequestCommand>> {
  return {
    "contract.preview-delivery": eraseRequestCommand(contractRequestCommand("contract.preview-delivery", port)),
    "contract.deliver": eraseRequestCommand(contractRequestCommand("contract.deliver", port)),
    "contract.verify": eraseRequestCommand(contractRequestCommand("contract.verify", port)),
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
        observeExecution(input.observe, observationSchema.parse(value));
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
      request.action === "contract.preview-delivery"
        ? "deliver-preview"
        : request.action === "contract.review"
          ? "review"
          : request.action === "contract.verify"
            ? "verify"
            : "deliver";
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
