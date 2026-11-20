export { entryUlidSchema } from "./result-leaves.js";
import type { ProtocolProgress } from "./progress.js";
import { randomBytes } from "node:crypto";
import { encodeEntry } from "../core/facts/codec.js";
import { admit, type PublicationFailed } from "../git/admission.js";
import { contractJournal, observeContractsAt, type ContractReadView } from "../git/observe.js";
import {
  confirmPrivateStatePublication,
  type PrivateStatePublicationSeat,
  type PrivateStateSeatCloseLag,
} from "../git/private-state-seat.js";
import { withGitDecodeChannel, type GitDecodeChannel } from "../git/read-observation.js";
import { GIT_REF, readRefs, type GitRefAssertion, type GitRefUpdate } from "../git/repository.js";
import { targetRef } from "../git/target.js";
import type { GitRepository } from "../git/process.js";
import type { AttemptContext } from "../core/decide.js";
import { foldJournal } from "../core/facts/fold.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ContractJournalAppend, Offer } from "../core/facts/offer.js";
import {
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

function mintEntryUlids(count: number): readonly EntryUlid[] {
  return Array.from({ length: count }, nextEntryUlid);
}

export function mintAttempts(input: Readonly<{ entryCount: number }>): readonly AttemptContext[] {
  return Array.from({ length: MAX_SEMANTIC_ATTEMPTS }, () => ({
    entryUlids: mintEntryUlids(input.entryCount),
  }));
}

export type AcceptedAdmission = Readonly<{
  kind: "accepted";
  facts: readonly JournalEntry[];
  state: ContractState;
  journal: readonly JournalEntry[];
  seatClose?: readonly PrivateStateSeatCloseLag[];
}>;

export type AttemptTerminal = Readonly<{ kind: "collision" }> | PublicationFailed;
export type DecidedOfferResult<Refusal = never> =
  | AcceptedAdmission
  | AttemptTerminal
  | Readonly<{ kind: "stale" }>
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

async function publicationPremiseMoved(
  repository: GitRepository,
  observation: ContractReadView,
  offer: Offer,
  assertions: readonly GitRefAssertion[],
): Promise<boolean> {
  const crossWorktree =
    (offer.target !== undefined && typeof offer.target.target !== "string") ||
    assertions.some((assertion) => assertion.ref.startsWith("worktrees/"));
  const stable = crossWorktree ? { ...repository, effectiveCwd: repository.primaryWorktree } : repository;
  const refs = await readRefs(stable, [
    GIT_REF,
    ...assertions.map((assertion) => assertion.ref),
    ...(offer.target === undefined ? [] : [targetRef(offer.target.target)]),
  ]);
  if (refs.get(GIT_REF) !== observation.epoch.commit) return true;
  for (const assertion of assertions) if (refs.get(assertion.ref) !== assertion.oid) return true;
  return offer.target !== undefined && refs.get(targetRef(offer.target.target)) !== offer.target.expectedOid;
}

export type PrepareRefCompanion<Refusal> = (
  observation: ContractReadView,
) => Promise<Readonly<{ kind: "companion"; update: GitRefUpdate }> | Readonly<{ kind: "refused"; refusal: Refusal }>>;

/** Admit one decided offer without making another legal decision. */
export async function admitDecidedOffer<Refusal = never>(
  input: Readonly<{
    scope: GitRepository;
    channel: GitDecodeChannel;
    contractId: ContractId;
    seat: PrivateStatePublicationSeat;
    observation: ContractReadView;
    attempt: AttemptContext;
    offer: Offer;
    assertions?: readonly GitRefAssertion[];
    prepareRefCompanion?: PrepareRefCompanion<Refusal>;
    validateAdmission?: (observation: ContractReadView) => Refusal | undefined | Promise<Refusal | undefined>;
    progress?: ProtocolProgress;
  }>,
): Promise<DecidedOfferResult<Refusal>> {
  const { seat, observation: decisionObservation, attempt, offer, contractId: primaryContract } = input;
  const repository = input.scope;
  const assertions = input.assertions ?? [];
  validateOffer(offer, attempt);
  const primary = primaryAppend(offer, primaryContract);
  if (input.validateAdmission !== undefined) {
    const refusal = await input.validateAdmission(decisionObservation);
    if (refusal !== undefined) return { kind: "refused", refusal };
  }
  const companion = await input.prepareRefCompanion?.(decisionObservation);
  if (companion?.kind === "refused") return companion;
  const admission = await admit(repository, offer, decisionObservation, assertions, companion?.update);
  if (admission.kind === "accepted") {
    confirmPrivateStatePublication(seat);
    input.progress?.recordPublication(primaryContract, admission.heads[primary.contractId]!, offerEntries(offer));
    const journal = [...contractJournal(decisionObservation.journals, primaryContract).entries, ...primary.entries];
    const accepted: AcceptedAdmission = {
      kind: "accepted",
      facts: offerEntries(offer),
      state: foldJournal(primary.contractId, journal, admission.heads[primary.contractId]!),
      journal,
    };
    input.progress?.recordAdmission(accepted);
    return accepted;
  }
  if (admission.kind === "publication-failed") {
    return (await publicationPremiseMoved(repository, decisionObservation, offer, assertions))
      ? { kind: "redecide" }
      : admission;
  }
  const recoveryRepository = { ...repository, signal: AbortSignal.timeout(5_000) };
  const recovered = await withGitDecodeChannel(recoveryRepository, async (recoveryChannel) =>
    observeContractsAt(
      recoveryRepository,
      recoveryChannel,
      offer.facts.map((append) => append.contractId),
    ),
  );
  const recoveredKind = classifyUnknownAttempt(recovered.journals, offer);
  if (recoveredKind !== "accepted") return { kind: recoveredKind };
  const { state, entries } = contractJournal(recovered.journals, primaryContract);
  if (state === null) throw new Error(`recovered offer is missing its primary contract: ${primaryContract}`);
  confirmPrivateStatePublication(seat);
  const accepted: AcceptedAdmission = { kind: "accepted", facts: offerEntries(offer), state, journal: entries };
  input.progress?.recordAdmission(accepted);
  return accepted;
}

/** Classify an unknown atomic-publication outcome using only a captured Git observation. */
function classifyUnknownAttempt(
  journals: ContractReadView["journals"],
  offer: Offer,
): "accepted" | "collision" | "redecide" {
  let exact = 0;
  let missing = 0;

  for (const append of offer.facts) {
    const record = contractJournal(journals, append.contractId);
    const lines = record.state === null ? [] : record.bytes.toString("utf8").split("\n");
    const entries = new Map(record.entries.map(({ entry }, index) => [entry, lines[index]!]));
    for (const planned of append.entries) {
      const observed = entries.get(planned.entry);
      if (observed === undefined) missing += 1;
      else if (`${observed}\n` !== encodeEntry(planned)) return "collision";
      else exact += 1;
    }
  }

  if (missing === 0) return "accepted";
  if (exact !== 0) throw new AuthorityCorruptionError("partial unknown attempt match is corrupted authority");
  return "redecide";
}
