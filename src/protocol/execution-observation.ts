import { z } from "zod";
import { decodeJournalEntry } from "../core/facts/codec.js";
import { contractId, snapshotId } from "../core/facts/types.js";
import { verificationObservationSchema } from "../verification/observation.js";

const contract = z.string().transform((value) => contractId(value));
const snapshot = z.string().transform((value) => snapshotId(value));
const observationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("admitted"),
      contractId: contract,
      fact: z.unknown().transform(decodeJournalEntry),
    })
    .strict(),
  z
    .object({
      kind: z.literal("verification"),
      contractId: contract,
      snapshot,
      observation: verificationObservationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("stage"),
      contractId: contract,
      stage: z.enum(["placement", "continuation", "reconciliation"]),
      state: z.enum(["started", "finished"]),
    })
    .strict(),
  z.object({ kind: z.literal("progress-dropped"), count: z.number().int().positive() }).strict(),
]);

export type ExecutionEvent = z.infer<typeof observationSchema>;
export type ExecutionObserver = (event: ExecutionEvent) => void;

/** One owner decoder for local and transported ephemeral observations. */
export function decodeExecutionEvent(value: unknown): ExecutionEvent {
  return observationSchema.parse(value);
}

/** Observation failure cannot change execution, admission, or process custody. */
export function observeExecution(observer: ExecutionObserver | undefined, event: ExecutionEvent): void {
  try {
    observer?.(event);
  } catch {
    // A consumer controls observation only, not the operation being observed.
  }
}
