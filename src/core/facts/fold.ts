import type {
  AmendEntry,
  BindEntry,
  ContractBody,
  ContractState,
  JournalEntry,
  SectionRevision,
} from "./types.js";

function foldError(message: string): never {
  throw new Error(`invalid journal fold: ${message}`);
}

function appendText(current: string, addition: string): string {
  return current.length === 0 ? addition : `${current}\n\n${addition}`;
}

function applyRevision(body: ContractBody, revision: SectionRevision): ContractBody {
  if (typeof revision.target === "string") {
    if (revision.op === "add") foldError(`cannot add built-in section '${revision.target}'`);
    const value = revision.op === "replace"
      ? revision.body
      : appendText(body[revision.target], revision.body);
    return { ...body, [revision.target]: value };
  }

  const title = revision.target.extension;
  const index = body.extensions.findIndex((extension) => extension.title === title);
  if (revision.op === "add") {
    if (index !== -1) foldError(`extension '${title}' already exists`);
    return { ...body, extensions: [...body.extensions, { title, content: revision.body }] };
  }
  if (index === -1) foldError(`extension '${title}' does not exist`);
  const extensions = body.extensions.map((extension, extensionIndex) => extensionIndex === index
    ? { ...extension, content: revision.op === "replace" ? revision.body : appendText(extension.content, revision.body) }
    : extension);
  return { ...body, extensions };
}

function applyAmend(body: ContractBody, entry: AmendEntry): ContractBody {
  let next = body;
  for (const revision of entry.data.revisions ?? []) next = applyRevision(next, revision);
  if (entry.data.region !== undefined) next = { ...next, region: [...entry.data.region] };
  if (entry.data.criteriaDelta && "add" in entry.data.criteriaDelta) {
    next = { ...next, criteria: [...next.criteria, ...entry.data.criteriaDelta.add] };
  }
  if (entry.data.criteriaDelta && "replace" in entry.data.criteriaDelta) {
    next = { ...next, criteria: [...entry.data.criteriaDelta.replace] };
  }
  if (entry.data.verificationDelta !== undefined) {
    next = { ...next, verification: [...entry.data.verificationDelta.replace] };
  }
  return next;
}

function initialState(id: ContractState["id"], head: ContractState["head"] = null): ContractState {
  return {
    id,
    head,
    phase: "active",
    body: null,
    delivery: null,
    petition: null,
    evidence: [],
    terminal: null,
  };
}

function requireBound(state: ContractState): ContractBody {
  if (state.body === null) foldError("journal must begin with bind");
  return state.body;
}

function refuse(state: ContractState, entry: JournalEntry): never {
  foldError(`${state.phase} cannot accept ${entry.kind}`);
}

function appendEvidence(state: ContractState, entry: JournalEntry): ContractState {
  if (entry.kind !== "review" && entry.kind !== "check" && entry.kind !== "verification") return state;
  return { ...state, evidence: [...state.evidence, entry] };
}

/** Fold one accepted journal fact without resolving Git or evidence objects. */
export function foldEntry(state: ContractState, entry: JournalEntry): ContractState {
  if (entry.contract !== state.id) foldError(`entry belongs to ${entry.contract}, not ${state.id}`);
  if (state.body === null && entry.kind !== "bind") foldError("journal must begin with bind");
  if (state.body !== null && entry.kind === "bind") foldError("bind may appear only once");

  let next = appendEvidence(state, entry);
  switch (entry.kind) {
    case "bind":
      return { ...next, body: { ...entry.data, region: [...entry.data.region], criteria: [...entry.data.criteria], verification: [...entry.data.verification], extensions: [...entry.data.extensions] } };
    case "amend":
      if (next.phase !== "active" && next.phase !== "awaiting-verdict" && next.phase !== "approved") refuse(next, entry);
      return { ...next, body: applyAmend(requireBound(next), entry), phase: "active", petition: null };
    case "seal":
      if (next.phase !== "active") refuse(next, entry);
      return { ...next, phase: "sealed" };
    case "renew":
      if (next.phase !== "sealed") refuse(next, entry);
      if (next.delivery !== null && entry.data.oldHead !== next.delivery.head) {
        foldError(`renew old head ${entry.data.oldHead} does not match current delivery head ${next.delivery.head}`);
      }
      return {
        ...next,
        phase: "active",
        delivery: { base: entry.data.oldHead, head: entry.data.newHead },
      };
    case "petition":
      if (next.phase !== "sealed") refuse(next, entry);
      return { ...next, phase: "awaiting-verdict", petition: entry };
    case "review":
      if (next.phase === "awaiting-verdict") {
        return entry.data.verdict === "approved"
          ? { ...next, phase: "approved" }
          : { ...next, phase: "active", petition: null };
      }
      return next;
    case "check":
    case "verification":
      return next;
    case "claim":
      if (next.phase !== "approved") refuse(next, entry);
      if (next.petition?.data.intent !== "claim" || next.petition.entry !== entry.data.petition) {
        foldError("claim must name the current claim petition");
      }
      return { ...next, phase: "claimed", petition: null, terminal: entry };
    case "forfeit":
      if (next.phase === "active" || next.phase === "sealed") {
        return { ...next, phase: "forfeited", petition: null, terminal: entry };
      }
      if (next.phase === "approved" && next.petition?.data.intent === "forfeit") {
        return { ...next, phase: "forfeited", petition: null, terminal: entry };
      }
      refuse(next, entry);
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

/** The bind body plus ordered amend facts is the canonical effective contract body. */
export function effectiveBody(state: ContractState): ContractBody {
  return requireBound(state);
}

export function foldEffectiveBody(entries: readonly JournalEntry[]): ContractBody {
  if (entries.length === 0 || entries[0]?.kind !== "bind") foldError("journal must begin with bind");
  return effectiveBody(foldJournal(entries[0].contract, entries));
}
