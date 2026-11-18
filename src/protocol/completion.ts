import { z } from "zod";
import { targetName, type ContractState } from "../core/facts/types.js";
import { snapshotIdSchema, contractIdSchema } from "../git/identity.js";
import { deliveryDiffScopeSchema } from "../git/integration.js";
import { requirementIdSchema, gateSchema, snapshotChangeSchema } from "./result-leaves.js";
import type { GateReport } from "../core/facts/gate.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import {
  admitPlacement,
  observeTargetPlacement,
  observeIntegrationTargetMovement,
  type PlacementProtocolResult,
} from "./placement.js";
import { reintegrateOperation, type ReintegrationResult } from "./reintegrate.js";
import {
  contractCheckpoint,
  executionIssue,
  isOperationalFailure,
  isOperationalStop,
  type ContractCheckpoint,
  type ProtocolProgress,
} from "./progress.js";
import { timestamp } from "./operations.js";
import {
  activeReasonSchema,
  targetLifecycleReasonSchema,
  targetWorkspaceReasonSchema,
  checkoutCollisionSchema,
  integrationProblemSchema,
  retrySchema,
  compactRetry,
  compactReason,
  executionIssueSchema,
} from "./result-reasons.js";

const MAX_REINTEGRATION_CYCLES = 3;

const requirementCoordinate = { gate: gateSchema, requirement: requirementIdSchema };
export const requirementProblemSchema = z.union([
  z.strictObject({ ...requirementCoordinate, state: z.literal("missing") }).readonly(),
  z
    .strictObject({ ...requirementCoordinate, state: z.literal("unsatisfied"), summary: z.string().exactOptional() })
    .readonly(),
  z
    .strictObject({
      ...requirementCoordinate,
      state: z.literal("stale"),
      reason: snapshotChangeSchema.exactOptional(),
      previousContentId: z.string().min(1).exactOptional(),
      currentContentId: z.string().min(1).exactOptional(),
    })
    .readonly(),
]);
export type RequirementProblem = z.output<typeof requirementProblemSchema>;

/** Select already-adjudicated unmet requirements; never recompute currentness. */
export function unmetGateProblems(reports: readonly GateReport[]): readonly RequirementProblem[] {
  return reports
    .filter((report) => !report.satisfied)
    .flatMap((report) =>
      report.requirements.flatMap(({ requirement, current }): RequirementProblem[] => {
        const coordinate = { gate: report.gate, requirement };
        if (current.kind === "missing") return [{ ...coordinate, state: "missing" }];
        if (current.kind === "attested")
          return current.verdict === "satisfied"
            ? []
            : [
                {
                  ...coordinate,
                  state: "unsatisfied",
                  ...(current.summary === undefined ? {} : { summary: current.summary }),
                },
              ];
        if (current.kind === "applicability-pending") {
          throw new Error("integration-based gate judgment cannot have pending applicability");
        }
        return [
          {
            ...coordinate,
            state: "stale",
            ...(current.reason === undefined
              ? {}
              : current.reason.kind === "snapshot-changed"
                ? { reason: current.reason }
                : {
                    previousContentId: current.reason.previousChange,
                    currentContentId: current.reason.currentChange,
                  }),
          },
        ];
      }),
    );
}

export const unmetPrerequisiteSchema = z
  .strictObject({
    contractId: contractIdSchema,
    state: z.enum(["missing", "active", "abandoned"]),
  })
  .readonly();
