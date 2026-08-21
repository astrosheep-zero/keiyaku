import { gatesSatisfied } from "../facts/gate.js";
import { activeContract, contractState } from "../facts/observation.js";
import type { ActorId, ContractId, ContractState, JournalEntry } from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../decide.js";

type PlacementInput = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
}>;

export type UnmetPrerequisite = Readonly<{
  contractId: ContractId;
  state: "missing" | "active" | "abandoned";
}>;

export type PlacementRefusal =
  | Readonly<{
      kind: "contract-missing" | "delivery-missing" | "terminal" | "gates-unsatisfied";
      contractId: ContractId;
    }>
  | Readonly<{
      kind: "prerequisites-unsatisfied";
      contractId: ContractId;
      unmet: readonly UnmetPrerequisite[];
    }>;

function unmetPrerequisites(
  prerequisites: readonly ContractId[],
  observation: ReadonlyMap<ContractId, ContractState | null>,
): readonly UnmetPrerequisite[] {
  const unmet: UnmetPrerequisite[] = [];
  for (const contractId of prerequisites) {
    const state = contractState(observation, contractId);
    if (state === null) {
      unmet.push({ contractId, state: "missing" });
    } else if (state.terminal?.kind === "abandoned") {
      unmet.push({ contractId, state: "abandoned" });
    } else if (state.terminal?.kind !== "claimed") {
      unmet.push({ contractId, state: "active" });
    }
  }
  return unmet;
}

export function decidePlacement({
  input,
  attempt,
  observation,
}: DecideInput<PlacementInput>): OfferDecision<PlacementRefusal> {
  const id = input.contractId;
  const current = activeContract(observation, id);
  if ("kind" in current) return { kind: "refused", refusal: current };
  const delivery = current.delivery;
  const integration = current.currentIntegration;
  if (!delivery || !integration) {
    return { kind: "refused", refusal: { kind: "delivery-missing", contractId: id } };
  }
  const unmet = unmetPrerequisites(current.terms.after, observation);
  if (unmet.length > 0) {
    return { kind: "refused", refusal: { kind: "prerequisites-unsatisfied", contractId: id, unmet } };
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
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: id, expectedHead: current.head, entries: [claimed] }],
      ...(current.coordinates.target === undefined
        ? {}
        : {
            target: {
              target: current.coordinates.target,
              expectedOid: integration.predecessor,
              newOid: integration.snapshot,
            },
          }),
    },
  } as const;
}
