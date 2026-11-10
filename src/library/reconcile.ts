/** @architectureCompositionRoot */
import { z } from "zod";
import { projectContractWorktree, type ContractFileLag, type ContractWorktreeResult } from "../contract-worktree.js";
import type { ContractId, ContractState } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { ReconcileResult } from "../git/reconcile.js";
import { reconcileObservationFailure } from "../git/reconcile.js";
import { contractIdSchema } from "../git/identity.js";
import { worktreePath } from "../git/workspace.js";
import { stateOperation, type RepositoryScope } from "../protocol/operations.js";
import { isOperationalFailure, isOperationalStop, executionStop, type ProtocolProgress } from "../protocol/progress.js";
import { reconcileAllOperation, reconcileOperation, worldContractStates } from "../protocol/reconcile.js";
import { settle, type SettlementReport } from "../settlement/settle.js";
import {
  appointManagedWorktrees,
  placeRegisterPath,
  releaseManagedWorktrees,
  type PlaceRegister,
} from "../workspace-place.js";
import { InvocationAccumulator } from "./invocation.js";
import {
  invocationIssues,
  meaningfulEffectSchema,
  reconcilePublicIssueSchema,
  type InvocationEffect,
  withOutcomeReceipt,
  project,
} from "./outcome.js";
export { reconcileLagScope, reconcileLagIsFailure, reconciliationLagSchema } from "./outcome.js";
export type { ReconcileLagScope } from "./outcome.js";

const reconcileEffectSchema = z.union([
  meaningfulEffectSchema.options[0],
  meaningfulEffectSchema.options[2],
  meaningfulEffectSchema.options[3],
  meaningfulEffectSchema.options[4],
  meaningfulEffectSchema.options[5],
]);

const contractReconcileSchema = z
  .strictObject({
    contractId: contractIdSchema,
    effects: z.array(reconcileEffectSchema).min(1).readonly().exactOptional(),
    issues: z.array(reconcilePublicIssueSchema).min(1).readonly().exactOptional(),
  })
  .readonly();
export const reconcileCompletionSchema = z.union([
  contractReconcileSchema
    .unwrap()
    .extend({ kind: z.literal("contract") })
    .readonly(),
  z.strictObject({ kind: z.literal("missing"), contractId: contractIdSchema }).readonly(),
]);
export const repoReconcileReportSchema = z.union([
  z
    .strictObject({
      kind: z.literal("world"),
      contracts: z.array(contractReconcileSchema).min(1).readonly().exactOptional(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("world-observation-failed"), diagnostic: z.string() }).readonly(),
]);
export const reconcileResultSchema = z.union([reconcileCompletionSchema, repoReconcileReportSchema]);
export type MeaningfulEffect = z.output<typeof reconcileEffectSchema>;
export type TopologyEffect = MeaningfulEffect;
export type ReconcileCompletion = z.output<typeof reconcileCompletionSchema>;
export type RepoContractReconcileReport = z.output<typeof contractReconcileSchema>;
export type ReconcileReport = RepoContractReconcileReport;
export type RepoReconcileReport = z.output<typeof repoReconcileReportSchema>;

// Physical custody remains local to reconciliation and the invocation accumulator.
type ReconcileWork = Readonly<{
  effects: ReconcileResult["effects"];
  lag: readonly (ReconcileResult["lag"][number] | ContractFileLag)[];
  settlement: SettlementReport;
  missing?: true;
}>;
type RepoReconcileContracts = readonly Readonly<{ contractId: ContractId; report: ReconcileWork }>[];
type RepoReconcileWork =
  | Readonly<{ kind: "completed"; contracts: RepoReconcileContracts }>
  | Readonly<{ kind: "world-observation-failed"; diagnostic: string }>;

type ReconcileProgress = ProtocolProgress &
  Readonly<{
    recordSettlement(contractId: ContractId, report: SettlementReport): void;
    recordReconciliation(
      contractId: ContractId,
      report: Readonly<{
        effects?: ReconcileResult["effects"];
        lag?: readonly (ReconcileResult["lag"][number] | ContractFileLag)[];
      }>,
    ): void;
  }>;

type ReconcileOptions = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  progress?: ReconcileProgress;
}>;

