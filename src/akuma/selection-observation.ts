import { z } from "zod";
import { createdDebtObservationSchema } from "../debt/created-observation.js";
import { akumaStatusSchema } from "./akuma.js";
import { compactTimelineSchema } from "./status-projection.js";
import { diffstatSchema } from "./heart/activity-schema.js";
import type { TellResult } from "./call-initial-tell.js";
import { dispatchAssociationSchema } from "./dispatch-association.js";
import { killEvidenceSchema } from "./heart/facts.js";
import { akumaIdSchema, turnHistoryIdSchema, type AkumaId } from "./identity.js";

const createdDebtRowSchema = createdDebtObservationSchema.options[0]
  .unwrap()
  .shape.rows.unwrap()
  .unwrap()
  .element.unwrap()
  .pick({ id: true, title: true, priority: true, disposition: true })
  .readonly();
export const akumaObservationSchema = z
  .strictObject({
    kind: z.literal("akuma"),
    id: akumaIdSchema,
    life: akumaStatusSchema.unwrap().shape.life,
    cwd: z.string(),
    provider: z.string(),
    model: z.string().exactOptional(),
    timeline: compactTimelineSchema,
    lastActivityAt: z.string().exactOptional(),
    strandedReason: z.literal("resume-unsupported").exactOptional(),
    contract: z.union([dispatchAssociationSchema.options[1], dispatchAssociationSchema.options[2]]).exactOptional(),
    createdDebts: z
      .union([z.array(createdDebtRowSchema).nonempty().readonly(), createdDebtObservationSchema.options[1]])
      .exactOptional(),
    changes: z
      .array(
        z
          .strictObject({
            path: z.string(),
            diffstat: diffstatSchema.strict().readonly().exactOptional(),
          })
          .readonly(),
      )
      .nonempty()
      .readonly()
      .exactOptional(),
    moreChanges: z.literal(true).exactOptional(),
    outsideChanges: z.number().int().positive().exactOptional(),
  })
  .readonly();
