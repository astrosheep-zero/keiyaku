import {
  admit,
  type Admission,
  type RefMoved,
} from "../carrier/admission.js";
import { observeContracts } from "../carrier/observe.js";
import type { GitRepository } from "../carrier/repository.js";
import type { AttemptContext, DecideInput, OfferDecision } from "../core/decide.js";
import { foldJournal } from "../core/facts/fold.js";
import type { ContractJournalAppend, Offer } from "../core/facts/offer.js";
import type { ContractsObservation } from "../core/facts/observation.js";
import {
  contractId,
  entryUlid,
  type ContractHead,
  type ContractId,
  type ContractState,
  type EntryUlid,
  type JournalEntry,
} from "../core/facts/types.js";
import { classifyUnknownAttempt, type UnknownAttemptClassification } from "./attempt.js";

export type ProtocolReceipt = Readonly<{
  facts: readonly JournalEntry[];
  prior: ContractState | null;
  snapshot: ContractState;
}>;

type ProtocolAccepted = Readonly<{ kind: "accepted"; receipt: ProtocolReceipt }>;

type ProtocolCollision = Extract<UnknownAttemptClassification, Readonly<{ kind: "collision" }>>;

export type ProtocolTerminal =
  | Readonly<{ kind: "exhausted"; admission: Admission | null }>
  | ProtocolCollision
  | RefMoved;

export type ProtocolResult<Refusal> =
  | ProtocolAccepted
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | ProtocolTerminal;

type RunProtocolInput<Input, Refusal> = Readonly<{
  input: Input;
  repository: GitRepository;
  contracts: readonly ContractId[];
  attempts: readonly AttemptContext[];
  decide: (input: DecideInput<Input>) => OfferDecision<Refusal>;
  /** Override the targeted observer only for intents that need a full snapshot. */
  observe?: (repository: GitRepository, contracts: readonly ContractId[]) => ContractsObservation;
  /** Mint just enough additional entries when an observation contains new contracts. */
  extendAttempt?: (attempt: AttemptContext, requiredEntries: number) => AttemptContext;
}>;

function validatedAttempts(attempts: readonly AttemptContext[]): readonly AttemptContext[] {
  if (!Array.isArray(attempts)) throw new TypeError("attempts must be an array");
  if (attempts.length === 0) throw new TypeError("at least one attempt context is required");
  const seenOrdinals = new Set<number>();
  const seenUlids = new Set<EntryUlid>();
  return attempts.map((attempt, index) => {
    if (!attempt || typeof attempt !== "object") throw new TypeError("attempt context must be an object");
    if (!Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 0) {
      throw new TypeError("attempt ordinal must be a nonnegative safe integer");
    }
    if (attempt.ordinal !== index || seenOrdinals.has(attempt.ordinal)) {
      throw new TypeError("attempt ordinals must be consecutive from zero");
    }
    seenOrdinals.add(attempt.ordinal);
    if (!Array.isArray(attempt.entryUlids) || attempt.entryUlids.length === 0) {
      throw new TypeError("attempt context requires fresh entry ULIDs");
    }
    const entryUlids = (attempt.entryUlids as readonly EntryUlid[]).map((value: EntryUlid) => {
      const ulid = entryUlid(value);
      if (seenUlids.has(ulid)) throw new TypeError(`entry ULID is not fresh: ${ulid}`);
      seenUlids.add(ulid);
      return ulid;
    });
    return { ordinal: attempt.ordinal, entryUlids };
  });
}

function watchedContracts(contracts: readonly ContractId[]): readonly ContractId[] {
  if (!Array.isArray(contracts)) throw new TypeError("contracts must be an array");
  const seen = new Set<ContractId>();
  return contracts.map((value) => {
    const id = contractId(value);
    if (seen.has(id)) throw new TypeError(`duplicate watched contract: ${id}`);
    seen.add(id);
    return id;
  });
}

function offerEntries(offer: Offer): readonly JournalEntry[] {
  return offer.facts.flatMap((append) => append.entries);
}

function primaryAppend(offer: Offer, attempt: AttemptContext): ContractJournalAppend {
  const primaryEntry = attempt.entryUlids[0]!;
  const append = offer.facts.find((candidate) => candidate.entries.some((entry) => entry.entry === primaryEntry))
    ?? offer.facts[0];
  if (append === undefined) throw new TypeError("accepted offer is missing its primary contract");
  return append;
}

type OfferValidation = Readonly<{
  attempt: AttemptContext;
  observation: ContractsObservation;
  expectedEntries: ReadonlySet<EntryUlid>;
  actualEntries: Set<EntryUlid>;
  appendedContracts: Set<ContractId>;
}>;

function validateOfferAppend(append: ContractJournalAppend, validation: OfferValidation): void {
  if (!append || typeof append !== "object") throw new TypeError("invalid contract append");
  const id = contractId(append.contractId);
  if (!validation.observation.contracts.has(id)) throw new TypeError(`offer contract is not observed: ${id}`);
  if (validation.appendedContracts.has(id)) throw new TypeError(`duplicate offer contract: ${id}`);
  validation.appendedContracts.add(id);
  if (append.expectedHead === undefined) throw new TypeError(`offer requires explicit expected head: ${id}`);
  const observed = validation.observation.contracts.get(id);
  if (observed === undefined) throw new TypeError(`offer contract observation is missing: ${id}`);
  if ((observed.state?.head ?? null) !== append.expectedHead) {
    throw new TypeError(`offer expected head does not match observation: ${id}`);
  }
  if (!Array.isArray(append.entries) || append.entries.length === 0) {
    throw new TypeError(`offer requires entries: ${id}`);
  }
  for (const entry of append.entries) {
    if (entry.contract !== id) throw new TypeError(`journal entry contract does not match offer: ${id}`);
    const ulid = entryUlid(entry.entry);
    if (!validation.expectedEntries.has(ulid) || validation.actualEntries.has(ulid)) {
      throw new TypeError(`offer entries must exactly match attempt ULIDs: ${validation.attempt.ordinal}`);
    }
    validation.actualEntries.add(ulid);
  }
}