function registerLag(scope: RepositoryScope, error: unknown): ContractFileLag {
  return {
    kind: "contract-file-failed",
    path: placeRegisterPath(scope),
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

function emptySettlement(): SettlementReport {
  return { actions: [], lags: [] };
}

function isManagedTerminal(state: ContractState | null): boolean {
  return state !== null && state.terminal !== null;
}

function appointableManagedContracts(states: readonly ContractState[]): readonly ContractId[] {
  return states.filter((state) => state.terminal === null).map((state) => state.id);
}

async function appointPlaces(scope: RepositoryScope, states: readonly ContractState[]): Promise<PlaceRegister> {
  return await appointManagedWorktrees(scope, appointableManagedContracts(states));
}

function realizedOrRetainedManagedWorktree(
  scope: RepositoryScope,
  report: ReconcileResult,
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
  cleanup: ReconcileResult | undefined,
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
    if (!isOperationalFailure(error)) throw error;
    return registerLag(scope, error);
  }
}

async function observeState(
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  contractId: ContractId,
): Promise<Readonly<{ state: ContractState | null } | { failed: ReconcileResult }>> {
  try {
    return { state: await stateOperation({ scope, channel, contractId }) };
  } catch (error) {
    if (!isOperationalFailure(error)) throw error;
    return { failed: reconcileObservationFailure(error) };
  }
}

async function appointForContract(
  scope: RepositoryScope,
  state: ContractState,
): Promise<Readonly<{ place?: string; register?: PlaceRegister } | { lag: ContractFileLag }>> {
  try {
    const register = await appointPlaces(scope, [state]);
    const place = register.byContract.get(state.id)?.place;
    if (place === undefined) {
      if (state.terminal !== null) return { register };
      throw new Error(`Place appointment was not recorded: ${state.id}`);
    }
    return { place, register };
  } catch (error) {
    if (!isOperationalFailure(error)) throw error;
    return { lag: registerLag(scope, error) };
  }
}

type TerminalReconcilePhase = Readonly<{
  cleanup: ReconcileResult | null;
  release: ContractFileLag | undefined;
}>;

async function finishTerminalReconcile(
  input: ReconcileOptions & Readonly<{ contractId: ContractId }>,
  retained: Awaited<ReturnType<typeof reconcileOperation>>,
  appointed: Readonly<{ place?: string }>,
): Promise<TerminalReconcilePhase> {
  const cleanup = isManagedTerminal(retained.state) ? await reconcileOperation({ ...input, ...appointed }) : null;
  if (cleanup !== null) input.progress?.recordPhysical(input.contractId, cleanup.report);
  const release = releaseEligible(retained.state, cleanup?.report, appointed.place !== undefined)
    ? await releaseAppointments(input.scope, [input.contractId])
    : undefined;
  if (release !== undefined) input.progress?.recordReconciliation(input.contractId, { lag: [release] });
  return { cleanup: cleanup?.report ?? null, release };
}

function assembleReconcile(
  retained: ReconcileResult,
  settlement: SettlementReport,
  terminal: TerminalReconcilePhase,
): ReconcileWork {
  const { cleanup, release } = terminal;
  return {
    effects: [...retained.effects, ...(cleanup?.effects ?? [])],
    lag: [...retained.lag, ...(cleanup?.lag ?? []), ...(release === undefined ? [] : [release])],
    settlement,
  };
}

async function reconcileContractWork(
  input: ReconcileOptions &
    Readonly<{
      contractId: ContractId;
    }>,
): Promise<ReconcileWork> {
  const observed = await observeState(input.scope, input.channel, input.contractId);
  if ("failed" in observed) {
    input.progress?.recordPhysical(input.contractId, observed.failed);
    return { effects: observed.failed.effects, lag: observed.failed.lag, settlement: emptySettlement() };
  }
  // A legitimately absent Contract has nothing to reconcile.
  if (observed.state === null) return { effects: [], lag: [], settlement: emptySettlement(), missing: true };
  const appointment = await appointForContract(input.scope, observed.state);
  if ("lag" in appointment) {
    input.progress?.recordReconciliation(input.contractId, { lag: [appointment.lag] });
    return { effects: [], lag: [appointment.lag], settlement: emptySettlement() };
  }
  const appointed = appointment.place === undefined ? {} : { place: appointment.place };
  const retained = await reconcileOperation({
    ...input,
    retainTerminalWorktree: true,
    ...appointed,
  });
  input.progress?.recordPhysical(input.contractId, retained.report);
  const projection = realizedOrRetainedManagedWorktree(input.scope, retained.report, appointment.place)
    ? await projectContractWorktree(input.scope, retained.state, appointment.register)
    : { effects: [], lag: [] };
  input.progress?.recordReconciliation(input.contractId, { lag: projection.lag });
  const settlement = await settle({
    repository: input.scope,
    channel: input.channel,
    state: retained.state,
    effects: retained.report.effects,
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });
  const terminal = await finishTerminalReconcile(input, retained, appointed);
  return assembleReconcile(retained.report, settlement, terminal);
}

/**
 * The one post-admission reconciliation walk: every affected Contract is observed afresh, and an
 * operational stop is recorded rather than thrown.
 */
export async function reconcileAffectedContracts(
  accumulator: InvocationAccumulator,
  contractId: ContractId,
  scope: RepositoryScope,
  channel: GitDecodeChannel,
  hooks: WorktreeHooks,
): Promise<void> {
  for (const contract of [...new Set([contractId, ...accumulator.snapshot().affected])]) {
    try {
      scope.signal?.throwIfAborted();
      accumulator.observe({ kind: "stage", contractId: contract, stage: "reconciliation", state: "started" });
      try {
        await reconcileContractWork({
          scope,
          channel,
          contractId: contract,
          hooks,
          retryHooks: false,
          progress: accumulator,
        });
      } finally {
        accumulator.observe({ kind: "stage", contractId: contract, stage: "reconciliation", state: "finished" });
      }
    } catch (error) {
      if (!isOperationalStop(error, scope.signal)) throw error;
      accumulator.recordStop(executionStop(contract, error, scope.signal));
    }
  }
}

function attachReleaseLag(
  contracts: RepoReconcileContracts,
  released: readonly ContractId[],
  lag: ContractFileLag,
): Extract<RepoReconcileWork, { kind: "completed" }> {
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

async function reconcileWorldWork(input: ReconcileOptions): Promise<RepoReconcileWork> {
  let states: readonly ContractState[];
  try {
    states = await worldContractStates(input);
  } catch (error) {
    if (!isOperationalFailure(error)) throw error;
    return { kind: "world-observation-failed", diagnostic: worldObservationDiagnostic(error) };
  }
  let appointed: PlaceRegister;
  try {
    appointed = await appointPlaces(input.scope, states);
  } catch (error) {
    if (!isOperationalFailure(error)) throw error;
    const lag = registerLag(input.scope, error);
    for (const state of states) input.progress?.recordReconciliation(state.id, { lag: [lag] });
    return {
      kind: "completed",
      contracts: states.map((state) => ({
        contractId: state.id,
        report: { effects: [], lag: [lag], settlement: emptySettlement() },
      })),
    };
  }
  const places = new Map(appointed.appointments.map((appointment) => [appointment.contract, appointment.place]));
  const retained = await reconcileAllOperation({
    ...input,
    states,
    retainTerminalWorktree: true,
    places,
  });
  const { projections, settlements } = await projectAndSettleWorld(input, retained, appointed);
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
        effects: [...contract.report.effects, ...(report?.effects ?? [])],
        lag: [...contract.report.lag, ...projection.lag, ...(report?.lag ?? [])],
        settlement: settlements[index]!,
      },
    });
  }
  const lag = await releaseAppointments(input.scope, released);
  if (lag !== undefined) for (const id of released) input.progress?.recordReconciliation(id, { lag: [lag] });
  return lag === undefined ? { kind: "completed", contracts } : attachReleaseLag(contracts, released, lag);
}

