import { cleanupTerminalContract, repairContractEffects, type ReconcileResult } from "../git/reconcile.js";
import { observeContractJournals } from "../git/observe.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import type { ContractHead, ContractId } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import type { MutationOperationInput, RepositoryScope } from "./operations.js";

type ReconcileOperationInput = MutationOperationInput & Readonly<{ hooks: WorktreeHooks; retryHooks: boolean }>;

function gitInput(input: ReconcileOperationInput) {
  return {
    ...input,
    repository: input.scope,
    onPhysical: (report: ReconcileResult) => input.progress?.recordPhysical(input.contractId, report),
  };
}

export async function repairContractOperation(input: ReconcileOperationInput) {
  return await repairContractEffects(gitInput(input));
}

export async function cleanupTerminalOperation(
  input: ReconcileOperationInput & Readonly<{ expectedHead: ContractHead | null; handoffSafe: boolean }>,
) {
  return await cleanupTerminalContract({
    ...gitInput(input),
    expectedHead: input.expectedHead,
    handoffSafe: input.handoffSafe,
  });
}

export async function worldContractIds(
  input: Readonly<{ scope: RepositoryScope; channel: GitDecodeChannel }>,
): Promise<readonly ContractId[]> {
  const journals = await withGitReadObservation(input.scope, input.channel, observeContractJournals);
  return [...journals.keys()];
}
