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
export const operationDiagnosticSchema = z
  .strictObject({ kind: z.enum(["authority-corruption", "infrastructure"]), diagnostic: z.string() })
  .readonly();
const failedWakeSchema = z
  .strictObject({ kind: z.literal("failed"), diagnostic: z.string(), logPath: z.string().exactOptional() })
  .readonly();
const pendingWakeSchema = z.strictObject({ kind: z.literal("pending") }).readonly();
const interruptSchema = z.union([
  z.strictObject({ kind: z.literal("pending") }).readonly(),
  z.strictObject({ kind: z.literal("unavailable"), evidence: z.enum(["hung", "untidy"]) }).readonly(),
]);
export const tellFailureSchema = z.union([
  failedWakeSchema
    .unwrap()
    .omit({ kind: true })
    .extend({ stage: z.literal("wake") })
    .readonly(),
  z.strictObject({ stage: z.literal("observation"), diagnostic: z.string() }).readonly(),
]);
type TellFailure = z.output<typeof tellFailureSchema>;
const akumaTextObservationSchema = z.union([
  z.strictObject({ kind: z.literal("answered"), answer: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("failed"), diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("unanswered") }).readonly(),
  z.strictObject({ kind: z.literal("deadline") }).readonly(),
]);
export const completedTextObservationSchema = z.union([
  akumaTextObservationSchema.options[0],
  akumaTextObservationSchema.options[2],
  akumaTextObservationSchema.options[3],
]);
const askSubject = { akumaId: akumaIdSchema, tellId: z.string(), interrupt: interruptSchema.exactOptional() };
const tellAnswer = {
  ...askSubject,
  wake: pendingWakeSchema.exactOptional(),
  input: completedTextObservationSchema.exactOptional(),
};
export const akumaTellResultSchema = z.union([
  z.strictObject({ kind: z.literal("admitted"), ...tellAnswer }).readonly(),
  z
    .strictObject({
      kind: z.literal("failed"),
      ...tellAnswer,
      failures: z.tuple([tellFailureSchema], tellFailureSchema).readonly(),
    })
    .readonly(),
]);
export const akumaAskObservationSchema = z.union([
  z.strictObject({ kind: z.literal("answered"), answer: z.json() }).readonly(),
  akumaTextObservationSchema.options[1],
  z.strictObject({ kind: z.literal("invalid-output"), diagnostic: z.string(), answer: z.string() }).readonly(),
  akumaTextObservationSchema.options[2],
  akumaTextObservationSchema.options[3],
]);
const settledAskSubject = { ...askSubject, wake: failedWakeSchema.exactOptional() };
const pendingAskSubject = { ...askSubject, wake: z.union([pendingWakeSchema, failedWakeSchema]).exactOptional() };
export const akumaAskResultSchema = z.union([
  akumaAskObservationSchema.options[0].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[1].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[2].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[3].unwrap().extend(pendingAskSubject).readonly(),
  akumaAskObservationSchema.options[4].unwrap().extend(pendingAskSubject).readonly(),
]);

export type AkumaObservation = z.output<typeof akumaObservationSchema>;
export type AkumaUnobserved = Readonly<{ id: AkumaId; diagnostic: string }>;
export type AkumaWaitItem = z.output<typeof akumaWaitItemSchema>;
export type AkumaWaitResult = z.output<typeof akumaWaitResultSchema>;
export type AkumaKillResult = z.output<typeof akumaKillResultSchema>;
export type AkumaTellResult = z.output<typeof akumaTellResultSchema>;
export type AkumaAskObservation = z.output<typeof akumaAskObservationSchema>;
export type AkumaAskResult = z.output<typeof akumaAskResultSchema>;

/** Project this invocation's already observed admission, never reread it. */
export function tellAdmissionEvidence(akumaId: AkumaId, tell: TellResult) {
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
    ...(interruption === undefined || interruption.kind === "completed"
      ? {}
      : {
          interrupt:
            interruption.kind === "pending"
              ? { kind: "pending" as const }
              : { kind: "unavailable" as const, evidence: interruption.evidence },
        }),
  };
}

/** Tell judges wake and observation together; an answer cannot erase a failed wake. */
export function completeTell(
  receipt: ReturnType<typeof tellAdmissionEvidence>,
  observation?: z.output<typeof akumaTextObservationSchema>,
): AkumaTellResult {
  const { wake, ...subject } = receipt;
  const failures: TellFailure[] = [];
  if (wake?.kind === "failed") {
    const { kind: _kind, ...failure } = wake;
    failures.push({ stage: "wake", ...failure });
  }
  if (observation?.kind === "failed") failures.push({ stage: "observation", diagnostic: observation.diagnostic });
  const answer = {
    ...subject,
    ...(wake?.kind === "pending" ? { wake } : {}),
    ...(observation === undefined || observation.kind === "failed" ? {} : { input: observation }),
  };
  const [first, ...rest] = failures;
  return first === undefined
    ? { kind: "admitted", ...answer }
    : { kind: "failed", ...answer, failures: [first, ...rest] };
}