async function projectAndSettleWorld(
  input: ReconcileOptions,
  retained: Awaited<ReturnType<typeof reconcileAllOperation>>,
  appointed: PlaceRegister,
) {
  const projections: ContractWorktreeResult[] = [];
  const settlements: SettlementReport[] = [];
  for (const contract of retained.contracts) {
    const place = appointed.byContract.get(contract.contractId)?.place;
    const projection = realizedOrRetainedManagedWorktree(input.scope, contract.report, place)
      ? await projectContractWorktree(input.scope, contract.state, appointed)
      : { effects: [], lag: [] };
    projections.push(projection);
    input.progress?.recordReconciliation(contract.contractId, { lag: projection.lag });
    settlements.push(
      await settle({
        repository: input.scope,
        channel: input.channel,
        state: contract.state,
        effects: contract.report.effects,
        ...(input.progress === undefined ? {} : { progress: input.progress }),
      }),
    );
  }
  return { projections, settlements };
}

function compactReconcile(
  contractId: ContractId,
  records: readonly InvocationEffect[],
  completed = false,
): RepoContractReconcileReport {
  const own = records.filter((record) => "contract" in record && record.contract === contractId);
  const issues = invocationIssues(own, contractId).map((issue) => {
    switch (issue.kind) {
      case "worktree-follow-retained":
      case "verification-cleanup":
      case "worktree-leak":
      case "execution-stopped":
      case "decode-channel-retirement":
        throw new Error(`unreachable explicit reconcile issue: ${issue.kind}`);
      default:
        return issue;
    }
  });
  const movements = own.flatMap((record): MeaningfulEffect[] => {
    if (record.kind !== "movement") return [];
    if (record.effect.kind === "worktree-followed") throw new Error("explicit reconcile cannot follow a dependent");
    return [record.effect];
  });
  // Completed receipts retain their established physical-before-settlement order.
  if (completed)
    movements.sort((left, right) => Number(left.kind === "debt-settled") - Number(right.kind === "debt-settled"));
  return {
    contractId,
    ...(movements.length === 0
      ? {}
      : { effects: [...new Map(movements.map((effect) => [JSON.stringify(effect), effect])).values()] }),
    ...(issues.length === 0 ? {} : { issues }),
  };
}

