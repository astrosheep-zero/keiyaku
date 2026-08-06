import { verificationDeclarationKey } from "../declaration-key.js";
import type { ContractBody, ContractState, Gate, VerificationEntry } from "./types.js";

export { verificationDeclarationKey };

export function effectiveGates(body: ContractBody): readonly Gate[] {
  const declared: Gate[] = body.gates === undefined ? ["reviewed"] : [...body.gates];
  if (body.verification.length > 0 && !declared.includes("verified")) declared.push("verified");
  return declared;
}

export function latestMatchingVerification(state: ContractState): VerificationEntry | null {
  if (state.delivery === null || state.body === null) return null;
  const currentKey = verificationDeclarationKey(state.body.verification);
  return state.verifications.findLast((verification) => (
    verification.data.candidate === state.delivery!.data.candidate
    && verification.data.declarationKey === currentKey
  )) ?? null;
}

export function gateSatisfied(state: ContractState, gate: Gate): boolean {
  const deliver = state.delivery;
  if (deliver === null) return false;
  if (gate === "verified") {
    return latestMatchingVerification(state)?.data.result === "pass";
  }
  return (state.reviews.findLast((review) => (
    review.data.reviewedPatchId === deliver.data.deliveryPatchId
  ))?.data.verdict ?? null) === "approved";
}

export function unsatisfiedGates(state: ContractState): readonly Gate[] {
  if (state.body === null) return [];
  return effectiveGates(state.body).filter((gate) => !gateSatisfied(state, gate));
}

export function gatesSatisfied(state: ContractState): boolean {
  return unsatisfiedGates(state).length === 0;
}
