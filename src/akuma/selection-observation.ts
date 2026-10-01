import { akumaIdSchema, akumaStatusSchema, type AkumaStatus } from "./akuma.js";
import { tellResultSchema } from "./call-initial-tell.js";
import type { KillEvidence } from "./heart/index.js";
import { NO_DISPATCH_ASSOCIATION, dispatchAssociationSchema } from "./dispatch-association.js";
import { EMPTY_CREATED_TASK_OBSERVATION, createdTaskObservationSchema } from "../task/created-observation.js";
import { z } from "zod";

const killEvidenceSchema = z.enum([
  "killed",
  "already-killed",
  "already-stopped",
  "hung",
  "untidy",
  "unavailable",
]) satisfies z.ZodType<KillEvidence>;
const akumaObservationSchema = z
  .object({
    status: akumaStatusSchema,
    contract: dispatchAssociationSchema,
    createdTasks: createdTaskObservationSchema,
  })
  .strict();
const akumaUnobservedSchema = z.object({ id: akumaIdSchema, diagnostic: z.string() }).strict();
const akumaKillResultItemSchema = z.object({ id: akumaIdSchema, evidence: killEvidenceSchema }).strict();
const akumaWaitResultSchema = z
  .object({
    mode: z.enum(["any", "all"]),
    reason: z.enum(["completed", "deadline"]),
    observations: z.array(akumaObservationSchema).readonly(),
    unobserved: z.array(akumaUnobservedSchema).readonly(),
  })
  .strict();
const akumaKillResultSchema = z.object({ results: z.array(akumaKillResultItemSchema).readonly() }).strict();
const akumaTellResultSchema = z.object({ akuma: akumaIdSchema, tell: tellResultSchema }).strict();
const askObservationSchema = z.union([
  z.object({ reason: z.literal("answered"), answer: z.unknown() }).strict(),
  z.object({ reason: z.literal("failed"), diagnostic: z.string() }).strict(),
  z.object({ reason: z.literal("invalid-output"), diagnostic: z.string(), answer: z.string() }).strict(),
  z.object({ reason: z.literal("unanswered") }).strict(),
  z.object({ reason: z.literal("deadline") }).strict(),
]);
const akumaAskResultSchema = z
  .object({
    akuma: akumaIdSchema,
    tell: tellResultSchema,
    observation: askObservationSchema,
    completedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export type AkumaObservation = z.infer<typeof akumaObservationSchema>;
export type AkumaObservationStage =
  | (Readonly<{ kind: "observed" }> & AkumaObservation)
  | Readonly<{ kind: "unobserved"; diagnostic: string }>;
export type AkumaUnobserved = z.infer<typeof akumaUnobservedSchema>;
export type AkumaWaitResult = z.infer<typeof akumaWaitResultSchema>;
export type AkumaKillResult = z.infer<typeof akumaKillResultSchema>;
export type AkumaTellResult = z.infer<typeof akumaTellResultSchema>;
export type AkumaAskObservation<T = unknown> =
  | Exclude<z.infer<typeof askObservationSchema>, { reason: "answered" }>
  | Readonly<{ reason: "answered"; answer: T }>;
export type AkumaAskResult<T = unknown> = Omit<z.infer<typeof akumaAskResultSchema>, "observation"> &
  Readonly<{ observation: AkumaAskObservation<T> }>;

export function parseAkumaObservation(value: unknown): AkumaObservation {
  return akumaObservationSchema.parse(value);
}

/** Compose one native status into the canonical observation its crossing transports. */
export function akumaObservationOf(status: AkumaStatus): AkumaObservation {
  return { status, contract: NO_DISPATCH_ASSOCIATION, createdTasks: EMPTY_CREATED_TASK_OBSERVATION };
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

export function isAskResult(value: unknown): value is AkumaAskResult {
  return akumaAskResultSchema.safeParse(value).success;
}

export const selectionResultSchemas = {
  wait: akumaWaitResultSchema,
  tell: akumaTellResultSchema,
  ask: akumaAskResultSchema,
  kill: akumaKillResultSchema,
  killEvidence: killEvidenceSchema,
};
