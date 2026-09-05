import { contractId, type ContractId, type ContractState, type JournalEntry } from "../core/facts/types.js";
import { observeActiveContractWorld } from "../git/observe.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { reconcileDependentWorktree } from "../git/reconcile.js";
import type { ReconcileResult } from "../git/reconcile.js";
import { worktreePath } from "../git/workspace.js";
import { completeCandidate, type CompletionResult } from "../protocol/completion.js";
import { contractCheckpoint, executionStop, type ExecutionProgress, type ExecutionStop } from "../protocol/progress.js";
import { observeContractAt } from "../git/observe.js";
import { decodeGitReconcileLag } from "../git/result-codec.js";
import { executionStopSchema } from "./execution-result.js";
import type { DocumentDerivation, PlacementStop, RepositoryScope } from "../protocol/operations.js";
import { decodePlacementStop } from "../protocol/result-codec.js";
import { ownerSchema } from "./result-codec.js";
import { appointmentFor, readPlaceRegister } from "../workspace-place.js";
import { z } from "zod";

export type ContinuationStop =
  | PlacementStop
  | ExecutionStop
  | Readonly<{ kind: "already-terminal" }>
  | Readonly<{ kind: "physical-lag"; lags: ReconcileResult["lag"] }>;

export type ContinuationReport = Readonly<{
  claimed: readonly ContractId[];
  stopped: readonly Readonly<{
    contractId: ContractId;
    stop: ContinuationStop;
  }>[];
}>;

export function decodeContinuationReport(value: unknown): ContinuationReport {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed continuation report");
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.claimed) || !Array.isArray(object.stopped))
    throw new Error("malformed continuation report");
  if (Object.keys(object).some((key) => key !== "claimed" && key !== "stopped"))
    throw new Error("malformed continuation report");
  return {
    claimed: object.claimed.map((id) => contractId(String(id))),
    stopped: object.stopped.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        throw new Error("malformed continuation report");
      const stopped = item as Record<string, unknown>;
      if (Object.keys(stopped).some((key) => key !== "contractId" && key !== "stop"))
        throw new Error("malformed continuation report");
      const stopValue = stopped.stop;
      const alreadyTerminal =
        stopValue !== null &&
        typeof stopValue === "object" &&
        !Array.isArray(stopValue) &&
        (stopValue as Record<string, unknown>).kind === "already-terminal" &&
        Object.keys(stopValue as Record<string, unknown>).length === 1;
      return {
        contractId: contractId(String(stopped.contractId)),
        stop: alreadyTerminal ? { kind: "already-terminal" as const } : decodeContinuationStop(stopValue),
      };
    }),
  };
}

export const continuationReportSchema = ownerSchema(
  decodeContinuationReport,
  "expected continuation report",
) satisfies z.ZodType<ContinuationReport>;

function decodeContinuationStop(value: unknown): ContinuationStop {
  if (value !== null && typeof value === "object" && "kind" in value) {
    if (value.kind === "execution-stopped") return executionStopSchema.parse(value);
    if (
      value.kind === "physical-lag" &&
      "lags" in value &&
      Array.isArray(value.lags) &&
      Object.keys(value).length === 2
    ) {
      return { kind: "physical-lag", lags: value.lags.map(decodeGitReconcileLag) };
    }
  }
  return decodePlacementStop(value);
}

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

type ContinuationInput = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  completed: Extract<CompletionResult, { kind: "completed" }>;
  progress: ExecutionProgress;
  deriveDocument(state: ContractState): DocumentDerivation;
  actor?: import("../core/facts/types.js").ActorId;
  signal?: AbortSignal;
}>;

type ContinuedCandidate = CompletionResult | Readonly<{ kind: "stopped-before-node"; stop: ContinuationStop }>;

async function continueCandidate(
  input: ContinuationInput,
  id: ContractId,
  predecessor: import("../core/facts/types.js").SnapshotId,
): Promise<ContinuedCandidate> {
  input.signal?.throwIfAborted();
  const observed = await observeContractAt(input.scope, input.channel, id);
  if (observed.state === null)
    return { kind: "stopped-before-node", stop: { refusal: { kind: "contract-missing", contractId: id } } };
  const appointment = appointmentFor(await readPlaceRegister(input.scope), id);
  if (appointment !== undefined) {
    const physical = await reconcileDependentWorktree(
      input.scope,
      id,
      worktreePath(input.scope, appointment.place),
      predecessor,
    );
    input.progress.recordPhysical(id, physical);
    if (physical.lag.length > 0)
      return { kind: "stopped-before-node", stop: { kind: "physical-lag", lags: physical.lag } };
  }
  return await completeCandidate({
    repository: input.scope,
    channel: input.channel,
    checkpoint: contractCheckpoint({ state: observed.state, journal: observed.entries }),
    progress: input.progress,
    start: "verification",
    deriveDocument: input.deriveDocument,
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
    const stop = executionStop(id, "continuation", error, input.signal);
    input.progress.recordStop(stop);
    return { kind: "stopped-before-node", stop };
  }
}

/** One bounded invocation-local walk. Discovery is scheduling input, never placement authority. */
export async function continueDeliveredDependents(input: ContinuationInput): Promise<ContinuationReport | undefined> {
  const primary = input.completed.checkpoint.state.id;
  const claimed: ContractId[] = [];
  const stopped: ContinuationReport["stopped"][number][] = [];
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
          queue.push({ contractId: id, target: result.evidence.completion.integration });
        } else {
          const stop = result.stop;
          stopped.push({
            contractId: id,
            stop: "refusal" in stop && stop.refusal.kind === "terminal" ? { kind: "already-terminal" } : stop,
          });
        }
      }
    }
    return attempted.size === 0 ? undefined : { claimed, stopped };
  } catch (error) {
    const stop = executionStop(primary, "continuation", error, input.signal);
    input.progress.recordStop(stop);
    stopped.push({ contractId: primary, stop });
    return { claimed, stopped };
  }
}
