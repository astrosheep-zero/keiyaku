import type { ContractJournalAppend, Offer } from "./offer.js";
import { contractState, type ContractsObservation } from "./observation.js";
import type { ContractId, EntryUlid } from "./types.js";

type EligibilityObservation = ContractsObservation;

type EligibilityAttempt = Readonly<{ entryUlids: readonly EntryUlid[] }>;

type PrerequisiteStatus = "unknown" | "pending" | "claimed";

/** Resolve prerequisite existence and eligibility from one decision snapshot. */
export function prerequisiteStatus(
  prerequisites: readonly ContractId[],
  observation: EligibilityObservation,
  offeredClaims?: ReadonlySet<ContractId>,
): PrerequisiteStatus {
  let pending = false;
  for (const dependency of prerequisites) {
    const state = contractState(observation, dependency);
    if (state === null) return "unknown";
    if (state.terminal?.kind !== "claimed" && offeredClaims?.has(dependency) !== true) pending = true;
  }
  return pending ? "pending" : "claimed";
}

/** Decide whether resulting prerequisites reach the amended contract. */
export function prerequisitesReach(
  contract: ContractId,
  prerequisites: readonly ContractId[],
  observation: EligibilityObservation,
): boolean {
  const pending = [...prerequisites];
  const visited = new Set<ContractId>();
  while (pending.length > 0) {
    const dependency = pending.pop()!;
    if (dependency === contract) return true;
    if (visited.has(dependency)) continue;
    visited.add(dependency);
    const state = contractState(observation, dependency);
    if (state === null) throw new Error(`absent contract in prerequisite closure: ${dependency}`);
    pending.push(...state.terms.after);
  }
  return false;
}

export function samePrerequisites(
  left: readonly ContractId[],
  right: readonly ContractId[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/** Append bounds made eligible by a claimed offer from its full snapshot. */
export function placeEligibleBounds(
  offer: Offer,
  observation: EligibilityObservation,
  attempt: EligibilityAttempt,
): Offer {
  const claimedEntry = offer.facts[0]?.entries[0];
  if (offer.facts.length !== 1 || offer.facts[0]?.entries.length !== 1 || claimedEntry?.kind !== "claimed") {
    throw new Error("eligible-bound placement requires exactly one claimed fact");
  }
  const claimed = new Set([claimedEntry.contract]);
  const used = new Set([claimedEntry.entry]);
  const available = attempt.entryUlids.filter((entry) => !used.has(entry));
  let availableIndex = 0;
  const additions: ContractJournalAppend[] = [];

  for (const id of observation.keys()) {
    const state = contractState(observation, id);
    if (!state || state.bound || state.terminal) continue;
    if (prerequisiteStatus(state.terms.after, observation, claimed) !== "claimed") continue;
    const entry = available[availableIndex];
    if (entry === undefined) throw new Error("placement attempt lacks an entry ULID for an eligible contract");
    availableIndex += 1;
    additions.push({
      contractId: id,
      expectedHead: state.head,
      entries: [{
        v: 1,
        kind: "bound",
        contract: id,
        entry,
        at: claimedEntry.at,
        ...(claimedEntry.actor === undefined ? {} : { actor: claimedEntry.actor }),
        data: {},
      }],
    });
  }
  return additions.length === 0 ? offer : { ...offer, facts: [...additions, ...offer.facts] };
}
