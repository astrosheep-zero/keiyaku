import { contractSegment, type ContractId, type ContractState } from "../core/facts/types.js";
import type { Effect } from "../git/reconcile.js";
import type { GitRepository } from "../git/repository.js";
import { repairNamespaceContext } from "../task/context.js";
import { settleTask } from "../task/operations.js";
import type { TaskId } from "../task/identity.js";
import { readTaskHolderProjection, type TaskHolderProjection } from "./holder.js";
import { World, type WorldRoot } from "../world.js";

export type SettlementAction =
  | Readonly<{ kind: "task"; taskId: TaskId; action: "done" | "reopened" }>
  | Readonly<{ kind: "namespace-context"; path: string; action: "installed" | "kept" }>;

export type SettlementLag = Readonly<{
  kind: "settlement-failed";
  surface: "task-holder" | "task" | "namespace-context";
  contractId: ContractId;
  taskId?: TaskId;
  path?: string;
  diagnostic: string;
}>;

export type SettlementReport = Readonly<{
  actions: readonly SettlementAction[];
  lags: readonly SettlementLag[];
}>;

export type SettlementInput = Readonly<{
  repository: GitRepository;
  state: ContractState | null;
  effects: readonly Effect[];
}>;

export type SettlementBatchInput = Readonly<{
  repository: GitRepository;
  contracts: readonly Readonly<Pick<SettlementInput, "state" | "effects">>[];
}>;

type SettlementObservation =
  | Readonly<{ kind: "present"; holders: TaskHolderProjection }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskFailure(result: Exclude<Awaited<ReturnType<typeof settleTask>>, { kind: "changed" | "unchanged" }>): string {
  return result.kind === "retry"
    ? `Task settlement requires retry: ${result.reason}`
    : `Task settlement refused: ${JSON.stringify(result.refusal)}`;
}

async function settleTasks(
  observation: SettlementObservation,
  world: WorldRoot,
  state: ContractState,
  actions: SettlementAction[],
  lags: SettlementLag[],
): Promise<void> {
  const terminal = state.terminal?.kind;
  if (terminal !== "claimed" && terminal !== "abandoned") return;
  if (observation.kind === "failed") {
    lags.push({ kind: "settlement-failed", surface: "task-holder", contractId: state.id, diagnostic: observation.diagnostic });
    return;
  }
  const holder = observation.holders.get(state.id) ?? null;
  const expectedDisposition = terminal === "claimed" ? "held" : "released";
  if (holder === null || holder.disposition !== expectedDisposition) return;
  const taskId = holder.taskId;
  try {
    const result = await settleTask(world, taskId, terminal === "claimed" ? "done" : "open-from-done");
    if (result.kind === "changed") actions.push({ kind: "task", taskId, action: result.action });
    else if (result.kind !== "unchanged") lags.push({
      kind: "settlement-failed",
      surface: "task",
      contractId: state.id,
      taskId,
      diagnostic: taskFailure(result),
    });
  } catch (error) {
    lags.push({ kind: "settlement-failed", surface: "task", contractId: state.id, taskId, diagnostic: diagnostic(error) });
  }
}

function settleNamespace(state: ContractState, effects: readonly Effect[], actions: SettlementAction[], lags: SettlementLag[]): void {
  if (state.terminal !== null || state.coordinates.workspace !== "worktree" || state.bound === null) return;
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

function observeSettlement(repository: GitRepository): SettlementObservation {
  try {
    return { kind: "present", holders: readTaskHolderProjection(repository) };
  } catch (error) {
    return { kind: "failed", diagnostic: diagnostic(error) };
  }
}

async function settleObserved(input: SettlementInput, observation: SettlementObservation): Promise<SettlementReport> {
  if (input.state === null) return { actions: [], lags: [] };
  const actions: SettlementAction[] = [], lags: SettlementLag[] = [];
  try {
    await settleTasks(observation, World.at(input.repository.primaryWorktree), input.state, actions, lags);
  } catch (error) {
    lags.push({ kind: "settlement-failed", surface: "task", contractId: input.state.id, diagnostic: diagnostic(error) });
  }
  settleNamespace(input.state, input.effects, actions, lags);
  return { actions, lags };
}

export async function settle(input: SettlementInput): Promise<SettlementReport> {
  return settleObserved(input, observeSettlement(input.repository));
}

export async function settleAll(input: SettlementBatchInput): Promise<readonly SettlementReport[]> {
  const observation = observeSettlement(input.repository);
  return Promise.all(input.contracts.map((contract) => settleObserved({
    repository: input.repository,
    ...contract,
  }, observation)));
}
