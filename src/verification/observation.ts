import { z } from "zod";
import { snapshotId } from "../core/facts/types.js";

const phase = z.enum(["materialize", "setup", "declaration", "cleanup"]);
const coordinate = {
  phase,
  cwd: z.string().exactOptional(),
  name: z.string().exactOptional(),
  command: z.string().exactOptional(),
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
      outcome: z.string().exactOptional(),
      elapsedMs: z.number().nonnegative().exactOptional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("output"),
      ...coordinate,
      stream: z.enum(["stdout", "stderr"]),
      text: z.string(),
    })
    .strict()
    .readonly(),
]);

/** Attempt-local observations, never testimony, liveness, or recovery authority. */
export type VerificationObservation = z.infer<typeof verificationObservationSchema>;
