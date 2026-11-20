import type { ProtocolProgress } from "./progress.js";
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
import { gitObjectIdForSnapshot } from "../git/identity.js";
import { targetRef } from "../git/target.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { reconcileEffectFailure, type ReconcileResult } from "../git/reconcile.js";
import { GitPlumbingError, type GitRepository } from "../git/process.js";
import {
  acquireTargetPlacementFence,
  observeTargetHead,
  observedTreeEqualsCandidate,
  recoverTargetPlacement,
  type TargetPlacementRefusal,
} from "../git/target-placement.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission } from "./attempt.js";
import {
  preparationIsCurrent,
  privateStateSeatAttempt,
  runBoundedAttempts,
  spentPreparation,
  type ObservedRef,
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
  observedTreeEqualsCandidate: boolean;
}>;

export async function observeIntegrationTargetMovement(
  repository: GitRepository,
  state: import("../core/facts/types.js").ContractState,
): Promise<TargetMovedStop | undefined> {
  const target = state.coordinates.target;
  const integration = state.currentIntegration;
  if (target === undefined || integration === null) return undefined;
  const observed = await observeTargetHead(repository, target);
  if (observed === integration.predecessor) return undefined;
  return {
    kind: "target-moved",
    target: targetName(target),
    expected: integration.predecessor,
    observed,
    observedTreeEqualsCandidate: await observedTreeEqualsCandidate(repository, observed, integration.snapshot),
  };
}

export type PlacementProtocolResult<ExtraRefusal = never> =
  | (AcceptedAdmission & Readonly<{ physical?: ReconcileResult }>)
  | Exclude<ProtocolResult<PlacementRefusal | TargetPlacementRefusal | ExtraRefusal>, AcceptedAdmission>
  | TargetMovedStop
  | PlacementExecutionFailure;

type PlacementProtocolInput = Readonly<{ contractId: ContractId; at: string }>;
type PlacementAdmissionInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  target: ContractTarget | undefined;
  placement: PlacementProtocolInput;
  progress?: ProtocolProgress;
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

async function targetMovement(
  repository: GitRepository,
  target: ContractTarget | undefined,
  integration: ContractState["currentIntegration"],
  observed: SnapshotId | null | undefined,
): Promise<TargetMovedStop | undefined> {
  if (observed === undefined || target === undefined || integration === null || observed === integration.predecessor)
    return undefined;
  return {
    kind: "target-moved",
    target: targetName(target),
    expected: integration.predecessor,
    observed,
    observedTreeEqualsCandidate: await observedTreeEqualsCandidate(repository, observed, integration.snapshot),
  };
}

type PreparedPlacement = Readonly<{
  expectedHead: import("../core/facts/types.js").ContractHead | null;
  expectedRef?: ObservedRef;
  moved: TargetMovedStop | undefined;
}>;

async function preparePlacementAttempt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  contractId: ContractId,
  target: ContractTarget | undefined,
): Promise<Readonly<{ kind: "prepared"; prepared: PreparedPlacement }> | SpentPreparation> {
  const before = await observeContractsAt(repository, channel, [contractId]);
  const state = contractState(before.decision, contractId);
  if (state?.terminal === null && !sameTarget(state.coordinates.target, target)) return spentPreparation;
  const integration = state?.terminal === null ? state.currentIntegration : null;
  const observed =
    target === undefined || integration === null ? undefined : await observeTargetHead(repository, target);
  const expectedRef =
    observed === undefined || target === undefined
      ? undefined
      : { ref: targetRef(target), oid: observed === null ? null : gitObjectIdForSnapshot(observed) };
  const moved = await targetMovement(repository, target, integration, observed);
  return {
    kind: "prepared",
    prepared: { expectedHead: state?.head ?? null, ...(expectedRef === undefined ? {} : { expectedRef }), moved },
  };
}

async function runPlacement(input: PlacementAdmissionInput): Promise<PlacementProtocolResult> {
  const { repository, channel, target, placement, progress } = input;
  const { contractId } = placement;
  const result = await runBoundedAttempts<
    PreparedPlacement,
    AcceptedAdmission | TargetMovedStop,
    PlacementRefusal | TargetPlacementRefusal
  >(
    mintAttempts({ entryCount: 1 }),
    async () => await preparePlacementAttempt(repository, channel, contractId, target),
    async (prepared, attempt) =>
      await privateStateSeatAttempt<Exclude<PlacementProtocolResult, PlacementExecutionFailure> | SpentPreparation>(
        repository,
        async (seat) => {
          const observation = await observeContractsAt(repository, channel, [contractId], { after: true });
          if (
            !(await preparationIsCurrent(
              repository,
              observation,
              contractId,
              prepared.expectedHead,
              prepared.expectedRef,
            ))
          ) {
            return spentPreparation;
          }
          const decision = decidePlacement({ input: placement, observation: observation.decision, attempt });
          if (decision.kind === "refused") return decision;
          const { offer } = decision;
          if (offer.target !== undefined && prepared.moved !== undefined) return prepared.moved;
          return await admitDecidedOffer({
            scope: repository,
            channel,
            contractId,
            seat,
            observation,
            attempt,
            offer,
            ...(progress === undefined ? {} : { progress }),
          });
        },
      ),
  );
  if (result.kind !== "accepted") return result;
  const { currentIntegration, coordinates } = result.state;
  if (coordinates.target === undefined || currentIntegration === null) return result;
  progress?.recordCompletion(contractId, {
    integration: currentIntegration.snapshot,
    predecessor: currentIntegration.predecessor,
    target: targetName(coordinates.target),
  });
  const report = (physical: ReconcileResult) => progress?.recordPlacementPhysical(contractId, physical);
  try {
    return { ...result, physical: await recoverTargetPlacement(repository, result.state, report) };
  } catch (error) {
    if (isPlacementCancellation(repository, error)) throw error;
    const physical = reconcileEffectFailure(error);
    report(physical);
    return { ...result, physical };
  }
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
  const { repository, target } = input;
  if (target === undefined) return await runPlacement(input);
  return await runUnderTargetPlacementFence(
    repository,
    targetName(target),
    () => runPlacement(input),
    (result, error) =>
      result.kind === "accepted"
        ? { ...result, physical: reconcileEffectFailure(error, result.physical) }
        : placementFailure(error),
  );
}