// A wait reports the settled outcome, not the timeline row that carries its event coordinates.
const waitOutcomeSchema = z.union([
  z.strictObject({ kind: z.literal("answered"), historyId: turnHistoryIdSchema, answer: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("failed"), historyId: turnHistoryIdSchema, diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("canceled"), historyId: turnHistoryIdSchema }).readonly(),
]);
export type AkumaWaitOutcome = z.output<typeof waitOutcomeSchema>;
export const akumaWaitItemSchema = z.union([
  z
    .strictObject({
      kind: z.literal("observed"),
      id: akumaIdSchema,
      life: akumaStatusSchema.unwrap().shape.life,
      pending: z.literal(true).exactOptional(),
      outcome: waitOutcomeSchema.exactOptional(),
      strandedReason: z.literal("resume-unsupported").exactOptional(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("unobserved"), id: akumaIdSchema, diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("missing"), id: akumaIdSchema }).readonly(),
]);
export const akumaWaitResultSchema = z
  .strictObject({
    kind: z.literal("akuma"),
    reason: z.enum(["completed", "deadline"]),
    results: z.array(akumaWaitItemSchema).readonly(),
  })
  .readonly();
export const akumaKillResultSchema = z
  .strictObject({
    results: z.array(z.strictObject({ id: akumaIdSchema, outcome: killEvidenceSchema }).readonly()).readonly(),
  })
  .readonly();
const bodyPositionSchema = z.number().int().positive();
const failedWakeSchema = z
  .strictObject({
    kind: z.literal("failed"),
    diagnostic: z.string(),
    logPath: z.string().exactOptional(),
  })
  .readonly();
export const publicWakeSchema = z.union([z.strictObject({ kind: z.literal("pending") }).readonly(), failedWakeSchema]);
const settledInterruptSchema = z.union([
  z.strictObject({ kind: z.literal("interrupted"), bodySequence: bodyPositionSchema }).readonly(),
  z
    .strictObject({
      kind: z.literal("unavailable"),
      bodySequence: bodyPositionSchema,
      evidence: z.enum(["hung", "untidy"]),
    })
    .readonly(),
]);
const interruptSchema = z.union([
  ...settledInterruptSchema.options,
  z.strictObject({ kind: z.literal("pending"), bodySequence: bodyPositionSchema }).readonly(),
]);
export const akumaTellResultSchema = z
  .strictObject({
    akumaId: akumaIdSchema,
    tellId: z.string(),
    wake: publicWakeSchema.exactOptional(),
    interrupt: settledInterruptSchema.exactOptional(),
  })
  .readonly();
export const akumaAskObservationSchema = z.union([
  z.strictObject({ kind: z.literal("answered"), answer: z.json() }).readonly(),
  z.strictObject({ kind: z.literal("answered"), answerUndefined: z.literal(true) }).readonly(),
  z.strictObject({ kind: z.literal("failed"), diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("invalid-output"), diagnostic: z.string(), answer: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("unanswered") }).readonly(),
  z.strictObject({ kind: z.literal("deadline") }).readonly(),
]);
const askSubject = { akumaId: akumaIdSchema, tellId: z.string(), interrupt: interruptSchema.exactOptional() };
const settledAskSubject = { ...askSubject, wake: failedWakeSchema.exactOptional() };
const pendingAskSubject = { ...askSubject, wake: publicWakeSchema.exactOptional() };
export const akumaAskResultSchema = z.union([
  akumaAskObservationSchema.options[0].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[1].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[2].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[3].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[4].unwrap().extend(pendingAskSubject).readonly(),
  akumaAskObservationSchema.options[5].unwrap().extend(pendingAskSubject).readonly(),
]);

export type AkumaObservation = z.output<typeof akumaObservationSchema>;
export type AkumaUnobserved = Readonly<{ id: AkumaId; diagnostic: string }>;
export type AkumaWaitItem = z.output<typeof akumaWaitItemSchema>;
export type AkumaWaitResult = z.output<typeof akumaWaitResultSchema>;
export type AkumaKillResult = z.output<typeof akumaKillResultSchema>;
export type AkumaTellResult = z.output<typeof akumaTellResultSchema>;
export type AkumaAskObservation<T = unknown> =
  | Readonly<{ kind: "answered"; answer: T; answerUndefined?: never }>
  | Readonly<{ kind: "answered"; answerUndefined: true; answer?: never }>
  | Readonly<{ kind: "failed"; diagnostic: string }>
  | Readonly<{ kind: "invalid-output"; diagnostic: string; answer: string }>
  | Readonly<{ kind: "unanswered" }>
  | Readonly<{ kind: "deadline" }>;
type AskSubject = Readonly<{ akumaId: AkumaId; tellId: string; interrupt?: z.output<typeof interruptSchema> }>;
export type AkumaAskResult<T = unknown> = AskSubject &
  (
    | (Exclude<AkumaAskObservation<T>, { kind: "unanswered" | "deadline" }> &
        Readonly<{ wake?: z.output<typeof failedWakeSchema> }>)
    | (Extract<AkumaAskObservation<T>, { kind: "unanswered" | "deadline" }> &
        Readonly<{ wake?: z.output<typeof publicWakeSchema> }>)
  );

/** Project this invocation's already observed admission, never reread it. */
export function compactTellResult(
  akumaId: AkumaId,
  tell: TellResult,
): Omit<AkumaTellResult, "interrupt"> & Readonly<{ interrupt?: z.output<typeof interruptSchema> }> {
  const interruption = tell.interruption;
  const wake = tell.wake;
  return {
    akumaId,
    tellId: tell.admission.tellId,
    ...(wake.kind === "told"
      ? {}
      : {
          wake:
            wake.kind === "failed"
              ? {
                  kind: "failed" as const,
                  diagnostic: wake.diagnostic,
                  ...(wake.child === undefined ? {} : { logPath: wake.child.log.path }),
                }
              : { kind: "pending" as const },
        }),
    ...(interruption === undefined
      ? {}
      : {
          interrupt:
            interruption.kind === "completed"
              ? { kind: "interrupted" as const, bodySequence: interruption.bodySequence }
              : interruption,
        }),
  };
}
