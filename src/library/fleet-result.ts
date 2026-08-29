import { akumaIdSchema, akumaStatusSchema } from "../akuma/akuma.js";
import type { KillEvidence, TellResult } from "../akuma/index.js";
import { contractId } from "../core/facts/types.js";
import { taskRowsSchema } from "../task/board.js";
import { z } from "zod";

const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
const contractIdSchema = z.string().transform((value, context) => {
  try {
    return contractId(value);
  } catch {
    context.addIssue({ code: "custom", message: "expected ContractId" });
    return z.NEVER;
  }
});
const killEvidenceSchema = z.enum([
  "killed",
  "already-killed",
  "already-stopped",
  "hung",
  "untidy",
  "unavailable",
]) satisfies z.ZodType<KillEvidence>;
const dispatchAssociationSchema = z.union([
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("associated"), contractId: contractIdSchema }).strict(),
  z.object({ kind: z.literal("failed"), diagnostic: z.string() }).strict(),
]);
const createdTaskObservationSchema = z.union([
  z.object({ kind: z.literal("present"), rows: taskRowsSchema }).strict(),
  z.object({ kind: z.literal("failed"), diagnostic: z.string() }).strict(),
]);
const akumaObservationSchema = z
  .object({
    status: akumaStatusSchema,
    contract: dispatchAssociationSchema,
    createdTasks: createdTaskObservationSchema,
  })
  .strict();
const runLogReferenceSchema = z
  .object({ path: z.string(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
  .strict();
const failedTellWakeSchema = z
  .object({
    kind: z.literal("failed"),
    diagnostic: z.string(),
    child: z
      .object({ code: z.number().int().nullable(), signal: z.string().nullable(), log: runLogReferenceSchema })
      .strict()
      .optional(),
  })
  .strict()
  .transform(({ child, ...wake }) => (child === undefined ? wake : { ...wake, child }));
const tellWakeSchema = z.union([
  z.object({ kind: z.literal("told") }).strict(),
  z.object({ kind: z.literal("held") }).strict(),
  z.object({ kind: z.literal("pursuing"), bodySequence: z.number().int().nonnegative() }).strict(),
  failedTellWakeSchema,
]);
const tellResultSchema = z
  .object({
    admission: z.object({ fact: z.literal("recorded"), tellId: nonblankTextSchema }).strict(),
    wake: tellWakeSchema,
  })
  .strict() satisfies z.ZodType<TellResult>;
const akumaUnobservedSchema = z.object({ id: akumaIdSchema, diagnostic: z.string() }).strict();
const akumaKillResultItemSchema = z.object({ id: akumaIdSchema, evidence: killEvidenceSchema }).strict();
const akumaWaitResultSchema = z
  .object({
    completion: z.enum(["any", "all"]),
    observations: z.array(akumaObservationSchema),
    unobserved: z.array(akumaUnobservedSchema),
  })
  .strict();
const akumaKillResultSchema = z.object({ results: z.array(akumaKillResultItemSchema) }).strict();
const akumaTellResultSchema = z.object({ akuma: akumaIdSchema, tell: tellResultSchema }).strict();

export type CreatedTaskObservation = z.infer<typeof createdTaskObservationSchema>;
export type DispatchAssociation = z.infer<typeof dispatchAssociationSchema>;
export type AkumaObservation = z.infer<typeof akumaObservationSchema>;
export type AkumaObservationStage =
  | (Readonly<{ kind: "observed" }> & AkumaObservation)
  | Readonly<{ kind: "unobserved"; diagnostic: string }>;
export type AkumaUnobserved = z.infer<typeof akumaUnobservedSchema>;
export type AkumaWaitResult = z.infer<typeof akumaWaitResultSchema>;
export type AkumaKillResult = z.infer<typeof akumaKillResultSchema>;
export type AkumaTellResult = z.infer<typeof akumaTellResultSchema>;

export function parseCreatedTaskObservation(value: unknown): CreatedTaskObservation {
  return createdTaskObservationSchema.parse(value);
}

export function parseAkumaObservation(value: unknown): AkumaObservation {
  return akumaObservationSchema.parse(value);
}

export function isWaitResult(value: unknown): value is AkumaWaitResult {
  return akumaWaitResultSchema.safeParse(value).success;
}

export function isKillResult(value: unknown): value is AkumaKillResult {
  return akumaKillResultSchema.safeParse(value).success;
}

export function isTellResult(value: unknown): value is AkumaTellResult {
  return akumaTellResultSchema.safeParse(value).success;
}

export const fleetResultSchemas = {
  wait: akumaWaitResultSchema,
  tell: akumaTellResultSchema,
  kill: akumaKillResultSchema,
  killEvidence: killEvidenceSchema,
};
