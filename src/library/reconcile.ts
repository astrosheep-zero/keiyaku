/** @architectureCompositionRoot */
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
  decodeContractFileLag,
  projectContractWorktree,
  type ContractFileEffect,
  type ContractFileLag,
  type ContractWorktreeResult,
} from "../contract-worktree.js";
import { decodeGitReconcileLag } from "../git/result-codec.js";
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
  /** The appointed worktree's short name when this invocation physically removed it. */
  retiredWorktree?: string;
  /** The appointed worktree's path when this invocation's own removal of it was retained. */
  retainedWorktree?: string;
}>;

export type ReconcileLagScope = "none" | "reconciliation" | "placement" | "continuation";

type ReconcileLagClassification = Readonly<{ scope: ReconcileLagScope; failure: boolean }>;

/**
 * The one owner mapping for combined reconciliation lags. `scope` identifies the
 * next independently retryable action; `failure` is true only when physical
 * repair is incomplete. Retained lags (worktree-retained, worktree-follow-
 * retained, and unsealed-bytes) are observable residue, not failed repair;
 * target-checkout-retained and every *-failed lag are failures.
 */
function classifyReconcileLag(kind: ReconcileCompletion["lag"][number]["kind"]): ReconcileLagClassification {
  switch (kind) {
    case "worktree-retained":
    case "unsealed-bytes":
      return { scope: "none", failure: false };
    case "worktree-follow-retained":
      return { scope: "continuation", failure: false };
    case "target-checkout-retained":
      return { scope: "placement", failure: true };
    case "worktree-hook-failed":
    case "reconcile-failed":
    case "contract-file-failed":
      return { scope: "reconciliation", failure: true };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Identifies the next independently retryable action for a reconciliation lag. */
export function reconcileLagScope(lag: ReconcileCompletion["lag"][number]): ReconcileLagScope {
  return classifyReconcileLag(lag.kind).scope;
}

/** True only when a reconciliation lag means physical repair is incomplete. */
export function reconcileLagIsFailure(lag: ReconcileCompletion["lag"][number]): boolean {
  return classifyReconcileLag(lag.kind).failure;
}

export function decodeReconciliationLag(value: unknown): ReconcileCompletion["lag"][number] {
  try {
    return decodeGitReconcileLag(value);
  } catch {
    return decodeContractFileLag(value);
  }
}

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

/**
 * Terminal cleanup retires the appointed worktree. Name its short name only when this
 * invocation physically removed that exact worktree; name its path when this invocation's
 * own removal was retained. A retained worktree keeps its own typed lag either way.
 */
function terminalWorktreeOutcome(
  scope: RepositoryScope,
  cleanup: ReconcileReport | undefined,
  place: string | undefined,
): Readonly<{ kind: "retired"; place: string } | { kind: "retained"; path: string }> | undefined {
  if (cleanup === undefined || place === undefined) return undefined;
  const path = worktreePath(scope, place);
  if (
    cleanup.effects.some((effect) => effect.kind === "worktree" && effect.path === path && effect.action === "removed")
  )
    return { kind: "retired", place };
  if (cleanup.lag.some((lag) => lag.kind === "worktree-retained" && lag.path === path))
    return { kind: "retained", path };
  return undefined;
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

type TerminalReconcilePhase = Readonly<{
  cleanup: ReconcileReport | null;
  worktree: ReturnType<typeof terminalWorktreeOutcome>;
  release: ContractFileLag | undefined;
}>;

async function finishTerminalReconcile(
  input: ReconcileOptions & Readonly<{ contractId: ContractId }>,
  retained: Awaited<ReturnType<typeof reconcileOperation>>,
  appointed: Readonly<{ place?: string }>,
): Promise<TerminalReconcilePhase> {
  const cleanup = isManagedTerminal(retained.state) ? await reconcileOperation({ ...input, ...appointed }) : null;
  const worktree = terminalWorktreeOutcome(input.scope, cleanup?.report, appointed.place);
  const release = releaseEligible(retained.state, cleanup?.report, appointed.place !== undefined)
    ? await releaseAppointments(input.scope, [input.contractId])
    : undefined;
  return { cleanup: cleanup?.report ?? null, worktree, release };
}

function assembleReconcile(
  retained: ReconcileReport,
  projection: ContractWorktreeResult,
  settlement: SettlementReport,
  terminal: TerminalReconcilePhase,
): ReconcileCompletion {
  const { cleanup, worktree, release } = terminal;
  const hookRuns = [...(retained.hookRuns ?? []), ...(cleanup?.hookRuns ?? [])];
  return {
    effects: [...retained.effects, ...projection.effects, ...(cleanup?.effects ?? [])],
    lag: [...retained.lag, ...projection.lag, ...(cleanup?.lag ?? []), ...(release === undefined ? [] : [release])],
    settlement,
    ...(hookRuns.length === 0 ? {} : { hookRuns }),
    ...(worktree?.kind === "retired" ? { retiredWorktree: worktree.place } : {}),
    ...(worktree?.kind === "retained" ? { retainedWorktree: worktree.path } : {}),
  };
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
  const terminal = await finishTerminalReconcile(input, retained, appointed);
  return assembleReconcile(retained.report, projection, settlement, terminal);
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
