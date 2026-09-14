import type { ExecutionProgress } from "./progress.js";
import { contractState } from "../core/facts/observation.js";
import type { ActorId, ContractId, ContractState, ReintegratedData } from "../core/facts/types.js";
import { decideReintegrate, type ReintegrateInput, type ReintegrateRefusal } from "../core/verbs/reintegrate.js";
import {
  materializeReintegrationSnapshot,
  persistedTender,
  planIntegration,
  type IntegrationPreparationRefusal,
} from "../git/integration.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import {
  appendPrivateStateSeatClose,
  mergePrivateStateSeatClose,
  withPrivateStatePublicationSeat,
  type PrivateStateSeatCloseLag,
  type PrivateStateSeatOutcome,
} from "../git/private-state-seat.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { GitRefAssertion } from "../git/repository.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission, type AttemptTerminal } from "./attempt.js";
import { timestamp } from "./operations.js";
import {
  contractStateWitness,
  STALE_PRIVATE_STATE_PREPARATION,
  type ContractStateWitness,
  type ProtocolTerminal,
} from "./run.js";
import { runUnderTargetPlacementFence, type PlacementExecutionFailure } from "./placement.js";

type TargetMissing = Readonly<{ kind: "target-missing"; contractId: ContractId }>;
export type ReintegrationRefusal = ReintegrateRefusal | TargetMissing | IntegrationPreparationRefusal;
export type ReintegrationResult =
  | (AcceptedAdmission & Readonly<{ value: ReintegratedData }>)
  | Readonly<{ kind: "refused"; refusal: ReintegrationRefusal }>
  | Readonly<{ kind: "retry"; reason: ProtocolTerminal }>
  | PlacementExecutionFailure;

type ReintegrationInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  contractId: ContractId;
  target: string;
  actor?: ActorId;
  progress?: ExecutionProgress;
}>;

type ReintegrationAttempt =
  | Exclude<ReintegrationResult, PlacementExecutionFailure>
  | AttemptTerminal
  | Readonly<{ kind: "redecide" }>
  | typeof STALE_PRIVATE_STATE_PREPARATION;

function reintegrationResultWithSeatClose(
  outcome: PrivateStateSeatOutcome<ReintegrationAttempt>,
): ReintegrationAttempt {
  return mergePrivateStateSeatClose(outcome, (value, closeLag: PrivateStateSeatCloseLag) => {
    if (value.kind !== "accepted") throw new Error(closeLag.diagnostic);
    return { ...value, seatClose: appendPrivateStateSeatClose(value.seatClose, closeLag) };
  });
}

/** What one seat-external integration plan proves about the target ref it was planned against. */
type ReintegrationArtifacts =
  | Readonly<{ kind: "defer" }>
  | Readonly<{ kind: "refused"; refusal: ReintegrationRefusal }>
  | Readonly<{
      kind: "prepared";
      data: Extract<ReintegrateInput<ReintegrationRefusal>["preparation"], { kind: "prepared" }>["data"];
      assertion: GitRefAssertion;
    }>;

type ExternalReintegrationPreparation =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "artifacts"; witness: ContractStateWitness; artifacts: ReintegrationArtifacts }>;

/** Plan and materialize the target-specific reintegration artifacts outside the publication seat. */
async function prepareExternalReintegration(input: ReintegrationInput): Promise<ExternalReintegrationPreparation> {
  const observation = await observeContractsForAdmissionAt(input.repository, input.channel, [input.contractId]);
  const state = contractState(observation.decision, input.contractId);
  if (state === null) return { kind: "unavailable" };
  return {
    kind: "artifacts",
    witness: contractStateWitness(state),
    artifacts: await planReintegrationArtifacts(input, state),
  };
}

