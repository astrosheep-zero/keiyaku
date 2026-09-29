import { decodeGateReport, gateReports, type GateReport } from "../facts/gate.js";
import { activeContract, contractState } from "../facts/observation.js";
import { contractId, type ActorId, type ContractId, type ContractState, type JournalEntry } from "../facts/types.js";
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
      kind: "contract-missing" | "delivery-missing" | "terminal";
      contractId: ContractId;
    }>
  | Readonly<{
      kind: "gates-unsatisfied";
      contractId: ContractId;
      unmet: readonly GateReport[];
      /** The reference the refused placement attempted to advance, when the Contract has one. */
      target?: string;
    }>
  | Readonly<{
      kind: "prerequisites-unsatisfied";
      contractId: ContractId;
      unmet: readonly UnmetPrerequisite[];
    }>;
function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed placement refusal");
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error("malformed placement refusal");
  return object;
}

export function decodePlacementRefusal(value: unknown): PlacementRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed placement refusal");
  const object = value as Record<string, unknown>;
  if (object.kind === "contract-missing" || object.kind === "delivery-missing" || object.kind === "terminal") {
    const { contractId: id } = exactRecord(value, ["kind", "contractId"]);
    try {
      return { kind: object.kind, contractId: contractId(String(id)) };
    } catch {
      throw new Error("malformed placement refusal");
    }
  }
  if (object.kind === "gates-unsatisfied") {
    const { contractId: id, unmet, target } = exactRecord(value, ["kind", "contractId", "unmet", "target"]);
    if (!Array.isArray(unmet)) throw new Error("malformed placement refusal");
    if (target !== undefined && (typeof target !== "string" || target.length === 0))
      throw new Error("malformed placement refusal");
    try {
      return {
        kind: "gates-unsatisfied",
        contractId: contractId(String(id)),
        unmet: unmet.map(decodeGateReport),
        ...(target === undefined ? {} : { target }),
      };
    } catch {
      throw new Error("malformed placement refusal");
    }
  }
  if (object.kind !== "prerequisites-unsatisfied") throw new Error("malformed placement refusal");
  const { contractId: id, unmet } = exactRecord(value, ["kind", "contractId", "unmet"]);
  if (!Array.isArray(unmet)) throw new Error("malformed placement refusal");
  try {
    return {
      kind: "prerequisites-unsatisfied",
      contractId: contractId(String(id)),
      unmet: unmet.map((item) => {
        const entry = exactRecord(item, ["contractId", "state"]);
        if (entry.state !== "missing" && entry.state !== "active" && entry.state !== "abandoned")
          throw new Error("malformed placement refusal");
        return { contractId: contractId(String(entry.contractId)), state: entry.state };
      }),
    };
  } catch {
    throw new Error("malformed placement refusal");
  }
}

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
  const gates = gateReports(current);
  if (!gates.satisfied) {
    const unmetGates = gates.reports.filter(
      (report) => report.current.kind !== "attested" || report.current.verdict !== "satisfied",
    );
    return {
      kind: "refused",
      refusal: {
        kind: "gates-unsatisfied",
        contractId: id,
        unmet: unmetGates,
        ...(current.coordinates.target === undefined ? {} : { target: current.coordinates.target }),
      },
    };
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
