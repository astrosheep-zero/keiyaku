import { type ContractId, type ContractState, type JournalEntry } from "../core/facts/types.js";
import { observeActiveContractWorld } from "../git/observe.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { reconcileDependentWorktree } from "../git/reconcile.js";
import type { ReconcileResult } from "../git/reconcile.js";
import { worktreePath } from "../git/workspace.js";
import {
  completeCandidate,
  compactPlacementStop,
  placementStopSchema,
  type CompactPlacementStop,
  type CompletionResult,
} from "../protocol/completion.js";
import {
  contractCheckpoint,
  isOperationalStop,
  executionStop,
  type ExecutionStop,
  type ProtocolProgress,
} from "../protocol/progress.js";
import { observeContractAt } from "../git/observe.js";
import type { RepositoryScope } from "../protocol/operations.js";
import { contractIdSchema } from "../protocol/operations.js";
import { appointmentFor, readPlaceRegister } from "../workspace-place.js";
import { z } from "zod";

export const continuationReportSchema = z
  .strictObject({
    claimed: z.array(contractIdSchema).min(1).readonly().exactOptional(),
    stopped: z
      .array(z.strictObject({ contractId: contractIdSchema, stop: placementStopSchema }).readonly())
      .min(1)
      .readonly()
      .exactOptional(),
  })
  .readonly();
export type ContinuationReport = z.infer<typeof continuationReportSchema>;

type RetainedDependent = Readonly<{ state: ContractState; journal: readonly JournalEntry[] }>;

function reverseDependents(world: Awaited<ReturnType<typeof observeActiveContractWorld>>) {
  const index = new Map<ContractId, RetainedDependent[]>();
  for (const record of world.contracts.values()) {
    const state = record.state;
    if (state === null || state.delivery === null) continue;
    for (const prerequisite of state.terms.after) {
      const dependents = index.get(prerequisite) ?? [];
      dependents.push({ state, journal: record.entries });
      index.set(prerequisite, dependents);
    }
  }
  for (const dependents of index.values()) dependents.sort((a, b) => a.state.id.localeCompare(b.state.id));
  return index;
}

/**
 * The narrow Library-side sink a continuation offers. It reuses the accumulator's own progress
 * methods, so each attempt is retained before the next sibling is awaited.
 */
type ContinuationProgress = Readonly<{
  recordPhysical(contractId: ContractId, physical: ReconcileResult): void;
  recordStop(stop: ExecutionStop): void;
  recordContinuation(contractId: ContractId, report: ContinuationReport): void;
}>;

type ContinuationInput = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  completed: Extract<CompletionResult, { kind: "completed" }>;
  progress: ProtocolProgress & ContinuationProgress;
  actor?: import("../core/facts/types.js").ActorId;
  signal?: AbortSignal;
}>;

type ContinuedCandidate =
  | CompletionResult
  | Readonly<{ kind: "stopped-before-node"; stop: CompactPlacementStop | ExecutionStop }>;

async function continueCandidate(
  input: ContinuationInput,
  id: ContractId,
  predecessor: import("../core/facts/types.js").SnapshotId,
): Promise<ContinuedCandidate> {
  input.signal?.throwIfAborted();
  const observed = await observeContractAt(input.scope, input.channel, id);
  if (observed.state === null)
    return {
      kind: "stopped-before-node",
      stop: { kind: "contract-missing" },
    };
  const appointment = appointmentFor(await readPlaceRegister(input.scope), id);
  if (appointment !== undefined) {
    const physical = await reconcileDependentWorktree(
      input.scope,
      id,
      worktreePath(input.scope, appointment.place),
      predecessor,
    );
    input.progress.recordPhysical(id, physical);
    if (physical.lag.length > 0) return { kind: "stopped-before-node", stop: { kind: "physical-lag" } };
  }
  return await completeCandidate({
    repository: input.scope,
    channel: input.channel,
    checkpoint: contractCheckpoint({ state: observed.state, journal: observed.entries }),
    progress: input.progress,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

async function attemptDependent(
  input: ContinuationInput,
  id: ContractId,
  predecessor: import("../core/facts/types.js").SnapshotId,
): Promise<ContinuedCandidate> {
  try {
    return await continueCandidate(input, id, predecessor);
  } catch (error) {
    if (!isOperationalStop(error, input.signal)) throw error;
    const stop = executionStop(id, error, input.signal);
    input.progress.recordStop(stop);
    return { kind: "stopped-before-node", stop };
  }
}

/** One bounded invocation-local walk. Discovery is scheduling input, never placement authority. */
export async function continueDeliveredDependents(input: ContinuationInput): Promise<ContinuationReport | undefined> {
  const primary = input.completed.checkpoint.state.id;
  const claimed: ContractId[] = [];
  const stopped: NonNullable<ContinuationReport["stopped"]>[number][] = [];
  const report = (): ContinuationReport => ({
    ...(claimed.length === 0 ? {} : { claimed: [...claimed] }),
    ...(stopped.length === 0 ? {} : { stopped: [...stopped] }),
  });
  const retain = (): void => input.progress.recordContinuation(primary, report());
  // The primary candidate's own conclusions are retained by completion before this walk discovers
  // anything; every sibling attempt is retained here before the next one is awaited.
  retain();
  try {
    input.signal?.throwIfAborted();
    const world = await withGitReadObservation(input.scope, input.channel, observeActiveContractWorld);
    const dependents = reverseDependents(world);
    const queue = [{ contractId: primary, target: input.completed.evidence.completion.integration }];
    const attempted = new Set<ContractId>();
    const newlyClaimed = new Set<ContractId>([primary]);
    while (queue.length > 0) {
      input.signal?.throwIfAborted();
      const parent = queue.shift()!;
      for (const candidate of dependents.get(parent.contractId) ?? []) {
        const id = candidate.state.id;
        if (
          attempted.has(id) ||
          !candidate.state.terms.after.every(
            (dependency) =>
              newlyClaimed.has(dependency) || world.eligibility.get(dependency)?.terminal?.kind === "claimed",
          )
        )
          continue;
        input.signal?.throwIfAborted();
        attempted.add(id);
        const result = await attemptDependent(input, id, parent.target);
        if (result.kind === "completed") {
          claimed.push(id);
          newlyClaimed.add(id);
          retain();
          queue.push({ contractId: id, target: result.evidence.completion.integration });
        } else {
          const stop = result.stop;
          const compact: CompactPlacementStop =
            "refusal" in stop || "retry" in stop || "failure" in stop
              ? compactPlacementStop(stop)
              : stop.kind === "execution-stopped"
                ? { kind: stop.kind, reason: stop.reason, diagnostic: stop.diagnostic }
                : stop;
          stopped.push({ contractId: id, stop: compact });
          retain();
        }
      }
    }
    return attempted.size === 0 ? undefined : report();
  } catch (error) {
    if (!isOperationalStop(error, input.signal)) throw error;
    const stop = executionStop(primary, error, input.signal);
    input.progress.recordStop(stop);
    stopped.push({ contractId: primary, stop: { kind: stop.kind, reason: stop.reason, diagnostic: stop.diagnostic } });
    retain();
    return report();
  }
}
