import type { ProtocolProgress } from "./progress.js";
import { contractState } from "../core/facts/observation.js";
import {
  targetName,
  sameTarget,
  type ContractHead,
  type ContractId,
  type ContractState,
  type ContractTarget,
  type SnapshotId,
} from "../core/facts/types.js";
import { observeTarget, type TargetObservation, type TargetWorkspaceRefusal } from "../git/target.js";
import { decideReintegrate, type ReintegrateInput, type ReintegrateRefusal } from "../core/verbs/reintegrate.js";
import {
  materializeReintegrationSnapshot,
  persistedTender,
  planIntegration,
  reusableIntegrationSnapshot,
  type IntegrationPreparationRefusal,
} from "../git/integration.js";
import { contractJournal, observeContractsAt } from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { admitIntent } from "./intent.js";
import { timestamp } from "./operations.js";
import { deliveryIntegrationSnapshots } from "./deliver.js";
import { runBoundedAttempts, spentPreparation, type ProtocolTerminal } from "./run.js";
import { runUnderTargetPlacementFence, type PlacementExecutionFailure } from "./placement.js";
import { mintAttempts, type AcceptedAdmission } from "./attempt.js";

type ReintegrationRefusal =
  | ReintegrateRefusal
  | Readonly<{ kind: "target-missing" }>
  | IntegrationPreparationRefusal
  | TargetWorkspaceRefusal;
export type ReintegrationResult =
  | AcceptedAdmission
  | Readonly<{ kind: "refused"; refusal: ReintegrationRefusal }>
  | Readonly<{ kind: "retry"; reason: ProtocolTerminal }>
  | PlacementExecutionFailure;

type ReintegrationInput = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  contractId: ContractId;
  target: ContractTarget;
  progress?: ProtocolProgress;
}>;

type ReintegrationPreparation = ReintegrateInput<ReintegrationRefusal>["preparation"];
type PreparedReintegration = Readonly<{
  expectedHead: ContractHead | null;
  expectedRef?: TargetObservation;
  preparation: ReintegrationPreparation;
}>;

async function prepareReintegration(
  repository: GitRepository,
  state: ContractState | null,
  recordedIntegrations: readonly SnapshotId[],
  targetObservation: TargetObservation | undefined,
): Promise<ReintegrationPreparation> {
  if (state === null) return { kind: "refused", refusal: { kind: "contract-missing" } };
  if (state.terminal !== null) return { kind: "refused", refusal: { kind: "terminal" } };
  if (state.delivery === null) return { kind: "refused", refusal: { kind: "delivery-missing" } };
  const planned = await planIntegration(
    repository,
    { coordinates: state.coordinates },
    await persistedTender(repository, state.delivery.data.tenderSnapshot),
    state.delivery.data.policy.requireBranchesToBeUpToDate,
    targetObservation,
  );
  if (planned.kind === "refused") return planned;
  const { tree, predecessor } = planned.data;
  const snapshot =
    (await reusableIntegrationSnapshot(repository, tree, predecessor, recordedIntegrations)) ??
    (await materializeReintegrationSnapshot(repository, tree, predecessor, state.delivery.data.integration.snapshot));
  return { kind: "prepared", data: { predecessor, snapshot } };
}

export async function reintegrateOperation(input: ReintegrationInput): Promise<ReintegrationResult> {
  const { repository, channel, contractId, target, progress } = input;
  return await runUnderTargetPlacementFence(repository, targetName(target), async () => {
    const result = await runBoundedAttempts<PreparedReintegration, AcceptedAdmission, ReintegrationRefusal>(
      mintAttempts({ entryCount: 1 }),
      async () => {
        const before = await observeContractsAt(repository, channel, [contractId]);
        const state = contractState(before.decision, contractId);
        if (state?.terminal === null && !sameTarget(state.coordinates.target, target)) return spentPreparation;
        const expectedRef =
          state?.terminal === null && state.delivery !== null ? await observeTarget(repository, target) : undefined;
        const preparation = await prepareReintegration(
          repository,
          state,
          deliveryIntegrationSnapshots(contractJournal(before.journals, contractId).entries),
          expectedRef,
        );
        return {
          kind: "prepared",
          prepared: {
            expectedHead: state?.head ?? null,
            ...(expectedRef === undefined ? {} : { expectedRef }),
            preparation,
          },
        };
      },
      async (prepared, attempt) =>
        await admitIntent(
          channel,
          repository,
          { contractId, at: timestamp(), preparation: prepared.preparation },
          decideReintegrate<ReintegrationRefusal>,
          {
            attempt,
            expectedHead: prepared.expectedHead,
            ...(prepared.expectedRef === undefined ? {} : { expectedRef: prepared.expectedRef }),
            ...(progress === undefined ? {} : { progress }),
          },
        ),
    );
    if (result.kind === "accepted") progress?.recordResidue(contractId, result);
    if (result.kind === "accepted" || result.kind === "refused") return result;
    return { kind: "retry", reason: result };
  });
}
