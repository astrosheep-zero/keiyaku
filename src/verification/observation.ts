import { z } from "zod";
import { snapshotId } from "../core/facts/types.js";

const phase = z.enum(["materialize", "setup", "declaration", "cleanup"]);
const coordinate = {
  phase,
  cwd: z.string().optional(),
  name: z.string().optional(),
  command: z.string().optional(),
  requirement: z.string(),
  snapshot: z.string().transform(snapshotId),
  index: z.number().int().positive(),
  total: z.number().int().positive(),
};

export const verificationObservationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("phase"),
      ...coordinate,
      state: z.enum(["started", "finished"]),
      outcome: z.string().optional(),
      elapsedMs: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("output"),
      ...coordinate,
      stream: z.enum(["stdout", "stderr"]),
      text: z.string(),
    })
    .strict(),
]);

/** Attempt-local observations, never testimony, liveness, or recovery authority. */
export type VerificationObservation = z.infer<typeof verificationObservationSchema>;
