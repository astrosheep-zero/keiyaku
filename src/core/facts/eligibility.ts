import type { ContractJournalAppend, Offer } from "./offer.js";
import type { ContractHead, ContractId, EntryUlid, ContractTerms, JournalEntry } from "./types.js";

type EligibilityObservation = Readonly<{
  contracts: ReadonlyMap<ContractId, Readonly<{
    id: ContractId;
    state: Readonly<{
      head: ContractHead | null;
      bound: JournalEntry | null;
      terminal: JournalEntry | null;
      terms: ContractTerms | null;
    }> | null;
  }>>;
}>;

type EligibilityAttempt = Readonly<{ entryUlids: readonly EntryUlid[] }>;

export function samePrerequisites(
  left: readonly ContractId[] | undefined,
  right: readonly ContractId[] | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

function entries(offer: Offer): readonly JournalEntry[] {
  return offer.facts.flatMap((append) => append.entries);
}

function canChangeEligibility(offer: Offer): boolean {
  return entries(offer).some((entry) => entry.kind === "bind" || entry.kind === "amend" || entry.kind === "claimed");
}

function offeredTerms(offer: Offer, id: ContractId, fallback: ContractTerms | null): ContractTerms | null {
  const append = offer.facts.find((candidate) => candidate.contractId === id);
  if (append === undefined) return fallback;
  for (let index = append.entries.length - 1; index >= 0; index -= 1) {
    const entry = append.entries[index]!;
    if (entry.kind === "amend") return entry.data;
    if (entry.kind === "bind") return entry.data.terms;
  }
  return fallback;
}

/**
 * Append newly eligible bound facts for an explicitly eligibility-changing
 * offer. The protocol runner never calls this implicitly.
 */
export function placeEligibleBounds(
  offer: Offer,
  observation: EligibilityObservation,
  attempt: EligibilityAttempt,
): Offer {
  if (!canChangeEligibility(offer)) return offer;

  const offeredEntries = entries(offer);
  const claimed = new Set(offeredEntries.filter((entry) => entry.kind === "claimed").map((entry) => entry.contract));
  const envelope = offeredEntries[0];
  if (!envelope) return offer;
  const used = new Set(offeredEntries.map((entry) => entry.entry));
  const available = attempt.entryUlids.filter((entry) => !used.has(entry));
  const additions: ContractJournalAppend[] = [];
  const replacements = new Map<ContractId, ContractJournalAppend>();

  for (const [id, observed] of observation.contracts) {
    const state = observed.state;
    if (!state || state.bound || state.terminal) continue;
    const append = offer.facts.find((candidate) => candidate.contractId === id);
    if (append?.entries.some((entry) => entry.kind === "bound")) continue;
    const prerequisites = offeredTerms(offer, id, state.terms)?.after ?? [];
    const eligible = prerequisites.every((dependency) => {
      const dependencyState = observation.contracts.get(dependency)?.state;
      return dependencyState?.terminal?.kind === "claimed" || claimed.has(dependency);
    });
    if (!eligible) continue;
    const entry = available.shift();
    if (!entry) throw new TypeError("attempt context needs an entry ULID for every eligible bound placement");
    const bound: JournalEntry = {
      v: 1,
      kind: "bound",
      contract: id,
      entry,
      at: envelope.at,
      ...(envelope.actor === undefined ? {} : { actor: envelope.actor }),
      data: {},
    };
    if (append === undefined) {
      additions.push({ contractId: id, expectedHead: state.head, entries: [bound] });
    } else {
      replacements.set(id, { ...append, entries: [...append.entries, bound] });
    }
  }
  if (additions.length === 0 && replacements.size === 0) return offer;
  return {
    ...offer,
    facts: [
      ...additions,
      ...offer.facts.map((append) => replacements.get(append.contractId) ?? append),
    ],
  };
}
