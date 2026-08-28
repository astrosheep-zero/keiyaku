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

export function deferredTaskHolderSettlement(
  input: Readonly<{
    contractId: ContractId;
    taskId: TaskId;
    diagnostic: string;
  }>,
): SettlementReport {
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

function taskFailure(
  result: Exclude<Awaited<ReturnType<typeof settleTask>>, { kind: "changed" | "unchanged" }>,
): string {
  return result.kind === "retry"
    ? `Task settlement requires retry: ${result.reason}`
    : `Task settlement refused: ${JSON.stringify(result.refusal)}`;
}

type SettleTasksInput = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  candidate: ContractState;
  actions: SettlementAction[];
  lags: SettlementLag[];
}>;

type ApplicableHolder = Readonly<{
  observation: GitDecisionObservation;
  holder: TaskHolder;
}>;

async function observeApplicableHolder(
  input: Pick<SettleTasksInput, "repository" | "channel" | "candidate" | "lags">,
): Promise<ApplicableHolder | null> {
  const { repository, channel, candidate, lags } = input;
  let observation: GitDecisionObservation;
  try {
    observation = await observeContractsForAdmissionAt(
      repository,
      channel,
      [candidate.id],
      taskHolderObservationSelection(),
    );
  } catch (error) {
    lags.push({
      kind: "settlement-failed",
      surface: "task-holder",
      contractId: candidate.id,
      diagnostic: diagnostic(error),
    });
    return null;
  }
  const state = observation.journals.get(candidate.id)?.state ?? null;
  if (state === null || state.terminal?.kind !== "claimed") return null;
  try {
    const holder = (await readTaskHolderProjectionFromDecision(channel, observation)).get(candidate.id) ?? null;
    return holder?.disposition === "held" ? { observation, holder } : null;
  } catch (error) {
    lags.push({
      kind: "settlement-failed",
      surface: "task-holder",
      contractId: candidate.id,
      diagnostic: diagnostic(error),
    });
    return null;
  }
}

async function settleTasks(input: SettleTasksInput): Promise<boolean> {
  const { repository, channel, candidate, actions, lags } = input;
  const applicable = await observeApplicableHolder({ repository, channel, candidate, lags });
  if (applicable === null) return false;
  const { observation, holder } = applicable;
  const taskId = holder.taskId;
  let world: WorldRoot;
  try {
    world = await World.at(repository.primaryWorktree);
  } catch (error) {
    lags.push({
      kind: "settlement-failed",
      surface: "task",
      contractId: candidate.id,
      taskId,
      diagnostic: diagnostic(error),
    });
    return true;
  }

  let result: SettledTaskResult;
  try {
    result = await settleTask(world, taskId);
  } catch (error) {
    lags.push({
      kind: "settlement-failed",
      surface: "task",
      contractId: candidate.id,
      taskId,
      diagnostic: diagnostic(error),
    });
    return true;
  }
  if (result.kind === "changed") actions.push({ kind: "task", taskId, action: "done" });
  else if (result.kind !== "unchanged") {
    lags.push({
      kind: "settlement-failed",
      surface: "task",
      contractId: candidate.id,
      taskId,
      diagnostic: taskFailure(result),
    });
    return true;
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
    lags.push({
      kind: "settlement-failed",
      surface: "task-holder",
      contractId: candidate.id,
      taskId,
      diagnostic: diagnostic(error),
    });
  }
  return true;
}

async function settleNamespace(
  state: ContractState,
  effects: readonly Effect[],
  actions: SettlementAction[],
  lags: SettlementLag[],
): Promise<void> {
  if (state.coordinates.workspace !== "worktree") return;
  const worktrees = effects.filter(
    (effect): effect is Extract<Effect, { kind: "worktree" }> =>
      effect.kind === "worktree" && effect.action !== "removed",
  );
  for (const effect of worktrees) {
    try {
      actions.push({
        kind: "namespace-context",
        path: effect.path,
        action: await repairNamespaceContext(effect.path, contractNamespace(state.id)),
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
  const actions: SettlementAction[] = [],
    lags: SettlementLag[] = [];
  let holderApplies = false;
  if (input.state.terminal?.kind === "claimed") {
    try {
      holderApplies = await settleTasks({
        repository: input.repository,
        channel: input.channel,
        candidate: input.state,
        actions,
        lags,
      });
    } catch (error) {
      lags.push({
        kind: "settlement-failed",
        surface: "task",
        contractId: input.state.id,
        diagnostic: diagnostic(error),
      });
    }
  }
  if (holderApplies) await settleNamespace(input.state, input.effects, actions, lags);
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
  return await Promise.all(
    input.contracts.map((contract) => settleObserved({ repository, channel: input.channel, ...contract })),
  );
}
