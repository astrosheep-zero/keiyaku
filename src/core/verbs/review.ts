import type { DecideInput, OfferDecision } from "../decide.js";
import type { ContractId, JournalEntry, ReviewData } from "../facts/types.js";
import { contractId, entryUlid } from "../facts/types.js";
export type ReviewInput = Readonly<{ contractId: ContractId; actor?: string; at: string; data: ReviewData }>;
export type ReviewRefusal = Readonly<{ kind: "contract-missing" | "delivery-missing" | "terminal" | "stale-tender"; contractId: ContractId }>;
export function decideReview({ input, attempt, observation }: DecideInput<ReviewInput>): OfferDecision<null, ReviewRefusal> {
  const id = contractId(input.contractId); const current = observation.contracts.get(id);
  if (!current?.state) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (current.state.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };
  const delivery = current.state.delivery;
  if (!delivery) return { kind: "refused", refusal: { kind: "delivery-missing", contractId: id } };
  if (input.data.reviewedPatchId !== delivery.data.deliveryPatchId || input.data.reviewedHead !== delivery.data.candidate) {
    return { kind: "refused", refusal: { kind: "stale-tender", contractId: id } };
  }
  const review: JournalEntry = { v: 1, kind: "review", contract: id, entry: entryUlid(attempt.entryUlids[0]!), at: input.at, ...(input.actor === undefined ? {} : { actor: input.actor }), data: input.data };
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current.state.head, entries: [review] }] }, handoff: null };
}
