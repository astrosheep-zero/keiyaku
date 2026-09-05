import type { ContractState, JournalEntry } from "../core/facts/types.js";
import type { AcceptedProtocolStep } from "./outcome.js";

/** A captured interpretation, not evidence that this invocation admitted a fact. */
export type ContractCheckpoint = Readonly<{
  state: ContractState;
  journal: readonly JournalEntry[];
}>;

/** Only the steps performed after the checkpoint belong to this completion. */
export type CompletionProgress = Readonly<{
  checkpoint: ContractCheckpoint;
  facts: readonly JournalEntry[];
  physical?: NonNullable<AcceptedProtocolStep["physical"]>;
  seatClose?: NonNullable<AcceptedProtocolStep["seatClose"]>;
}>;

type Residue = Pick<CompletionProgress, "physical" | "seatClose">;

export function contractCheckpoint(input: ContractCheckpoint): ContractCheckpoint {
  return { state: input.state, journal: input.journal };
}

export function beginCompletion(checkpoint: ContractCheckpoint): CompletionProgress {
  return { checkpoint: contractCheckpoint(checkpoint), facts: [] };
}

function combineResidue(current: Residue, next: Residue): Residue {
  const effects = [...(current.physical?.effects ?? []), ...(next.physical?.effects ?? [])];
  const lag = [...(current.physical?.lag ?? []), ...(next.physical?.lag ?? [])];
  const seatClose = [...(current.seatClose ?? []), ...(next.seatClose ?? [])];
  return {
    ...(effects.length === 0 && lag.length === 0 ? {} : { physical: { effects, lag } }),
    ...(seatClose.length === 0 ? {} : { seatClose }),
  };
}

function sameContract(current: ContractCheckpoint, next: ContractCheckpoint): void {
  if (current.state.id !== next.state.id) throw new Error("completion checkpoint belongs to another contract");
}

/** Advance the observation and retain each accepted step exactly once in call order. */
export function recordCompletionStep(current: CompletionProgress, next: AcceptedProtocolStep): CompletionProgress {
  sameContract(current.checkpoint, next);
  return {
    checkpoint: contractCheckpoint(next),
    facts: [...current.facts, ...next.facts],
    ...combineResidue(current, next),
  };
}

/** Attach trailing progress to a real leading admission, never to a read-only checkpoint. */
export function completeLeadingAdmission(
  leading: AcceptedProtocolStep,
  progress: CompletionProgress,
): AcceptedProtocolStep {
  sameContract(leading, progress.checkpoint);
  return {
    kind: "accepted",
    ...progress.checkpoint,
    facts: [...leading.facts, ...progress.facts],
    ...combineResidue(leading, progress),
  };
}
