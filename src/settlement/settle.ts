import { contractSegment, type ContractId, type ContractState } from "../core/facts/types.js";
import type { Effect } from "../carrier/reconcile.js";
import { repairNamespaceContext } from "../task/context.js";
import { associatedTaskIds, settleAssociatedTask } from "../task/operations.js";
import type { TaskId } from "../task/identity.js";
import type { TaskWorld } from "../task/store.js";

export type SettlementAction =
  | Readonly<{ kind: "task"; taskId: TaskId; action: "done" | "reopened" }>
  | Readonly<{ kind: "namespace-context"; path: string; action: "installed" | "kept" }>;

export type SettlementLag = Readonly<{
  kind: "settlement-failed";
  surface: "task" | "namespace-context";
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
  taskRoot: string;
  state: ContractState | null;
  effects: readonly Effect[];
}>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskFailure(result: Exclude<Awaited<ReturnType<typeof settleAssociatedTask>>, { kind: "changed" | "unchanged" }>): string {
  return result.kind === "retry"
    ? `Task settlement requires retry: ${result.reason}`
    : `Task settlement refused: ${JSON.stringify(result.refusal)}`;
}

async function settleTasks(
  world: TaskWorld,
  state: ContractState,
  actions: SettlementAction[],
  lags: SettlementLag[],
): Promise<void> {
  const terminal = state.terminal?.kind;
  if (terminal !== "claimed" && terminal !== "abandoned") return;
  let ids: readonly TaskId[];
  try {
    ids = associatedTaskIds(world, state.id);
  } catch (error) {
    lags.push({ kind: "settlement-failed", surface: "task", contractId: state.id, diagnostic: diagnostic(error) });
    return;
  }
  for (const taskId of ids) {
    try {
      const result = await settleAssociatedTask(world, taskId, state.id, terminal === "claimed" ? "done" : "open-from-done");
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
}

function settleNamespace(state: ContractState, effects: readonly Effect[], actions: SettlementAction[], lags: SettlementLag[]): void {
  if (state.terminal !== null || state.coordinates.workspace !== "worktree" || state.bound === null) return;
  const worktrees = effects.filter((effect): effect is Extract<Effect, { kind: "worktree" }> =>
    effect.kind === "worktree" && effect.action !== "removed");
  for (const effect of worktrees) {
    try {
      actions.push({
        kind: "namespace-context",
        path: effect.path,
        action: repairNamespaceContext(effect.path, [contractSegment(state.id)]),
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

export async function settle(input: SettlementInput): Promise<SettlementReport> {
  if (input.state === null) return { actions: [], lags: [] };
  const actions: SettlementAction[] = [], lags: SettlementLag[] = [];
  await settleTasks({ root: input.taskRoot }, input.state, actions, lags);
  settleNamespace(input.state, input.effects, actions, lags);
  return { actions, lags };
}
