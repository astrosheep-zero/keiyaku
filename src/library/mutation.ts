import type { ContractHead, ContractId, JournalEntry } from "../core/facts/types.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { reconcileOperation, type ReconcileReport, type RepositoryScope } from "../protocol/operations.js";
import type { IntentOutcome } from "../protocol/operations.js";
import { deferredTaskHolderSettlement, settle, type SettlementReport } from "../settlement/settle.js";
import type { TaskHolderAdmission } from "../settlement/holder.js";
import type { WorktreeHooks } from "./configuration.js";
import { projectContractWorktree, type ContractFileEffect, type ContractFileLag } from "../contract-worktree.js";

export type AcceptedIntent<Value> = Readonly<{
  kind: "accepted";
  facts: readonly JournalEntry[];
  head: ContractHead;
  value: Value;
  physical?: ReconcileReport;
}>;

export type MutationResult<Value> = Readonly<{
  facts: readonly JournalEntry[];
  head: ContractHead;
  value: Value;
  effects: readonly (ReconcileReport["effects"][number] | ContractFileEffect)[];
  lags: readonly (ReconcileReport["lag"][number] | ContractFileLag)[];
  settlement: SettlementReport;
}>;

type Completion<Value, PublicValue> = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  contractId: ContractId;
  accepted: AcceptedIntent<Value>;
  value: (result: Value) => PublicValue;
  hooks: WorktreeHooks;
}>;

export async function completeMutation<Value, PublicValue>(
  input: Completion<Value, PublicValue>,
): Promise<MutationResult<PublicValue>> {
  const { scope, channel, contractId, accepted, value, hooks } = input;
  const retained = await reconcileOperation({ scope, channel, contractId, hooks, retryHooks: false, retainTerminalWorktree: true });
  const projection = projectContractWorktree(scope, retained.state);
  const settlement = await settle({ repository: scope, channel, state: retained.state, effects: retained.report.effects });
  const deferRemoval = retained.state !== null && retained.state.terminal !== null
    && retained.state.coordinates.workspace === "worktree";
  const cleanup = deferRemoval
    ? await reconcileOperation({ scope, channel, contractId, hooks, retryHooks: false })
    : null;
  return {
    facts: accepted.facts,
    head: accepted.head,
    value: value(accepted.value),
    effects: [...(accepted.physical?.effects ?? []), ...retained.report.effects, ...projection.effects, ...(cleanup?.report.effects ?? [])],
    lags: [...(accepted.physical?.lag ?? []), ...retained.report.lag, ...projection.lag, ...(cleanup?.report.lag ?? [])],
    settlement,
  };
}

export async function completeHolderMutation<Value, PublicValue, Refusal>(input: Readonly<{
  completion: Omit<Completion<Value, PublicValue>, "accepted">;
  admission: TaskHolderAdmission<IntentOutcome<Value, Refusal>>;
  requireAccepted: (result: IntentOutcome<Value, Refusal>) => AcceptedIntent<Value>;
}>): Promise<MutationResult<PublicValue>> {
  const accepted = input.requireAccepted(input.admission.result);
  if (input.admission.kind === "completed") return completeMutation({ ...input.completion, accepted });
  return {
    facts: accepted.facts,
    head: accepted.head,
    value: input.completion.value(accepted.value),
    effects: [...(accepted.physical?.effects ?? [])],
    lags: [...(accepted.physical?.lag ?? [])],
    settlement: deferredTaskHolderSettlement({
      contractId: input.completion.contractId,
      taskId: input.admission.taskId,
      diagnostic: input.admission.diagnostic,
    }),
  };
}
