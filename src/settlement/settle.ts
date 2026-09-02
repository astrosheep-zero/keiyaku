import { type ContractId, type ContractState } from "../core/facts/types.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import { withPrivateStatePublicationSeat } from "../git/private-state-seat.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { Effect } from "../git/reconcile.js";
import type { GitRepository } from "../git/process.js";
import { settleTask, type SettledTaskResult } from "../task/operations.js";
import { type TaskId } from "../task/identity.js";
import {
  publishTaskHolderRelease,
  readTaskHolderProjectionFromDecision,
  taskHolderObservationSelection,
  type TaskHolder,
} from "./holder.js";
import { acquireTaskSettlementFence } from "./fence.js";
import { World, type WorldRoot } from "../world.js";

export type SettlementAction = Readonly<{ kind: "task"; taskId: TaskId; action: "done" }>;

export type SettlementLag = Readonly<{
  kind: "settlement-failed";
  surface: "task-holder" | "task";
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

async function observeApplicableHolder(
  input: Pick<SettleTasksInput, "repository" | "channel" | "candidate" | "lags">,
): Promise<TaskHolder | null> {
  const { repository, channel, candidate, lags } = input;
  let observation: GitDecisionObservation;
  try {
    observation = await observeContractsForAdmissionAt(
      repository,
      channel,
      [candidate.id],
      taskHolderObservationSelection(),
    );
    const state = observation.journals.get(candidate.id)?.state ?? null;
    if (state === null || state.terminal?.kind !== "claimed") return null;
    const holder = (await readTaskHolderProjectionFromDecision(channel, observation)).get(candidate.id) ?? null;
    return holder?.disposition === "held" ? holder : null;
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

async function completeHeldTask(
  input: Pick<SettleTasksInput, "repository" | "candidate" | "actions" | "lags"> & { taskId: TaskId },
): Promise<boolean> {
  const { repository, candidate, actions, lags, taskId } = input;
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
    return false;
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
    return false;
  }
  if (result.kind === "changed") actions.push({ kind: "task", taskId, action: "done" });
  if (result.kind === "changed" && result.cleanup !== undefined) {
    for (const detail of result.cleanup.diagnostics) {
      lags.push({
        kind: "settlement-failed",
        surface: "task",
        contractId: candidate.id,
        taskId,
        diagnostic: detail,
      });
    }
  }
  if (result.kind === "changed" || result.kind === "unchanged") return true;
  lags.push({
    kind: "settlement-failed",
    surface: "task",
    contractId: candidate.id,
    taskId,
    diagnostic: taskFailure(result),
  });
  return false;
}

async function releaseHeldTaskHolder(
  input: Pick<SettleTasksInput, "repository" | "channel" | "candidate" | "lags"> & { taskId: TaskId },
): Promise<void> {
  const { repository, channel, candidate, lags, taskId } = input;
  try {
    await withPrivateStatePublicationSeat(repository, async (seat) => {
      const observation = await observeContractsForAdmissionAt(
        repository,
        channel,
        [candidate.id],
        taskHolderObservationSelection(),
      );
      const state = observation.journals.get(candidate.id)?.state ?? null;
      if (state === null || state.terminal?.kind !== "claimed") return;
      const holder = (await readTaskHolderProjectionFromDecision(channel, observation)).get(candidate.id) ?? null;
      if (holder === null || holder.disposition !== "held" || holder.taskId !== taskId) return;
      const publication = await publishTaskHolderRelease(repository, channel, observation, candidate.id, seat);
      if (publication.kind === "non-published") {
        lags.push({
          kind: "settlement-failed",
          surface: "task-holder",
          contractId: candidate.id,
          taskId,
          diagnostic: `Task holder release requires retry: ${publication.diagnostic}`,
        });
      }
    });
  } catch (error) {
    lags.push({
      kind: "settlement-failed",
      surface: "task-holder",
      contractId: candidate.id,
      taskId,
      diagnostic: diagnostic(error),
    });
  }
}

async function settleTasks(input: SettleTasksInput): Promise<boolean> {
  const { repository, channel, candidate, actions, lags } = input;
  const hint = await observeApplicableHolder({ repository, channel, candidate, lags });
  if (hint === null) return false;
  const taskId = hint.taskId;
  let fence;
  try {
    fence = await acquireTaskSettlementFence(repository, taskId);
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
  let taskSettled = false;
  try {
    const holder = await observeApplicableHolder({ repository, channel, candidate, lags });
    if (holder === null || holder.taskId !== taskId) return false;
    taskSettled = await completeHeldTask({ repository, candidate, actions, lags, taskId });
    if (!taskSettled) return true;
    await releaseHeldTaskHolder({ repository, channel, candidate, taskId, lags });
    return true;
  } finally {
    try {
      await fence.close();
    } catch (error) {
      if (!taskSettled) throw error;
      lags.push({
        kind: "settlement-failed",
        surface: "task-holder",
        contractId: candidate.id,
        taskId,
        diagnostic: diagnostic(error),
      });
    }
  }
}

async function settleObserved(input: SettlementInput): Promise<SettlementReport> {
  if (input.state === null) return { actions: [], lags: [] };
  const actions: SettlementAction[] = [],
    lags: SettlementLag[] = [];
  const candidate = input.state;
  if (candidate.terminal?.kind === "claimed") {
    try {
      await settleTasks({
        repository: input.repository,
        channel: input.channel,
        candidate,
        actions,
        lags,
      });
    } catch (error) {
      lags.push({
        kind: "settlement-failed",
        surface: "task",
        contractId: candidate.id,
        diagnostic: diagnostic(error),
      });
    }
  }
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
