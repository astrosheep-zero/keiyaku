import type { DecideInput, OfferDecision } from "../decide.js";
import { activeContract } from "../facts/observation.js";
import { contractId, type ActorId, type ArcData, type ContractId, type JournalEntry } from "../facts/types.js";

export type ArcInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  data: Readonly<Omit<ArcData, "seq">>;
}>;

export type ArcRefusal = Readonly<{
  kind: "contract-missing" | "terminal";
  contractId: ContractId;
}>;

export function decodeArcRefusal(value: unknown): ArcRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed arc refusal");
  const object = value as Record<string, unknown>;
  if (object.kind !== "contract-missing" && object.kind !== "terminal") throw new Error("malformed arc refusal");
  if (Object.keys(object).some((key) => key !== "kind" && key !== "contractId"))
    throw new Error("malformed arc refusal");
  try {
    return { kind: object.kind, contractId: contractId(String(object.contractId)) };
  } catch {
    throw new Error("malformed arc refusal");
  }
}

export function decideArc({ input, attempt, observation }: DecideInput<ArcInput>): OfferDecision<ArcRefusal> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };

  const arc: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: id,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: {
      seq: (current.currentArc?.data.seq ?? 0) + 1,
      title: input.data.title,
      objective: input.data.objective,
      brief: input.data.brief,
    },
  };
  return {
    kind: "offer",
    offer: { facts: [{ contractId: id, expectedHead: current.head, entries: [arc] }] },
  };
}
