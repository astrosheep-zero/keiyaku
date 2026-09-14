import type { ExecutionProgress } from "./progress.js";
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
import { GIT_REF, readRefs, type GitRefAssertion } from "../git/repository.js";
import type { AttemptContext, DecideInput, OfferDecision } from "../core/decide.js";
import type { Offer, TreeUpdate } from "../core/facts/offer.js";
import type { ChangeId, ContractHead, ContractId, SnapshotId } from "../core/facts/types.js";
import type { GitObjectId } from "../git/identity.js";
import { admitDecidedOffer, type AcceptedAdmission, type AttemptTerminal, type DecidedOfferResult } from "./attempt.js";

export const STALE_PRIVATE_STATE_PREPARATION = {
  kind: "stale",
} as const;

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

/**
 * Seat-external preparation: immutable artifacts plus the currentness witnesses they carry.
 * It never observes private state as authority and never forms an offer.
 */
export type ExternalProtocolPreparation<Prepared, Refusal> =
  | Readonly<{ kind: "prepared"; prepared: Prepared; assertions?: readonly GitRefAssertion[] }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>;

/**
 * In-custody assembly of one decision input from the fresh observation and an external artifact.
 * `stale` means only that the outside preparation is spent: discard it and restart the cycle.
 */
export type InCustodyProtocolPreparation<Input, Refusal> =
  | Readonly<{ kind: "prepared"; input: Input; assertions?: readonly GitRefAssertion[] }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>;

/** The one split-preparation mechanism: repeatable work outside custody, assembly inside it. */
export type ProtocolPreparation<Input, Refusal, Seed, Prepared> = Readonly<{
  external: (
    seed: Seed,
  ) => ExternalProtocolPreparation<Prepared, Refusal> | Promise<ExternalProtocolPreparation<Prepared, Refusal>>;
  assemble: (
    observation: GitDecisionObservation,
    seed: Seed,
    prepared: Prepared,
  ) => InCustodyProtocolPreparation<Input, Refusal> | Promise<InCustodyProtocolPreparation<Input, Refusal>>;
}>;

type ProtocolAdmission<Input extends Readonly<{ contractId: ContractId }>, Refusal> = Readonly<{
  channel: GitDecodeChannel;
  repository: GitRepository;
  progress?: ExecutionProgress;
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
}>;

/** An intent whose invocation is already its decision input. */
export type DirectRunProtocolInput<Seed extends Readonly<{ contractId: ContractId }>, Refusal> = ProtocolAdmission<
  Seed,
  Refusal
> &
  Readonly<{ input: Seed; preparation?: undefined }>;

/** An intent whose repeatable preparation runs outside custody and is assembled inside it. */
export type SplitRunProtocolInput<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
  Prepared,
> = ProtocolAdmission<Input, Refusal> &
  Readonly<{ input: Seed; preparation: ProtocolPreparation<Input, Refusal, Seed, Prepared> }>;

export type RunProtocolInput<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
  Prepared = Seed,
> = DirectRunProtocolInput<Seed, Refusal> | SplitRunProtocolInput<Input, Refusal, Seed, Prepared>;

export type PreparedProtocolAttempt<Refusal> =
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{
      kind: "offered";
      observation: GitDecisionObservation;
      attempt: AttemptContext;
      offer: Offer;
      assertions: readonly GitRefAssertion[];
    }>;

type PreparedProtocolInput<Input> = Readonly<{
  attempt: AttemptContext;
  input: Input;
  assertions: readonly GitRefAssertion[];
}>;

/**
 * The private-state witness a seat-external preparation was computed against. Equal journal heads
 * mean the same decoded contract state, so the same document, coordinates, and facts.
 */
export type ContractStateWitness = Readonly<{ head: ContractHead | null }>;

export function contractStateWitness(state: ContractStateWitness): ContractStateWitness {
  return { head: state.head };
}

