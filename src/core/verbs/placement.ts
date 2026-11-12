import { gateReports, type GateReport } from "../facts/gate.js";
import {
  activeContract,
  contractState,
  targetContractRefusal,
  type TargetContractRefusal,
} from "../facts/observation.js";
import { journalEntry, type ContractId, type ContractState } from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../decide.js";

type PlacementInput = Readonly<{
  contractId: ContractId;
  at: string;
}>;

type UnmetPrerequisite = Readonly<{
  contractId: ContractId;
  state: "missing" | "active" | "abandoned";
}>;

export type PlacementRefusal =
  | TargetContractRefusal
  | Readonly<{
      kind: "contract-missing" | "delivery-missing" | "terminal";
    }>
  | Readonly<{
      kind: "gates-unsatisfied";
      unmet: readonly GateReport[];
    }>
  | Readonly<{
      kind: "prerequisites-unsatisfied";
      unmet: readonly UnmetPrerequisite[];
    }>;
export function unmetPrerequisites(
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
  const targetRefusal = targetContractRefusal(observation, current.coordinates.target);
  if (targetRefusal !== undefined) return { kind: "refused", refusal: targetRefusal };
  const delivery = current.delivery;
  const integration = current.currentIntegration;
  if (!delivery || !integration) {
    return { kind: "refused", refusal: { kind: "delivery-missing" } };
  }
  const unmet = unmetPrerequisites(current.terms.after, observation);
  if (unmet.length > 0) {
    return { kind: "refused", refusal: { kind: "prerequisites-unsatisfied", unmet } };
  }
  const gates = gateReports(current);
  if (!gates.satisfied) {
    const unmetGates = gates.reports.filter((report) => !report.satisfied);
    return {
      kind: "refused",
      refusal: {
        kind: "gates-unsatisfied",
        unmet: unmetGates,
      },
    };
  }

  const claimed = journalEntry("claimed", input, attempt.entryUlids[0]!, { delivery: delivery.entry });
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: id, entries: [claimed] }],
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
