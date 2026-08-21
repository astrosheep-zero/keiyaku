import { reconcile, reconcileBatch, reconcileObservationFailure, type ReconcileResult } from "../git/reconcile.js";
import { observeContractWorld } from "../git/observe.js";
import { withGitReadObservation } from "../git/read-observation.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractId, ContractState } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { MutationOperationInput, RepositoryScope } from "./operations.js";

export type ReconcileReport = ReconcileResult;
type ReconcileObservation = Readonly<{ state: ContractState | null; report: ReconcileReport }>;
type ReconcileOptions = Readonly<{
  hooks: WorktreeHooks;
  retryHooks: boolean;
  retainTerminalWorktree?: boolean;
  place?: string;
  places?: ReadonlyMap<ContractId, string>;
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
      ...(input.retainTerminalWorktree === undefined ? {} : { retainTerminalWorktree: input.retainTerminalWorktree }),
      ...(input.place === undefined ? {} : { place: input.place }),
    });
    return { state: observation.state, report: observation.result };
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
    return { state: null, report: reconcileObservationFailure(error) };
  }
}

type RepoReconcileItem = Readonly<{ contractId: ContractId; state: ContractState | null; report: ReconcileReport }>;
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
  }> &
    ReconcileOptions,
): Promise<RepoReconcileReport> {
  const contracts = (
    await reconcileBatch(
      input.scope,
      input.channel,
      input.states.map((state) => state.id),
      {
        hooks: input.hooks,
        retryHooks: input.retryHooks,
        retainTerminalWorktree: input.retainTerminalWorktree ?? false,
        ...(input.places === undefined ? {} : { places: input.places }),
      },
    )
  ).map(
    (item): RepoReconcileItem => ({
      contractId: item.contract,
      state: item.state,
      report: item.result,
    }),
  );
  return { contracts };
}
