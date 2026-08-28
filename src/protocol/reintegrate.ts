import { contractState } from "../core/facts/observation.js";
import type { ActorId, ContractId, ReintegratedData } from "../core/facts/types.js";
import { decideReintegrate, type ReintegrateInput, type ReintegrateRefusal } from "../core/verbs/reintegrate.js";
import {
  materializeReintegrationSnapshot,
  persistedTender,
  planIntegration,
  type IntegrationPreparationRefusal,
} from "../git/integration.js";
import { observeContractsForAdmissionAt } from "../git/observe.js";
import { withPrivateStatePublicationSeat } from "../git/private-state-seat.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { GitRefAssertion } from "../git/repository.js";
import { admitDecidedOffer, mintAttempts, type AcceptedAdmission } from "./attempt.js";
import { timestamp } from "./operations.js";
import type { ProtocolTerminal } from "./run.js";
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
}>;

async function runReintegration(
  input: ReintegrationInput,
): Promise<Exclude<ReintegrationResult, PlacementExecutionFailure>> {
  return await withPrivateStatePublicationSeat(input.repository, async (seat) => {
    const attempts = mintAttempts({ entryCount: 1 });
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]!;
      const observation = await observeContractsForAdmissionAt(input.repository, input.channel, [input.contractId]);
      const state = contractState(observation.decision, input.contractId);
      let preparation: ReintegrateInput<ReintegrationRefusal>["preparation"];
      let assertions: readonly GitRefAssertion[] = [];
      if (state === null || state.delivery === null || state.currentIntegration === null) {
        preparation = {
          kind: "refused",
          refusal: {
            kind: state === null ? "contract-missing" : "delivery-missing",
            contractId: input.contractId,
          },
        };
      } else {
        const planned = await planIntegration(
          input.repository,
          { contractId: input.contractId, coordinates: state.coordinates },
          await persistedTender(input.repository, state.delivery.data.tenderSnapshot),
          state.delivery.data.policy.requireBranchesToBeUpToDate,
        );
        if (planned.kind === "refused") {
          preparation = planned;
        } else {
          const snapshot = await materializeReintegrationSnapshot(
            input.repository,
            planned.data.tree,
            planned.data.predecessor,
            state.delivery.data.integration.snapshot,
          );
          preparation = {
            kind: "prepared",
            data: { predecessor: planned.data.predecessor, snapshot },
          };
          assertions = [{ ref: input.target, oid: planned.data.predecessor }];
        }
      }
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
      const result = await admitDecidedOffer({
        channel: input.channel,
        repository: input.repository,
        seat,
        decisionObservation: observation,
        attempt,
        offer: decision.offer,
        primaryContract: input.contractId,
        assertions,
      });
      if (result.kind === "accepted") {
        if (preparation.kind !== "prepared") throw new Error("accepted reintegration has no preparation");
        return { ...result, value: preparation.data };
      }
      if (result.kind === "publication-failed") return { kind: "retry", reason: result };
      if (result.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: result };
    }
    return { kind: "retry", reason: { kind: "exhausted" } };
  });
}

export async function reintegrateOperation(input: ReintegrationInput): Promise<ReintegrationResult> {
  return await runUnderTargetPlacementFence(input.repository, input.target, async () => await runReintegration(input));
}
