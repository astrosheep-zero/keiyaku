import { snapshotIdSchema } from "./identity.js";
import { z } from "zod";
import { targetCheckoutEffectSchema, targetCheckoutLagSchema, targetWorkspaceLagSchema } from "./target-placement.js";
import { worktreeHookLagSchema } from "./hooks.js";
import { unsealedBytesSchema } from "./terminal-seal.js";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acquireSqliteTransactionLock,
  SqliteTransactionLockError,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  CANDIDATE_PIN_REF_NAMESPACE,
  commonGitDirectory,
  DELIVERY_REF_NAMESPACE,
  registeredWorktreePaths,
} from "./repository.js";
import { executeGit, GitPlumbingError, type GitRepository } from "./process.js";
import { targetName, type ContractId, type ContractState, type SnapshotId } from "../core/facts/types.js";
import { appointmentFor, readPlaceRegister } from "../workspace-place.js";
import { contractLocator, contractPhysicalName, gitObjectIdForSnapshot } from "./identity.js";
import { observeContractAt } from "./observe.js";
import { GitPrivateStateSeatContentionError, withPrivateStatePublicationSeat } from "./private-state-seat.js";
import type { GitDecodeChannel } from "./read-observation.js";
import { acquireTargetPlacementFence, recoverTargetPlacement } from "./target-placement.js";
import { runCreateHooks, type WorktreeHooks } from "./hooks.js";
import { followDependentManagedWorktree, retireConflictHandoff, worktreePath } from "./workspace.js";
import { removeCollectableScratchWorktrees } from "./scratch.js";
import { reconcileTerminalManagedWorktree, removeRef, updateRef } from "./terminal-reconcile.js";

class WorktreeCustodyError extends Error {}

