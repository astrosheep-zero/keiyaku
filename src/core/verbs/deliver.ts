import type { DecideInput, OfferDecision } from "../decide.js";
import type { ActorId, ContractId, DeliverData, JournalEntry } from "../facts/types.js";
import { contractId, entryUlid } from "../facts/types.js";
export type DeliverInput = Readonly<{ contractId: ContractId; actor?: ActorId; at: string; data: DeliverData }>;
export type DeliverRefusal = Readonly<{ kind: "contract-missing" | "not-bound" | "terminal"; contractId: ContractId }>;
export function decideDeliver({ input, attempt, observation }: DecideInput<DeliverInput>): OfferDecision<null, DeliverRefusal> {
  const id = contractId(input.contractId); const current = observation.contracts.get(id);
  if (!current?.state) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (!current.state.bound) return { kind: "refused", refusal: { kind: "not-bound", contractId: id } };
  if (current.state.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };
  const data: DeliverData = {
    expectedPredecessor: input.data.expectedPredecessor,
    candidate: input.data.candidate,
    deliveryPatchId: input.data.deliveryPatchId,
  };
  const deliver: JournalEntry = { v: 1, kind: "deliver", contract: id, entry: entryUlid(attempt.entryUlids[0]!), at: input.at, ...(input.actor === undefined ? {} : { actor: input.actor }), data };
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current.state.head, entries: [deliver] }] }, handoff: null };
}
