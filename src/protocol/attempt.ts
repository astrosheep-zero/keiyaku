import { randomBytes } from "node:crypto";
import { encodeEntry } from "../core/facts/codec.js";
import { admit, type PublicationFailed } from "../git/admission.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import { confirmPrivateStatePublication, type PrivateStatePublicationSeat } from "../git/private-state-seat.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { GIT_REF, readRefs, type GitRefAssertion } from "../git/repository.js";
import type { GitRepository } from "../git/process.js";
import type { AttemptContext } from "../core/decide.js";
import { foldJournal } from "../core/facts/fold.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractJournalAppend, Offer } from "../core/facts/offer.js";
import {
  type ContractHead,
  type ContractId,
  type ContractState,
  type EntryUlid,
  type JournalEntry,
  entryUlid,
} from "../core/facts/types.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_SEMANTIC_ATTEMPTS = 3;

function nextEntryUlid(): EntryUlid {
  let value = "";
  let time = BigInt(Date.now());
  for (let index = 0; index < 10; index += 1) {
    value = ALPHABET[Number(time & 31n)]! + value;
    time >>= 5n;
  }
  let random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  for (let index = 0; index < 16; index += 1) {
    value += ALPHABET[Number(random & 31n)]!;
    random >>= 5n;
  }
  return entryUlid(value);
}

export function mintEntryUlids(count: number): readonly EntryUlid[] {
  return Array.from({ length: count }, nextEntryUlid);
}

export function mintAttempts(input: Readonly<{ entryCount: number }>): readonly AttemptContext[] {
  return Array.from({ length: MAX_SEMANTIC_ATTEMPTS }, () => ({
    entryUlids: mintEntryUlids(input.entryCount),
  }));
}

export type UnknownAttemptClassification =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "redecide" }>
  | Readonly<{
      kind: "collision";
      contractId: ContractId;
      planned: JournalEntry;
      observed: JournalEntry;
      plannedBytes: string;
      observedBytes: string;
    }>;

export type AcceptedAdmission = Readonly<{
  kind: "accepted";
  facts: readonly JournalEntry[];
  state: ContractState;
  journal: readonly JournalEntry[];
}>;

export type AttemptTerminal = Readonly<{ kind: "collision" }> | PublicationFailed;
export type DecidedOfferResult<Refusal = never> =
  | AcceptedAdmission
  | AttemptTerminal
  | Readonly<{ kind: "redecide" }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>;

function offerEntries(offer: Offer): readonly JournalEntry[] {
  return offer.facts.flatMap((append) => append.entries);
}

function primaryAppend(offer: Offer, primary: ContractId): ContractJournalAppend {
  const append = offer.facts.find((candidate) => candidate.contractId === primary);
  if (append === undefined) throw new Error(`offer is missing its primary contract: ${primary}`);
  return append;
}

function validateOffer(offer: Offer, attempt: AttemptContext): void {
  const expectedEntries = new Set(attempt.entryUlids);
  const actualEntries = new Set<EntryUlid>();
  for (const append of offer.facts) {
    for (const entry of append.entries) {
      if (!expectedEntries.has(entry.entry) || actualEntries.has(entry.entry)) {
        throw new Error("offer entries must use distinct ULIDs from the current attempt");
      }
      actualEntries.add(entry.entry);
    }
  }
  if (actualEntries.size === 0) throw new Error("offer requires at least one current-attempt ULID");
}

function snapshotFor(
  append: ContractJournalAppend,
  journals: GitDecisionObservation["journals"],
  head: ContractHead,
): ContractState {
  const record = journals.get(append.contractId);
  if (record === undefined) throw new Error("accepted offer contract is missing from its observation");
  return foldJournal(append.contractId, [...record.entries, ...append.entries], head);
}

function journalFor(
  append: ContractJournalAppend,
  journals: GitDecisionObservation["journals"],
): readonly JournalEntry[] {
  const record = journals.get(append.contractId);
  if (record === undefined) throw new Error("accepted offer contract is missing from its observation");
  return [...record.entries, ...append.entries];
}

function recoveredAcceptance(
  observation: Readonly<{ contracts: GitDecisionObservation["journals"] }>,
  offer: Offer,
  primaryContract: ContractId,
): AcceptedAdmission {
  const record = observation.contracts.get(primaryContract);
  if (record?.state === null || record?.state === undefined) {
    throw new Error(`recovered offer is missing its primary contract: ${primaryContract}`);
  }
  return {
    kind: "accepted",
    facts: offerEntries(offer),
    state: record.state,
    journal: record.entries,
  };
}

