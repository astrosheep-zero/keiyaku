/** @architectureCompositionRoot */
import { z } from "zod";
import { projectContractWorktree } from "../contract-worktree.js";
import type { ContractId, ContractState } from "../core/facts/types.js";
import type { WorktreeHooks } from "../git/hooks.js";
import { contractIdSchema } from "../git/identity.js";
import { observeContractJournals } from "../git/observe.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { cleanupTerminalContract, repairContractEffects, type ReconcileResult } from "../git/reconcile.js";
import { worktreePath } from "../git/workspace.js";
import { stateOperation, type RepositoryScope } from "../protocol/operations.js";
import { isOperationalFailure, isOperationalStop, executionStop } from "../protocol/progress.js";
import { settle } from "../settlement/settle.js";
import { attestedVerificationSnapshots } from "../verification/declaration.js";
import {
  appointManagedWorktrees,
  placeRegisterPath,
  readPlaceRegister,
  releaseManagedWorktrees,
} from "../workspace-place.js";
import type { InvocationAccumulator } from "./invocation.js";
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

const reconcileEffectSchema = z
  .union([
    meaningfulEffectSchema.options[0],
    meaningfulEffectSchema.options[2],
    meaningfulEffectSchema.options[3],
    meaningfulEffectSchema.options[4],
    meaningfulEffectSchema.options[5],
  ])
  .meta({ id: "reconcileEffect" });

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
export type ReconcileCompletion = z.output<typeof reconcileCompletionSchema>;
export type RepoContractReconcileReport = z.output<typeof contractReconcileSchema>;
export type RepoReconcileReport = z.output<typeof repoReconcileReportSchema>;

type ReconcileOptions = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  hooks: WorktreeHooks;
  retryHooks: boolean;
  accumulator: InvocationAccumulator;
}>;

function diagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim();
}

async function reconcileContractWork(input: ReconcileOptions & { contractId: ContractId }): Promise<"missing" | void> {
  const { accumulator, channel, contractId, scope } = input;
  scope.signal?.throwIfAborted();
  let state: ContractState | null;
  try {
    state = await stateOperation(input);
  } catch (error) {
    if (!isOperationalFailure(error)) throw error;
    accumulator.recordReconciliation(contractId, {
      lag: [{ kind: "reconcile-failed", diagnostic: diagnostic(error) }],
    });
    return;
  }
  if (state === null) return "missing";

  const recordFileLag = (path: string, error: unknown): void => {
    if (!isOperationalFailure(error) || (scope.signal?.aborted && error === scope.signal.reason)) throw error;
    accumulator.recordReconciliation(contractId, {
      lag: [{ kind: "contract-file-failed", path, diagnostic: diagnostic(error) }],
    });
  };
  try {
    if (state.terminal === null && !(await readPlaceRegister(scope)).has(contractId)) {
      await appointManagedWorktrees(scope, [contractId]);
    }
  } catch (error) {
    recordFileLag(placeRegisterPath(scope), error);
    return;
  }

  const physical = {
    repository: scope,
    channel,
    contractId,
    hooks: input.hooks,
    retryHooks: input.retryHooks,
    attestedSnapshots: (state: ContractState) =>
      state.attestations.flatMap(({ data }) => attestedVerificationSnapshots(data)),
    onPhysical: (report: ReconcileResult) => accumulator.recordPhysical(contractId, report),
  };
  const repair = await repairContractEffects(physical);
  if (repair.state === undefined) return;
  scope.signal?.throwIfAborted();
  if (repair.workspace !== undefined) {
    try {
      accumulator.recordReconciliation(
        contractId,
        await projectContractWorktree(scope, repair.state, repair.workspace),
      );
    } catch (error) {
      recordFileLag(worktreePath(scope, repair.workspace.get(contractId)!), error);
    }
  }
  scope.signal?.throwIfAborted();
  await settle({
    repository: scope,
    channel,
    state: repair.state,
    progress: accumulator,
  });
  if (repair.state.terminal === null) return;

  const cleanup = await cleanupTerminalContract({
    ...physical,
    expectedHead: repair.state.head,
    handoffSafe: repair.handoffSafe,
  });
  if (cleanup.appointedPathAbsent) {
    try {
      await releaseManagedWorktrees(scope, [contractId]);
    } catch (error) {
      recordFileLag(placeRegisterPath(scope), error);
    }
  }
}

/** Post-admission reconciliation observes each affected Contract afresh. */
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
        await reconcileContractWork({ scope, channel, contractId: contract, hooks, retryHooks: false, accumulator });
      } finally {
        accumulator.observe({ kind: "stage", contractId: contract, stage: "reconciliation", state: "finished" });
      }
    } catch (error) {
      if (!isOperationalStop(error, scope.signal)) throw error;
      accumulator.recordStop(executionStop(contract, error, scope.signal));
    }
  }
}

function compactReconcile(contractId: ContractId, records: readonly InvocationEffect[]): RepoContractReconcileReport {
  const issues = invocationIssues(records, contractId).map((issue) => {
    if (issue.kind === "worktree-follow-retained" || issue.kind === "execution-stopped")
      throw new Error(`unreachable explicit reconcile issue: ${issue.kind}`);
    return issue;
  });
  const movements = records.flatMap((record): MeaningfulEffect[] => {
    if (record.kind !== "movement") return [];
    if (record.effect.kind === "worktree-followed") throw new Error("explicit reconcile cannot follow a dependent");
    return [record.effect];
  });
  return {
    contractId,
    ...(movements.length === 0 ? {} : { effects: movements }),
    ...(issues.length === 0 ? {} : { issues }),
  };
}

function observedReconcileContracts(accumulator: InvocationAccumulator): readonly RepoContractReconcileReport[] {
  const grouped = new Map<ContractId, InvocationEffect[]>();
  for (const record of accumulator.snapshot().effects) {
    const own = grouped.get(record.contract);
    if (own === undefined) grouped.set(record.contract, [record]);
    else own.push(record);
  }
  return [...grouped]
    .map(([id, records]) => compactReconcile(id, records))
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
  input: ReconcileOptions & { contractId: ContractId },
): Promise<ReconcileCompletion> {
  if ((await reconcileContractWork(input)) === "missing") return { kind: "missing", contractId: input.contractId };
  return { kind: "contract", ...compactReconcile(input.contractId, input.accumulator.snapshot().effects) };
}

export async function completeRepoReconcile(input: ReconcileOptions): Promise<RepoReconcileReport> {
  let ids: readonly ContractId[];
  try {
    const journals = await withGitReadObservation(input.scope, input.channel, observeContractJournals);
    ids = [...journals.keys()];
  } catch (error) {
    if (!isOperationalFailure(error)) throw error;
    return { kind: "world-observation-failed", diagnostic: diagnostic(error) };
  }
  for (const contractId of ids) await reconcileContractWork({ ...input, contractId });
  const contracts = observedReconcileContracts(input.accumulator);
  return { kind: "world", ...(contracts.length === 0 ? {} : { contracts }) };
}
