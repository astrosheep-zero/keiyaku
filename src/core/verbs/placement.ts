import { gatesSatisfied } from "../facts/gate.js";
import type { ContractId, JournalEntry } from "../facts/types.js";
import { contractId, entryUlid } from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../decide.js";

export type PlacementInput = Readonly<{
  contractId: ContractId;
  actor?: string;
  at: string;
}>;

export type PlacementRefusal = Readonly<{
  kind: "contract-missing" | "delivery-missing" | "terminal" | "gates-unsatisfied";
  contractId: ContractId;
}>;

/** Decide the only journal/target pair that can place the current delivery. */
export function decidePlacement({ input, attempt, observation }: DecideInput<PlacementInput>): OfferDecision<null, PlacementRefusal> {
  const id = contractId(input.contractId);
  const current = observation.contracts.get(id);
  if (!current?.state) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (current.state.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };
  const delivery = current.state.delivery;
  if (!delivery || !current.state.coordinates) {
    return { kind: "refused", refusal: { kind: "delivery-missing", contractId: id } };
  }
  if (!gatesSatisfied(current.state)) {
    return { kind: "refused", refusal: { kind: "gates-unsatisfied", contractId: id } };
  }

  const claimed: JournalEntry = {
    v: 1,
    kind: "claimed",
    contract: id,
    entry: entryUlid(attempt.entryUlids[0]!),
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: { delivery: delivery.entry },
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: id, expectedHead: current.state.head, entries: [claimed] }],
      ...(current.state.coordinates.target === undefined ? {} : {
        target: {
          target: current.state.coordinates.target,
          expectedOid: delivery.data.expectedPredecessor,
          newOid: delivery.data.candidate,
        },
      }),
    },
    handoff: null,
  };
}
