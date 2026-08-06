import type { DecideInput, OfferDecision } from "../decide.js";
import type { AbandonData, ActorId, ContractId, JournalEntry, SnapshotId } from "../facts/types.js";
import { contractId, entryUlid } from "../facts/types.js";
export type AbandonInput = Readonly<{ contractId: ContractId; actor?: ActorId; at: string; data: AbandonData; finalHead: SnapshotId | null }>;
export type AbandonRefusal = Readonly<{ kind: "contract-missing" | "terminal"; contractId: ContractId }>;
export function decideAbandon({ input, attempt, observation }: DecideInput<AbandonInput>): OfferDecision<null, AbandonRefusal> {
  const id = contractId(input.contractId); const current = observation.contracts.get(id);
  if (!current?.state) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (current.state.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };
  const abandon: JournalEntry = { v: 1, kind: "abandon", contract: id, entry: entryUlid(attempt.entryUlids[0]!), at: input.at, ...(input.actor === undefined ? {} : { actor: input.actor }), data: input.data };
  const abandoned: JournalEntry = { v: 1, kind: "abandoned", contract: id, entry: entryUlid(attempt.entryUlids[1]!), at: input.at, ...(input.actor === undefined ? {} : { actor: input.actor }), data: { finalHead: input.finalHead } };
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current.state.head, entries: [abandon, abandoned] }] }, handoff: null };
}
