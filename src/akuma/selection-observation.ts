import { z } from "zod";
import { createdDebtObservationSchema, type CreatedDebtObservation } from "../debt/created-observation.js";
import { akumaStatusSchema, type AkumaStatus } from "./akuma.js";
import { tellResultSchema, type TellResult } from "./call-initial-tell.js";
import { dispatchAssociationSchema, type DispatchAssociation } from "./dispatch-association.js";
import { killEvidenceSchema, type KillEvidence } from "./heart/facts.js";
import { akumaIdSchema, type AkumaId } from "./identity.js";

export const akumaObservationSchema = z
  .strictObject({
    status: akumaStatusSchema,
    contract: dispatchAssociationSchema,
    createdDebts: createdDebtObservationSchema,
  })
  .readonly();
export const akumaObservationStageSchema = z.union([
  z.strictObject({ kind: z.literal("observed"), ...akumaObservationSchema.unwrap().shape }).readonly(),
  z.strictObject({ kind: z.literal("unobserved"), diagnostic: z.string() }).readonly(),
]);
export const akumaWaitResultSchema = z
  .strictObject({
    mode: z.enum(["any", "all"]),
    reason: z.enum(["completed", "deadline"]),
    observations: z.array(akumaObservationSchema).readonly(),
    unobserved: z.array(z.strictObject({ id: akumaIdSchema, diagnostic: z.string() }).readonly()).readonly(),
  })
  .readonly();
export const akumaKillResultSchema = z
  .strictObject({
    results: z.array(z.strictObject({ id: akumaIdSchema, evidence: killEvidenceSchema }).readonly()).readonly(),
  })
  .readonly();
export const akumaTellResultSchema = z.strictObject({ akuma: akumaIdSchema, tell: tellResultSchema }).readonly();
export const akumaAskObservationSchema = z.union([
  z.strictObject({ reason: z.literal("answered"), answer: z.unknown().exactOptional() }).readonly(),
  z.strictObject({ reason: z.literal("failed"), diagnostic: z.string() }).readonly(),
  z.strictObject({ reason: z.literal("invalid-output"), diagnostic: z.string(), answer: z.string() }).readonly(),
  z.strictObject({ reason: z.literal("unanswered") }).readonly(),
  z.strictObject({ reason: z.literal("deadline") }).readonly(),
]);
export const akumaAskResultSchema = z
  .strictObject({
    akuma: akumaIdSchema,
    tell: tellResultSchema,
    observation: akumaAskObservationSchema,
    completedAt: z.string().nullable().exactOptional(),
  })
  .readonly();

export type AkumaObservation = Readonly<{
  status: AkumaStatus;
  contract: DispatchAssociation;
  createdDebts: CreatedDebtObservation;
}>;
export type AkumaObservationStage =
  | (Readonly<{ kind: "observed" }> & AkumaObservation)
  | Readonly<{ kind: "unobserved"; diagnostic: string }>;
export type AkumaUnobserved = Readonly<{ id: AkumaId; diagnostic: string }>;
export type AkumaWaitResult = Readonly<{
  mode: "any" | "all";
  reason: "completed" | "deadline";
  observations: readonly AkumaObservation[];
  unobserved: readonly AkumaUnobserved[];
}>;
export type AkumaKillResult = Readonly<{
  results: readonly Readonly<{ id: AkumaId; evidence: KillEvidence }>[];
}>;
export type AkumaTellResult = Readonly<{ akuma: AkumaId; tell: TellResult }>;
export type AkumaAskObservation<T = unknown> =
  | Readonly<{ reason: "answered"; answer: T }>
  | Readonly<{ reason: "failed"; diagnostic: string }>
  | Readonly<{ reason: "invalid-output"; diagnostic: string; answer: string }>
  | Readonly<{ reason: "unanswered" }>
  | Readonly<{ reason: "deadline" }>;
export type AkumaAskResult<T = unknown> = Readonly<{
  akuma: AkumaId;
  tell: TellResult;
  observation: AkumaAskObservation<T>;
  completedAt?: string | null;
}>;
