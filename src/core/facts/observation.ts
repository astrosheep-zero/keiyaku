import type { ContractId, ContractState, DocumentKey } from "./types.js";

/** The complete state projection consumed by one pure pact decision. */
export type ContractsObservation = ReadonlyMap<ContractId, ContractState | null>;
export type PrerequisiteStatus = "unknown" | "pending" | "claimed";

/** Read one requested identity; a missing key violates the observation contract. */
export function contractState(
  observation: ContractsObservation,
  contract: ContractId,
): ContractState | null {
  const state = observation.get(contract);
  if (state === undefined) {
    throw new Error(`missing contract decision observation: ${contract}`);
  }
  if (state !== null && state.id !== contract) {
    throw new Error(`contract state identity disagrees with decision map: ${contract}`);
  }
  return state;
}

/** Project prerequisite existence and terminal satisfaction from one observation. */
export function prerequisiteStatus(
  prerequisites: readonly ContractId[],
  observation: ContractsObservation,
): PrerequisiteStatus {
  let pending = false;
  for (const dependency of prerequisites) {
    const state = contractState(observation, dependency);
    if (state === null) return "unknown";
    if (state.terminal?.kind !== "claimed") pending = true;
  }
  return pending ? "pending" : "claimed";
}

export type ActiveContractRefusal = Readonly<{
  kind: "contract-missing" | "terminal";
  contractId: ContractId;
}>;

/** The single lifecycle guard shared by every operation on an existing contract. */
export function activeContract(
  observation: ContractsObservation,
  contract: ContractId,
): ContractState | ActiveContractRefusal {
  const state = contractState(observation, contract);
  if (state === null) return { kind: "contract-missing", contractId: contract };
  if (state.terminal) return { kind: "terminal", contractId: contract };
  return state;
}

export function documentIsCurrent(
  state: ContractState,
  document: DocumentKey,
): boolean {
  return state.terms.document.key === document;
}
