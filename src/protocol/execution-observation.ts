import { z } from "zod";
import { validateEntry } from "../core/facts/codec.js";
import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { verificationObservationSchema } from "../verification/observation.js";

export const observationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("admitted"),
      contractId: contractIdSchema,
      fact: z.unknown().transform(validateEntry),
    })
    .strict(),
  z
    .object({
      kind: z.literal("verification"),
      contractId: contractIdSchema,
      snapshot: snapshotIdSchema,
      observation: verificationObservationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("stage"),
      contractId: contractIdSchema,
      stage: z.enum(["placement", "continuation", "reconciliation"]),
      state: z.enum(["started", "finished"]),
    })
    .strict(),
  z.object({ kind: z.literal("progress-dropped"), count: z.number().int().positive() }).strict(),
]);

export type ExecutionObservation = z.infer<typeof observationSchema>;
export type ExecutionObserver = (event: ExecutionObservation) => void | PromiseLike<void>;

/** Observation failure cannot change execution, admission, or process custody. */
export function observeExecution(observer: ExecutionObserver | undefined, event: ExecutionObservation): void {
  try {
    void Promise.resolve(observer?.(event)).catch(() => undefined);
  } catch {
    // A consumer controls observation only, not the operation being observed.
  }
}
