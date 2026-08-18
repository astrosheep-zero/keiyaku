import type {
  ArcEntry,
  AttestationEntry,
  ContractTerms,
  ContractCoordinates,
  ContractState,
  BindEntry,
  JournalEntry,
} from "./types.js";
import { gatesSatisfied } from "./gate.js";
import { AuthorityCorruptionError } from "./errors.js";

function foldError(message: string): never {
  throw new AuthorityCorruptionError(`invalid journal fold: ${message}`);
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

function stateFromBind(
  id: ContractState["id"],
  head: ContractState["head"],
  bind: BindEntry,
  attestations: AttestationEntry[],
): ContractState {
  if (bind.contract !== id) foldError(`entry belongs to ${bind.contract}, not ${id}`);
  return {
    id,
    head,
    coordinates: cloneCoordinates(bind.data.coordinates),
    terms: cloneTerms(bind.data.terms),
    bound: null,
    delivery: null,
    currentIntegration: null,
    attestations,
    terminal: null,
  };
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

function foldEntry(
  state: ContractState,
  entry: JournalEntry,
  attestations: AttestationEntry[],
): ContractState {
  if (entry.contract !== state.id) foldError(`entry belongs to ${entry.contract}, not ${state.id}`);
  requireActive(state, entry);

  switch (entry.kind) {
    case "bind":
      foldError("bind may appear only once");
    case "amend":
      return { ...state, terms: cloneTerms(entry.data) };
    case "bound":
      if (state.bound !== null) foldError("bound may appear only once");
      return { ...state, bound: entry };
    case "deliver":
      if (state.bound === null) foldError("deliver requires bound");
      return { ...state, delivery: entry, currentIntegration: { ...entry.data.integration } };
    case "reintegrated":
      if (state.delivery === null) foldError("reintegrated requires a deliver");
      return {
        ...state,
        currentIntegration: {
          predecessor: entry.data.predecessor,
          snapshot: entry.data.snapshot,
          changeId: state.delivery.data.integration.changeId,
        },
      };
    case "attestation":
      attestations.push(entry);
      return { ...state, attestations };
    case "claimed":
      if (state.delivery === null) foldError("claimed requires a deliver");
      if (entry.data.delivery !== state.delivery.entry) foldError("claimed must name the current deliver");
      if (!gatesSatisfied(state)) foldError("claimed gates are not satisfied");
      return { ...state, terminal: entry };
    case "arc":
      return foldArc(state, entry);
    case "abandoned":
      return { ...state, terminal: entry };
  }
}

export function foldJournal(
  id: ContractState["id"],
  entries: readonly JournalEntry[],
  head: ContractState["head"] = null,
): ContractState {
  const first = entries[0];
  if (first === undefined || first.kind !== "bind") foldError("journal must begin with bind");
  const seen = new Set<string>();
  const attestations: AttestationEntry[] = [];
  seen.add(first.entry);
  let state = stateFromBind(id, head, first, attestations);
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (seen.has(entry.entry)) foldError(`duplicate entry ${entry.entry}`);
    seen.add(entry.entry);
    state = foldEntry(state, entry, attestations);
  }
  return state;
}
