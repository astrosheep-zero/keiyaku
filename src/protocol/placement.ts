import type { ProtocolProgress } from "./progress.js";
import type { Placed } from "./completion.js";
import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { contractState } from "../core/facts/observation.js";
import {
  sameTarget,
  targetName,
  type ContractId,
  type ContractState,
  type ContractTarget,
  type SnapshotId,
} from "../core/facts/types.js";
import { decidePlacement, type PlacementRefusal } from "../core/verbs/placement.js";
import { observeContractsAt } from "../git/observe.js";
import { observeTarget } from "../git/target.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { reconcileEffectFailure } from "../git/reconcile.js";
import { GitPlumbingError, type GitRepository } from "../git/process.js";
import {
  acquireTargetPlacementFence,
  observedTreeEqualsCandidate,
  recoverTargetPlacement,
  type TargetPlacementRefusal,
} from "../git/target-placement.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission } from "./attempt.js";
import {
  privateStateSeatAttempt,
  runBoundedAttempts,
  spentPreparation,
  type ProtocolResult,
  type SpentPreparation,
} from "./run.js";

export type PlacementExecutionFailure = Readonly<{
  kind: "placement-failed";
  diagnostic: string;
}>;

type TargetMovedStop = Readonly<{
  kind: "target-moved";
  target: string;
  expected: SnapshotId;
  observed: SnapshotId | null;
  integration: SnapshotId;
}>;

type IdenticalTarget = Readonly<{
  kind: "target-content-identical";
  target: string;
  expected: SnapshotId;
  observed: SnapshotId;
}>;

type PlacedAdmission = AcceptedAdmission & Readonly<{ placement: Placed }>;
type PlacementDecision = Exclude<ProtocolResult<PlacementRefusal | TargetPlacementRefusal>, AcceptedAdmission>;
export type PlacementProtocolResult =
  | PlacementDecision
  | PlacedAdmission
  | TargetMovedStop
  | IdenticalTarget
  | PlacementExecutionFailure;

type PlacementProtocolInput = Readonly<{ contractId: ContractId; at: string }>;
type PlacementAdmissionInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  target: ContractTarget | undefined;
  placement: PlacementProtocolInput;
  progress: ProtocolProgress;
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

async function placementDestination(
  repository: GitRepository,
  target: ContractTarget,
  integration: NonNullable<ContractState["currentIntegration"]>,
): Promise<TargetPlacementRefusal | TargetMovedStop | undefined> {
  const observed = await observeTarget(repository, target);
  if (observed.kind === "refused") return observed.refusal;
  if (observed.head !== integration.predecessor) {
    return {
      kind: "target-moved",
      target: targetName(target),
      expected: integration.predecessor,
      observed: observed.head,
      integration: integration.snapshot,
    };
  }
  return undefined;
}

export function confirmPlacement(progress: ProtocolProgress, state: ContractState): Placed {
  const {
    currentIntegration,
    coordinates: { target },
  } = state;
  if (currentIntegration === null) throw new Error("accepted placement requires its integration snapshot");
  return progress.recordCompletion(state.id, {
    integration: currentIntegration.snapshot,
    ...(target === undefined ? {} : { target: targetName(target), predecessor: currentIntegration.predecessor }),
  });
}

async function runPlacement(input: PlacementAdmissionInput): Promise<PlacementProtocolResult> {
  const { repository, channel, target, placement, progress } = input;
  const { contractId } = placement;
  const result = await runBoundedAttempts<
    undefined,
    PlacedAdmission | TargetMovedStop,
    PlacementRefusal | TargetPlacementRefusal
  >(
    mintAttempts({ entryCount: 1 }),
    async () => ({ kind: "prepared", prepared: undefined }),
    async (_, attempt) =>
      await privateStateSeatAttempt<PlacedAdmission | TargetMovedStop | PlacementDecision | SpentPreparation>(
        repository,
        async (seat) => {
          const observation = await observeContractsAt(repository, channel, [contractId], { after: true });
          const state = contractState(observation.decision, contractId);
          if (state?.terminal === null && !sameTarget(state.coordinates.target, target)) return spentPreparation;
          const destinationStop =
            target !== undefined && state?.terminal === null && state.currentIntegration !== null
              ? await placementDestination(repository, target, state.currentIntegration)
              : undefined;
          const decision = decidePlacement({
            input: { ...placement, ...(destinationStop === undefined ? {} : { destinationStop }) },
            observation: observation.decision,
            attempt,
          });
          if (decision.kind === "refused") {
            const { refusal } = decision;
            return refusal.kind === "target-moved" ? refusal : { kind: "refused", refusal };
          }
          const { offer } = decision;
          const admitted = await admitDecidedOffer({
            scope: repository,
            channel,
            contractId,
            seat,
            observation,
            attempt,
            offer,
            progress,
          });
          return admitted.kind === "accepted"
            ? { ...admitted, placement: confirmPlacement(progress, admitted.state) }
            : admitted;
        },
      ),
  );
  if (result.kind === "target-moved") {
    const { target, expected, observed, integration } = result;
    if (observed !== null && (await observedTreeEqualsCandidate(repository, observed, integration)))
      return { kind: "target-content-identical", target, expected, observed };
  }
  if (result.kind !== "accepted") return result;
  progress.recordResidue(contractId, result);
  if (result.state.coordinates.target === undefined) return result;
  try {
    await recoverTargetPlacement(repository, result.state, (physical) => progress.recordPhysical(contractId, physical));
  } catch (error) {
    if (isPlacementCancellation(repository, error)) throw error;
    progress.recordPhysical(contractId, reconcileEffectFailure(error));
  }
  return result;
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

/** Run the sole placement adjudicator inside the target's physical fence. */
export async function admitPlacement(input: PlacementAdmissionInput): Promise<PlacementProtocolResult> {
  const { repository, target, progress, placement } = input;
  if (target === undefined) return await runPlacement(input);
  return await runUnderTargetPlacementFence(
    repository,
    targetName(target),
    () => runPlacement(input),
    (result, error) => {
      if (result.kind !== "accepted") return placementFailure(error);
      progress.recordPhysical(placement.contractId, reconcileEffectFailure(error));
      return result;
    },
  );
}
