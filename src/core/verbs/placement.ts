import { gatesSatisfied } from "../facts/gate.js";
import { placeEligibleBounds } from "../facts/eligibility.js";
import { activeContract } from "../facts/observation.js";
import type { ActorId, ContractId, JournalEntry } from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../decide.js";

type PlacementInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
}>;

export type PlacementRefusal = Readonly<{
  kind: "contract-missing" | "delivery-missing" | "terminal" | "gates-unsatisfied";
  contractId: ContractId;
}>;

export function decidePlacement({ input, attempt, observation }: DecideInput<PlacementInput>): OfferDecision<PlacementRefusal> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };
  const delivery = current.delivery;
  if (!delivery) {
    return { kind: "refused", refusal: { kind: "delivery-missing", contractId: id } };
  }
  if (!gatesSatisfied(current)) {
    return { kind: "refused", refusal: { kind: "gates-unsatisfied", contractId: id } };
  }

  const claimed: JournalEntry = {
    v: 1,
    kind: "claimed",
    contract: id,
    entry: attempt.entryUlids[0]!,
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: { delivery: delivery.entry },
  };
  const offer = {
    kind: "offer",
    offer: {
      facts: [{ contractId: id, expectedHead: current.head, entries: [claimed] }],
      ...(current.coordinates.target === undefined ? {} : {
        target: {
          target: current.coordinates.target,
          expectedOid: delivery.data.expectedPredecessor,
          newOid: delivery.data.candidate,
        },
      }),
    },
  } as const;
  return {
    ...offer,
    offer: placeEligibleBounds(offer.offer, observation, attempt),
  };
}
