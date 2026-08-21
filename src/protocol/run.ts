import { extendAdmissionPathsAt, observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import type { GitDecodeChannel, GitTreeSelection } from "../git/read-observation.js";
import type { GitRepository } from "../git/process.js";
import type { GitRefAssertion } from "../git/repository.js";
import type { AttemptContext, DecideInput, OfferDecision } from "../core/decide.js";
import type { Offer, TreeUpdate } from "../core/facts/offer.js";
import { type ContractId } from "../core/facts/types.js";
import { admitDecidedOffer, type AcceptedAdmission, type AttemptTerminal } from "./attempt.js";

export type ProtocolTerminal = Readonly<{ kind: "exhausted" }> | AttemptTerminal;

export type ProtocolResult<Refusal> =
  | AcceptedAdmission
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | ProtocolTerminal;

export type CompanionDecorator = (
  input: Readonly<{
    repository: GitRepository;
    observation: GitDecisionObservation;
    contractId: ContractId;
    offer: Offer;
  }>,
) => readonly TreeUpdate[] | Promise<readonly TreeUpdate[]>;

export type RunProtocolInput<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
> = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  contracts: readonly ContractId[];
  attempts: readonly AttemptContext[];
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>;
  /** Override the targeted observer only for intents that need a full snapshot. */
  observe?: (
    repository: GitRepository,
    channel: GitDecodeChannel,
    contracts: readonly ContractId[],
  ) => Promise<GitDecisionObservation>;
  /** Mint verb-owned entries from the exact size of this attempt's observation. */
  extendAttempt?: (attempt: AttemptContext, observedContractCount: number) => AttemptContext;
  /** Add opaque companions from the exact immutable observation for this attempt. */
  decorateOffer?: CompanionDecorator;
  observationSelection?: GitTreeSelection;
}> &
  (
    | Readonly<{
        input: Input;
        prepareInput?: never;
      }>
    | Readonly<{
        input: Seed;
        prepareInput: (
          observation: GitDecisionObservation,
          input: Seed,
        ) =>
          | Readonly<{ kind: "prepared"; input: Input; assertions?: readonly GitRefAssertion[] }>
          | Readonly<{ kind: "refused"; refusal: Refusal }>
          | Promise<
              | Readonly<{ kind: "prepared"; input: Input; assertions?: readonly GitRefAssertion[] }>
              | Readonly<{ kind: "refused"; refusal: Refusal }>
            >;
      }>
  );

export type PreparedProtocolAttempt<Refusal> =
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{
      kind: "offered";
      observation: GitDecisionObservation;
      attempt: AttemptContext;
      offer: Offer;
      assertions: readonly GitRefAssertion[];
    }>;

/** Form one decided offer without admitting or reinterpreting it. */
export async function prepareProtocolAttempt<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
>(
  input: RunProtocolInput<Input, Refusal, Seed>,
  baseAttempt: AttemptContext,
): Promise<PreparedProtocolAttempt<Refusal>> {
  const decisionObservation =
    input.observe === undefined
      ? await observeContractsForAdmissionAt(
          input.repository,
          input.channel,
          input.contracts,
          input.observationSelection,
        )
      : await input.observe(input.repository, input.channel, input.contracts);
  const observation = decisionObservation.decision;
  const preparedInput =
    "prepareInput" in input && input.prepareInput !== undefined
      ? await input.prepareInput(decisionObservation, input.input)
      : { kind: "prepared" as const, input: input.input, assertions: [] };
  if (preparedInput.kind === "refused") return preparedInput;
  const attempt = input.extendAttempt === undefined ? baseAttempt : input.extendAttempt(baseAttempt, observation.size);
  const decision = input.decide({ input: preparedInput.input, attempt, observation });
  if (decision.kind === "refused") return decision;

  const companions =
    input.decorateOffer === undefined
      ? []
      : await input.decorateOffer({
          repository: input.repository,
          observation: decisionObservation,
          contractId: input.input.contractId,
          offer: decision.offer,
        });
  const offer =
    companions.length === 0
      ? decision.offer
      : { ...decision.offer, companions: [...(decision.offer.companions ?? []), ...companions] };
  const admissionObservation =
    companions.length === 0
      ? decisionObservation
      : await extendAdmissionPathsAt(
          input.channel,
          decisionObservation,
          companions.map(({ path }) => path),
        );
  return {
    kind: "offered",
    observation: admissionObservation,
    attempt,
    offer,
    assertions: preparedInput.assertions ?? [],
  };
}

/** Run bounded, verb-neutral attempts and return one real admission on acceptance. */
export async function runProtocol<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
>(input: RunProtocolInput<Input, Refusal, Seed>): Promise<ProtocolResult<Refusal>> {
  const attempts = input.attempts;

  for (let index = 0; index < attempts.length; index += 1) {
    const prepared = await prepareProtocolAttempt(input, attempts[index]!);
    if (prepared.kind === "refused") return prepared;
    const result = await admitDecidedOffer({
      channel: input.channel,
      repository: input.repository,
      decisionObservation: prepared.observation,
      attempt: prepared.attempt,
      offer: prepared.offer,
      primaryContract: input.input.contractId,
      assertions: prepared.assertions,
    });
    if (result.kind === "accepted" || result.kind === "publication-failed") return result;
    if (result.kind === "collision" && index + 1 === attempts.length) return result;
  }
  return { kind: "exhausted" };
}
