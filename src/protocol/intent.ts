import type { ProtocolProgress } from "./progress.js";
import { observeContractsAt, type ContractReadView } from "../git/observe.js";
import type { GitDecodeChannel, GitTreeSelection } from "../git/read-observation.js";
import type { GitRepository } from "../git/process.js";
import type { AttemptContext, DecideInput, OfferDecision } from "../core/decide.js";
import type { ContractHead, ContractId } from "../core/facts/types.js";
import {
  privateStateSeatAttempt,
  preparationIsCurrent,
  spentPreparation,
  type CompanionDecorator,
  type ObservedRef,
  type ProtocolTerminal,
} from "./run.js";
import { admitDecidedOffer, type DecidedOfferResult, type PrepareRefCompanion } from "./attempt.js";

export type IntentAdmissionOptions<Refusal = never> = Readonly<{
  progress?: ProtocolProgress;
  observedContracts?: readonly ContractId[];
  decorateOffer?: CompanionDecorator;
  validateAdmission?: (observation: ContractReadView) => Refusal | undefined | Promise<Refusal | undefined>;
  prepareRefCompanion?: PrepareRefCompanion<Refusal>;
  observationSelection?: GitTreeSelection;
  expectedHead?: ContractHead | null;
  expectedRef?: ObservedRef;
}>;

/** One admission carries both the attempt identity and the optional admission options. */
export type IntentAdmission<Refusal = never> = IntentAdmissionOptions<Refusal> & Readonly<{ attempt: AttemptContext }>;

/** Observe, decide, and atomically admit one prepared decision input inside the publication seat. */
export async function admitIntent<Input extends Readonly<{ contractId: ContractId }>, Refusal>(
  channel: GitDecodeChannel,
  repository: GitRepository,
  input: Input,
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>,
  admission: IntentAdmission<Refusal>,
): Promise<DecidedOfferResult<Refusal> | ProtocolTerminal> {
  const { contractId } = input;
  const { attempt, ...options } = admission;
  const { expectedHead, expectedRef } = options;
  return privateStateSeatAttempt<DecidedOfferResult<Refusal>>(repository, async (seat) => {
    const observation = await observeContractsAt(
      repository,
      channel,
      options.observedContracts ?? [contractId],
      options.observationSelection,
    );
    if (
      expectedHead !== undefined &&
      !(await preparationIsCurrent(repository, observation, contractId, expectedHead, expectedRef))
    ) {
      return spentPreparation;
    }
    const decision = decide({ input, observation: observation.decision, attempt });
    if (decision.kind === "refused") return decision;
    const companions = await options.decorateOffer?.({ repository, observation, contractId, offer: decision.offer });
    const offer = companions?.length
      ? { ...decision.offer, companions: [...(decision.offer.companions ?? []), ...companions] }
      : decision.offer;
    return await admitDecidedOffer({
      ...options,
      scope: repository,
      channel,
      contractId,
      seat,
      observation,
      attempt,
      offer,
      assertions: expectedRef?.oid == null ? [] : [{ ref: expectedRef.ref, oid: expectedRef.oid }],
    });
  });
}
