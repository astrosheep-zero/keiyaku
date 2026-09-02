import type { ContractId, ContractState } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import {
  reconcileAllOperation,
  reconcileOperation,
  worldContractStates,
  type ReconcileReport,
} from "../protocol/reconcile.js";
import { reconcileObservationFailure } from "../git/reconcile.js";
import { worktreePath } from "../git/workspace.js";
import { stateOperation, type RepositoryScope } from "../protocol/operations.js";
import { settle, settleAll, type SettlementReport } from "../settlement/settle.js";
import type { WorktreeHooks } from "./configuration.js";
import {
  projectContractWorktree,
  type ContractFileEffect,
  type ContractFileLag,
  type ContractWorktreeResult,
} from "../contract-worktree.js";
import {
  appointManagedWorktrees,
  placeRegisterPath,
  releaseManagedWorktrees,
  type PlaceRegister,
} from "../workspace-place.js";

export type ReconcileCompletion = Readonly<{
  effects: readonly (ReconcileReport["effects"][number] | ContractFileEffect)[];
  lag: readonly (ReconcileReport["lag"][number] | ContractFileLag)[];
  settlement: SettlementReport;
  hookRuns?: readonly { phase: "create" | "destroy"; name: string }[];
}>;

export type RepoContractReconcileReport = ReconcileCompletion;

type RepoReconcileContracts = readonly Readonly<{
  contractId: ContractId;
  report: RepoContractReconcileReport;
}>[];

export type RepoReconcileReport =
  | Readonly<{ kind: "completed"; contracts: RepoReconcileContracts }>
  | Readonly<{ kind: "world-observation-failed"; diagnostic: string }>;

type ReconcileOptions = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  hooks: WorktreeHooks;
  retryHooks: boolean;
}>;