const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

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
type ReconcileInput = Readonly<{
  repository: GitRepository;
  channel: GitDecodeChannel;
  contractId: ContractId;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  retainTerminalWorktree?: boolean;
  place?: string;
  onPhysical?: (report: ReconcileResult) => void;
}>;
type ReconcileEffectsInput = ReconcileInput;
const reconcileFailureSchema = z
  .object({
    kind: z.literal("reconcile-failed"),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
type ReconcileFailure = z.infer<typeof reconcileFailureSchema>;
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
export type ReconcileResult = Readonly<{
  effects: readonly Effect[];
  lag: readonly ReconcileLag[];
}>;
type ReconcileBatchItem = Readonly<{
  contract: ContractId;
  state: ContractState | null;
  result: ReconcileResult;
}>;
type GitReconcileObservation = Readonly<{
  state: ContractState | null;
  result: ReconcileResult;
}>;
export type WorktreeTopology = Readonly<{ paths: Set<string> }>;
export type ReconcileAccumulation = Readonly<{
  effects: Effect[];
  lag: ReconcileLag[];
  recordEffect(...effects: readonly Effect[]): void;
  recordLag(...lag: readonly ReconcileLag[]): void;
}>;

function deliveryRefFor(contract: ContractId): string {
  return `${DELIVERY_REF_NAMESPACE}/${contractPhysicalName(contract)}`;
}
function candidatePinRefFor(contract: ContractId): string {
  return `${CANDIDATE_PIN_REF_NAMESPACE}/${contractPhysicalName(contract)}`;
}

function missingPlaceLag(repository: GitRepository): ReconcileFailure {
  return {
    kind: "reconcile-failed",
    diagnostic: `managed Contract is unappointed: ${join(repository.commonDirectory, "keiyaku", "places.json")}`,
  };
}
async function acquireWorktreeTopology(repository: GitRepository): Promise<WorktreeTopology> {
  return { paths: new Set(await registeredWorktreePaths(repository)) };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function complete(effects: readonly Effect[] = [], lag: readonly ReconcileLag[] = []): ReconcileResult {
  return { effects, lag };
}
/** Append owner observations and publish those same objects before the next await. */
function reconcileAccumulation(onPhysical: ReconcileInput["onPhysical"]): ReconcileAccumulation {
  const effects: Effect[] = [];
  const lag: ReconcileLag[] = [];
  return {
    effects,
    lag,
    recordEffect(...observed) {
      effects.push(...observed);
      if (observed.length > 0) onPhysical?.({ effects: observed, lag: [] });
    },
    recordLag(...observed) {
      lag.push(...observed);
      if (observed.length > 0) onPhysical?.({ effects: [], lag: observed });
    },
  };
}

function failed(error: unknown, effects: readonly Effect[] = [], lag: readonly ReconcileLag[] = []): ReconcileResult {
  if (
    !(
      error instanceof WorktreeCustodyError ||
      error instanceof GitPrivateStateSeatContentionError ||
      error instanceof GitPlumbingError ||
      error instanceof SqliteTransactionLockError ||
      (error instanceof Error &&
        !(error instanceof AuthorityCorruptionError) &&
        !(error instanceof TypeError) &&
        "code" in error &&
        typeof error.code === "string" &&
        /^E[A-Z0-9]+$/u.test(error.code))
    )
  )
    throw error;
  return { effects, lag: [...lag, { kind: "reconcile-failed", diagnostic: diagnostic(error) }] };
}

function reconcileLockPath(repository: GitRepository, contract: ContractId): string {
  const locator = contractLocator(contract);
  return join(
    commonGitDirectory(repository),
    "keiyaku",
    "locks",
    "reconcile",
    locator.slice(0, 2),
    `${locator.slice(2)}.sqlite`,
  );
}

async function worktree(
  repository: GitRepository,
  topology: WorktreeTopology,
  path: string,
  desired: SnapshotId,
): Promise<Extract<Effect, { kind: "worktree" }>> {
  const registered = topology.paths.has(path);
  if (registered && (await pathExists(path))) return { kind: "worktree", path, action: "unchanged" };
  if (registered) {
    await executeGit(repository, ["worktree", "remove", path]);
    topology.paths.delete(path);
  }
  if (await pathExists(path)) throw new WorktreeCustodyError(`delivery worktree path is occupied: ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await executeGit(repository, ["worktree", "add", "--detach", path, gitObjectIdForSnapshot(desired)]);
  topology.paths.add(path);
  return { kind: "worktree", path, action: "created" };
}
async function removeCollectableScratch(
  repository: GitRepository,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
  terminalContract?: ContractId,
): Promise<void> {
  for (const removal of await removeCollectableScratchWorktrees(repository, topology.paths, terminalContract)) {
    if (!removal.retained) {
      acc.recordEffect({ kind: "worktree", path: removal.path, action: "removed" });
      continue;
    }
    acc.recordLag({
      kind: "worktree-retained",
      path: removal.path,
      ...(removal.diagnostic === undefined ? {} : { diagnostic: removal.diagnostic }),
    });
  }
}

async function reconcileTargetCheckouts(
  repository: GitRepository,
  state: ContractState,
  onPhysical?: (report: ReconcileResult) => void,
): Promise<ReconcileResult> {
  if (state.terminal?.kind !== "claimed" || state.coordinates.target === undefined || state.delivery === null) {
    return complete();
  }
  let held: HeldSqliteTransactionLock;
  try {
    held = await acquireTargetPlacementFence(repository, targetName(state.coordinates.target));
  } catch (error) {
    return failed(error);
  }
  let result: ReconcileResult | undefined;
  let exceptional: { error: unknown } | undefined;
  try {
    const recovered = await recoverTargetPlacement(repository, state, onPhysical);
    result = complete(recovered.effects, recovered.lag);
  } catch (error) {
    try {
      result = failed(error);
    } catch (unexpected) {
      exceptional = { error: unexpected };
    }
  }
  let releaseFailure: unknown;
  try {
    held.close();
  } catch (error) {
    releaseFailure = error;
  }
  if (exceptional !== undefined) throw exceptional.error;
  if (result === undefined) throw new Error("target checkout reconcile produced no result");
  if (releaseFailure !== undefined) result = failed(releaseFailure, result.effects, result.lag);
  return result;
}

async function reconcileActiveManagedWorktree(
  { repository, channel, hooks, retryHooks, place }: ReconcileEffectsInput,
  state: ContractState,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
): Promise<ReconcileResult> {
  const { effects, lag } = acc;
  if (place === undefined) {
    acc.recordLag(missingPlaceLag(repository));
    return complete(effects, lag);
  }
  const path = worktreePath(repository, place);
  const desired = state.delivery?.data.tenderSnapshot ?? state.coordinates.start;
  const pins = await withPrivateStatePublicationSeat(repository, async () => {
    const current = (await observeContractAt(repository, channel, state.id)).state;
    if (current?.head !== state.head) return undefined;
    acc.recordEffect(await updateRef(repository, deliveryRefFor(state.id), desired));
    acc.recordEffect(
      state.delivery
        ? await updateRef(
            repository,
            candidatePinRefFor(state.id),
            state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot,
          )
        : await removeRef(repository, candidatePinRefFor(state.id)),
    );
    return true;
  });
  if (pins.value === undefined)
    throw new WorktreeCustodyError(`Contract moved during workspace reconciliation: ${state.id}`);
  const projection = await worktree(repository, topology, path, desired);
  acc.recordEffect(projection);
  const handoff = await retireConflictHandoff(repository, {
    contractId: state.id,
    place,
    workspace: path,
    consume: state.delivery !== null,
  });
  if (state.delivery !== null && handoff.kind === "retained") {
    acc.recordLag({
      kind: "reconcile-failed",
      diagnostic: `conflict handoff retirement retained: ${handoff.reason}`,
    });
  }
  if (projection.action === "created" || retryHooks) {
    const hookRun = await runCreateHooks(path, hooks);
    if (hookRun.lag !== null) acc.recordLag(hookRun.lag);
  }
  return complete(effects, lag);
}

async function terminalHandoffRetained(
  input: ReconcileEffectsInput,
  state: ContractState,
  topology: WorktreeTopology,
  acc: ReconcileAccumulation,
): Promise<boolean> {
  if (input.place === undefined) return false;
  const path = worktreePath(input.repository, input.place);
  if (!topology.paths.has(path) && !(await pathExists(path))) return false;
  const handoff = await retireConflictHandoff(input.repository, {
    contractId: state.id,
    place: input.place,
    workspace: path,
    consume: state.delivery !== null,
  });
  if (handoff.kind === "active") {
    acc.recordLag({
      kind: "reconcile-failed",
      diagnostic: "conflict handoff retirement retained: active",
    });
    return true;
  }
  if (handoff.kind !== "retained") return false;
  acc.recordLag({
    kind: "reconcile-failed",
    diagnostic: `conflict handoff retirement retained: ${handoff.reason}`,
  });
  return true;
}

async function reconcileWithTopology(
  input: ReconcileEffectsInput,
  state: ContractState | null,
  topology: WorktreeTopology,
): Promise<ReconcileResult> {
  const { repository } = input;
  const acc = reconcileAccumulation(input.onPhysical);
  const { effects, lag } = acc;
  try {
    await removeCollectableScratch(repository, topology, acc, state?.terminal ? state.id : undefined);
    if (!state) return complete(effects, lag);
    if (state.terminal) {
      if (await terminalHandoffRetained(input, state, topology, acc)) return complete(effects, lag);
      return await reconcileTerminalManagedWorktree(input, state, topology, acc, {
        ref: deliveryRefFor(state.id),
        pin: candidatePinRefFor(state.id),
      });
    }
    const result = await reconcileActiveManagedWorktree(input, state, topology, acc);
    return result;
  } catch (error) {
    return failed(error, effects, lag);
  }
}

function releaseFailure(
  held: HeldSqliteTransactionLock,
  observation: GitReconcileObservation | undefined,
): GitReconcileObservation | undefined {
  try {
    held.close();
    return observation;
  } catch (error) {
    const prior = observation?.result;
    return {
      state: observation?.state ?? null,
      result: failed(error, prior?.effects, prior?.lag),
    };
  }
}

type ReconcileCursor = {
  before: ContractState | null;
  outgoing?: ReconcileResult;
  observation?: GitReconcileObservation | undefined;
};

async function reconcileFreshEffects(input: ReconcileInput, cursor: ReconcileCursor): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = (await observeContractAt(input.repository, input.channel, input.contractId)).state;
    cursor.before = before;
    const recovered =
      before === null ? complete() : await reconcileTargetCheckouts(input.repository, before, input.onPhysical);
    const outgoing = {
      effects: [...(cursor.outgoing?.effects ?? []), ...recovered.effects],
      lag: [...(cursor.outgoing?.lag ?? []), ...recovered.lag],
    };
    cursor.outgoing = outgoing;
    const incoming = await acquireTargetPlacementFence(input.repository, input.contractId);
    try {
      const state = (await observeContractAt(input.repository, input.channel, input.contractId)).state;
      if (state?.head !== before?.head) continue;
      const topology = await acquireWorktreeTopology(input.repository);
      const place = appointmentFor(await readPlaceRegister(input.repository), input.contractId)?.place;
      const { place: _previousPlace, ...base } = input;
      const result = await reconcileWithTopology(
        { ...base, ...(place === undefined ? {} : { place }) },
        state,
        topology,
      );
      cursor.observation = {
        state,
        result: { ...result, effects: [...outgoing.effects, ...result.effects], lag: [...outgoing.lag, ...result.lag] },
      };
    } finally {
      incoming.close();
    }
    return;
  }
  throw new WorktreeCustodyError(`Contract moved during reconciliation: ${input.contractId}`);
}

export async function reconcile(input: ReconcileInput): Promise<GitReconcileObservation> {
  let held: HeldSqliteTransactionLock;
  try {
    held = await acquireSqliteTransactionLock({
      path: reconcileLockPath(input.repository, input.contractId),
      mode: "immediate",
    });
  } catch (error) {
    return { state: null, result: failed(error) };
  }

  const cursor: ReconcileCursor = { before: null };
  let exceptional: { error: unknown } | undefined;
  try {
    await reconcileFreshEffects(input, cursor);
    input.onPhysical?.(cursor.observation!.result);
  } catch (error) {
    try {
      const prior = cursor.observation?.result ?? cursor.outgoing;
      cursor.observation = {
        state: cursor.observation?.state ?? cursor.before,
        result: failed(error, prior?.effects, prior?.lag),
      };
    } catch (unexpected) {
      exceptional = { error: unexpected };
    }
  }

  try {
    cursor.observation = releaseFailure(held, cursor.observation);
  } catch (error) {
    exceptional ??= { error };
  }
  if (exceptional !== undefined) throw exceptional.error;
  if (cursor.observation === undefined) throw new Error("reconcile produced no observation");
  return cursor.observation;
}

/** Reconcile one retained dependent worktree under its normal per-Contract lock. */
export async function reconcileDependentWorktree(
  repository: GitRepository,
  contractId: ContractId,
  path: string,
  target: SnapshotId,
): Promise<ReconcileResult> {
  let held: HeldSqliteTransactionLock;
  try {
    held = await acquireSqliteTransactionLock({ path: reconcileLockPath(repository, contractId), mode: "immediate" });
  } catch (error) {
    return failed(error);
  }
  let result: ReconcileResult;
  try {
    const incoming = await acquireTargetPlacementFence(repository, contractId);
    try {
      const appointed = appointmentFor(await readPlaceRegister(repository), contractId);
      if (appointed === undefined || worktreePath(repository, appointed.place) !== path)
        throw new WorktreeCustodyError(`dependent Contract workspace appointment changed: ${contractId}`);
      const follow = await followDependentManagedWorktree(repository, path, target);
      if (follow.kind === "followed") {
        result = {
          effects: [{ kind: "worktree", path, action: "followed", before: follow.before, after: follow.after }],
          lag: [],
        };
      } else if (follow.kind === "unchanged") {
        result = { effects: [], lag: [] };
      } else {
        result = {
          effects: [{ kind: "worktree", path, action: "unchanged" }],
          lag: [
            {
              kind: "worktree-follow-retained",
              path,
              reason: follow.reason,
            },
          ],
        };
      }
    } finally {
      incoming.close();
    }
  } catch (error) {
    result = failed(error, [{ kind: "worktree", path, action: "unchanged" }]);
  }
  try {
    held.close();
  } catch (error) {
    result = failed(error, result.effects, result.lag);
  }
  return result;
}

export function reconcileObservationFailure(error: unknown): ReconcileResult {
  return failed(error);
}

export function reconcileEffectFailure(error: unknown, prior?: ReconcileResult): ReconcileResult {
  return failed(error, prior?.effects, prior?.lag);
}

type ReconcileBatchOptions = Readonly<{
  hooks: WorktreeHooks;
  retryHooks: boolean;
  retainTerminalWorktree: boolean;
  places?: ReadonlyMap<ContractId, string>;
}>;

/** Reconcile each discovered Contract through its own serialized, fresh observation. */
export async function reconcileBatch(
  repository: GitRepository,
  channel: GitDecodeChannel,
  contracts: Iterable<ContractId>,
  options: ReconcileBatchOptions,
): Promise<readonly ReconcileBatchItem[]> {
  const items: ReconcileBatchItem[] = [];
  for (const contract of contracts) {
    const place = options.places?.get(contract);
    const observation = await reconcile({
      repository,
      channel,
      contractId: contract,
      hooks: options.hooks,
      retryHooks: options.retryHooks,
      retainTerminalWorktree: options.retainTerminalWorktree,
      ...(place === undefined ? {} : { place }),
    });
    items.push({ contract, state: observation.state, result: observation.result });
  }
  return items;
}
