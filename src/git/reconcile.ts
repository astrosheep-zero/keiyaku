import { z } from "zod";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acquireSqliteTransactionLock,
  SqliteTransactionLockError,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  targetName,
  type ContractHead,
  type ContractId,
  type ContractState,
  type SnapshotId,
} from "../core/facts/types.js";
import { readPlaceRegister, type PlaceRegister } from "../workspace-place.js";
import { runCreateHooks, worktreeHookLagSchema, type WorktreeHooks } from "./hooks.js";
import { contractLocator, contractPhysicalName, gitObjectIdForSnapshot, snapshotIdSchema } from "./identity.js";
import { observeContractAt } from "./observe.js";
import { GitPrivateStateSeatContentionError, withPrivateStatePublicationSeat } from "./private-state-seat.js";
import { executeGit, GitPlumbingError, type GitRepository } from "./process.js";
import type { GitDecodeChannel } from "./read-observation.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  DELIVERY_REF_NAMESPACE,
  pathExists,
  registeredWorktreePaths,
} from "./repository.js";
import { removeCollectableScratchWorktrees } from "./scratch.js";
import {
  acquireTargetPlacementFence,
  recoverTargetPlacement,
  targetCheckoutEffectSchema,
  targetCheckoutLagSchema,
  targetWorkspaceLagSchema,
} from "./target-placement.js";
import {
  removeSealedTerminalWorktree,
  releaseTerminalCustody,
  repairDetachedTerminalCustody,
  updateRef,
} from "./terminal-reconcile.js";
import { unsealedBytesSchema } from "./terminal-seal.js";
import { followDependentManagedWorktree, retireConflictHandoff, worktreePath } from "./workspace.js";

class WorktreeCustodyError extends Error {}

