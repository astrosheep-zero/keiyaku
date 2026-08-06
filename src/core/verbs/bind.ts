import type { DecideInput, OfferDecision } from "../decide.js";
import type { ActorId, BindData, BoundData, ContractBody, ContractId, JournalEntry } from "../facts/types.js";
import { contractId, entryUlid } from "../facts/types.js";

export type BindInput = Readonly<{ contractId: ContractId; actor?: ActorId; at: string; data: BindData }>;
export type BindRefusal = Readonly<{ kind: "contract-exists" | "invalid-after"; contractId: ContractId }>;
export function decideBind({ input, attempt, observation }: DecideInput<BindInput>): OfferDecision<BindRefusal> {
  const id = contractId(input.contractId);
  const current = observation.contracts.get(id);
  if (current?.state) return { kind: "refused", refusal: { kind: "contract-exists", contractId: id } };
  const body: ContractBody = input.data.body;
  if (body.after?.includes(id)) return { kind: "refused", refusal: { kind: "invalid-after", contractId: id } };
  const bind: JournalEntry = { v: 1, kind: "bind", contract: id, entry: entryUlid(attempt.entryUlids[0]!), at: input.at, ...(input.actor === undefined ? {} : { actor: input.actor }), data: input.data };
  const entries: JournalEntry[] = [bind];
  const dependencies = body.after ?? [];
  const ready = dependencies.every((dependency) => observation.contracts.get(dependency)?.state?.terminal?.kind === "claimed");
  if (ready) entries.push({ v: 1, kind: "bound", contract: id, entry: entryUlid(attempt.entryUlids[1]!), at: input.at, ...(input.actor === undefined ? {} : { actor: input.actor }), data: {} as BoundData });
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current?.state?.head ?? null, entries }] } };
}
