import type { ProtocolProgress } from "./progress.js";
import type { ContractReadView } from "../git/observe.js";
import type { GitDecodeChannel, GitTreeSelection } from "../git/read-observation.js";
import type { GitRepository } from "../git/process.js";
import type { DecideInput, OfferDecision } from "../core/decide.js";
import type { ContractId } from "../core/facts/types.js";
import { runProtocol, type CompanionDecorator, type ProtocolPreparation, type ProtocolResult } from "./run.js";
import { mintAttempts, type PrepareRefCompanion } from "./attempt.js";

type CommonIntentAdmissionOptions<Refusal> = Readonly<{
  progress?: ProtocolProgress;
  observedContracts?: readonly ContractId[];
  observe?: (
    repository: GitRepository,
    channel: GitDecodeChannel,
    contracts: readonly ContractId[],
  ) => Promise<ContractReadView>;
  decorateOffer?: CompanionDecorator;
  prepareRefCompanion?: PrepareRefCompanion<Refusal>;
  validateAdmission?: (observation: ContractReadView) => Refusal | undefined | Promise<Refusal | undefined>;
  observationSelection?: GitTreeSelection;
}>;

export type IntentAdmissionOptions<Refusal = never> = CommonIntentAdmissionOptions<Refusal>;

type PreparedIntentAdmissionOptions<Input, Refusal, Seed, Prepared> = CommonIntentAdmissionOptions<Refusal> &
  Readonly<{ preparation: ProtocolPreparation<Input, Refusal, Seed, Prepared> }>;

/** Observe, decide, and atomically admit one intent whose invocation already is its decision input. */
export function admitIntent<Input extends Readonly<{ contractId: ContractId }>, Refusal>(
  channel: GitDecodeChannel,
  repository: GitRepository,
  input: Input,
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>,
  options: IntentAdmissionOptions<Refusal> = {},
): Promise<ProtocolResult<Refusal>> {
  const { observedContracts = [input.contractId], ...admission } = options;
  return runProtocol<Input, Refusal, Input, Input>({
    ...admission,
    input,
    channel,
    repository,
    contracts: observedContracts,
    attempts: mintAttempts({ entryCount: 1 }),
    decide,
  });
}

/**
 * Observe, decide, and atomically admit one intent whose repeatable preparation happens outside
 * the publication seat and whose decision input is assembled from the fresh in-custody observation.
 */
export function admitPreparedIntent<
  Input extends Readonly<{ contractId: ContractId }>,
  Refusal,
  Seed extends Readonly<{ contractId: ContractId }>,
  Prepared,
>(
  channel: GitDecodeChannel,
  repository: GitRepository,
  input: Seed,
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>,
  options: PreparedIntentAdmissionOptions<Input, Refusal, Seed, Prepared>,
): Promise<ProtocolResult<Refusal>> {
  const { observedContracts = [input.contractId], ...admission } = options;
  return runProtocol<Input, Refusal, Seed, Prepared>({
    ...admission,
    input,
    channel,
    repository,
    contracts: observedContracts,
    attempts: mintAttempts({ entryCount: 1 }),
    decide,
  });
}