function registerLag(scope: RepositoryScope, error: unknown): ContractFileLag {
  return {
    kind: "contract-file-failed",
    worktree: scope.primaryWorktree,
    path: placeRegisterPath(scope),
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

function emptySettlement(): SettlementReport {
  return { actions: [], lags: [] };
}

function isManagedWorktree(state: ContractState): boolean {
  return state.coordinates.workspace === "worktree";
}

function isManagedTerminal(state: ContractState | null): boolean {
  return state !== null && isManagedWorktree(state) && state.terminal !== null;
}

function appointableManagedContracts(states: readonly ContractState[]): readonly ContractId[] {
  return states.filter((state) => isManagedWorktree(state) && state.terminal === null).map((state) => state.id);
}

async function appointPlaces(scope: RepositoryScope, states: readonly ContractState[]): Promise<PlaceRegister> {
  return await appointManagedWorktrees(scope, appointableManagedContracts(states));
}

function realizedOrRetainedManagedWorktree(
  scope: RepositoryScope,
  report: ReconcileReport,
  place: string | undefined,
): boolean {
  if (place === undefined) return false;
  const path = worktreePath(scope, place);
  return report.effects.some(
    (effect) =>
      effect.kind === "worktree" &&
      effect.path === path &&
      (effect.action === "created" || effect.action === "unchanged" || effect.action === "followed"),
  );
}

function releaseEligible(
  state: ContractState | null,
  cleanup: ReconcileReport | undefined,
  appointed: boolean,
): boolean {
  return cleanup !== undefined && cleanup.lag.length === 0 && isManagedTerminal(state) && appointed;
}

async function releaseAppointments(
  scope: RepositoryScope,
  contracts: readonly ContractId[],
): Promise<ContractFileLag | undefined> {
  try {
    await releaseManagedWorktrees(scope, contracts);
    return undefined;
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
    return registerLag(scope, error);
  }
}

async function observeState(
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  contractId: ContractId,
): Promise<Readonly<{ state: ContractState } | { failed: ReconcileReport }>> {
  try {
    return { state: await stateOperation({ scope, channel, contractId }) };
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
    return { failed: reconcileObservationFailure(error) };
  }
}

async function appointForContract(
  scope: RepositoryScope,
  state: ContractState,
): Promise<Readonly<{ place?: string; register?: PlaceRegister } | { lag: ContractFileLag }>> {
  if (!isManagedWorktree(state)) return {};
  try {
    const register = await appointPlaces(scope, [state]);
    const place = register.byContract.get(state.id)?.place;
    if (place === undefined) {
      if (state.terminal !== null) return { register };
      throw new Error(`Place appointment was not recorded: ${state.id}`);
    }
    return { place, register };
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
    return { lag: registerLag(scope, error) };
  }
}

export async function completeReconcile(
  input: ReconcileOptions &
    Readonly<{
      contractId: ContractId;
    }>,
): Promise<ReconcileCompletion> {
  const observed = await observeState(input.scope, input.channel, input.contractId);
  if ("failed" in observed) {
    return { effects: observed.failed.effects, lag: observed.failed.lag, settlement: emptySettlement() };
  }
  const appointment = await appointForContract(input.scope, observed.state);
  if ("lag" in appointment) {
    return { effects: [], lag: [appointment.lag], settlement: emptySettlement() };
  }
  const appointed = appointment.place === undefined ? {} : { place: appointment.place };
  const retained = await reconcileOperation({
    ...input,
    retainTerminalWorktree: true,
    ...appointed,
  });
  const projection = realizedOrRetainedManagedWorktree(input.scope, retained.report, appointment.place)
    ? await projectContractWorktree(input.scope, retained.state, appointment.register)
    : { effects: [], lag: [] };
  const settlement = await settle({
    repository: input.scope,
    channel: input.channel,
    state: retained.state,
    effects: retained.report.effects,
  });
  const cleanup = isManagedTerminal(retained.state) ? await reconcileOperation({ ...input, ...appointed }) : null;
  const release = releaseEligible(retained.state, cleanup?.report, appointment.place !== undefined)
    ? await releaseAppointments(input.scope, [input.contractId])
    : undefined;
  const hookRuns = [...(retained.report.hookRuns ?? []), ...(cleanup?.report.hookRuns ?? [])];
  return {
    effects: [...retained.report.effects, ...projection.effects, ...(cleanup?.report.effects ?? [])],
    lag: [
      ...retained.report.lag,
      ...projection.lag,
      ...(cleanup?.report.lag ?? []),
      ...(release === undefined ? [] : [release]),
    ],
    settlement,
    ...(hookRuns.length === 0 ? {} : { hookRuns }),
  };
}

function attachReleaseLag(
  contracts: RepoReconcileContracts,
  released: readonly ContractId[],
  lag: ContractFileLag,
): Extract<RepoReconcileReport, { kind: "completed" }> {
  const affected = new Set(released);
  return {
    kind: "completed",
    contracts: contracts.map((contract) =>
      affected.has(contract.contractId)
        ? { ...contract, report: { ...contract.report, lag: [...contract.report.lag, lag] } }
        : contract,
    ),
  };
}

function worldObservationDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim();
}

export async function completeRepoReconcile(input: ReconcileOptions): Promise<RepoReconcileReport> {
  let states: readonly ContractState[];
  try {
    states = await worldContractStates(input);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
    return { kind: "world-observation-failed", diagnostic: worldObservationDiagnostic(error) };
  }
  let appointed: PlaceRegister;
  try {
    appointed = await appointPlaces(input.scope, states);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) throw error;
    const lag = registerLag(input.scope, error);
    const contracts: RepoReconcileContracts[number][] = [];
    for (const state of states) {
      contracts.push({
        contractId: state.id,
        report: isManagedWorktree(state)
          ? { effects: [], lag: [lag], settlement: emptySettlement() }
          : await completeReconcile({ ...input, contractId: state.id }),
      });
    }
    return { kind: "completed", contracts };
  }
  const places = new Map(appointed.appointments.map((appointment) => [appointment.contract, appointment.place]));
  const retained = await reconcileAllOperation({
    ...input,
    states,
    retainTerminalWorktree: true,
    places,
  });
  const projections: ContractWorktreeResult[] = [];
  for (const contract of retained.contracts) {
    projections.push(
      realizedOrRetainedManagedWorktree(input.scope, contract.report, places.get(contract.contractId))
        ? await projectContractWorktree(input.scope, contract.state, appointed)
        : { effects: [], lag: [] },
    );
  }
  const settlements = await settleAll({
    repository: input.scope,
    channel: input.channel,
    contracts: retained.contracts.map((contract) => ({
      state: contract.state,
      effects: contract.report.effects,
    })),
  });
  const cleanup = retained.contracts.some((contract) => isManagedTerminal(contract.state))
    ? await reconcileAllOperation({ ...input, states, places })
    : null;
  const later =
    cleanup === null ? null : new Map(cleanup.contracts.map((contract) => [contract.contractId, contract.report]));
  const released: ContractId[] = retained.contracts
    .filter((contract) =>
      releaseEligible(contract.state, later?.get(contract.contractId), places.has(contract.contractId)),
    )
    .map((contract) => contract.contractId);
  const contracts: RepoReconcileContracts[number][] = [];
  for (const [index, contract] of retained.contracts.entries()) {
    const report = later?.get(contract.contractId);
    const projection = projections[index]!;
    contracts.push({
      contractId: contract.contractId,
      report: {
        effects: [...contract.report.effects, ...projection.effects, ...(report?.effects ?? [])],
        lag: [...contract.report.lag, ...projection.lag, ...(report?.lag ?? [])],
        settlement: settlements[index]!,
      },
    });
  }
  const lag = await releaseAppointments(input.scope, released);
  return lag === undefined ? { kind: "completed", contracts } : attachReleaseLag(contracts, released, lag);
}
