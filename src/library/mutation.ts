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
import type { CompletionEvidence } from "../protocol/completion.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { Delivery } from "./delivery.js";
import type { ContinuationReport } from "./continuation.js";
import type { Review } from "./contract-forwarding-result.js";
import type { AmendResult, BindResult } from "./contract-types.js";
import type { KeiyakuRefused, KeiyakuRetry } from "./refusal.js";

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

export type MutationPendingSurface = Readonly<{ surface: MutationFinalitySurface; required: boolean }>;

type ObligationPendingInput = Readonly<{
  lags: MutationResult<unknown>["lags"];
  settlementLags: MutationResult<unknown>["settlementLags"];
  cleanup?: AcceptedObligations["cleanup"];
  leak?: AcceptedObligations["leak"];
  seatClose?: AcceptedObligations["seatClose"];
}>;

export function noValuePending(_value?: unknown): readonly MutationPendingSurface[] {
  return [];
}

export function auditPending(value: AuditReport): readonly MutationPendingSurface[] {
  return value.verification.kind === "stopped" ? [pendingSurface("verification", true)] : [];
}

export function completionPending(value: {
  verification?: CompletionEvidence["verification"] | undefined;
  placement?: CompletionEvidence["placement"] | undefined;
  continuation?: ContinuationReport | undefined;
}): readonly MutationPendingSurface[] {
  const pending: MutationPendingSurface[] = [];
  if (value.verification !== undefined) pending.push(pendingSurface("verification", true));
  if (value.placement !== undefined) pending.push(pendingSurface("placement", true));
  if (value.continuation !== undefined && value.continuation.stopped.length > 0) {
    pending.push(pendingSurface("continuation", true));
  }
  return pending;
}

export function obligationPending(input: ObligationPendingInput): readonly MutationPendingSurface[] {
  const pending: MutationPendingSurface[] = [];
  if (input.lags.length > 0) pending.push(pendingSurface("reconciliation", true));
  if (input.settlementLags.length > 0) pending.push(pendingSurface("settlement", true));
  if (input.cleanup !== undefined || input.leak !== undefined || (input.seatClose?.length ?? 0) > 0) {
    pending.push(pendingSurface("cleanup", false));
  }
  return pending;
}

export function collectAcceptedPending(
  valuePending: readonly MutationPendingSurface[],
  obligations: ObligationPendingInput,
): readonly MutationPendingSurface[] {
  return [...valuePending, ...obligationPending(obligations)];
}

/** Purely projects the leading mutation's finality without changing its details. */
export function projectMutationFinality(input: MutationFinalityInput): MutationFinality {
  if (input.kind === "accepted") {
    return input.pending.length === 0
      ? { kind: "complete" }
      : { kind: "accepted-pending", pending: input.pending };
  }
  return { kind: "not-admitted" };
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
    kind: "accepted";
    facts: readonly JournalEntry[];
    head: ContractHead;
    value: Value;
    lags: ReconcileCompletion["lag"];
    settlementLags: SettlementReport["lags"];
    recoverySnapshot?: SnapshotId;
    pending: readonly MutationPendingSurface[];
  } & AcceptedObligations
>;

type Completion<Value, PublicValue> = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  contractId: ContractId;
  accepted: AcceptedIntent<Value>;
  value: (result: Value) => PublicValue;
  valuePending?: (value: PublicValue) => readonly MutationPendingSurface[];
  hooks: WorktreeHooks;
}>;

export function completionInput<Value, PublicValue>(
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  contractId: ContractId,
  value: (result: Value) => PublicValue,
  hooks: WorktreeHooks,
  valuePending: (value: PublicValue) => readonly MutationPendingSurface[] = noValuePending,
): Omit<Completion<Value, PublicValue>, "accepted"> {
  return { scope, channel, contractId, value, valuePending, hooks };
}

export async function completeMutation<Value, PublicValue>(
  input: Completion<Value, PublicValue>,
): Promise<MutationResult<PublicValue>> {
  const { scope, channel, contractId, accepted, value, hooks } = input;
  const valuePending = input.valuePending ?? noValuePending;
  const contracts = [...new Set([contractId, ...accepted.facts.map((fact) => fact.contract)])];
  const reports: ReconcileCompletion[] = [];
  for (const affected of contracts) {
    reports.push(await completeReconcile({ scope, channel, contractId: affected, hooks, retryHooks: false }));
  }
  const obligations: AcceptedObligations = {
    ...(accepted.cleanup === undefined ? {} : { cleanup: accepted.cleanup }),
    ...(accepted.leak === undefined ? {} : { leak: accepted.leak }),
    ...(accepted.seatClose === undefined || accepted.seatClose.length === 0 ? {} : { seatClose: accepted.seatClose }),
  };
  const effects = [...(accepted.physical?.effects ?? []), ...reports.flatMap((report) => report.effects)];
  const recoverySnapshot = effects.findLast((effect) => effect.kind === "recovery-snapshot")?.snapshot;
  const publicValue = value(accepted.value);
  const lags = [...(accepted.physical?.lag ?? []), ...reports.flatMap((report) => report.lag)];
  const settlementLags = reports.flatMap((report) => report.settlement.lags);
  return {
    kind: "accepted",
    facts: accepted.facts,
    head: accepted.head,
    value: publicValue,
    lags,
    settlementLags,
    pending: collectAcceptedPending(valuePending(publicValue), {
      lags,
      settlementLags,
      ...obligations,
    }),
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
  const settlementLags = [...completed.settlementLags, ...deferred.lags];
  return {
    ...completed,
    settlementLags,
    pending: collectAcceptedPending((input.completion.valuePending ?? noValuePending)(completed.value), {
      lags: completed.lags,
      settlementLags,
      ...(completed.cleanup === undefined ? {} : { cleanup: completed.cleanup }),
      ...(completed.leak === undefined ? {} : { leak: completed.leak }),
      ...(completed.seatClose === undefined || completed.seatClose.length === 0
        ? {}
        : { seatClose: completed.seatClose }),
    }),
  };
}