async function planReintegrationArtifacts(
  input: ReintegrationInput,
  state: ContractState,
): Promise<ReintegrationArtifacts> {
  if (state.delivery === null || state.currentIntegration === null) return { kind: "defer" };
  const planned = await planIntegration(
    input.repository,
    { contractId: input.contractId, coordinates: state.coordinates },
    await persistedTender(input.repository, state.delivery.data.tenderSnapshot),
    state.delivery.data.policy.requireBranchesToBeUpToDate,
  );
  if (planned.kind === "refused") return { kind: "refused", refusal: planned.refusal };
  const snapshot = await materializeReintegrationSnapshot(
    input.repository,
    planned.data.tree,
    planned.data.predecessor,
    state.delivery.data.integration.snapshot,
  );
  return {
    kind: "prepared",
    data: { predecessor: planned.data.predecessor, snapshot },
    assertion: { ref: input.target, oid: planned.data.predecessor },
  };
}

type AssembledReintegration =
  | Readonly<{ kind: "unavailable"; refusal: ReintegrationRefusal }>
  | Extract<ReintegrationArtifacts, { kind: "refused" | "prepared" }>
  | typeof STALE_PRIVATE_STATE_PREPARATION;

/** Assemble the decision input from the fresh Contract; spent artifacts restart the whole cycle. */
function assembleReintegrationAttempt(
  input: ReintegrationInput,
  observation: GitDecisionObservation,
  external: ExternalReintegrationPreparation,
): AssembledReintegration {
  const state = contractState(observation.decision, input.contractId);
  if (state === null) {
    return external.kind === "unavailable"
      ? { kind: "unavailable", refusal: { kind: "contract-missing", contractId: input.contractId } }
      : STALE_PRIVATE_STATE_PREPARATION;
  }
  if (external.kind === "unavailable") return STALE_PRIVATE_STATE_PREPARATION;
  if (external.witness.head !== state.head) return STALE_PRIVATE_STATE_PREPARATION;
  if (state.delivery === null || state.currentIntegration === null) {
    return { kind: "unavailable", refusal: { kind: "delivery-missing", contractId: input.contractId } };
  }
  return external.artifacts.kind === "defer" ? STALE_PRIVATE_STATE_PREPARATION : external.artifacts;
}

async function runReintegration(
  input: ReintegrationInput,
): Promise<Exclude<ReintegrationResult, PlacementExecutionFailure>> {
  const attempts = mintAttempts({ entryCount: 1 });
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const external = await prepareExternalReintegration(input);
    const result = reintegrationResultWithSeatClose(
      await withPrivateStatePublicationSeat(input.repository, async (seat) => {
        const observation = await observeContractsForAdmissionAt(input.repository, input.channel, [input.contractId]);
        const assembled = assembleReintegrationAttempt(input, observation, external);
        if (assembled.kind === "stale") return assembled;
        const preparation: ReintegrateInput<ReintegrationRefusal>["preparation"] =
          assembled.kind === "unavailable" ? { kind: "refused", refusal: assembled.refusal } : assembled;
        const decision = decideReintegrate({
          input: {
            contractId: input.contractId,
            ...(input.actor === undefined ? {} : { actor: input.actor }),
            at: timestamp(),
            preparation,
          },
          attempt,
          observation: observation.decision,
        });
        if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };
        const admitted = await admitDecidedOffer({
          channel: input.channel,
          repository: input.repository,
          seat,
          decisionObservation: observation,
          attempt,
          offer: decision.offer,
          primaryContract: input.contractId,
          ...(input.progress === undefined ? {} : { progress: input.progress }),
          ...(assembled.kind === "prepared" ? { assertions: [assembled.assertion] } : {}),
        });
        if (admitted.kind === "accepted") {
          if (assembled.kind !== "prepared") throw new Error("accepted reintegration has no preparation");
          return { ...admitted, value: assembled.data };
        }
        return admitted;
      }),
    );
    if (result.kind === "accepted" || result.kind === "refused") return result;
    if (result.kind === "stale" || result.kind === "redecide") continue;
    if (result.kind === "publication-failed") return { kind: "retry", reason: result };
    if (result.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: result };
  }
  return { kind: "retry", reason: { kind: "exhausted" } };
}

export async function reintegrateOperation(input: ReintegrationInput): Promise<ReintegrationResult> {
  return await runUnderTargetPlacementFence(input.repository, input.target, async () => await runReintegration(input));
}
