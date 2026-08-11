import { randomBytes } from "node:crypto";
import { encodeEntry } from "../core/facts/codec.js";
import { admit, type PublicationFailed } from "../git/admission.js";
import { observeContracts, type GitDecisionObservation } from "../git/observe.js";
import { GIT_REF, readRef, type GitRepository } from "../git/repository.js";
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
export type DecidedOfferResult = AcceptedAdmission | AttemptTerminal | Readonly<{ kind: "redecide" }>;

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
  observation: ReturnType<typeof observeContracts>,
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

function publicationPremiseMoved(
  repository: GitRepository,
  observation: GitDecisionObservation,
  offer: Offer,
): boolean {
  if (readRef(repository, GIT_REF) !== observation.admission.snapshot.commit) return true;
  return offer.target !== undefined
    && readRef(repository, offer.target.target) !== offer.target.expectedOid;
}

/** Admit one decided offer without making another legal decision. */
export function admitDecidedOffer(
  repository: GitRepository,
  decisionObservation: GitDecisionObservation,
  attempt: AttemptContext,
  offer: Offer,
  primaryContract: ContractId,
): DecidedOfferResult {
  validateOffer(offer, attempt);
  const primary = primaryAppend(offer, primaryContract);
  const admission = admit(repository, offer, decisionObservation.admission);
  if (admission.kind === "accepted") {
    return {
      kind: "accepted",
      facts: offerEntries(offer),
      state: snapshotFor(primary, decisionObservation.journals, admission.heads[primary.contractId]!),
      journal: journalFor(primary, decisionObservation.journals),
    };
  }
  if (admission.kind === "publication-failed") {
    return publicationPremiseMoved(repository, decisionObservation, offer)
      ? { kind: "redecide" }
      : admission;
  }
  const recovered = observeContracts(repository, offer.facts.map((append) => append.contractId));
  const classification = classifyUnknownAttempt(recovered, offer);
  if (classification.kind === "accepted") return recoveredAcceptance(recovered, offer, primaryContract);
  return classification.kind === "collision" ? { kind: "collision" } : { kind: "redecide" };
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
