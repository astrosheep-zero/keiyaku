import type { ProtocolProgress } from "./progress.js";
import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { contractState } from "../core/facts/observation.js";
import { sameTarget, targetName, type ContractId, type ContractTarget, type SnapshotId } from "../core/facts/types.js";
import { decidePlacement, type PlacementRefusal } from "../core/verbs/placement.js";
import { observeContractsAt } from "../git/observe.js";
import { withPrivateStatePublicationSeat } from "../git/private-state-seat.js";
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
import { resolveContractTarget } from "../git/target.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission } from "./attempt.js";
import {
  prepareProtocolAttempt,
  protocolSeatClose,
  runProtocol,
  type ProtocolResult,
  type RunProtocolInput,
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
type PlacementAdmissionInput<ExtraRefusal> = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  target: ContractTarget | undefined;
  placement: PlacementProtocolInput;
  onDeliveryMissing?: () => Promise<PlacementProtocolResult<ExtraRefusal> | undefined>;
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

async function runFencedPlacement(
  repository: GitRepository,
  input: PlacementProtocolInput,
  protocol: RunProtocolInput<PlacementProtocolInput, PlacementRefusal | TargetPlacementRefusal>,
): Promise<PlacementProtocolResult> {
  for (const [index, attempt] of protocol.attempts.entries()) {
    const result = protocolSeatClose(
      await withPrivateStatePublicationSeat(repository, async (seat) => {
        const prepared = await prepareProtocolAttempt(protocol, attempt);
        if (prepared.kind !== "offered") return prepared;
        const movement = prepared.offer.target;
        if (movement === undefined) throw new Error("targeted placement offer is missing its target movement");
        const { target, expectedOid, newOid } = movement;
        const destination =
          typeof target === "string" ? undefined : await resolveContractTarget(repository, target.contractId, target);
        if (destination?.kind === "refused") return destination;
        const observed = destination?.head ?? (await observeTargetHead(repository, target));
        if (observed !== expectedOid)
          return {
            kind: "target-moved" as const,
            target: targetName(target),
            expected: expectedOid,
            observed,
            observedTreeEqualsCandidate: await observedTreeEqualsCandidate(repository, observed, newOid),
          };
        return await admitDecidedOffer({
          ...protocol,
          scope: repository,
          contractId: input.contractId,
          seat,
          observation: prepared.observation,
          attempt: prepared.attempt,
          offer: prepared.offer,
        });
      }),
    );
    if (result.kind === "redecide" || result.kind === "stale") continue;
    if (result.kind === "collision" && index + 1 < protocol.attempts.length) continue;
    if (result.kind !== "accepted") return result;
    const { currentIntegration, coordinates } = result.state;
    if (currentIntegration === null || coordinates.target === undefined)
      throw new Error("accepted targeted placement has no integration movement");
    protocol.progress?.recordCompletion(input.contractId, {
      integration: currentIntegration.snapshot,
      predecessor: currentIntegration.predecessor,
      target: targetName(coordinates.target),
    });
    const report = (physical: ReconcileResult) =>
      protocol.progress?.recordPlacementPhysical(input.contractId, physical);
    try {
      return { ...result, physical: await recoverTargetPlacement(repository, result.state, report) };
    } catch (error) {
      if (isPlacementCancellation(repository, error)) throw error;
      const physical = reconcileEffectFailure(error);
      report(physical);
      return { ...result, physical };
    }
  }
  return { kind: "exhausted" };
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
    preparation: {
      external: () => ({ kind: "prepared", prepared: input }),
      assemble: (observation) =>
        sameTarget(contractState(observation.decision, input.contractId)?.coordinates.target, target)
          ? { kind: "prepared", input }
          : { kind: "stale" },
    },
    ...(admission.progress === undefined ? {} : { progress: admission.progress }),
    observe: (observedRepository, observedChannel, contracts) =>
      observeContractsAt(observedRepository, observedChannel, contracts, { after: true }),
  };
  if (target === undefined) return await runProtocol(protocol);
  return await runUnderTargetPlacementFence(
    repository,
    targetName(target),
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
