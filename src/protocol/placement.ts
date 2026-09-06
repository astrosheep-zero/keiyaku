import type { ExecutionProgress } from "./progress.js";
import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { contractState } from "../core/facts/observation.js";
import type { ActorId, ContractId, SnapshotId } from "../core/facts/types.js";
import { decidePlacement, type PlacementRefusal } from "../core/verbs/placement.js";
import { observeGitForAdmissionAt } from "../git/observe.js";
import {
  appendPrivateStateSeatClose,
  mergePrivateStateSeatClose,
  withPrivateStatePublicationSeat,
  type PrivateStateSeatCloseLag,
  type PrivateStateSeatOutcome,
} from "../git/private-state-seat.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { reconcileEffectFailure, type ReconcileResult } from "../git/reconcile.js";
import { GitPlumbingError, type GitRepository } from "../git/process.js";
import {
  acquireTargetPlacementFence,
  followTargetPlacement,
  prepareTargetPlacement,
  observeTargetHead,
  observedTreeEqualsCandidate,
  type PreparedTargetPlacement,
  type TargetPlacementRefusal,
} from "../git/target-placement.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission } from "./attempt.js";
import { prepareProtocolAttempt, runProtocol, type ProtocolResult, type RunProtocolInput } from "./run.js";

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
  observedTreeEqualsCandidate: boolean;
}>;

export type PlacementProtocolResult<ExtraRefusal = never> =
  | (AcceptedAdmission & Readonly<{ physical?: ReconcileResult }>)
  | Exclude<ProtocolResult<PlacementRefusal | TargetPlacementRefusal | ExtraRefusal>, AcceptedAdmission>
  | TargetMovedStop
  | PlacementExecutionFailure;

type PlacementProtocolInput = Readonly<{ contractId: ContractId; actor?: ActorId; at: string }>;
type PlacementAdmissionInput<ExtraRefusal> = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  target: string | undefined;
  placement: PlacementProtocolInput;
  onDeliveryMissing?: () => Promise<PlacementProtocolResult<ExtraRefusal> | undefined>;
  progress?: ExecutionProgress;
}>;

function placementFailure(error: unknown): PlacementExecutionFailure {
  return { kind: "placement-failed", diagnostic: error instanceof Error ? error.message : String(error) };
}

function expectedOperationalDiagnostic(error: unknown): string {
  if (error instanceof GitPlumbingError || error instanceof SqliteTransactionLockError) {
    return error instanceof Error ? error.message : String(error);
  }
  throw error;
}

function expectedPlacementFailure(error: unknown): PlacementExecutionFailure {
  return { kind: "placement-failed", diagnostic: expectedOperationalDiagnostic(error) };
}

function placementResultWithSeatClose<ExtraRefusal = never>(
  outcome: PrivateStateSeatOutcome<PlacementProtocolResult<ExtraRefusal>>,
): PlacementProtocolResult<ExtraRefusal> {
  return mergePrivateStateSeatClose(outcome, (value, closeLag: PrivateStateSeatCloseLag) => {
    if (value.kind !== "accepted") throw new Error(closeLag.diagnostic);
    return { ...value, seatClose: appendPrivateStateSeatClose(value.seatClose, closeLag) };
  });
}

