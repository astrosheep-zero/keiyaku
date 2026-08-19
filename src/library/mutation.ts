import type { ContractHead, ContractId, JournalEntry } from "../core/facts/types.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { ReconcileReport } from "../protocol/reconcile.js";
import type { RepositoryScope } from "../protocol/operations.js";
import type { IntentOutcome } from "../protocol/operations.js";
import type { AcceptedObligations } from "../protocol/outcome.js";
import { deferredTaskHolderSettlement, type SettlementReport } from "../settlement/settle.js";
import type { TaskHolderAdmission } from "../settlement/holder.js";
import type { WorktreeHooks } from "./configuration.js";
import { completeReconcile, type ReconcileCompletion } from "./reconcile.js";

export type AcceptedIntent<Value> = Readonly<{
  kind: "accepted";
  facts: readonly JournalEntry[];
  head: ContractHead;
  value: Value;
  physical?: ReconcileReport;
} & AcceptedObligations>;

export type MutationResult<Value> = Readonly<{
  facts: readonly JournalEntry[];
  head: ContractHead;
  value: Value;
  effects: ReconcileCompletion["effects"];
  lags: ReconcileCompletion["lag"];
  settlement: SettlementReport;
} & AcceptedObligations>;

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
  const report = await completeReconcile({ scope, channel, contractId, hooks, retryHooks: false });
  const obligations: AcceptedObligations = {
    ...(accepted.cleanup === undefined ? {} : { cleanup: accepted.cleanup }),
    ...(accepted.leak === undefined ? {} : { leak: accepted.leak }),
  };
  return {
    facts: accepted.facts,
    head: accepted.head,
    value: value(accepted.value),
    effects: [...(accepted.physical?.effects ?? []), ...report.effects],
    lags: [...(accepted.physical?.lag ?? []), ...report.lag],
    settlement: report.settlement,
    ...obligations,
  };
}

export async function completeHolderMutation<Value, PublicValue, Refusal>(input: Readonly<{
  completion: Omit<Completion<Value, PublicValue>, "accepted">;
  admission: TaskHolderAdmission<IntentOutcome<Value, Refusal>>;
  requireAccepted: (result: IntentOutcome<Value, Refusal>) => AcceptedIntent<Value>;
}>): Promise<MutationResult<PublicValue>> {
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
    settlement: {
      actions: completed.settlement.actions,
      lags: [...completed.settlement.lags, ...deferred.lags],
    },
  };
}
