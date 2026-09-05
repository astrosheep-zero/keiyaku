import type { ActorId, ContractId } from "../core/facts/types.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { AuditReport } from "../protocol/audit.js";
import { auditContract, type AuditComposition } from "./audit.js";
import { executeLocalDelivery, executeLocalReview, type AttestationVerdict } from "./contract-execution.js";
import type { DeliveryValue } from "./delivery.js";
import type { MutationResult, Review } from "./mutation.js";
import { Repo, scopeForRepo } from "./repo.js";

export { executeLocalDelivery, executeLocalReview } from "./contract-execution.js";
export type { AttestationVerdict, DeliveryExecutionInput, ReviewExecutionInput } from "./contract-execution.js";
export type { Review } from "./mutation.js";

export async function executeForwardedDeliver(
  input: Readonly<{
    repo: Repo;
    contractId: ContractId;
    requester: ActorId;
    message?: string;
    includeDirty: boolean;
    materializeConflict: boolean;
    requireBranchesToBeUpToDate: boolean;
    hooks: Parameters<typeof executeLocalDelivery>[0]["hooks"];
    signal?: AbortSignal;
  }>,
): Promise<
  Readonly<{ result: MutationResult<DeliveryValue> | IntegrationConflictMaterialized; deliveryFactId?: string }>
> {
  const result = await executeLocalDelivery({
    scope: scopeForRepo(input.repo),
    contractId: input.contractId,
    actor: input.requester,
    ...(input.message === undefined ? {} : { message: input.message }),
    requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
    includeDirty: input.includeDirty,
    materializeConflict: input.materializeConflict,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    hooks: input.hooks,
  });
  if (result.kind !== "accepted") return { result };
  const delivery = result.facts.find((fact) => fact.kind === "deliver");
  if (delivery === undefined) throw new Error("accepted delivery is missing its journal fact");
  return { result, deliveryFactId: delivery.entry };
}

export async function executeForwardedReview(
  input: Readonly<{
    repo: Repo;
    contractId: ContractId;
    requester: ActorId;
    verdict: AttestationVerdict;
    summary?: string;
    hooks: Parameters<typeof executeLocalReview>[0]["hooks"];
  }>,
): Promise<Readonly<{ result: MutationResult<Review>; reviewFactId?: string }>> {
  const result = await executeLocalReview({
    scope: scopeForRepo(input.repo),
    contractId: input.contractId,
    actor: input.requester,
    verdict: input.verdict,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    hooks: input.hooks,
  });
  const review = result.facts.find((fact) => fact.kind === "attestation");
  if (review === undefined) throw new Error("accepted review is missing its journal fact");
  return { result, reviewFactId: review.entry };
}

export async function executeForwardedAudit(
  input: Readonly<{
    repo: Repo;
    contractId: ContractId;
    requester: ActorId;
    includeDirty: boolean;
    showDiff: boolean;
    requireBranchesToBeUpToDate: boolean;
    hooks: NonNullable<AuditComposition["hooks"]>;
    signal?: AbortSignal;
  }>,
): Promise<Readonly<{ result: MutationResult<AuditReport>; auditReport?: AuditReport }>> {
  const result = await auditContract({
    scope: scopeForRepo(input.repo),
    contractId: input.contractId,
    input: {
      includeDirty: input.includeDirty,
      showDiff: input.showDiff,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    composition: {
      actor: input.requester,
      hooks: input.hooks,
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
    },
  });
  return { result, auditReport: result.value };
}