async function runFencedPlacement(
  repository: GitRepository,
  input: PlacementProtocolInput,
  protocol: RunProtocolInput<PlacementProtocolInput, PlacementRefusal | TargetPlacementRefusal>,
): Promise<PlacementProtocolResult> {
  let preparedPhysical: PreparedTargetPlacement | undefined;
  const result: PlacementProtocolResult = placementResultWithSeatClose(
    await withPrivateStatePublicationSeat(repository, async (seat) => {
      for (let index = 0; index < protocol.attempts.length; index += 1) {
        const prepared = await prepareProtocolAttempt(protocol, protocol.attempts[index]!);
        if (prepared.kind === "refused") return prepared;
        const state = contractState(prepared.observation.decision, input.contractId);
        if (state === null) throw new Error("placement offer has no contract state");
        if (prepared.offer.target === undefined)
          throw new Error("targeted placement offer is missing its target movement");
        const observed = await observeTargetHead(repository, prepared.offer.target.target);
        if (observed !== prepared.offer.target.expectedOid) {
          const treeEquals = await observedTreeEqualsCandidate(repository, observed, prepared.offer.target.newOid);
          return {
            kind: "target-moved",
            contractId: input.contractId,
            target: prepared.offer.target.target,
            expected: prepared.offer.target.expectedOid,
            observed,
            observedTreeEqualsCandidate: treeEquals,
          };
        }
        const physical = await prepareTargetPlacement(repository, state, prepared.offer.target);
        if (physical.kind === "refused") return physical;
        const result = await admitDecidedOffer({
          channel: protocol.channel,
          repository,
          seat,
          decisionObservation: prepared.observation,
          attempt: prepared.attempt,
          offer: prepared.offer,
          primaryContract: input.contractId,
          ...(protocol.progress === undefined ? {} : { progress: protocol.progress }),
        });
        if (result.kind === "accepted") {
          preparedPhysical = physical.placement;
          return result;
        }
        if (result.kind === "publication-failed") return result;
        if (result.kind === "collision" && index + 1 === protocol.attempts.length) return result;
      }
      return { kind: "exhausted" };
    }),
  );
  if (result.kind !== "accepted") return result;
  if (preparedPhysical === undefined) {
    throw new Error("accepted placement has no prepared target checkout");
  }
  return { ...result, physical: await followTargetPlacement(repository, preparedPhysical) };
}

function isPlacementCancellation(repository: GitRepository, error: unknown): boolean {
  return (
    repository.signal?.aborted === true &&
    (error === repository.signal.reason ||
      error instanceof GitPlumbingError ||
      error instanceof SqliteTransactionLockError)
  );
}

/** Hold the existing target-placement fence for one owner callback. */
export async function runUnderTargetPlacementFence<T>(
  repository: GitRepository,
  target: string,
  run: () => Promise<T>,
  onReleaseFailure?: (result: T, error: unknown) => T | PlacementExecutionFailure,
): Promise<T | PlacementExecutionFailure> {
  let held: Awaited<ReturnType<typeof acquireTargetPlacementFence>>;
  try {
    held = await acquireTargetPlacementFence(repository, target);
  } catch (error) {
    if (isPlacementCancellation(repository, error)) throw error;
    return placementFailure(error);
  }
  let produced: T | undefined;
  let result: T | PlacementExecutionFailure | undefined;
  let exceptional: unknown;
  try {
    produced = await run();
    result = produced;
  } catch (error) {
    if (error instanceof AuthorityCorruptionError || error instanceof TypeError) exceptional = error;
    else if (isPlacementCancellation(repository, error)) exceptional = error;
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
  if (result === undefined) throw new Error("fenced target work produced no result");
  if (releaseFailure !== undefined) {
    return produced !== undefined && onReleaseFailure !== undefined
      ? onReleaseFailure(produced, releaseFailure)
      : placementFailure(releaseFailure);
  }
  return result;
}

function isDeliveryMissing(result: PlacementProtocolResult): boolean {
  return result.kind === "refused" && result.refusal.kind === "delivery-missing";
}

/** Run the sole placement adjudicator inside the target's physical fence. */
export async function admitPlacement<ExtraRefusal = never>(
  admission: PlacementAdmissionInput<ExtraRefusal>,
): Promise<PlacementProtocolResult<ExtraRefusal>> {
  const { channel, repository, target, placement: input, onDeliveryMissing } = admission;
  const attempts = mintAttempts({ entryCount: 1 });
  const protocol: RunProtocolInput<PlacementProtocolInput, PlacementRefusal | TargetPlacementRefusal> = {
    input,
    channel,
    repository,
    contracts: [input.contractId],
    attempts,
    decide: decidePlacement,
    ...(admission.progress === undefined ? {} : { progress: admission.progress }),
    observe: (observedRepository, observedChannel, contracts) =>
      observeGitForAdmissionAt(observedRepository, observedChannel, contracts),
  };
  if (target === undefined) return await runProtocol(protocol);
  return await runUnderTargetPlacementFence(
    repository,
    target,
    async () => {
      const result = await runFencedPlacement(repository, input, protocol);
      if (onDeliveryMissing === undefined || !isDeliveryMissing(result)) return result;
      return (await onDeliveryMissing()) ?? result;
    },
    (result, error) =>
      result.kind === "accepted"
        ? { ...result, physical: reconcileEffectFailure(error, result.physical) }
        : placementFailure(error),
  );
}
