import type { ProtocolProgress } from "./progress.js";
import { contractState } from "../core/facts/observation.js";
import {
  targetName,
  sameTarget,
  type ContractHead,
  type ContractId,
  type ContractState,
  type ContractTarget,
  type ReintegratedData,
  type SnapshotId,
} from "../core/facts/types.js";
import { resolveContractTarget, targetRef, targetRepository, type TargetWorkspaceRefusal } from "../git/target.js";
import { decideReintegrate, type ReintegrateInput, type ReintegrateRefusal } from "../core/verbs/reintegrate.js";
import {
  materializeReintegrationSnapshot,
  persistedTender,
  planIntegration,
  reusableIntegrationSnapshot,
  type IntegrationPreparationRefusal,
} from "../git/integration.js";
import { mintSnapshotId } from "../git/identity.js";
import { readRef } from "../git/repository.js";
import { contractJournal, observeContractsAt } from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { admitIntent } from "./intent.js";
import { timestamp } from "./operations.js";
import { deliveryIntegrationSnapshots } from "./deliver.js";
import { runBoundedAttempts, spentPreparation, type ObservedRef, type ProtocolTerminal } from "./run.js";
import { runUnderTargetPlacementFence, type PlacementExecutionFailure } from "./placement.js";
import { mintAttempts, type AcceptedAdmission } from "./attempt.js";

type ReintegrationRefusal =
  | ReintegrateRefusal
  | Readonly<{ kind: "target-missing" }>
  | IntegrationPreparationRefusal
  | TargetWorkspaceRefusal;
export type ReintegrationResult =
  | (AcceptedAdmission & Readonly<{ value: ReintegratedData }>)
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
  expectedRef?: ObservedRef;
  preparation: ReintegrationPreparation;
}>;

async function prepareReintegration(
  repository: GitRepository,
  state: ContractState | null,
  recordedIntegrations: readonly SnapshotId[],
  targetHead: SnapshotId | null | undefined,
): Promise<ReintegrationPreparation> {
  if (state === null) return { kind: "refused", refusal: { kind: "contract-missing" } };
  if (state.terminal !== null) return { kind: "refused", refusal: { kind: "terminal" } };
  if (state.delivery === null) return { kind: "refused", refusal: { kind: "delivery-missing" } };
  const planned = await planIntegration(
    repository,
    { coordinates: state.coordinates },
    await persistedTender(repository, state.delivery.data.tenderSnapshot),
    state.delivery.data.policy.requireBranchesToBeUpToDate,
    targetHead,
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
    const result = await runBoundedAttempts<
      PreparedReintegration,
      AcceptedAdmission & Readonly<{ value: ReintegratedData }>,
      ReintegrationRefusal
    >(
      mintAttempts({ entryCount: 1 }),
      async () => {
        const before = await observeContractsAt(repository, channel, [contractId]);
        const state = contractState(before.decision, contractId);
        if (state?.terminal === null && !sameTarget(state.coordinates.target, target)) return spentPreparation;
        const ref = targetRef(target);
        const oid =
          state?.terminal === null && state.delivery !== null
            ? await readRef(targetRepository(repository, target), ref)
            : undefined;
        const expectedRef = oid === undefined ? undefined : { ref, oid };
        const targetHead = typeof oid === "string" ? mintSnapshotId(oid) : oid;
        const preparation = await prepareReintegration(
          repository,
          state,
          deliveryIntegrationSnapshots(contractJournal(before.journals, contractId).entries),
          targetHead,
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
      async (prepared, attempt) => {
        const admitted = await admitIntent(
          channel,
          repository,
          { contractId, at: timestamp(), preparation: prepared.preparation },
          decideReintegrate<ReintegrationRefusal>,
          {
            attempt,
            expectedHead: prepared.expectedHead,
            ...(prepared.expectedRef === undefined ? {} : { expectedRef: prepared.expectedRef }),
            ...(progress === undefined ? {} : { progress }),
            validateAdmission: async () => {
              if (typeof target === "string") return undefined;
              const resolved = await resolveContractTarget(repository, target.contractId, target);
              return resolved.kind === "refused" ? resolved.refusal : undefined;
            },
          },
        );
        if (admitted.kind !== "accepted") return admitted;
        if (prepared.preparation.kind !== "prepared") throw new Error("accepted reintegration has no preparation");
        return { ...admitted, value: prepared.preparation.data };
      },
    );
    if (result.kind === "accepted" || result.kind === "refused") return result;
    return { kind: "retry", reason: result };
  });
}