export const reconcileEffectSchema = z.union([
  z
    .object({
      kind: z.literal("worktree"),
      path: z.string().refine((value) => value.trim() !== ""),
      action: z.enum(["created", "removed", "unchanged"]),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("worktree"),
      path: z.string().refine((value) => value.trim() !== ""),
      action: z.literal("followed"),
      before: snapshotIdSchema,
      after: snapshotIdSchema,
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("recovery-snapshot"),
      snapshot: snapshotIdSchema,
    })
    .strict()
    .readonly(),
  targetCheckoutEffectSchema,
  z
    .object({
      kind: z.literal("ref"),
      name: z.string().refine((value) => value.trim() !== ""),
      before: z.string().min(1).nullable(),
      after: z.string().min(1).nullable(),
    })
    .strict()
    .readonly(),
]);
export type Effect = z.infer<typeof reconcileEffectSchema>;
const reconcileFailureSchema = z
  .object({
    kind: z.literal("reconcile-failed"),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
export const gitReconcileLagSchema = z.union([
  z
    .object({
      kind: z.literal("worktree-retained"),
      path: z.string().refine((value) => value.trim() !== ""),
      diagnostic: z
        .string()
        .refine((value) => value.trim() !== "")
        .exactOptional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("worktree-follow-retained"),
      path: z.string().refine((value) => value.trim() !== ""),
      reason: z.enum(["head-moved", "head-attached", "operation-in-progress"]),
    })
    .strict()
    .readonly(),
  unsealedBytesSchema,
  targetCheckoutLagSchema,
  targetWorkspaceLagSchema,
  worktreeHookLagSchema,
  reconcileFailureSchema,
]);
export type ReconcileLag = z.infer<typeof gitReconcileLagSchema>;
export type ReconcileResult = Readonly<{ effects: readonly Effect[]; lag: readonly ReconcileLag[] }>;
type ReconcileInput = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  contractId: ContractId;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  onPhysical?: (report: ReconcileResult) => void;
}>;
export type ReconcileAccumulation = Readonly<{
  report: ReconcileResult;
  recordEffect(effect: Effect): void;
  recordLag(lag: ReconcileLag): void;
  recordFailure(error: unknown): void;
}>;

function operational(error: unknown): error is Error {
  return (
    error instanceof WorktreeCustodyError ||
    error instanceof GitPrivateStateSeatContentionError ||
    error instanceof GitPlumbingError ||
    error instanceof SqliteTransactionLockError ||
    (error instanceof Error &&
      !(
        error instanceof AuthorityCorruptionError ||
        error instanceof TypeError ||
        error instanceof RangeError ||
        error instanceof ReferenceError ||
        error instanceof SyntaxError
      ) &&
      "code" in error &&
      typeof error.code === "string" &&
      /^E[A-Z0-9]+$/u.test(error.code))
  );
}

function failureLag(error: unknown): ReconcileLag {
  if (!operational(error)) throw error;
  return { kind: "reconcile-failed", diagnostic: error.message };
}

/** Publish each delta before another observation or retirement can fail. */
function reconcileAccumulation(
  repository: GitRepository,
  onPhysical?: ReconcileInput["onPhysical"],
): ReconcileAccumulation {
  const effects: Effect[] = [];
  const lag: ReconcileLag[] = [];
  const recordLag = (issue: ReconcileLag): void => {
    lag.push(issue);
    onPhysical?.({ effects: [], lag: [issue] });
  };
  return {
    report: { effects, lag },
    recordLag,
    recordEffect(effect) {
      effects.push(effect);
      onPhysical?.({ effects: [effect], lag: [] });
    },
    recordFailure(error) {
      if (repository.signal?.aborted && error === repository.signal.reason) throw error;
      recordLag(failureLag(error));
    },
  };
}

async function withReconcileLock(
  acquire: () => Promise<HeldSqliteTransactionLock>,
  acc: ReconcileAccumulation,
  work: () => Promise<void>,
): Promise<void> {
  let held: HeldSqliteTransactionLock | undefined;
  let exceptional = false;
  try {
    held = await acquire();
    await work();
  } catch (error) {
    exceptional = true;
    acc.recordFailure(error);
    exceptional = false;
  } finally {
    try {
      held?.close();
    } catch (error) {
      // A close lag is independent of the action; it must not replace an exceptional cause.
      if (!exceptional || operational(error)) acc.recordFailure(error);
    }
  }
}

function acquireEffectLock(repository: GitRepository, contract: ContractId): Promise<HeldSqliteTransactionLock> {
  const locator = contractLocator(contract);
  return acquireSqliteTransactionLock({
    path: join(
      repository.commonDirectory,
      "keiyaku",
      "locks",
      "reconcile",
      locator.slice(0, 2),
      `${locator.slice(2)}.sqlite`,
    ),
    mode: "immediate",
    ...(repository.signal === undefined ? {} : { signal: repository.signal }),
  });
}

function custodyRefs(id: ContractId) {
  const name = contractPhysicalName(id);
  return { ref: `${DELIVERY_REF_NAMESPACE}/${name}`, pin: `${CANDIDATE_PIN_REF_NAMESPACE}/${name}` };
}

async function collectScratch(
  repository: GitRepository,
  paths: Set<string>,
  acc: ReconcileAccumulation,
  terminal?: ContractId,
) {
  await removeCollectableScratchWorktrees(repository, paths, terminal, (removal) => {
    if (removal.retained)
      acc.recordLag({
        kind: "worktree-retained",
        path: removal.path,
        ...(removal.diagnostic === undefined ? {} : { diagnostic: removal.diagnostic }),
      });
    else acc.recordEffect({ kind: "worktree", path: removal.path, action: "removed" });
  });
}

async function ensureWorktree(
  repository: GitRepository,
  paths: Set<string>,
  path: string,
  desired: SnapshotId,
  acc: ReconcileAccumulation,
) {
  if (paths.has(path)) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (info?.isDirectory()) return false;
    if (info !== undefined) throw new WorktreeCustodyError(`delivery worktree path is occupied: ${path}`);
    await executeGit(repository, ["worktree", "remove", path]);
  }
  if (await pathExists(path)) throw new WorktreeCustodyError(`delivery worktree path is occupied: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await executeGit(repository, ["worktree", "add", "--detach", path, gitObjectIdForSnapshot(desired)]);
  acc.recordEffect({ kind: "worktree", path, action: "created" });
  return true;
}

async function repairPins(
  input: ReconcileInput,
  state: ContractState,
  acc: ReconcileAccumulation,
  terminalWithoutWorkspace: boolean,
) {
  const { repository, channel } = input;
  const { ref, pin } = custodyRefs(state.id);
  let exceptional: { error: unknown } | undefined;
  let repaired = false;
  try {
    await withPrivateStatePublicationSeat(repository, async () => {
      try {
        const current = (await observeContractAt(repository, channel, state.id)).state;
        if (current?.head !== state.head) throw moved(state.id);
        if (terminalWithoutWorkspace && state.delivery !== null) {
          await repairDetachedTerminalCustody({ repository, channel, state, ref, pin, acc });
        } else {
          await updateRef(repository, ref, state.delivery?.data.tenderSnapshot ?? state.coordinates.start, acc);
          const integration =
            state.delivery === null
              ? null
              : (state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot);
          if (integration !== null || state.terminal === null) await updateRef(repository, pin, integration, acc);
        }
        repaired = true;
      } catch (error) {
        try {
          acc.recordFailure(error);
        } catch (cause) {
          // The seat owns close, but cannot replace the original exceptional cause.
          exceptional = { error: cause };
        }
      }
    });
  } catch (error) {
    repaired = false;
    if (exceptional === undefined || operational(error)) acc.recordFailure(error);
  }
  if (exceptional !== undefined) throw exceptional.error;
  return repaired;
}

function moved(id: ContractId): WorktreeCustodyError {
  return new WorktreeCustodyError(`Contract moved during reconciliation: ${id}`);
}

async function retireHandoff(
  input: ReconcileInput,
  state: ContractState,
  place: string,
  path: string,
  acc: ReconcileAccumulation,
) {
  const handoff = await retireConflictHandoff(input.repository, {
    contractId: state.id,
    place,
    workspace: path,
    consume: state.delivery !== null,
  });
  if (
    (state.terminal !== null && handoff.kind === "active") ||
    ((state.terminal !== null || state.delivery !== null) && handoff.kind === "retained")
  ) {
    acc.recordLag({
      kind: "reconcile-failed",
      diagnostic: `conflict handoff retirement retained: ${handoff.kind === "retained" ? handoff.reason : "active"}`,
    });
    return false;
  }
  return true;
}

export async function repairContractEffects(input: ReconcileInput) {
  const { repository, channel, contractId } = input;
  const acc = reconcileAccumulation(repository, input.onPhysical);
  let state: ContractState | undefined;
  let workspace: PlaceRegister | undefined;
  let handoffSafe = false;
  await withReconcileLock(
    () => acquireEffectLock(repository, contractId),
    acc,
    async () => {
      const before = (await observeContractAt(repository, channel, contractId)).state;
      if (before === null) return;
      const target = before.coordinates.target;
      if (before.terminal?.kind === "claimed" && target !== undefined && before.delivery !== null) {
        await withReconcileLock(
          () => acquireTargetPlacementFence(repository, targetName(target)),
          acc,
          async () => {
            const append = (delta: ReconcileResult): void => {
              for (const effect of delta.effects) acc.recordEffect(effect);
              for (const lag of delta.lag) acc.recordLag(lag);
            };
            let streamed = false;
            const result = await recoverTargetPlacement(repository, before, (delta) => {
              streamed = true;
              append(delta);
            });
            // The existing follower returns an early target-incarnation refusal before it starts streaming.
            if (!streamed) append(result);
          },
        );
      }
      await withReconcileLock(
        () => acquireTargetPlacementFence(repository, contractId),
        acc,
        async () => {
          const current = (await observeContractAt(repository, channel, contractId)).state;
          if (current === null || current.head !== before.head) throw moved(contractId);
          state = current;
          const paths = new Set(await registeredWorktreePaths(repository));
          const register = await readPlaceRegister(repository);
          const place = register.get(contractId);
          if (current.terminal === null) await collectScratch(repository, paths, acc);
          if (place === undefined) {
            if (current.terminal === null)
              throw new WorktreeCustodyError(`managed Contract is unappointed: ${contractId}`);
            return;
          }
          const path = worktreePath(repository, place);
          const terminalWithoutWorkspace = current.terminal !== null && !(paths.has(path) && (await pathExists(path)));
          if (terminalWithoutWorkspace && current.delivery === null && !paths.has(path)) return;
          if (!(await repairPins(input, current, acc, terminalWithoutWorkspace))) return;
          if (current.terminal !== null) {
            if (!terminalWithoutWorkspace) handoffSafe = await retireHandoff(input, current, place, path, acc);
            return;
          }
          const desired = current.delivery?.data.tenderSnapshot ?? current.coordinates.start;
          const created = await ensureWorktree(repository, paths, path, desired, acc);
          workspace = register;
          await retireHandoff(input, current, place, path, acc);
          if (created || input.retryHooks) {
            const hook = await runCreateHooks(path, input.hooks);
            if (hook.lag !== null) acc.recordLag(hook.lag);
          }
        },
      );
    },
  );
  return { state, workspace, handoffSafe, report: acc.report };
}

export async function cleanupTerminalContract(
  input: ReconcileInput & { expectedHead: ContractHead | null; handoffSafe: boolean },
) {
  const { channel, contractId, expectedHead } = input;
  const repository = { ...input.repository, effectiveCwd: input.repository.primaryWorktree };
  const acc = reconcileAccumulation(repository, input.onPhysical);
  let appointedPathAbsent = false;
  await withReconcileLock(
    () => acquireEffectLock(repository, contractId),
    acc,
    async () => {
      await withReconcileLock(
        () => acquireTargetPlacementFence(repository, contractId),
        acc,
        async () => {
          const state = (await observeContractAt(repository, channel, contractId)).state;
          if (state === null || state.head !== expectedHead || state.terminal === null) throw moved(contractId);
          const paths = new Set(await registeredWorktreePaths(repository));
          const place = (await readPlaceRegister(repository)).get(contractId);
          await collectScratch(repository, paths, acc, contractId);
          if (place !== undefined) {
            const path = worktreePath(repository, place);
            if (paths.has(path) && (await pathExists(path))) {
              if (!input.handoffSafe) {
                acc.recordLag({ kind: "worktree-retained", path });
                return;
              }
              if (!(await retireHandoff({ ...input, repository }, state, place, path, acc))) return;
            }
            if (
              !(await removeSealedTerminalWorktree({
                repository,
                channel,
                paths,
                path,
                state,
                hooks: input.hooks,
                acc,
              }))
            )
              return;
            appointedPathAbsent = true;
          }
          await releaseTerminalCustody({ repository, channel, state, ...custodyRefs(contractId), acc });
        },
      );
    },
  );
  return { appointedPathAbsent, report: acc.report };
}

/** Follow one retained dependent workspace under its normal effect and incoming custody. */
export async function reconcileDependentWorktree(
  repository: GitRepository,
  contractId: ContractId,
  path: string,
  target: SnapshotId,
  onPhysical?: ReconcileInput["onPhysical"],
): Promise<ReconcileResult> {
  const acc = reconcileAccumulation(repository, onPhysical);
  await withReconcileLock(
    () => acquireEffectLock(repository, contractId),
    acc,
    async () => {
      await withReconcileLock(
        () => acquireTargetPlacementFence(repository, contractId),
        acc,
        async () => {
          const place = (await readPlaceRegister(repository)).get(contractId);
          if (place === undefined || worktreePath(repository, place) !== path)
            throw new WorktreeCustodyError(`dependent Contract workspace appointment changed: ${contractId}`);
          const follow = await followDependentManagedWorktree(repository, path, target);
          if (follow.kind === "followed")
            acc.recordEffect({
              kind: "worktree",
              path,
              action: "followed",
              before: follow.before,
              after: follow.after,
            });
          if (follow.kind === "retained")
            acc.recordLag({ kind: "worktree-follow-retained", path, reason: follow.reason });
        },
      );
    },
  );
  return acc.report;
}

export function reconcileEffectFailure(error: unknown, prior?: ReconcileResult): ReconcileResult {
  return { effects: prior?.effects ?? [], lag: [...(prior?.lag ?? []), failureLag(error)] };
}
