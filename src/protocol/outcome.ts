import type { ContractHead, ContractState, JournalEntry } from "../core/facts/types.js";
import type { AcceptedAdmission } from "./attempt.js";
import type { ProtocolResult, ProtocolTerminal } from "./run.js";

export type IntentOutcome<Value, Refusal = never> =
  | Readonly<{ kind: "accepted"; facts: readonly JournalEntry[]; head: ContractHead; value: Value }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "retry"; reason: ProtocolTerminal }>;

export function accepted<Value, Refusal = never>(
  state: ContractState, facts: readonly JournalEntry[], value: Value,
): IntentOutcome<Value, Refusal> {
  if (state.head === null) throw new Error("accepted contract is missing its journal head");
  return { kind: "accepted", facts, head: state.head, value };
}

export function admitted<Value, Refusal = never>(admission: AcceptedAdmission, value: Value): IntentOutcome<Value, Refusal> {
  return accepted(admission.state, admission.facts, value);
}

export function complete<Value, Refusal>(result: ProtocolResult<Refusal>, value: Value): IntentOutcome<Value, Refusal> {
  if (result.kind === "refused") return { kind: "refused", refusal: result.refusal };
  if (result.kind !== "accepted") return { kind: "retry", reason: result };
  return admitted(result, value);
}
