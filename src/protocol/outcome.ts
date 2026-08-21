import type { ContractHead, ContractState, JournalEntry } from "../core/facts/types.js";
import type { WorktreeLeak } from "../git/scratch.js";
import type { ReconcileResult } from "../git/reconcile.js";
import type { AcceptedAdmission } from "./attempt.js";
import type { VerificationCleanupFailure } from "./intent.js";
import type { ProtocolResult, ProtocolTerminal } from "./run.js";

export type AcceptedProtocolStep = AcceptedAdmission & Readonly<{ physical?: ReconcileResult }>;

export type AcceptedObligations = Readonly<{
  cleanup?: VerificationCleanupFailure;
  leak?: WorktreeLeak;
}>;

export type IntentOutcome<Value, Refusal = never> =
  | Readonly<
      {
        kind: "accepted";
        facts: readonly JournalEntry[];
        head: ContractHead;
        value: Value;
        physical?: ReconcileResult;
      } & AcceptedObligations
    >
  | Readonly<{ kind: "refused"; refusal: Refusal }>
  | Readonly<{ kind: "retry"; reason: ProtocolTerminal }>;

export function accepted<Value, Refusal = never>(
  state: ContractState,
  facts: readonly JournalEntry[],
  value: Value,
  physical?: ReconcileResult,
  obligations?: AcceptedObligations,
): IntentOutcome<Value, Refusal> {
  if (state.head === null) throw new Error("accepted contract is missing its journal head");
  return {
    kind: "accepted",
    facts,
    head: state.head,
    value,
    ...(physical === undefined ? {} : { physical }),
    ...(obligations?.cleanup === undefined ? {} : { cleanup: obligations.cleanup }),
    ...(obligations?.leak === undefined ? {} : { leak: obligations.leak }),
  };
}

export function admitted<Value, Refusal = never>(
  admission: AcceptedProtocolStep,
  value: Value,
): IntentOutcome<Value, Refusal> {
  return accepted(admission.state, admission.facts, value, admission.physical);
}

export function complete<Value, Refusal>(result: ProtocolResult<Refusal>, value: Value): IntentOutcome<Value, Refusal> {
  if (result.kind === "refused") return { kind: "refused", refusal: result.refusal };
  if (result.kind !== "accepted") return { kind: "retry", reason: result };
  return admitted(result, value);
}
