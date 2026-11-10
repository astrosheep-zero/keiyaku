import type { ContractId, ContractState, ContractTarget, DocumentKey } from "./types.js";

/** The complete state projection consumed by one pure pact decision. */
export type ContractsObservation = ReadonlyMap<ContractId, ContractState | null>;
export type PrerequisiteStatus = "unknown" | "pending" | "claimed";

/** Read one requested identity; a missing key violates the observation contract. */
export function contractState(observation: ContractsObservation, contract: ContractId): ContractState | null {
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
}>;

export type TargetContractRefusal = Readonly<{
  kind: "target-contract-missing" | "target-contract-terminal";
  targetContractId: ContractId;
}>;

export function targetContractRefusal(
  observation: ContractsObservation,
  target: ContractTarget | undefined,
): TargetContractRefusal | undefined {
  if (target === undefined || typeof target === "string") return undefined;
  return targetContractIdRefusal(observation, target.contractId);
}

export function targetContractIdRefusal(
  observation: ContractsObservation,
  target: ContractId,
): TargetContractRefusal | undefined {
  const state = contractState(observation, target);
  if (state === null) return { kind: "target-contract-missing", targetContractId: target };
  if (state.terminal !== null) return { kind: "target-contract-terminal", targetContractId: target };
  return undefined;
}

/** The single lifecycle guard shared by every operation on an existing contract. */
export function activeContract(
  observation: ContractsObservation,
  contract: ContractId,
): ContractState | ActiveContractRefusal {
  const state = contractState(observation, contract);
  if (state === null) return { kind: "contract-missing" };
  if (state.terminal) return { kind: "terminal" };
  return state;
}

export function documentIsCurrent(state: ContractState, document: DocumentKey): boolean {
  return state.terms.document.key === document;
}
