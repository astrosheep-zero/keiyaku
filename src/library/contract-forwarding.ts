import type { ActorId, ContractId } from "../core/facts/types.js";
import type { ExecutionObserver } from "./keiyaku.js";
import type { AuditReport } from "../protocol/audit.js";
import type { AttestationVerdict } from "./contract-types.js";
import { Keiyaku, type AuditOutcome, type DeliverOutcome, type ReviewOutcome } from "./keiyaku.js";
import type { Repo } from "./repo.js";

export type { AttestationVerdict } from "./contract-types.js";
export type { Review } from "./keiyaku.js";

type CompositionInput = Readonly<{ hooks: NonNullable<Parameters<typeof Keiyaku.with>[0]>["hooks"] }>;

export async function executeForwardedDeliver(
  input: Readonly<{
    repo: Repo;
    contractId: ContractId;
    requester: ActorId;
    message?: string;
    includeDirty: boolean;
    materializeConflict: boolean;
    overwrite?: boolean;
    requireBranchesToBeUpToDate: boolean;
    hooks: CompositionInput["hooks"];
    signal?: AbortSignal;
    observe?: ExecutionObserver;
  }>,
): Promise<Readonly<{ result: DeliverOutcome; deliveryFactId?: string }>> {
  const result = await Keiyaku.with({
    actor: input.requester,
    requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  })
    .select({ repo: input.repo, id: input.contractId })
    .deliver(
      {
        includeDirty: input.includeDirty,
        materializeConflict: input.materializeConflict,
        ...(input.message === undefined ? {} : { message: input.message }),
        ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      input.observe === undefined ? undefined : { observe: input.observe },
    );
  if (result.kind !== "accepted") return { result };
  if (result.value.leading === undefined) throw new Error("accepted delivery is missing its leading provenance");
  return { result, deliveryFactId: result.value.leading.fact };
}

export async function executeForwardedReview(
  input: Readonly<{
    repo: Repo;
    contractId: ContractId;
    requester: ActorId;
    verdict: AttestationVerdict;
    summary?: string;
    signal?: AbortSignal;
    hooks: CompositionInput["hooks"];
    observe?: ExecutionObserver;
  }>,
): Promise<Readonly<{ result: ReviewOutcome; reviewFactId?: string }>> {
  const result = await Keiyaku.with({
    actor: input.requester,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  })
    .select({ repo: input.repo, id: input.contractId })
    .review(
      {
        verdict: input.verdict,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      input.observe === undefined ? undefined : { observe: input.observe },
    );
  if (result.kind !== "accepted") return { result };
  const review = result.facts.find((fact) => fact.contract === input.contractId && fact.kind === "attestation");
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
    hooks: CompositionInput["hooks"];
    signal?: AbortSignal;
    observe?: ExecutionObserver;
  }>,
): Promise<Readonly<{ result: AuditOutcome; auditReport?: AuditReport }>> {
  const result = await Keiyaku.with({
    actor: input.requester,
    requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  })
    .select({ repo: input.repo, id: input.contractId })
    .audit(
      {
        includeDirty: input.includeDirty,
        showDiff: input.showDiff,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      input.observe === undefined ? undefined : { observe: input.observe },
    );
  return result.kind === "accepted" ? { result, auditReport: result.value } : { result };
}