function validateOffer(
  offer: Offer,
  attempt: AttemptContext,
  observation: ContractsObservation,
): void {
  if (!offer || typeof offer !== "object" || !Array.isArray(offer.facts) || offer.facts.length === 0) {
    throw new TypeError("offer requires nonempty facts");
  }
  const expectedEntries = new Set(attempt.entryUlids);
  const actualEntries = new Set<EntryUlid>();
  const appendedContracts = new Set<ContractId>();
  const validation = { attempt, observation, expectedEntries, actualEntries, appendedContracts };
  for (const append of offer.facts) validateOfferAppend(append, validation);
  if (actualEntries.size === 0) throw new TypeError(`offer requires at least one attempt ULID: ${attempt.ordinal}`);
}

function priorFor(
  offer: Offer,
  attempt: AttemptContext,
  observation: ContractsObservation,
): ContractState | null {
  const append = primaryAppend(offer, attempt);
  const observed = observation.contracts.get(append.contractId);
  if (observed === undefined) throw new TypeError("accepted offer contract is missing from its observation");
  return observed.state;
}

function snapshotFor(
  offer: Offer,
  attempt: AttemptContext,
  observation: ContractsObservation,
  head: ContractHead,
): ContractState {
  const append = primaryAppend(offer, attempt);
  const observed = observation.contracts.get(append.contractId);
  if (observed === undefined) throw new TypeError("accepted offer contract is missing from its observation");
  return foldJournal(append.contractId, [...observed.entries, ...append.entries], head);
}

function extendedAttempt(
  base: AttemptContext,
  candidate: AttemptContext,
  usedUlids: Set<EntryUlid>,
): AttemptContext {
  if (!candidate || candidate.ordinal !== base.ordinal || !Array.isArray(candidate.entryUlids)) {
    throw new TypeError("extended attempt context must preserve its ordinal and entries");
  }
  if (candidate.entryUlids.length < base.entryUlids.length) {
    throw new TypeError("extended attempt context cannot remove entry ULIDs");
  }
  for (let index = 0; index < base.entryUlids.length; index += 1) {
    if (candidate.entryUlids[index] !== base.entryUlids[index]) {
      throw new TypeError("extended attempt context must preserve its original entry ULIDs");
    }
  }
  const entryUlids = candidate.entryUlids.map((value) => entryUlid(value));
  for (const ulid of entryUlids.slice(base.entryUlids.length)) {
    if (usedUlids.has(ulid)) throw new TypeError(`entry ULID is not fresh: ${ulid}`);
    usedUlids.add(ulid);
  }
  return { ordinal: candidate.ordinal, entryUlids };
}

function accepted(
  offer: Offer,
  prior: ContractState | null,
  snapshot: ContractState,
): ProtocolAccepted {
  return {
    kind: "accepted",
    receipt: {
      facts: offerEntries(offer),
      prior,
      snapshot,
    },
  };
}

/** Run bounded, verb-neutral admission retries and return receipt facts after acceptance. */
export function runProtocol<Input, Refusal>(input: RunProtocolInput<Input, Refusal>): ProtocolResult<Refusal> {
  const attempts = validatedAttempts(input.attempts);
  const usedUlids = new Set(attempts.flatMap((attempt) => attempt.entryUlids));
  const contracts = watchedContracts(input.contracts);
  const observe = input.observe ?? observeContracts;
  let lastAdmission: Admission | null = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const baseAttempt = attempts[index]!;
    const observation = observe(input.repository, contracts);
    const attempt = input.extendAttempt === undefined
      ? baseAttempt
      : extendedAttempt(baseAttempt, input.extendAttempt(baseAttempt, observation.contracts.size + 2), usedUlids);
    const decision = input.decide({ input: input.input, attempt, observation });
    if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };

    const offer = decision.offer;
    validateOffer(offer, attempt, observation);
    let reusedUnknownOffer = false;
    while (true) {
      const admission = admit(input.repository, offer);
      lastAdmission = admission;
      if (admission.kind === "accepted") {
        const append = primaryAppend(offer, attempt);
        const head = admission.heads[append.contractId];
        if (head === undefined) throw new TypeError(`accepted offer is missing its new head: ${append.contractId}`);
        return accepted(offer, priorFor(offer, attempt, observation), snapshotFor(offer, attempt, observation, head));
      }
      if (admission.kind === "ref-moved") return admission;
      if (admission.kind !== "unknown") break;

      const recovered = observe(input.repository, contracts);
      const classification = classifyUnknownAttempt(recovered, offer);
      if (classification.kind === "accepted") {
        const append = primaryAppend(offer, attempt);
        const head = admission.proposedHeads[append.contractId];
        if (head === undefined) throw new TypeError(`unknown offer is missing its proposed head: ${append.contractId}`);
        return accepted(offer, priorFor(offer, attempt, observation), snapshotFor(offer, attempt, observation, head));
      }
      if (classification.kind === "collision") {
        if (index + 1 === attempts.length) return classification;
        break;
      }
      if (classification.kind === "redecide" || reusedUnknownOffer) break;
      reusedUnknownOffer = true;
    }
  }
  return { kind: "exhausted", admission: lastAdmission };
}
