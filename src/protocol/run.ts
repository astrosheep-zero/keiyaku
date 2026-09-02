import { extendAdmissionPathsAt, observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import {
  appendPrivateStateSeatClose,
  isPrivateStateSeatContention,
  mergePrivateStateSeatClose,
  withPrivateStatePublicationSeat,
  type PrivateStatePublicationSeat,
  type PrivateStateSeatCloseLag,
  type PrivateStateSeatOutcome,
} from "../git/private-state-seat.js";
import type { GitDecodeChannel, GitTreeSelection } from "../git/read-observation.js";
import type { GitRepository } from "../git/process.js";
import { GIT_REF, readRefs, type GitOid, type GitRefAssertion } from "../git/repository.js";
import type { AttemptContext, DecideInput, OfferDecision } from "../core/decide.js";
import type { Offer, TreeUpdate } from "../core/facts/offer.js";
import { type ChangeId, type ContractId, type SnapshotId } from "../core/facts/types.js";
import { admitDecidedOffer, type AcceptedAdmission, type AttemptTerminal, type DecidedOfferResult } from "./attempt.js";
import type { GitObjectId } from "../git/identity.js";

export const STALE_PRIVATE_STATE_PREPARATION = {
  kind: "publication-failed",
  diagnostic: "stale private-state preparation",
} as const satisfies AttemptTerminal;

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
  validateAdmission?: (observation: GitDecisionObservation) => Refusal | undefined | Promise<Refusal | undefined>;
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

type PreparedProtocolInput<Input, Refusal> =
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "prepared"; input: Input; assertions: readonly GitRefAssertion[] }>;

type SpeculativeProtocolPreparation<Input, Refusal> =
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{
      kind: "prepared";
      observation: GitDecisionObservation;
      input: Input;
      assertions: readonly GitRefAssertion[];
    }>;

export function privateRootCommit(observation: GitDecisionObservation): GitOid | null {
  return observation.admission.snapshot.commit;
}

export function samePrivateRootObservation(prepared: GitDecisionObservation, fresh: GitDecisionObservation): boolean {
  return privateRootCommit(prepared) === privateRootCommit(fresh);
}

export type SpeculativeWorktreeInput = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  mergeHead?: SnapshotId;
  dirty: boolean;
  changeId: ChangeId;
}>;

export function sameSpeculativeWorktreeInput(
  prepared: SpeculativeWorktreeInput | undefined,
  fresh: SpeculativeWorktreeInput | undefined,
): boolean {
  if (prepared === undefined || fresh === undefined) return prepared === fresh;
  return (
    prepared.tree === fresh.tree &&
    prepared.head === fresh.head &&
    prepared.mergeHead === fresh.mergeHead &&
    prepared.dirty === fresh.dirty &&
    prepared.changeId === fresh.changeId
  );
}

export async function privateStateAssertionsMatch(
  repository: GitRepository,
  assertions: readonly GitRefAssertion[],
): Promise<boolean> {
  if (assertions.length === 0) return true;
  const refs = await readRefs(repository, [GIT_REF, ...assertions.map((assertion) => assertion.ref)]);
  return assertions.every((assertion) => refs.get(assertion.ref) === assertion.oid);
}

export function publicationFailedFromSeatError(error: unknown): AttemptTerminal {
  if (isPrivateStateSeatContention(error)) return { kind: "publication-failed", diagnostic: error.message };
  throw error;
}

export async function matchingPrivateRootObservation(
  repository: GitRepository,
  channel: GitDecodeChannel,
  contractId: ContractId,
  prepared: GitDecisionObservation,
  revalidate?: (fresh: GitDecisionObservation) => boolean | Promise<boolean>,
): Promise<GitDecisionObservation | typeof STALE_PRIVATE_STATE_PREPARATION> {
  const fresh = await observeContractsForAdmissionAt(repository, channel, [contractId]);
  if (!samePrivateRootObservation(prepared, fresh)) return STALE_PRIVATE_STATE_PREPARATION;
  if (revalidate !== undefined && !(await revalidate(fresh))) return STALE_PRIVATE_STATE_PREPARATION;
  return fresh;
}

export async function privateStateSeatAttempt<T>(
  repository: GitRepository,
  action: (seat: PrivateStatePublicationSeat) => Promise<T>,
  wrap: (outcome: PrivateStateSeatOutcome<T>) => T,
): Promise<T | AttemptTerminal> {
  try {
    return wrap(await withPrivateStatePublicationSeat(repository, action));
  } catch (error) {
    return publicationFailedFromSeatError(error);
  }
}

async function observeProtocolDecision<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
>(input: RunProtocolInput<Input, Refusal, Seed>): Promise<GitDecisionObservation> {
  return input.observe === undefined
    ? await observeContractsForAdmissionAt(input.repository, input.channel, input.contracts, input.observationSelection)
    : await input.observe(input.repository, input.channel, input.contracts);
}

