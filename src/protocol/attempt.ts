import { encodeEntry } from "../core/facts/codec.js";
import type { Offer } from "../core/facts/offer.js";
import {
  contractHead,
  contractId,
  type ContractHead,
  type ContractId,
  type JournalEntry,
} from "../core/facts/types.js";
import type { ContractsObservation } from "../core/facts/observation.js";

export type UnknownAttemptClassification =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "retry-offer" }>
  | Readonly<{ kind: "redecide" }>
  | Readonly<{
    kind: "collision";
    contractId: ContractId;
    planned: JournalEntry;
    observed: JournalEntry;
    plannedBytes: string;
    observedBytes: string;
  }>;

type PlannedEntry = Readonly<{
  entry: JournalEntry;
  bytes: string;
}>;

type PlannedFactGroup = Readonly<{
  contractId: ContractId;
  expectedHead: ContractHead | null;
  entries: readonly PlannedEntry[];
}>;

function validatedFacts(offer: Offer): readonly PlannedFactGroup[] {
  if (!offer || typeof offer !== "object" || !Array.isArray(offer.facts) || offer.facts.length === 0) {
    throw new TypeError("unknown attempt requires nonempty facts");
  }
  const contracts = new Set<ContractId>();
  const entries = new Set<string>();
  return offer.facts.map((append) => {
    if (!append || typeof append !== "object") throw new TypeError("invalid contract append");
    const id = contractId(append.contractId);
    if (contracts.has(id)) throw new TypeError(`duplicate contract append: ${id}`);
    contracts.add(id);
    if (append.expectedHead === undefined) throw new TypeError(`unknown attempt requires explicit expected head: ${id}`);
    const expectedHead = append.expectedHead === null ? null : contractHead(append.expectedHead);
    if (!Array.isArray(append.entries) || append.entries.length === 0) {
      throw new TypeError(`unknown attempt requires planned entries: ${id}`);
    }
    const planned = append.entries.map((entry: JournalEntry) => {
      const bytes = encodeEntry(entry);
      if (entry.contract !== id) throw new TypeError(`journal entry contract does not match append: ${id}`);
      if (entries.has(entry.entry)) throw new TypeError(`duplicate planned entry ULID: ${entry.entry}`);
      entries.add(entry.entry);
      return { entry, bytes };
    });
    return { contractId: id, expectedHead, entries: planned };
  });
}

/** Classify an unknown atomic-publication outcome using only a captured carrier observation. */
export function classifyUnknownAttempt(
  observation: ContractsObservation,
  offer: Offer,
): UnknownAttemptClassification {
  const appends = validatedFacts(offer);
  let exact = 0;
  let missing = 0;
  let headsUnchanged = true;

  for (const append of appends) {
    const contract = observation.contracts.get(append.contractId);
    if (contract === undefined) throw new TypeError(`missing contract observation: ${append.contractId}`);
    if ((contract.state?.head ?? null) !== append.expectedHead) headsUnchanged = false;
    const entries = new Map(contract.entries.map((entry) => [entry.entry, entry]));
    for (const planned of append.entries) {
      const observed = entries.get(planned.entry.entry);
      if (observed === undefined) {
        missing += 1;
        continue;
      }
      const observedBytes = encodeEntry(observed);
      if (planned.bytes !== observedBytes) {
        return {
          kind: "collision",
          contractId: append.contractId,
          planned: planned.entry,
          observed,
          plannedBytes: planned.bytes,
          observedBytes,
        };
      }
      exact += 1;
    }
  }

  if (missing === 0) return { kind: "accepted" };
  if (exact !== 0) throw new TypeError("partial unknown attempt match is corrupted authority");
  return headsUnchanged ? { kind: "retry-offer" } : { kind: "redecide" };
}
