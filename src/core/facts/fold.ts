import type {
  ArcEntry,
  ContractTerms,
  ContractCoordinates,
  ContractState,
  JournalEntry,
} from "./types.js";
import { samePrerequisites } from "./eligibility.js";
import { gatesSatisfied } from "./gate.js";

function foldError(message: string): never {
  throw new Error(`invalid journal fold: ${message}`);
}

function cloneTerms(terms: ContractTerms): ContractTerms {
  return {
    document: { ...terms.document },
    segments: [...terms.segments],
    gates: [...terms.gates],
    after: [...terms.after],
  };
}

function cloneCoordinates(coordinates: ContractCoordinates): ContractCoordinates {
  return { ...coordinates };
}

function initialState(id: ContractState["id"], head: ContractState["head"] = null): ContractState {
  return {
    id,
    head,
    coordinates: null,
    terms: null,
    bound: null,
    delivery: null,
    attestations: [],
    abandon: null,
    terminal: null,
  };
}

function requireTerms(state: ContractState): ContractTerms {
  if (state.terms === null) foldError("journal must begin with bind");
  return state.terms;
}

function requireActive(state: ContractState, entry: JournalEntry): void {
  if (state.terminal !== null) foldError(`terminal contract cannot accept ${entry.kind}`);
}

function foldArc(state: ContractState, entry: ArcEntry): ContractState {
  const expectedSequence = (state.currentArc?.data.seq ?? 0) + 1;
  if (entry.data.seq !== expectedSequence) {
    foldError(`arc sequence must be ${expectedSequence}`);
  }
  return { ...state, currentArc: entry };
}

/** Fold one accepted journal fact. */
function foldEntry(state: ContractState, entry: JournalEntry): ContractState {
  if (entry.contract !== state.id) foldError(`entry belongs to ${entry.contract}, not ${state.id}`);
  if (state.terms === null && entry.kind !== "bind") foldError("journal must begin with bind");
  if (state.terms !== null && entry.kind === "bind") foldError("bind may appear only once");
  requireActive(state, entry);

  switch (entry.kind) {
    case "bind":
      return {
        ...state,
        coordinates: cloneCoordinates(entry.data.coordinates),
        terms: cloneTerms(entry.data.terms),
      };
    case "amend": {
      const previous = requireTerms(state);
      if (state.bound !== null && !samePrerequisites(previous.after, entry.data.after)) {
        foldError("cannot change after once prerequisites are consumed");
      }
      return { ...state, terms: cloneTerms(entry.data) };
    }
    case "bound":
      if (state.bound !== null) foldError("bound may appear only once");
      return { ...state, bound: entry };
    case "deliver":
      if (state.bound === null) foldError("deliver requires bound");
      return { ...state, delivery: entry };
    case "attestation":
      if (state.delivery === null) foldError("attestation requires a deliver");
      if (state.terms === null || !state.terms.gates.includes(entry.data.gate)) foldError("attestation gate must be declared");
      return { ...state, attestations: [...state.attestations, entry] };
    case "claimed":
      if (state.delivery === null) foldError("claimed requires a deliver");
      if (entry.data.delivery !== state.delivery.entry) foldError("claimed must name the current deliver");
      if (!gatesSatisfied(state)) foldError("claimed gates are not satisfied");
      return { ...state, terminal: entry };
    case "arc":
      return foldArc(state, entry);
    case "abandon":
      if (state.abandon !== null) foldError("abandon may appear only once");
      return { ...state, abandon: entry };
    case "abandoned":
      if (state.abandon === null) foldError("abandoned requires abandon intent");
      return { ...state, terminal: entry };
  }
}

export function foldJournal(
  id: ContractState["id"],
  entries: readonly JournalEntry[],
  head: ContractState["head"] = null,
): ContractState {
  if (entries.length === 0 || entries[0]?.kind !== "bind") foldError("journal must begin with bind");
  const seen = new Set<string>();
  let state = initialState(id, head);
  for (const entry of entries) {
    if (seen.has(entry.entry)) foldError(`duplicate entry ${entry.entry}`);
    seen.add(entry.entry);
    state = foldEntry(state, entry);
  }
  return state;
}
