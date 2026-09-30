import { contractIdSchema } from "../git/identity.js";
import { z } from "zod";
import { taskIdSchema } from "../task/identity.js";
import { type ContractId, type ContractState } from "../core/facts/types.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import {
  appendPrivateStateSeatClose,
  withPrivateStatePublicationSeat,
  type PrivateStateSeatCloseLag,
} from "../git/private-state-seat.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { Effect } from "../git/reconcile.js";
import { GitPlumbingError, type GitRepository } from "../git/process.js";
import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
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
export const settlementActionSchema = z
  .object({ kind: z.literal("task"), taskId: taskIdSchema, action: z.literal("done") })
  .strict();
export type SettlementAction = z.infer<typeof settlementActionSchema>;
export const settlementLagSchema = z
  .object({
    kind: z.literal("settlement-failed"),
    surface: z.enum(["task-holder", "task"]),
    contractId: contractIdSchema,
    taskId: taskIdSchema.optional(),
    path: z
      .string()
      .refine((value) => value.trim() !== "")
      .optional(),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict();
export type SettlementLag = z.infer<typeof settlementLagSchema>;
export type SettlementReport = Readonly<{
  actions: readonly SettlementAction[];
  lags: readonly SettlementLag[];
  seatClose?: readonly PrivateStateSeatCloseLag[];
}>;

export type SettlementProgress = Readonly<{
  recordSettlement(contractId: ContractId, report: SettlementReport): void;
}>;

function operational(error: unknown): boolean {
  return (
    error instanceof Error &&
    !(error instanceof AuthorityCorruptionError) &&
    (error instanceof GitPlumbingError ||
      error instanceof SqliteTransactionLockError ||
      ("code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/u.test(error.code)))
  );
}

export type SettlementInput = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  state: ContractState | null;
  effects: readonly Effect[];
  progress?: SettlementProgress;
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
  seatClose: PrivateStateSeatCloseLag[];
  progress?: SettlementProgress;
}>;

function recordLag(input: Pick<SettleTasksInput, "candidate" | "lags" | "progress">, lag: SettlementLag): void {
  input.lags.push(lag);
  input.progress?.recordSettlement(input.candidate.id, { actions: [], lags: [lag] });
}
function recordAction(
  input: Pick<SettleTasksInput, "candidate" | "actions" | "progress">,
  action: SettlementAction,
): void {
  input.actions.push(action);
  input.progress?.recordSettlement(input.candidate.id, { actions: [action], lags: [] });
}

async function observeApplicableHolder(
  input: Pick<SettleTasksInput, "repository" | "channel" | "candidate" | "lags" | "progress">,
): Promise<TaskHolder | null> {
  const { repository, channel, candidate } = input;
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
    if (!operational(error)) throw error;
    recordLag(input, {
      kind: "settlement-failed",
      surface: "task-holder",
      contractId: candidate.id,
      diagnostic: diagnostic(error),
    });
    return null;
  }
}

async function completeHeldTask(
  input: Pick<SettleTasksInput, "repository" | "candidate" | "actions" | "lags" | "progress"> & { taskId: TaskId },
): Promise<boolean> {
  const { repository, candidate, taskId } = input;
  let world: WorldRoot;
  try {
    world = await World.at(repository.primaryWorktree);
  } catch (error) {
    if (!operational(error)) throw error;
    recordLag(input, {
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
    if (!operational(error)) throw error;
    recordLag(input, {
      kind: "settlement-failed",
      surface: "task",
      contractId: candidate.id,
      taskId,
      diagnostic: diagnostic(error),
    });
    return false;
  }
  if (result.kind === "changed") recordAction(input, { kind: "task", taskId, action: "done" });
  if (result.kind === "changed" && result.cleanup !== undefined) {
    for (const detail of result.cleanup.diagnostics) {
      recordLag(input, {
        kind: "settlement-failed",
        surface: "task",
        contractId: candidate.id,
        taskId,
        diagnostic: detail,
      });
    }
  }
  if (result.kind === "changed" || result.kind === "unchanged") return true;
  recordLag(input, {
    kind: "settlement-failed",
    surface: "task",
    contractId: candidate.id,
    taskId,
    diagnostic: taskFailure(result),
  });
  return false;
}

async function releaseHeldTaskHolder(
  input: Pick<SettleTasksInput, "repository" | "channel" | "candidate" | "lags" | "seatClose" | "progress"> & {
    taskId: TaskId;
  },
): Promise<"released" | "held" | "inert"> {
  const { repository, channel, candidate, seatClose, taskId } = input;
  try {
    const outcome = await withPrivateStatePublicationSeat(repository, async (seat) => {
      const observation = await observeContractsForAdmissionAt(
        repository,
        channel,
        [candidate.id],
        taskHolderObservationSelection(),
      );
      const state = observation.journals.get(candidate.id)?.state ?? null;
      if (state === null || state.terminal?.kind !== "claimed") return "inert" as const;
      const holder = (await readTaskHolderProjectionFromDecision(channel, observation)).get(candidate.id) ?? null;
      if (holder === null || holder.disposition !== "held" || holder.taskId !== taskId) return "inert" as const;
      const publication = await publishTaskHolderRelease(repository, channel, observation, candidate.id, seat);
      if (publication.kind === "non-published") {
        recordLag(input, {
          kind: "settlement-failed",
          surface: "task-holder",
          contractId: candidate.id,
          taskId,
          diagnostic: `Task holder release requires retry: ${publication.diagnostic}`,
        });
        return "held" as const;
      }
      return publication.kind === "released" ? ("released" as const) : ("inert" as const);
    });
    if (outcome.closeLag !== undefined) {
      seatClose.push(...appendPrivateStateSeatClose(undefined, outcome.closeLag));
      input.progress?.recordSettlement(candidate.id, { actions: [], lags: [], seatClose: [outcome.closeLag] });
    }
    return outcome.value;
  } catch (error) {
    if (!operational(error)) throw error;
    recordLag(input, {
      kind: "settlement-failed",
      surface: "task-holder",
      contractId: candidate.id,
      taskId,
      diagnostic: diagnostic(error),
    });
    return "held";
  }
}

async function settleTasks(input: SettleTasksInput): Promise<boolean> {
  const { repository, channel, candidate, lags, seatClose } = input;
  const hint = await observeApplicableHolder(input);
  if (hint === null) return false;
  const taskId = hint.taskId;
  let fence;
  try {
    fence = await acquireTaskSettlementFence(repository, taskId);
  } catch (error) {
    if (!operational(error)) throw error;
    recordLag(input, {
      kind: "settlement-failed",
      surface: "task",
      contractId: candidate.id,
      taskId,
      diagnostic: diagnostic(error),
    });
    return true;
  }
  let failure: { error: unknown } | undefined;
  let taskSettled = false;
  let holderDisposition: "released" | "held" | "inert" | null = null;
  try {
    const holder = await observeApplicableHolder(input);
    if (holder === null || holder.taskId !== taskId) return false;
    taskSettled = await completeHeldTask({ ...input, taskId });
    if (!taskSettled) return true;
    holderDisposition = await releaseHeldTaskHolder({
      repository,
      channel,
      candidate,
      taskId,
      lags,
      seatClose,
      ...(input.progress === undefined ? {} : { progress: input.progress }),
    });
    return true;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      await fence.close();
    } catch (error) {
      if (!operational(error)) {
        if (failure === undefined) throw error;
      } else if (!taskSettled && failure === undefined) throw error;
      // Post-release fence teardown is custodial residue, not an owed holder publication.
      if (holderDisposition !== "released") {
        recordLag(input, {
          kind: "settlement-failed",
          surface: "task-holder",
          contractId: candidate.id,
          taskId,
          diagnostic: diagnostic(error),
        });
      }
    }
  }
}

function settlementReport(
  actions: readonly SettlementAction[],
  lags: readonly SettlementLag[],
  seatClose: readonly PrivateStateSeatCloseLag[],
): SettlementReport {
  return {
    actions,
    lags,
    ...(seatClose.length === 0 ? {} : { seatClose }),
  };
}

async function settleObserved(input: SettlementInput): Promise<SettlementReport> {
  if (input.state === null) return { actions: [], lags: [] };
  const actions: SettlementAction[] = [],
    lags: SettlementLag[] = [],
    seatClose: PrivateStateSeatCloseLag[] = [];
  const candidate = input.state;
  if (candidate.terminal?.kind === "claimed") {
    try {
      await settleTasks({
        repository: input.repository,
        channel: input.channel,
        candidate,
        actions,
        lags,
        seatClose,
        ...(input.progress === undefined ? {} : { progress: input.progress }),
      });
    } catch (error) {
      if (!operational(error)) throw error;
      recordLag(
        { candidate, lags, ...(input.progress === undefined ? {} : { progress: input.progress }) },
        {
          kind: "settlement-failed",
          surface: "task",
          contractId: candidate.id,
          diagnostic: diagnostic(error),
        },
      );
    }
  }
  return settlementReport(actions, lags, seatClose);
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