const normalPlacementReasonSchema = z.union([
  z.strictObject({ kind: z.literal("delivery-missing") }).readonly(),
  z
    .strictObject({
      kind: z.literal("prerequisites-unsatisfied"),
      unmet: z.array(unmetPrerequisiteSchema).min(1).readonly(),
    })
    .readonly(),
  z
    .strictObject({ kind: z.literal("gates-unsatisfied"), unmet: z.array(requirementProblemSchema).min(1).readonly() })
    .readonly(),
]);
export const placementReasonSchema = z.union([
  ...normalPlacementReasonSchema.options,
  activeReasonSchema,
  targetLifecycleReasonSchema,
  targetWorkspaceReasonSchema,
  z.strictObject({ kind: z.literal("target-missing") }).readonly(),
  checkoutCollisionSchema,
  ...integrationProblemSchema.options,
]);
export const normalContinuationStopSchema = z.union([
  ...normalPlacementReasonSchema.options,
  z.strictObject({ kind: z.literal("physical-lag") }).readonly(),
]);
export const placementStopSchema = z
  .union([
    ...placementReasonSchema.options,
    ...retrySchema.options,
    z.strictObject({ kind: z.literal("failed"), diagnostic: z.string().min(1) }).readonly(),
    z
      .strictObject({
        kind: z.literal("target-content-identical"),
        target: z.string().min(1),
        expected: snapshotIdSchema,
        observed: snapshotIdSchema,
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal("target-moved"),
        target: z.string().min(1),
        integration: snapshotIdSchema,
        observed: snapshotIdSchema.nullable(),
      })
      .readonly(),
    executionIssueSchema,
    normalContinuationStopSchema.options[3],
  ])
  .meta({ id: "contractStop" });
export type CompactPlacementStop = z.output<typeof placementStopSchema>;
export const compactScopeSchema = z
  .strictObject({
    filesChanged: z.number().int().positive().exactOptional(),
    insertions: z.number().int().positive().exactOptional(),
    deletions: z.number().int().positive().exactOptional(),
    paths: z.array(z.string()).min(1).readonly().exactOptional(),
  })
  .readonly();
export const placedSchema = z
  .strictObject({
    kind: z.literal("placed"),
    integration: snapshotIdSchema,
    target: z.string().exactOptional(),
    predecessor: snapshotIdSchema.exactOptional(),
  })
  .readonly();
export const normalPlacementSchema = z.union([placedSchema, ...normalPlacementReasonSchema.options]);
export const placementSchema = z.union([placedSchema, placementStopSchema]);
export type Placement = z.output<typeof placementSchema>;
export type Placed = z.output<typeof placedSchema>;

export function placementOutcome(stop: CompactPlacementStop | Pick<Placed, "kind">): "benign" | "retry" | "failed" {
  switch (stop.kind) {
    case "placed":
    case "gates-unsatisfied":
    case "prerequisites-unsatisfied":
    case "delivery-missing":
    case "physical-lag":
    case "target-content-identical":
      return "benign";
    case "retry":
      return "retry";
    case "contract-missing":
    case "terminal":
    case "target-contract-missing":
    case "target-contract-terminal":
    case "target-workspace-unavailable":
    case "target-missing":
    case "checkout-not-followable":
    case "not-based-on-target":
    case "unrelated-histories":
    case "integration-conflict":
    case "integration-unsupported":
    case "failed":
    case "target-moved":
    case "execution-stopped":
      return "failed";
    default: {
      const exhaustive: never = stop;
      return exhaustive;
    }
  }
}

export function compactScope(scope: z.output<typeof deliveryDiffScopeSchema>): z.output<typeof compactScopeSchema> {
  return {
    ...(scope.filesChanged === 0 ? {} : { filesChanged: scope.filesChanged }),
    ...(scope.insertions === 0 ? {} : { insertions: scope.insertions }),
    ...(scope.deletions === 0 ? {} : { deletions: scope.deletions }),
    ...(scope.paths === undefined || scope.paths.length === 0 ? {} : { paths: scope.paths }),
  };
}

type PlacementAttempt = PlacementProtocolResult | ReintegrationResult;

function placementConclusion(result: Exclude<PlacementAttempt, { kind: "accepted" }>): CompactPlacementStop {
  switch (result.kind) {
    case "refused": {
      const reason = result.refusal;
      return reason.kind === "gates-unsatisfied"
        ? { kind: reason.kind, unmet: unmetGateProblems(reason.unmet) }
        : compactReason(reason);
    }
    case "placement-failed":
      return { kind: "failed", diagnostic: result.diagnostic };
    case "target-moved": {
      const { target, expected, observed, observedTreeEqualsCandidate } = result;
      if (!observedTreeEqualsCandidate || observed === null)
        throw new Error("unexhausted returned target movement requires identical content");
      return { kind: "target-content-identical", target, expected, observed };
    }
    case "retry":
      return compactRetry(result.reason);
    default:
      return compactRetry(result);
  }
}

type CompletionInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  checkpoint: ContractCheckpoint;
  progress: ProtocolProgress;
  signal?: AbortSignal;
}>;

type CompletionResult = Readonly<{ checkpoint: ContractCheckpoint; placement: Placement }>;

async function observeCandidateTarget(input: CompletionInput, state: ContractState) {
  const { target } = state.coordinates;
  const integration = state.currentIntegration;
  if (target === undefined || integration === null) return undefined;
  try {
    const observed = await observeTargetPlacement(input.repository, {
      contractId: state.id,
      coordinates: { ...state.coordinates, target },
      predecessor: integration.predecessor,
      candidate: integration.snapshot,
    });
    return observed.kind === "refused" ? placementConclusion(observed) : undefined;
  } catch (error) {
    if (!isOperationalFailure(error)) throw error;
    return placementConclusion({ kind: "placement-failed", diagnostic: error.message });
  }
}

function confirmPlacement(progress: ProtocolProgress, state: ContractState): Placed {
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

async function placeCurrentCandidate(input: CompletionInput, state: ContractState) {
  input.signal?.throwIfAborted();
  input.progress.observe({ kind: "stage", contractId: state.id, stage: "placement", state: "started" });
  try {
    return await admitPlacement({
      channel: input.channel,
      repository: input.repository,
      progress: input.progress,
      target: state.coordinates.target,
      placement: { contractId: state.id, at: timestamp() },
    });
  } finally {
    input.progress.observe({ kind: "stage", contractId: state.id, stage: "placement", state: "finished" });
  }
}

/** Advance one contract. The trigger owns the leading act; this node owns no other contract. */
export async function completeCandidate(input: CompletionInput): Promise<CompletionResult> {
  let checkpoint = input.checkpoint;
  const {
    id,
    coordinates: { target },
  } = checkpoint.state;
  const { progress } = input;
  const stopped = (placement: CompactPlacementStop): CompletionResult => {
    progress.recordCandidate(id, placement);
    return { checkpoint, placement };
  };
  try {
    input.signal?.throwIfAborted();
    progress.recordCandidate(id, undefined);
    for (let cycles = 0; ; cycles += 1) {
      input.signal?.throwIfAborted();
      let attempt: PlacementProtocolResult | undefined = await observeIntegrationTargetMovement(
        input.repository,
        checkpoint.state,
      );
      if (attempt === undefined) {
        const stop = await observeCandidateTarget(input, checkpoint.state);
        if (stop !== undefined) return stopped(stop);
        attempt = await placeCurrentCandidate(input, checkpoint.state);
      }
      if (attempt.kind === "accepted") {
        checkpoint = contractCheckpoint(attempt);
        const placement = confirmPlacement(progress, checkpoint.state);
        progress.recordResidue(id, attempt);
        return { checkpoint, placement };
      }
      if (attempt.kind !== "target-moved" || target === undefined || attempt.observedTreeEqualsCandidate)
        return stopped(placementConclusion(attempt));
      if (cycles === MAX_REINTEGRATION_CYCLES)
        return stopped({
          kind: "target-moved",
          target: targetName(target),
          integration: checkpoint.state.currentIntegration!.snapshot,
          observed: attempt.observed,
        });
      input.signal?.throwIfAborted();
      const reintegrated = await reintegrateOperation({
        channel: input.channel,
        repository: input.repository,
        progress,
        contractId: id,
        target,
      });
      if (reintegrated.kind !== "accepted") return stopped(placementConclusion(reintegrated));
      checkpoint = contractCheckpoint(reintegrated);
      progress.recordResidue(id, reintegrated);
    }
  } catch (error) {
    if (!isOperationalStop(error, input.signal)) throw error;
    const stop = executionIssue(error, input.signal);
    checkpoint = progress.checkpoint(id) ?? checkpoint;
    // An observed historical claim is not movement by this invocation.
    const claim = checkpoint.state.terminal;
    if (claim?.kind === "claimed" && progress.hasFact(claim)) {
      progress.recordStop({ contractId: id, ...stop });
      return { checkpoint, placement: confirmPlacement(progress, checkpoint.state) };
    }
    return stopped(stop);
  }
}
