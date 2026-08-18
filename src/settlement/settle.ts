import { contractSegment, type ContractId, type ContractState } from "../core/facts/types.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { Effect } from "../git/reconcile.js";
import type { GitRepository } from "../git/process.js";
import { repairNamespaceContext } from "../task/context.js";
import { settleTask, type SettledTaskResult } from "../task/operations.js";
import type { TaskId } from "../task/identity.js";
import {
  publishTaskHolderRelease,
  readTaskHolderProjectionFromDecision,
  taskHolderObservationSelection,
  type TaskHolder,
} from "./holder.js";
import { World, type WorldRoot } from "../world.js";

export type SettlementAction =
  | Readonly<{ kind: "task"; taskId: TaskId; action: "done" }>
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

export function deferredTaskHolderSettlement(input: Readonly<{
  contractId: ContractId;
  taskId: TaskId;
  diagnostic: string;
}>): SettlementReport {
  return { actions: [], lags: [{ kind: "settlement-failed", surface: "task-holder", ...input }] };
}

export function contractNamespace(id: ContractId): readonly [string] {
  return [contractSegment(id)];
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

function taskFailure(result: Exclude<Awaited<ReturnType<typeof settleTask>>, { kind: "changed" | "unchanged" }>): string {
  return result.kind === "retry"
    ? `Task settlement requires retry: ${result.reason}`
    : `Task settlement refused: ${JSON.stringify(result.refusal)}`;
}

type SettleTasksInput = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  world: WorldRoot;
  candidate: ContractState;
  actions: SettlementAction[];
  lags: SettlementLag[];
}>;

async function settleTasks(input: SettleTasksInput): Promise<void> {
  const { repository, channel, world, candidate, actions, lags } = input;
  let observation: GitDecisionObservation;
  try {
    observation = await observeContractsForAdmissionAt(repository, channel, [candidate.id], taskHolderObservationSelection());
  } catch (error) {
    lags.push({ kind: "settlement-failed", surface: "task-holder", contractId: candidate.id, diagnostic: diagnostic(error) });
    return;
  }
  const state = observation.journals.get(candidate.id)?.state ?? null;
  if (state === null || state.terminal?.kind !== "claimed") return;
  let holder: TaskHolder | null;
  try {
    holder = (await readTaskHolderProjectionFromDecision(channel, observation)).get(candidate.id) ?? null;
  } catch (error) {
    lags.push({ kind: "settlement-failed", surface: "task-holder", contractId: candidate.id, diagnostic: diagnostic(error) });
    return;
  }
  if (holder === null || holder.disposition !== "held") return;
  const taskId = holder.taskId;

  let result: SettledTaskResult;
  try {
    result = await settleTask(world, taskId);
  } catch (error) {
    lags.push({ kind: "settlement-failed", surface: "task", contractId: candidate.id, taskId, diagnostic: diagnostic(error) });
    return;
  }
  if (result.kind === "changed") actions.push({ kind: "task", taskId, action: "done" });
  else if (result.kind !== "unchanged") {
    lags.push({ kind: "settlement-failed", surface: "task", contractId: candidate.id, taskId, diagnostic: taskFailure(result) });
    return;
  }

  try {
    const publication = await publishTaskHolderRelease(repository, channel, observation, candidate.id);
    if (publication.kind === "non-published") {
      lags.push({
        kind: "settlement-failed",
        surface: "task-holder",
        contractId: candidate.id,
        taskId,
        diagnostic: `Task holder release requires retry: ${publication.diagnostic}`,
      });
    }
  } catch (error) {
    lags.push({ kind: "settlement-failed", surface: "task-holder", contractId: candidate.id, taskId, diagnostic: diagnostic(error) });
  }
}

async function settleNamespace(state: ContractState, effects: readonly Effect[], actions: SettlementAction[], lags: SettlementLag[]): Promise<void> {
  if (state.terminal !== null || state.coordinates.workspace !== "worktree") return;
  const worktrees = effects.filter((effect): effect is Extract<Effect, { kind: "worktree" }> =>
    effect.kind === "worktree" && effect.action !== "removed");
  for (const effect of worktrees) {
    try {
      const world = await World.at(effect.path);
      actions.push({
        kind: "namespace-context",
        path: effect.path,
        action: await repairNamespaceContext(world, contractNamespace(state.id)),
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

async function settleObserved(input: SettlementInput): Promise<SettlementReport> {
  if (input.state === null) return { actions: [], lags: [] };
  const actions: SettlementAction[] = [], lags: SettlementLag[] = [];
  if (input.state.terminal?.kind === "claimed") {
    try {
      await settleTasks({
        repository: input.repository,
        channel: input.channel,
        world: await World.at(input.repository.primaryWorktree),
        candidate: input.state,
        actions,
        lags,
      });
    } catch (error) {
      lags.push({ kind: "settlement-failed", surface: "task", contractId: input.state.id, diagnostic: diagnostic(error) });
    }
  }
  await settleNamespace(input.state, input.effects, actions, lags);
  return { actions, lags };
}

function onPrimaryWorktree(repository: GitRepository): GitRepository {
  return { ...repository, effectiveCwd: repository.primaryWorktree };
}

export async function settle(input: SettlementInput): Promise<SettlementReport> {
  const repository = onPrimaryWorktree(input.repository);
  return await settleObserved({ ...input, repository });
}

export async function settleAll(input: SettlementBatchInput): Promise<readonly SettlementReport[]> {
  const repository = onPrimaryWorktree(input.repository);
  return await Promise.all(input.contracts.map((contract) => settleObserved({ repository, channel: input.channel, ...contract })));
}