export function observedReconcileContracts(accumulator: InvocationAccumulator): readonly RepoContractReconcileReport[] {
  const snapshot = accumulator.snapshot();
  const ids = new Set(snapshot.effects.flatMap((effect) => ("contract" in effect ? [effect.contract] : [])));
  return [...ids]
    .map((id) => compactReconcile(id, snapshot.effects))
    .filter((row) => row.effects !== undefined || row.issues !== undefined);
}

export function reconcileException(error: unknown, accumulator: InvocationAccumulator, contractId?: ContractId): never {
  if (contractId === undefined) {
    const contracts = observedReconcileContracts(accumulator);
    throw withOutcomeReceipt(error, { kind: "world", ...(contracts.length === 0 ? {} : { contracts }) });
  }
  const result = project("abandon", accumulator.snapshot(), { kind: "failed", contract: contractId, error });
  if (result.kind === "failed") throw result.error;
  throw new Error("failed reconciliation produced a normal result");
}

export async function completeReconcile(
  input: ReconcileOptions & Readonly<{ contractId: ContractId; accumulator?: InvocationAccumulator }>,
): Promise<ReconcileCompletion> {
  const accumulator = input.accumulator ?? new InvocationAccumulator();
  try {
    const report = await reconcileContractWork({ ...input, progress: accumulator });
    if (report.missing === true) return { kind: "missing", contractId: input.contractId };
    return { kind: "contract", ...compactReconcile(input.contractId, accumulator.snapshot().effects, true) };
  } catch (error) {
    return reconcileException(error, accumulator, input.contractId);
  }
}

export async function completeRepoReconcile(
  input: ReconcileOptions & Readonly<{ accumulator?: InvocationAccumulator }>,
): Promise<RepoReconcileReport> {
  const accumulator = input.accumulator ?? new InvocationAccumulator();
  try {
    const report = await reconcileWorldWork({ ...input, progress: accumulator });
    if (report.kind === "world-observation-failed") return report;
    const contracts = report.contracts
      .map(({ contractId }) => compactReconcile(contractId, accumulator.snapshot().effects, true))
      .filter((row) => row.effects !== undefined || row.issues !== undefined);
    return { kind: "world", ...(contracts.length === 0 ? {} : { contracts }) };
  } catch (error) {
    return reconcileException(error, accumulator);
  }
}