async function publicationPremiseMoved(
  repository: GitRepository,
  observation: GitDecisionObservation,
  offer: Offer,
  assertions: readonly GitRefAssertion[],
): Promise<boolean> {
  const refs = await readRefs(repository, [
    GIT_REF,
    ...assertions.map((assertion) => assertion.ref),
    ...(offer.target === undefined ? [] : [offer.target.target]),
  ]);
  if (refs.get(GIT_REF) !== observation.admission.snapshot.commit) return true;
  for (const assertion of assertions) if (refs.get(assertion.ref) !== assertion.oid) return true;
  return offer.target !== undefined && refs.get(offer.target.target) !== offer.target.expectedOid;
}

/** Admit one decided offer without making another legal decision. */
export async function admitDecidedOffer<Refusal = never>(
  input: Readonly<{
    channel: GitDecodeChannel;
    repository: GitRepository;
    seat: PrivateStatePublicationSeat;
    decisionObservation: GitDecisionObservation;
    attempt: AttemptContext;
    offer: Offer;
    primaryContract: ContractId;
    assertions?: readonly GitRefAssertion[];
    validateAdmission?: (observation: GitDecisionObservation) => Refusal | undefined | Promise<Refusal | undefined>;
  }>,
): Promise<DecidedOfferResult<Refusal>> {
  const { channel, repository, decisionObservation, attempt, offer, primaryContract } = input;
  const assertions = input.assertions ?? [];
  validateOffer(offer, attempt);
  const primary = primaryAppend(offer, primaryContract);
  if (input.validateAdmission !== undefined) {
    const refusal = await input.validateAdmission(decisionObservation);
    if (refusal !== undefined) return { kind: "refused", refusal };
  }
  const admission = await admit(repository, offer, decisionObservation.admission, assertions);
  if (admission.kind === "accepted") {
    confirmPrivateStatePublication(input.seat);
    return {
      kind: "accepted",
      facts: offerEntries(offer),
      state: snapshotFor(primary, decisionObservation.journals, admission.heads[primary.contractId]!),
      journal: journalFor(primary, decisionObservation.journals),
    };
  }
  if (admission.kind === "publication-failed") {
    return (await publicationPremiseMoved(repository, decisionObservation, offer, assertions))
      ? { kind: "redecide" }
      : admission;
  }
  const recovered = await observeContractsForAdmissionAt(
    repository,
    channel,
    offer.facts.map((append) => append.contractId),
  );
  const classification = classifyUnknownAttempt({ contracts: recovered.journals }, offer);
  if (classification.kind === "accepted")
    return confirmRecoveredAcceptance(input.seat, { contracts: recovered.journals }, offer, primaryContract);
  return classification.kind === "collision" ? { kind: "collision" } : { kind: "redecide" };
}

function confirmRecoveredAcceptance(
  seat: PrivateStatePublicationSeat,
  observation: Readonly<{ contracts: GitDecisionObservation["journals"] }>,
  offer: Offer,
  primaryContract: ContractId,
): AcceptedAdmission {
  const recovered = recoveredAcceptance(observation, offer, primaryContract);
  confirmPrivateStatePublication(seat);
  return recovered;
}

/** Classify an unknown atomic-publication outcome using only a captured Git observation. */
export function classifyUnknownAttempt(
  observation: Readonly<{ contracts: GitDecisionObservation["journals"] }>,
  offer: Offer,
): UnknownAttemptClassification {
  let exact = 0;
  let missing = 0;

  for (const append of offer.facts) {
    const record = observation.contracts.get(append.contractId);
    if (record === undefined) throw new Error(`missing contract observation: ${append.contractId}`);
    const entries = new Map(record.entries.map((entry) => [entry.entry, entry]));
    for (const planned of append.entries) {
      const plannedBytes = encodeEntry(planned);
      const observed = entries.get(planned.entry);
      if (observed === undefined) {
        missing += 1;
        continue;
      }
      const observedBytes = encodeEntry(observed);
      if (plannedBytes !== observedBytes) {
        return {
          kind: "collision",
          contractId: append.contractId,
          planned,
          observed,
          plannedBytes,
          observedBytes,
        };
      }
      exact += 1;
    }
  }

  if (missing === 0) return { kind: "accepted" };
  if (exact !== 0) throw new AuthorityCorruptionError("partial unknown attempt match is corrupted authority");
  return { kind: "redecide" };
}