async function prepareProtocolSeed<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
>(
  input: RunProtocolInput<Input, Refusal, Seed>,
  observation: GitDecisionObservation,
): Promise<PreparedProtocolInput<Input, Refusal>> {
  if (!("prepareInput" in input) || input.prepareInput === undefined) {
    return { kind: "prepared", input: input.input, assertions: [] };
  }
  const prepared = await input.prepareInput(observation, input.input);
  return prepared.kind === "refused" ? prepared : { ...prepared, assertions: prepared.assertions ?? [] };
}

async function decideDecoratedProtocolOffer<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
>(
  input: RunProtocolInput<Input, Refusal, Seed>,
  baseAttempt: AttemptContext,
  decisionObservation: GitDecisionObservation,
  preparedInput: Extract<PreparedProtocolInput<Input, Refusal>, { kind: "prepared" }>,
): Promise<PreparedProtocolAttempt<Refusal>> {
  const attempt =
    input.extendAttempt === undefined
      ? baseAttempt
      : input.extendAttempt(baseAttempt, decisionObservation.decision.size);
  const decision = input.decide({
    input: preparedInput.input,
    attempt,
    observation: decisionObservation.decision,
  });
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
    assertions: preparedInput.assertions,
  };
}

/** Form one decided offer without admitting or reinterpreting it. */
export async function prepareProtocolAttempt<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
>(
  input: RunProtocolInput<Input, Refusal, Seed>,
  baseAttempt: AttemptContext,
): Promise<PreparedProtocolAttempt<Refusal>> {
  const decisionObservation = await observeProtocolDecision(input);
  const preparedInput = await prepareProtocolSeed(input, decisionObservation);
  if (preparedInput.kind === "refused") return preparedInput;
  return await decideDecoratedProtocolOffer(input, baseAttempt, decisionObservation, preparedInput);
}

function protocolAttemptWithSeatClose<Refusal>(
  outcome: PrivateStateSeatOutcome<DecidedOfferResult<Refusal>>,
): DecidedOfferResult<Refusal> {
  return mergePrivateStateSeatClose(outcome, (value, closeLag: PrivateStateSeatCloseLag) => {
    if (value.kind !== "accepted") throw new Error(closeLag.diagnostic);
    return { ...value, seatClose: appendPrivateStateSeatClose(value.seatClose, closeLag) };
  });
}

async function speculateProtocolAttempt<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
>(input: RunProtocolInput<Input, Refusal, Seed>): Promise<SpeculativeProtocolPreparation<Input, Refusal>> {
  const observation = await observeProtocolDecision(input);
  const prepared = await prepareProtocolSeed(input, observation);
  return prepared.kind === "refused" ? prepared : { observation, ...prepared };
}

async function admitSpeculativeProtocolAttempt<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
>(
  input: RunProtocolInput<Input, Refusal, Seed>,
  seat: PrivateStatePublicationSeat,
  speculated: Extract<SpeculativeProtocolPreparation<Input, Refusal>, { kind: "prepared" }>,
  attempt: AttemptContext,
): Promise<DecidedOfferResult<Refusal>> {
  const fresh = await observeProtocolDecision(input);
  if (
    !samePrivateRootObservation(speculated.observation, fresh) ||
    !(await privateStateAssertionsMatch(input.repository, speculated.assertions))
  ) {
    return STALE_PRIVATE_STATE_PREPARATION;
  }
  const decided = await decideDecoratedProtocolOffer(input, attempt, fresh, {
    kind: "prepared",
    input: speculated.input,
    assertions: speculated.assertions,
  });
  if (decided.kind === "refused") return decided;
  return await admitDecidedOffer<Refusal>({
    channel: input.channel,
    repository: input.repository,
    seat,
    decisionObservation: decided.observation,
    attempt: decided.attempt,
    offer: decided.offer,
    primaryContract: input.input.contractId,
    assertions: decided.assertions,
    ...(input.validateAdmission === undefined ? {} : { validateAdmission: input.validateAdmission }),
  });
}

async function runSpeculativeProtocolAttempt<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
>(
  input: RunProtocolInput<Input, Refusal, Seed>,
  speculated: SpeculativeProtocolPreparation<Input, Refusal>,
  attempt: AttemptContext,
): Promise<DecidedOfferResult<Refusal>> {
  if (speculated.kind === "refused") return speculated;
  return await privateStateSeatAttempt(
    input.repository,
    async (seat) => await admitSpeculativeProtocolAttempt(input, seat, speculated, attempt),
    protocolAttemptWithSeatClose,
  );
}

/** Run bounded, verb-neutral attempts and return one real admission on acceptance. */
export async function runProtocol<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
>(input: RunProtocolInput<Input, Refusal, Seed>): Promise<ProtocolResult<Refusal>> {
  const attempts = input.attempts;

  for (let index = 0; index < attempts.length; index += 1) {
    const result = await runSpeculativeProtocolAttempt(input, await speculateProtocolAttempt(input), attempts[index]!);
    if (result.kind === "refused" || result.kind === "accepted" || result.kind === "publication-failed") return result;
    if (result.kind === "collision" && index + 1 === attempts.length) return result;
  }
  return { kind: "exhausted" };
}
