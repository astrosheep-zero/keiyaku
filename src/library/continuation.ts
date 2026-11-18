import { contractState } from "../core/facts/observation.js";
import type { ContractId, ContractState, SnapshotId } from "../core/facts/types.js";
import { observeActiveContractWorld, observeContractAt } from "../git/observe.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { reconcileDependentWorktree } from "../git/reconcile.js";
import { worktreePath } from "../git/workspace.js";
import {
  completeCandidate,
  placementStopSchema,
  normalContinuationStopSchema,
  type Placed,
  type Placement,
} from "../protocol/completion.js";
import { executionIssue, isOperationalStop, type ProtocolProgress } from "../protocol/progress.js";
import type { RepositoryScope } from "../protocol/operations.js";
import { contractIdSchema } from "../protocol/operations.js";
import { readPlaceRegister } from "../workspace-place.js";
import { z } from "zod";

function continuationSchema<Stop extends z.ZodType>(stop: Stop) {
  return z
    .strictObject({
      claimed: z.array(contractIdSchema).min(1).readonly().exactOptional(),
      stopped: z
        .array(z.strictObject({ contractId: contractIdSchema, stop }).readonly())
        .min(1)
        .readonly()
        .exactOptional(),
    })
    .readonly();
}
export const continuationNormalReportSchema = continuationSchema(normalContinuationStopSchema);
export const continuationReportSchema = continuationSchema(placementStopSchema);
export type ContinuationReport = z.infer<typeof continuationReportSchema>;

function reverseDependents(world: Awaited<ReturnType<typeof observeActiveContractWorld>>) {
  const index = new Map<ContractId, ContractState[]>();
  for (const { state } of world.journals.values()) {
    if (state === null || state.terminal !== null || state.delivery === null) continue;
    for (const prerequisite of state.terms.after) {
      const dependents = index.get(prerequisite) ?? [];
      dependents.push(state);
      index.set(prerequisite, dependents);
    }
  }
  for (const dependents of index.values()) dependents.sort((a, b) => a.id.localeCompare(b.id));
  return index;
}

type ContinuationInput = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  primary: ContractId;
  placed: Placed;
  progress: ProtocolProgress & { recordContinuation(contractId: ContractId, report: ContinuationReport): void };
  signal?: AbortSignal;
}>;

async function attemptDependent(input: ContinuationInput, id: ContractId, predecessor: SnapshotId): Promise<Placement> {
  try {
    input.signal?.throwIfAborted();
    const observed = await observeContractAt(input.scope, input.channel, id);
    if (observed.state === null) return { kind: "contract-missing" };
    const place = (await readPlaceRegister(input.scope)).get(id);
    if (place !== undefined) {
      const physical = await reconcileDependentWorktree(
        input.scope,
        id,
        worktreePath(input.scope, place),
        predecessor,
        (delta) => input.progress.recordPhysical(id, delta),
      );
      if (physical.lag.length > 0) return { kind: "physical-lag" };
    }
    const { placement } = await completeCandidate({
      repository: input.scope,
      channel: input.channel,
      checkpoint: { state: observed.state, journal: observed.entries },
      progress: input.progress,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return placement;
  } catch (error) {
    if (!isOperationalStop(error, input.signal)) throw error;
    return executionIssue(error, input.signal);
  }
}

/** One bounded invocation-local walk. Discovery is scheduling input, never placement authority. */
export async function continueDeliveredDependents(input: ContinuationInput): Promise<void> {
  const { primary } = input;
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
    const queue = [{ contractId: primary, target: input.placed.integration }];
    const attempted = new Set<ContractId>();
    const newlyClaimed = new Set<ContractId>([primary]);
    while (queue.length > 0) {
      input.signal?.throwIfAborted();
      const parent = queue.shift()!;
      for (const candidate of dependents.get(parent.contractId) ?? []) {
        const id = candidate.id;
        if (
          attempted.has(id) ||
          !candidate.terms.after.every(
            (dependency) =>
              newlyClaimed.has(dependency) || contractState(world.decision, dependency)?.terminal?.kind === "claimed",
          )
        )
          continue;
        input.signal?.throwIfAborted();
        attempted.add(id);
        const placement = await attemptDependent(input, id, parent.target);
        if (placement.kind === "placed") {
          claimed.push(id);
          newlyClaimed.add(id);
          queue.push({ contractId: id, target: placement.integration });
        } else {
          stopped.push({ contractId: id, stop: placement });
        }
        retain();
      }
    }
  } catch (error) {
    if (!isOperationalStop(error, input.signal)) throw error;
    input.progress.recordStop({ contractId: primary, ...executionIssue(error, input.signal) });
  }
}
