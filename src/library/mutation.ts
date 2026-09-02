import type { ContractHead, ContractId, JournalEntry, SnapshotId } from "../core/facts/types.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { ReconcileReport } from "../protocol/reconcile.js";
import type { RepositoryScope } from "../protocol/operations.js";
import type { IntentOutcome } from "../protocol/operations.js";
import type { AcceptedObligations } from "../protocol/outcome.js";
import { deferredTaskHolderSettlement, type SettlementReport } from "../settlement/settle.js";
import type { TaskHolderAdmission } from "../settlement/holder.js";
import type { WorktreeHooks } from "./configuration.js";
import { completeReconcile, type ReconcileCompletion } from "./reconcile.js";
import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { ContinuationReport } from "./continuation.js";
import type { Delivery } from "./delivery.js";
import type { Review } from "./contract-forwarding-result.js";
import type { AmendResult, BindResult } from "./contract-types.js";
import { KeiyakuRefused, KeiyakuRetry } from "./refusal.js";

export type MutationFinalitySurface =
  | "verification"
  | "placement"
  | "continuation"
  | "reconciliation"
  | "settlement"
  | "cleanup";

export type MutationFinality =
  | Readonly<{ kind: "complete" }>
  | Readonly<{
      kind: "accepted-pending";
      pending: readonly Readonly<{ surface: MutationFinalitySurface; required: boolean }>[];
    }>
  | Readonly<{ kind: "not-admitted" }>;

export type MutationFinalityInput =
  | MutationResult<AuditReport>
  | MutationResult<Delivery>
  | MutationResult<Review>
  | MutationResult<void>
  | BindResult
  | AmendResult
  | IntegrationConflictMaterialized
  | KeiyakuRefused
  | KeiyakuRetry;

function pendingSurface(surface: MutationFinalitySurface, required: boolean) {
  return { surface, required } as const;
}

/** Purely projects the leading mutation's finality without changing its details. */
export function projectMutationFinality(input: MutationFinalityInput): MutationFinality {
  if (input instanceof KeiyakuRefused || input instanceof KeiyakuRetry || isIntegrationConflictMaterialized(input)) {
    return { kind: "not-admitted" };
  }
  const pending: Array<Readonly<{ surface: MutationFinalitySurface; required: boolean }>> = [];
  if ("value" in input) {
    const value = input.value;
    if (isAuditReport(value)) {
      if (value.verification.kind === "stopped") pending.push(pendingSurface("verification", true));
      if (input.cleanup !== undefined || input.leak !== undefined) pending.push(pendingSurface("cleanup", false));
    } else if (isCompletionValue(value)) {
      completionPending(value, pending);
      if (
        value.cleanup !== undefined ||
        value.leak !== undefined ||
        input.cleanup !== undefined ||
        input.leak !== undefined
      ) {
        pending.push(pendingSurface("cleanup", false));
      }
    }
  }
  if (input.lags.length > 0) pending.push(pendingSurface("reconciliation", true));
  if (input.settlementLags.length > 0) pending.push(pendingSurface("settlement", true));
  return pending.length === 0 ? { kind: "complete" } : { kind: "accepted-pending", pending };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isAuditReport(value: unknown): value is AuditReport {
  return isRecord(value) && "candidate" in value && "verification" in value && "target" in value;
}

function isIntegrationConflictMaterialized(value: unknown): value is IntegrationConflictMaterialized {
  return isRecord(value) && value.kind === "integration-conflict-materialized";
}

type CompletionValue = Readonly<{
  verification?: unknown;
  placement?: unknown;
  cleanup?: unknown;
  leak?: unknown;
  continuation?: ContinuationReport | undefined;
}>;

function isCompletionValue(value: unknown): value is CompletionValue {
  return isRecord(value) && !isAuditReport(value);
}

function completionPending(
  value: CompletionValue,
  pending: Array<Readonly<{ surface: MutationFinalitySurface; required: boolean }>>,
) {
  if (value.verification !== undefined) pending.push(pendingSurface("verification", true));
  if (value.placement !== undefined) pending.push(pendingSurface("placement", true));
  if (value.continuation !== undefined && value.continuation.stopped.length > 0) {
    pending.push(pendingSurface("continuation", true));
  }
}

export type AcceptedIntent<Value> = Readonly<
  {
    kind: "accepted";
    facts: readonly JournalEntry[];
    head: ContractHead;
    value: Value;
    physical?: ReconcileReport;
  } & AcceptedObligations
>;

export type MutationResult<Value> = Readonly<
  {
    facts: readonly JournalEntry[];
    head: ContractHead;
    value: Value;
    lags: ReconcileCompletion["lag"];
    settlementLags: SettlementReport["lags"];
    recoverySnapshot?: SnapshotId;
  } & AcceptedObligations
>;

type Completion<Value, PublicValue> = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  contractId: ContractId;
  accepted: AcceptedIntent<Value>;
  value: (result: Value) => PublicValue;
  hooks: WorktreeHooks;
}>;

export function completionInput<Value, PublicValue>(
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  contractId: ContractId,
  value: (result: Value) => PublicValue,
  hooks: WorktreeHooks,
): Omit<Completion<Value, PublicValue>, "accepted"> {
  return { scope, channel, contractId, value, hooks };
}

export async function completeMutation<Value, PublicValue>(
  input: Completion<Value, PublicValue>,
): Promise<MutationResult<PublicValue>> {
  const { scope, channel, contractId, accepted, value, hooks } = input;
  const contracts = [...new Set([contractId, ...accepted.facts.map((fact) => fact.contract)])];
  const reports: ReconcileCompletion[] = [];
  for (const affected of contracts) {
    reports.push(await completeReconcile({ scope, channel, contractId: affected, hooks, retryHooks: false }));
  }
  const obligations: AcceptedObligations = {
    ...(accepted.cleanup === undefined ? {} : { cleanup: accepted.cleanup }),
    ...(accepted.leak === undefined ? {} : { leak: accepted.leak }),
  };
  const effects = [...(accepted.physical?.effects ?? []), ...reports.flatMap((report) => report.effects)];
  const recoverySnapshot = effects.findLast((effect) => effect.kind === "recovery-snapshot")?.snapshot;
  return {
    facts: accepted.facts,
    head: accepted.head,
    value: value(accepted.value),
    lags: [...(accepted.physical?.lag ?? []), ...reports.flatMap((report) => report.lag)],
    settlementLags: reports.flatMap((report) => report.settlement.lags),
    ...(recoverySnapshot === undefined ? {} : { recoverySnapshot }),
    ...obligations,
  };
}

export async function completeHolderMutation<Value, PublicValue, Refusal>(
  input: Readonly<{
    completion: Omit<Completion<Value, PublicValue>, "accepted">;
    admission: TaskHolderAdmission<IntentOutcome<Value, Refusal>>;
    requireAccepted: (result: IntentOutcome<Value, Refusal>) => AcceptedIntent<Value>;
  }>,
): Promise<MutationResult<PublicValue>> {
  const accepted = input.requireAccepted(input.admission.result);
  const completed = await completeMutation({ ...input.completion, accepted });
  if (input.admission.kind === "completed") return completed;
  const deferred = deferredTaskHolderSettlement({
    contractId: input.completion.contractId,
    taskId: input.admission.taskId,
    diagnostic: input.admission.diagnostic,
  });
  return {
    ...completed,
    settlementLags: [...completed.settlementLags, ...deferred.lags],
  };
}