/**
 * A physical worktree capture carried across custody as a witness, never as authority.
 *
 * Unlike a ref or a journal head, uncommitted worktree bytes are covered by no atomic
 * compare-and-swap, so the only sound proof that a seat-external capture still describes the
 * bytes about to be published is a fresh capture compared against this witness under custody.
 * A cheaper structural signature (head, merge head, dirty flag, changed paths) cannot judge it:
 * a writer that rewrites an already-changed path - a conflict materialization, for instance -
 * leaves every path-level signature identical while the bytes that would be published differ.
 */
export type WorktreeWitness = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  mergeHead?: SnapshotId;
  dirty: boolean;
  changeId: ChangeId;
}>;

export function sameWorktreeWitness(
  prepared: WorktreeWitness | undefined,
  fresh: WorktreeWitness | undefined,
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
  Prepared,
>(input: RunProtocolInput<Input, Refusal, Seed, Prepared>): Promise<GitDecisionObservation> {
  return input.observe === undefined
    ? await observeContractsForAdmissionAt(input.repository, input.channel, input.contracts, input.observationSelection)
    : await input.observe(input.repository, input.channel, input.contracts);
}

type DecidedProtocolOffer<Refusal> = Exclude<PreparedProtocolAttempt<Refusal>, Readonly<{ kind: "stale" }>>;

async function decideDecoratedProtocolOffer<Input extends Readonly<{ contractId: ContractId }>, Refusal>(
  admission: ProtocolAdmission<Input, Refusal>,
  primaryContract: ContractId,
  decisionObservation: GitDecisionObservation,
  prepared: PreparedProtocolInput<Input>,
): Promise<DecidedProtocolOffer<Refusal>> {
  const attempt =
    admission.extendAttempt === undefined
      ? prepared.attempt
      : admission.extendAttempt(prepared.attempt, decisionObservation.decision.size);
  const decision = admission.decide({
    input: prepared.input,
    attempt,
    observation: decisionObservation.decision,
  });
  if (decision.kind === "refused") return decision;
  const companions =
    admission.decorateOffer === undefined
      ? []
      : await admission.decorateOffer({
          repository: admission.repository,
          observation: decisionObservation,
          contractId: primaryContract,
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
          admission.channel,
          decisionObservation,
          companions.map(({ path }) => path),
        );
  return {
    kind: "offered",
    observation: admissionObservation,
    attempt,
    offer,
    assertions: prepared.assertions,
  };
}

async function admitDecidedProtocolOffer<Input extends Readonly<{ contractId: ContractId }>, Refusal>(
  admission: ProtocolAdmission<Input, Refusal>,
  primaryContract: ContractId,
  seat: PrivateStatePublicationSeat,
  decisionObservation: GitDecisionObservation,
  prepared: PreparedProtocolInput<Input>,
): Promise<DecidedOfferResult<Refusal>> {
  const decided = await decideDecoratedProtocolOffer(admission, primaryContract, decisionObservation, prepared);
  if (decided.kind === "refused") return decided;
  return await admitDecidedOffer<Refusal>({
    channel: admission.channel,
    repository: admission.repository,
    seat,
    decisionObservation: decided.observation,
    attempt: decided.attempt,
    offer: decided.offer,
    primaryContract,
    ...(admission.progress === undefined ? {} : { progress: admission.progress }),
    assertions: decided.assertions,
    ...(admission.validateAdmission === undefined ? {} : { validateAdmission: admission.validateAdmission }),
  });
}

function protocolAttemptWithSeatClose<Refusal>(
  outcome: PrivateStateSeatOutcome<DecidedOfferResult<Refusal>>,
): DecidedOfferResult<Refusal> {
  return mergePrivateStateSeatClose(outcome, (value, closeLag: PrivateStateSeatCloseLag) => {
    if (value.kind !== "accepted") throw new Error(closeLag.diagnostic);
    return { ...value, seatClose: appendPrivateStateSeatClose(value.seatClose, closeLag) };
  });
}

async function runDirectProtocolAttempt<Seed extends Readonly<{ contractId: ContractId }>, Refusal>(
  input: DirectRunProtocolInput<Seed, Refusal>,
  attempt: AttemptContext,
): Promise<DecidedOfferResult<Refusal>> {
  return await privateStateSeatAttempt(
    input.repository,
    async (seat) => {
      const observation = await observeProtocolDecision<Seed, Refusal, Seed, Seed>(input);
      return await admitDecidedProtocolOffer<Seed, Refusal>(input, input.input.contractId, seat, observation, {
        attempt,
        input: input.input,
        assertions: [],
      });
    },
    protocolAttemptWithSeatClose,
  );
}

/**
 * One full attempt: repeatable preparation outside custody, then a single in-custody cycle of
 * observation, witness validation, assembly, decision, companions, and atomic publication.
 */
async function runSplitProtocolAttempt<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
  Prepared,
>(
  input: SplitRunProtocolInput<Input, Refusal, Seed, Prepared>,
  attempt: AttemptContext,
): Promise<DecidedOfferResult<Refusal>> {
  const external = await input.preparation.external(input.input);
  if (external.kind === "refused") return external;
  return await privateStateSeatAttempt(
    input.repository,
    async (seat) => {
      const observation = await observeProtocolDecision(input);
      const assembled = await input.preparation.assemble(observation, input.input, external.prepared);
      if (assembled.kind !== "prepared") return assembled;
      const assertions = [...(external.assertions ?? []), ...(assembled.assertions ?? [])];
      if (!(await privateStateAssertionsMatch(input.repository, assertions))) return STALE_PRIVATE_STATE_PREPARATION;
      return await admitDecidedProtocolOffer<Input, Refusal>(input, input.input.contractId, seat, observation, {
        attempt,
        input: assembled.input,
        assertions,
      });
    },
    protocolAttemptWithSeatClose,
  );
}

/** Form one decided offer without admitting or reinterpreting it. */
export async function prepareProtocolAttempt<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
  Prepared = Seed,
>(
  input: RunProtocolInput<Input, Refusal, Seed, Prepared>,
  baseAttempt: AttemptContext,
): Promise<PreparedProtocolAttempt<Refusal>> {
  if (input.preparation === undefined) return await prepareDirectProtocolAttempt<Seed, Refusal>(input, baseAttempt);
  const external = await input.preparation.external(input.input);
  if (external.kind === "refused") return external;
  const decisionObservation = await observeProtocolDecision(input);
  const assembled = await input.preparation.assemble(decisionObservation, input.input, external.prepared);
  if (assembled.kind !== "prepared") return assembled;
  return await decideDecoratedProtocolOffer<Input, Refusal>(input, input.input.contractId, decisionObservation, {
    attempt: baseAttempt,
    input: assembled.input,
    assertions: [...(external.assertions ?? []), ...(assembled.assertions ?? [])],
  });
}

async function prepareDirectProtocolAttempt<Seed extends Readonly<{ contractId: ContractId }>, Refusal>(
  input: DirectRunProtocolInput<Seed, Refusal>,
  baseAttempt: AttemptContext,
): Promise<PreparedProtocolAttempt<Refusal>> {
  const decisionObservation = await observeProtocolDecision<Seed, Refusal, Seed, Seed>(input);
  return await decideDecoratedProtocolOffer<Seed, Refusal>(input, input.input.contractId, decisionObservation, {
    attempt: baseAttempt,
    input: input.input,
    assertions: [],
  });
}

/** Run bounded, verb-neutral attempts and return one real admission on acceptance. */
export async function runProtocol<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }> = Input,
  Prepared = Seed,
>(input: RunProtocolInput<Input, Refusal, Seed, Prepared>): Promise<ProtocolResult<Refusal>> {
  const attempts = input.attempts;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const result =
      input.preparation === undefined
        ? await runDirectProtocolAttempt(input, attempt)
        : await runSplitProtocolAttempt(input, attempt);
    if (result.kind === "refused" || result.kind === "accepted" || result.kind === "publication-failed") return result;
    if (result.kind === "collision" && index + 1 === attempts.length) return result;
  }
  return { kind: "exhausted" };
}
