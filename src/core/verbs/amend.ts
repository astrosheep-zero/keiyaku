import type { DecideInput, OfferDecision } from "../decide.js";
import { samePrerequisites } from "../facts/eligibility.js";
import type { AmendData, ContractId, JournalEntry } from "../facts/types.js";
import { contractId, entryUlid } from "../facts/types.js";
export type AmendInput = Readonly<{ contractId: ContractId; actor?: string; at: string; data: AmendData }>;
export type AmendRefusal = Readonly<{
  kind: "contract-missing" | "terminal" | "invalid-after" | "prerequisites-already-consumed";
  contractId: ContractId;
}>;
export function decideAmend({ input, attempt, observation }: DecideInput<AmendInput>): OfferDecision<null, AmendRefusal> {
  const id = contractId(input.contractId); const current = observation.contracts.get(id);
  if (!current?.state) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (current.state.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };
  if (input.data.after?.includes(id)) return { kind: "refused", refusal: { kind: "invalid-after", contractId: id } };
  if (current.state.bound !== null && !samePrerequisites(current.state.body?.after, input.data.after)) {
    return { kind: "refused", refusal: { kind: "prerequisites-already-consumed", contractId: id } };
  }
  const entry: JournalEntry = { v: 1, kind: "amend", contract: id, entry: entryUlid(attempt.entryUlids[0]!), at: input.at, ...(input.actor === undefined ? {} : { actor: input.actor }), data: input.data };
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current.state.head, entries: [entry] }] }, handoff: null };
}
