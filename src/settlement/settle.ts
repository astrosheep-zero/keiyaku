import { contractSegment, type ContractId, type ContractState } from "../core/facts/types.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { Effect } from "../git/reconcile.js";
import type { GitRepository } from "../git/repository.js";
import { repairNamespaceContext } from "../task/context.js";
import type { TaskId } from "../task/identity.js";
import { World } from "../world.js";

export type SettlementAction =
  Readonly<{ kind: "namespace-context"; path: string; action: "installed" | "kept" }>;

export type SettlementLag = Readonly<{
  kind: "settlement-failed";
  surface: "task-holder" | "namespace-context";
  contractId: ContractId;
  taskId?: TaskId;
  path?: string;
  diagnostic: string;
}>;

export type SettlementReport = Readonly<{
  actions: readonly SettlementAction[];
  lags: readonly SettlementLag[];
}>;

export function deferredTaskHolderSettlement(input: Readonly<{
  contractId: ContractId;
  taskId: TaskId;
  diagnostic: string;
}>): SettlementReport {
  return { actions: [], lags: [{ kind: "settlement-failed", surface: "task-holder", ...input }] };
}

export type SettlementInput = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  state: ContractState | null;
  effects: readonly Effect[];
}>;

export type SettlementBatchInput = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  contracts: readonly Readonly<Pick<SettlementInput, "state" | "effects">>[];
}>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settleNamespace(state: ContractState, effects: readonly Effect[], actions: SettlementAction[], lags: SettlementLag[]): void {
  if (state.terminal !== null || state.coordinates.workspace !== "worktree") return;
  const worktrees = effects.filter((effect): effect is Extract<Effect, { kind: "worktree" }> =>
    effect.kind === "worktree" && effect.action !== "removed");
  for (const effect of worktrees) {
    try {
      const world = World.at(effect.path);
      actions.push({
        kind: "namespace-context",
        path: effect.path,
        action: repairNamespaceContext(world, [contractSegment(state.id)]),
      });
    } catch (error) {
      lags.push({
        kind: "settlement-failed",
        surface: "namespace-context",
        contractId: state.id,
        path: effect.path,
        diagnostic: diagnostic(error),
      });
    }
  }
}

function settleObserved(input: SettlementInput): SettlementReport {
  if (input.state === null) return { actions: [], lags: [] };
  const actions: SettlementAction[] = [], lags: SettlementLag[] = [];
  settleNamespace(input.state, input.effects, actions, lags);
  return { actions, lags };
}

function onPrimaryWorktree(repository: GitRepository): GitRepository {
  return { ...repository, effectiveCwd: repository.primaryWorktree };
}

export async function settle(input: SettlementInput): Promise<SettlementReport> {
  const repository = onPrimaryWorktree(input.repository);
  return settleObserved({ ...input, repository });
}

export async function settleAll(input: SettlementBatchInput): Promise<readonly SettlementReport[]> {
  const repository = onPrimaryWorktree(input.repository);
  return input.contracts.map((contract) => settleObserved({ repository, channel: input.channel, ...contract }));
}
