import {
  admit,
  type Accepted,
  type Admission,
  type Offer,
  type RefMoved,
} from "../facts/admission.js";
import type { GitRepository } from "../facts/repository.js";
import {
  contractId,
  entryUlid,
  type ContractId,
  type EntryUlid,
  type JournalEntry,
} from "../facts/types.js";
import { classifyUnknownAttempt, type UnknownAttemptClassification } from "./attempt.js";
import { observeContracts, type ContractsObservation } from "./observe.js";

export type AttemptContext = Readonly<{
  ordinal: number;
  entryUlids: readonly EntryUlid[];
}>;

export type DecideInput<Input> = Readonly<{
  input: Input;
  attempt: AttemptContext;
  observation: ContractsObservation;
  collision?: Extract<UnknownAttemptClassification, { kind: "collision" }>;
}>;

export type OfferDecision<Handoff, Refusal> =
  | Readonly<{ kind: "offer"; offer: Offer; handoff: Handoff }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>;

export type ReconcileHandoff<Handoff> = Readonly<{
  handoff: Handoff;
  acceptedEntries: readonly JournalEntry[];
  admission: Accepted | null;
}>;

export type ProtocolTerminal =
  | Readonly<{ kind: "exhausted"; admission: Admission | null }>
  | Readonly<{ kind: "collision"; collision: Extract<UnknownAttemptClassification, { kind: "collision" }> }>
  | RefMoved;

export type ProtocolResult<Handoff, Refusal> =
  | Readonly<{ kind: "handoff"; handoff: ReconcileHandoff<Handoff> }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | ProtocolTerminal;

export type RunProtocolInput<Input, Handoff, Refusal> = Readonly<{
  input: Input;
  repository: GitRepository;
  contracts: readonly ContractId[];
  attempts: readonly AttemptContext[];
  decide: (input: DecideInput<Input>) => OfferDecision<Handoff, Refusal>;
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

function validateOffer(
  offer: Offer,
  attempt: AttemptContext,
  contracts: ReadonlySet<ContractId>,
  observation: ContractsObservation,
): void {
  if (!offer || typeof offer !== "object" || !Array.isArray(offer.facts) || offer.facts.length === 0) {
    throw new TypeError("offer requires nonempty facts");
  }
  const expectedEntries = new Set(attempt.entryUlids);
  const actualEntries = new Set<EntryUlid>();
  const appendedContracts = new Set<ContractId>();
  for (const append of offer.facts) {
    if (!append || typeof append !== "object") throw new TypeError("invalid contract append");
    const id = contractId(append.contractId);
    if (!contracts.has(id)) throw new TypeError(`offer contract is not watched: ${id}`);
    if (appendedContracts.has(id)) throw new TypeError(`duplicate offer contract: ${id}`);
    appendedContracts.add(id);
    if (append.expectedHead === undefined) throw new TypeError(`offer requires explicit expected head: ${id}`);
    const observed = observation.contracts.get(id);
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
      if (!expectedEntries.has(ulid) || actualEntries.has(ulid)) {
        throw new TypeError(`offer entries must exactly match attempt ULIDs: ${attempt.ordinal}`);
      }
      actualEntries.add(ulid);
    }
  }
  if (actualEntries.size !== expectedEntries.size) {
    throw new TypeError(`offer entries must exactly match attempt ULIDs: ${attempt.ordinal}`);
  }
}

function handoff<Handoff>(handoff: Handoff, offer: Offer, admission: Accepted | null): ProtocolResult<Handoff, never> {
  return {
    kind: "handoff",
    handoff: {
      handoff,
      acceptedEntries: offerEntries(offer),
      admission,
    },
  };
}

/** Run bounded, verb-neutral admission retries and return only reconciliation data after acceptance. */
export function runProtocol<Input, Handoff, Refusal>(input: RunProtocolInput<Input, Handoff, Refusal>): ProtocolResult<Handoff, Refusal> {
  const attempts = validatedAttempts(input.attempts);
  const contracts = watchedContracts(input.contracts);
  const contractSet = new Set(contracts);
  let lastAdmission: Admission | null = null;
  let collision: Extract<UnknownAttemptClassification, { kind: "collision" }> | undefined;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const observation = observeContracts(input.repository, contracts);
    const decisionInput: DecideInput<Input> = collision === undefined
      ? { input: input.input, attempt, observation }
      : { input: input.input, attempt, observation, collision };
    collision = undefined;
    const decision = input.decide(decisionInput);
    if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };

    validateOffer(decision.offer, attempt, contractSet, observation);
    let offer = decision.offer;
    let reusedUnknownOffer = false;
    while (true) {
      const admission = admit(input.repository, offer);
      lastAdmission = admission;
      if (admission.kind === "accepted") return handoff(decision.handoff, offer, admission);
      if (admission.kind === "ref-moved") return admission;
      if (admission.kind !== "unknown") break;

      const recovered = observeContracts(input.repository, contracts);
      const classification = classifyUnknownAttempt(recovered, offer);
      if (classification.kind === "accepted") return handoff(decision.handoff, offer, null);
      if (classification.kind === "collision") {
        if (index + 1 === attempts.length) return { kind: "collision", collision: classification };
        collision = classification;
        break;
      }
      if (classification.kind === "redecide" || reusedUnknownOffer) break;
      reusedUnknownOffer = true;
    }
  }
  return { kind: "exhausted", admission: lastAdmission };
}
