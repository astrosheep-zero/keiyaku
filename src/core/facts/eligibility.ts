import { contractState, type ContractsObservation } from "./observation.js";
import type { ContractId } from "./types.js";

type EligibilityObservation = ContractsObservation;

/** Decide whether resulting prerequisites reach the amended contract. */
export function prerequisitesReach(
  contract: ContractId,
  prerequisites: readonly ContractId[],
  observation: EligibilityObservation,
): boolean {
  const pending = [...prerequisites];
  const visited = new Set<ContractId>();
  while (pending.length > 0) {
    const dependency = pending.pop()!;
    if (dependency === contract) return true;
    if (visited.has(dependency)) continue;
    visited.add(dependency);
    const state = contractState(observation, dependency);
    if (state === null) throw new Error(`absent contract in prerequisite closure: ${dependency}`);
    pending.push(...state.terms.after);
  }
  return false;
}

export function samePrerequisites(
  left: readonly ContractId[],
  right: readonly ContractId[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}
