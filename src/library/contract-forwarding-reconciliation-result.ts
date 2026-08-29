import { snapshotId } from "../core/facts/types.js";
import { z } from "zod";

function canonicalSnapshot(value: string, context: z.RefinementCtx) {
  try {
    return snapshotId(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected SnapshotId" });
    return z.NEVER;
  }
}

const nonblankStringSchema = z.string().refine((value) => value.trim() !== "");
const snapshotIdSchema = z.string().transform(canonicalSnapshot);
const hookFailureSchema = z.union([
  z
    .object({
      kind: z.literal("exit"),
      code: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("timeout") }).strict(),
  z.object({ kind: z.literal("spawn-error"), diagnostic: z.string() }).strict(),
  z.object({ kind: z.literal("unknown-exit") }).strict(),
]);

export const reconciliationLagSchema = z.union([
  z.object({ kind: z.literal("worktree-retained"), path: nonblankStringSchema }).strict(),
  z
    .object({
      kind: z.literal("worktree-follow-retained"),
      path: nonblankStringSchema,
      tender: snapshotIdSchema,
      head: snapshotIdSchema,
      reason: z.enum(["head-moved", "head-attached", "operation-in-progress", "unsupported-parent-shape"]),
      paths: z.array(nonblankStringSchema).optional(),
    })
    .strict()
    .transform(({ paths, ...lag }) => (paths === undefined ? lag : { ...lag, paths })),
  z
    .object({
      kind: z.literal("unsealed-bytes"),
      path: nonblankStringSchema,
      paths: z.array(nonblankStringSchema),
      head: snapshotIdSchema.optional(),
    })
    .strict()
    .transform(({ head, ...lag }) => (head === undefined ? lag : { ...lag, head })),
  z
    .object({
      kind: z.literal("target-checkout-retained"),
      path: nonblankStringSchema,
      target: nonblankStringSchema,
      diagnostic: nonblankStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("reconcile-failed"),
      stage: z.enum(["observation", "effect"]),
      diagnostic: nonblankStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worktree-hook-failed"),
      phase: z.enum(["create", "destroy"]),
      path: nonblankStringSchema,
      command: z.number().int().nonnegative(),
      name: nonblankStringSchema,
      failure: hookFailureSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("contract-file-failed"),
      worktree: nonblankStringSchema,
      path: nonblankStringSchema,
      diagnostic: nonblankStringSchema,
    })
    .strict(),
]);
