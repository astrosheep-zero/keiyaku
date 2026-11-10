import { reconcile, reconcileObservationFailure, type ReconcileResult } from "../git/reconcile.js";
import type { ProtocolProgress } from "./progress.js";
import { observeContractWorld } from "../git/observe.js";
import { withGitReadObservation } from "../git/read-observation.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractId, ContractState } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { MutationOperationInput, RepositoryScope } from "./operations.js";

type ReconcileObservation = Readonly<{ state: ContractState | null; report: ReconcileResult }>;
type ReconcileOptions = Readonly<{
  hooks: WorktreeHooks;
  retryHooks: boolean;
  retainTerminalWorktree?: boolean;
  place?: string;
  places?: ReadonlyMap<ContractId, string>;
  onPhysical?: (report: ReconcileResult) => void;
}>;

export async function reconcileOperation(
  input: MutationOperationInput & ReconcileOptions,
): Promise<ReconcileObservation> {
  try {
    const observation = await reconcile({
      repository: input.scope,
      channel: input.channel,
      contractId: input.contractId,
      hooks: input.hooks,
      retryHooks: input.retryHooks,
      onPhysical: (report) => {
        input.progress?.recordPhysical(input.contractId, report);
        input.onPhysical?.(report);
      },
      ...(input.retainTerminalWorktree === undefined ? {} : { retainTerminalWorktree: input.retainTerminalWorktree }),
      ...(input.place === undefined ? {} : { place: input.place }),
    });
    return { state: observation.state, report: observation.result };
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
    return { state: null, report: reconcileObservationFailure(error) };
  }
}

type RepoReconcileItem = Readonly<{ contractId: ContractId; state: ContractState | null; report: ReconcileResult }>;
type RepoReconcileReport = Readonly<{ contracts: readonly RepoReconcileItem[] }>;

export async function worldContractStates(
  input: Readonly<{ scope: RepositoryScope; channel: GitDecodeChannel }>,
): Promise<readonly ContractState[]> {
  const observation = await withGitReadObservation(
    input.scope,
    input.channel,
    async (read) => await observeContractWorld(read),
  );
  return [...observation.contracts.values()].flatMap((value) => (value.state === null ? [] : [value.state]));
}

export async function reconcileAllOperation(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    states: readonly ContractState[];
    progress?: ProtocolProgress;
  }> &
    ReconcileOptions,
): Promise<RepoReconcileReport> {
  const contracts: RepoReconcileItem[] = [];
  for (const state of input.states) {
    const place = input.places?.get(state.id);
    const observed = await reconcileOperation({
      ...input,
      contractId: state.id,
      retainTerminalWorktree: input.retainTerminalWorktree ?? false,
      ...(place === undefined ? {} : { place }),
    });
    contracts.push({ contractId: state.id, ...observed });
  }
  return { contracts };
}
