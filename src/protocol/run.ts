import { observeContractsForAdmission, type GitDecisionObservation } from "../git/observe.js";
import type { GitRepository } from "../git/repository.js";
import type { AttemptContext, DecideInput, OfferDecision } from "../core/decide.js";
import type { Offer, TreeUpdate } from "../core/facts/offer.js";
import {
  type ContractId,
} from "../core/facts/types.js";
import { admitDecidedOffer, type AcceptedAdmission, type AttemptTerminal } from "./attempt.js";

export type ProtocolTerminal =
  | Readonly<{ kind: "exhausted" }>
  | AttemptTerminal;

export type ProtocolResult<Refusal> =
  | AcceptedAdmission
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | ProtocolTerminal;

export type CompanionDecorator = (input: Readonly<{
  repository: GitRepository;
  observation: GitDecisionObservation;
  contractId: ContractId;
  offer: Offer;
}>) => readonly TreeUpdate[];

type RunProtocolInput<Input extends Readonly<{ contractId: ContractId }>, Refusal> = Readonly<{
  input: Input;
  repository: GitRepository;
  contracts: readonly ContractId[];
  attempts: readonly AttemptContext[];
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>;
  /** Override the targeted observer only for intents that need a full snapshot. */
  observe?: (repository: GitRepository, contracts: readonly ContractId[]) => GitDecisionObservation;
  /** Mint verb-owned entries from the exact size of this attempt's observation. */
  extendAttempt?: (attempt: AttemptContext, observedContractCount: number) => AttemptContext;
  /** Add opaque companions from the exact immutable observation for this attempt. */
  decorateOffer?: CompanionDecorator;
}>;

/** Run bounded, verb-neutral attempts and return one real admission on acceptance. */
export function runProtocol<Input extends Readonly<{ contractId: ContractId }>, Refusal>(input: RunProtocolInput<Input, Refusal>): ProtocolResult<Refusal> {
  const attempts = input.attempts;
  const contracts = input.contracts;
  const observe = input.observe ?? observeContractsForAdmission;

  for (let index = 0; index < attempts.length; index += 1) {
    const baseAttempt = attempts[index]!;
    const decisionObservation = observe(input.repository, contracts);
    const observation = decisionObservation.decision;
    const attempt = input.extendAttempt === undefined
      ? baseAttempt
      : input.extendAttempt(baseAttempt, observation.size);
    const decision = input.decide({ input: input.input, attempt, observation });
    if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };

    const companions = input.decorateOffer === undefined
      ? []
      : input.decorateOffer({
          repository: input.repository,
          observation: decisionObservation,
          contractId: input.input.contractId,
          offer: decision.offer,
        });
    const offer = companions.length === 0
      ? decision.offer
      : { ...decision.offer, companions: [...(decision.offer.companions ?? []), ...companions] };
    const result = admitDecidedOffer(input.repository, decisionObservation, attempt, offer, input.input.contractId);
    if (result.kind === "accepted" || result.kind === "publication-failed") return result;
    if (result.kind === "collision" && index + 1 === attempts.length) return result;
  }
  return { kind: "exhausted" };
}
