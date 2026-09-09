import { z } from "zod";

const phase = z.enum(["materialize", "environment", "setup", "declaration", "cleanup"]);
const coordinate = {
  phase,
  cwd: z.string().optional(),
  source: z.string().optional(),
  name: z.string().optional(),
  command: z.string().optional(),
  index: z.number().int().positive().optional(),
  total: z.number().int().nonnegative().optional(),
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
