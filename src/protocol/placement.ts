import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { contractState } from "../core/facts/observation.js";
import type { ActorId, ChangeId, ContractId, SnapshotId } from "../core/facts/types.js";
import { decidePlacement, type PlacementRefusal } from "../core/verbs/placement.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { reconcileEffectFailure, type ReconcileResult } from "../git/reconcile.js";
import { GitPlumbingError, type GitRepository } from "../git/repository.js";
import {
  acquireTargetPlacementFence,
  followTargetPlacement,
  prepareTargetPlacement,
  observeTargetHead,
  type TargetPlacementRefusal,
} from "../git/target-placement.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission } from "./attempt.js";
import { readTaskHolderProjectionFromDecision, taskHolderObservationSelection } from "../settlement/holder.js";
import type { TaskId } from "../task/identity.js";
import {
  prepareProtocolAttempt,
  runProtocol,
  type ProtocolResult,
  type RunProtocolInput,
} from "./run.js";

export type PlacementExecutionFailure = Readonly<{
  kind: "placement-failed";
  diagnostic: string;
}>;

export type TargetMovedStop = Readonly<{
  kind: "target-moved";
  contractId: ContractId;
  target: string;
  expected: SnapshotId;
  observed: SnapshotId | null;
}>;

export type PlacementProtocolResult =
  | (AcceptedAdmission & Readonly<{ physical?: ReconcileResult }>)
  | Exclude<ProtocolResult<PlacementRefusal | TargetPlacementRefusal | PlacementCurrentnessRefusal>, AcceptedAdmission>
  | TargetMovedStop
  | PlacementExecutionFailure;

export type PlacementCurrentnessRefusal = Readonly<{
  kind: "placement-content-moved" | "task-holder-moved";
  contractId: ContractId;
  taskId?: TaskId;
}>;

type PlacementProtocolInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  changeId?: ChangeId;
  taskId?: TaskId;
}>;

function placementFailure(error: unknown): PlacementExecutionFailure {
  return { kind: "placement-failed", diagnostic: error instanceof Error ? error.message : String(error) };
}

function expectedPlacementFailure(error: unknown): PlacementExecutionFailure {
  if (error instanceof GitPlumbingError || error instanceof SqliteTransactionLockError) return placementFailure(error);
  throw error;
}

async function runFencedPlacement(
  repository: GitRepository,
  input: PlacementProtocolInput,
  protocol: RunProtocolInput<PlacementProtocolInput, PlacementRefusal | TargetPlacementRefusal | PlacementCurrentnessRefusal>,
): Promise<PlacementProtocolResult> {
  for (let index = 0; index < protocol.attempts.length; index += 1) {
    const prepared = await prepareProtocolAttempt(protocol, protocol.attempts[index]!);
    if (prepared.kind === "refused") return prepared;
    const state = contractState(prepared.observation.decision, input.contractId);
    if (state === null) throw new Error("placement offer has no contract state");
    if (prepared.offer.target === undefined) throw new Error("targeted placement offer is missing its target movement");
    const observed = observeTargetHead(repository, prepared.offer.target.target);
    if (observed !== prepared.offer.target.expectedOid) {
      return {
        kind: "target-moved",
        contractId: input.contractId,
        target: prepared.offer.target.target,
        expected: prepared.offer.target.expectedOid,
        observed,
      };
    }
    const physical = await prepareTargetPlacement(repository, state, prepared.offer.target);
    if (physical.kind === "refused") return physical;
    const result = await admitDecidedOffer({
      channel: protocol.channel,
      repository,
      decisionObservation: prepared.observation,
      attempt: prepared.attempt,
      offer: prepared.offer,
      primaryContract: input.contractId,
    });
    if (result.kind === "accepted") {
      return { ...result, physical: followTargetPlacement(repository, physical.placement) };
    }
    if (result.kind === "publication-failed") return result;
    if (result.kind === "collision" && index + 1 === protocol.attempts.length) return result;
  }
  return { kind: "exhausted" };
}

/** Run the sole placement adjudicator inside the target's physical fence. */
export async function admitPlacement(
  channel: GitDecodeChannel,
  repository: GitRepository,
  target: string | undefined,
  input: PlacementProtocolInput,
): Promise<PlacementProtocolResult> {
  const attempts = mintAttempts({ entryCount: 1 });
  const protocol: RunProtocolInput<PlacementProtocolInput, PlacementRefusal | TargetPlacementRefusal | PlacementCurrentnessRefusal> = {
    input,
    channel,
    repository,
    contracts: [input.contractId],
    attempts,
    decide: decidePlacement,
    observationSelection: taskHolderObservationSelection(),
    prepareInput: async (observation, original) => {
      const state = contractState(observation.decision, original.contractId);
      if (
        original.changeId !== undefined
        && state?.delivery !== null
        && state?.delivery !== undefined
        && state.delivery.data.integration.changeId !== original.changeId
      ) {
        return { kind: "refused", refusal: { kind: "placement-content-moved", contractId: original.contractId } };
      }
      if (original.taskId !== undefined) {
        const holder = (await readTaskHolderProjectionFromDecision(channel, observation)).get(original.contractId);
        if (holder?.disposition !== "held" || holder.taskId !== original.taskId) {
          return { kind: "refused", refusal: { kind: "task-holder-moved", contractId: original.contractId, taskId: original.taskId } };
        }
      }
      return { kind: "prepared", input: original };
    },
  };
  const run = (): Promise<ProtocolResult<PlacementRefusal | TargetPlacementRefusal | PlacementCurrentnessRefusal>> => runProtocol(protocol);

  if (target === undefined) return await run();

  let held: Awaited<ReturnType<typeof acquireTargetPlacementFence>>;
  try {
    held = await acquireTargetPlacementFence(repository, target);
  } catch (error) {
    return placementFailure(error);
  }
  let result: PlacementProtocolResult | undefined;
  let exceptional: unknown;
  try {
    result = await runFencedPlacement(repository, input, protocol);
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) exceptional = error;
    else {
      try {
        result = expectedPlacementFailure(error);
      } catch (unexpected) {
        exceptional = unexpected;
      }
    }
  }
  let releaseFailure: unknown;
  try {
    held.close();
  } catch (error) {
    releaseFailure = error;
  }
  if (exceptional !== undefined) throw exceptional;
  if (result === undefined) throw new Error("placement produced no result");
  if (releaseFailure !== undefined) {
    return result.kind === "accepted"
      ? { ...result, physical: reconcileEffectFailure(releaseFailure, result.physical) }
      : placementFailure(releaseFailure);
  }
  return result;
}
