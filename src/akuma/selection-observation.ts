import { z } from "zod";
import { akumaStatusSchema } from "./akuma.js";
import { currentWorkSchema } from "./status-projection.js";
import { activityRowSchema } from "./projection.js";
import { diffstatSchema } from "./heart/activity-schema.js";
import {
  failedWakeSchema,
  pendingWakeSchema,
  tellActionSchema,
  tellConfirmationStopSchema,
  type TellResult,
} from "./call-initial-tell.js";
import { dispatchAssociationSchema } from "./dispatch-association.js";
import { killEvidenceSchema } from "./heart/facts.js";
import { akumaAliasSchema } from "../identity/selector.js";
import { akumaIdSchema, turnHistoryIdSchema, type AkumaId } from "./identity.js";

export const akumaCatalogueRowSchema = z
  .strictObject({
    id: akumaIdSchema,
    life: z.enum(["running", "asleep", "stranded", "hung", "untidy", "killed", "unborn", "stillborn"]),
    lifeAt: z.string().exactOptional(),
    lastActivityAt: z.string().exactOptional(),
    pending: z.number().int().positive().exactOptional(),
    diagnostic: z.string().exactOptional(),
    aliases: z.array(akumaAliasSchema).nonempty().readonly().exactOptional(),
    parentAkumaId: akumaIdSchema.exactOptional(),
    contract: z
      .union([dispatchAssociationSchema.options[1], z.strictObject({ kind: z.literal("unavailable") }).readonly()])
      .exactOptional(),
  })
  .readonly();
export const akumaCatalogueSchema = z
  .strictObject({
    kind: z.literal("akuma-catalogue"),
    observedAt: z.string(),
    rows: z.array(akumaCatalogueRowSchema).nonempty().readonly().exactOptional(),
    more: z.literal(true).exactOptional(),
    aliasesError: z.string().exactOptional(),
  })
  .readonly();

export const akumaObservationSchema = z
  .strictObject({
    kind: z.literal("akuma"),
    id: akumaIdSchema,
    life: akumaStatusSchema.unwrap().shape.life,
    cwd: z.string(),
    provider: z.string(),
    model: z.string().exactOptional(),
    work: currentWorkSchema,
    recent: z.array(activityRowSchema).max(3).readonly().exactOptional(),
    lastActivityAt: z.string().exactOptional(),
    strandedReason: z.literal("resume-unsupported").exactOptional(),
    contract: z.union([dispatchAssociationSchema.options[1], dispatchAssociationSchema.options[2]]).exactOptional(),
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
export const observedAkumaWaitItemSchema = z
  .strictObject({
    kind: z.literal("observed"),
    id: akumaIdSchema,
    life: akumaStatusSchema.unwrap().shape.life,
    lastActivityAt: akumaCatalogueRowSchema.unwrap().shape.lastActivityAt,
    events: z.array(activityRowSchema).max(3).readonly().exactOptional(),
    eventsUnavailable: z.string().exactOptional(),
    pending: z.literal(true).exactOptional(),
    outcome: waitOutcomeSchema.exactOptional(),
    strandedReason: z.literal("resume-unsupported").exactOptional(),
  })
  .readonly();
export const akumaWaitItemSchema = z.union([
  observedAkumaWaitItemSchema,
  z.strictObject({ kind: z.literal("unobserved"), id: akumaIdSchema, diagnostic: z.string() }).readonly(),
  z.strictObject({ kind: z.literal("missing"), id: akumaIdSchema }).readonly(),
]);
function waitResultSchema<Item extends z.ZodType>(item: Item) {
  return z
    .strictObject({
      kind: z.literal("akuma"),
      reason: z.enum(["completed", "deadline"]),
      results: z.array(item).readonly(),
    })
    .readonly();
}
export const akumaWaitNormalResultSchema = waitResultSchema(observedAkumaWaitItemSchema);
export const akumaWaitResultSchema = waitResultSchema(akumaWaitItemSchema);
export const akumaKillResultSchema = z
  .strictObject({
    results: z.array(z.strictObject({ id: akumaIdSchema, outcome: killEvidenceSchema }).readonly()).readonly(),
  })
  .readonly();
export const operationDiagnosticSchema = z
  .strictObject({ kind: z.enum(["authority-corruption", "infrastructure"]), diagnostic: z.string() })
  .readonly();
const interruptSchema = z.union([
  pendingWakeSchema,
  z.strictObject({ kind: z.literal("unavailable"), evidence: z.enum(["hung", "untidy"]) }).readonly(),
]);
const interruptReceiptSchema = z.union([
  ...interruptSchema.options,
  z.strictObject({ kind: z.literal("completed") }).readonly(),
]);
export const tellFailureSchema = z.union([
  failedWakeSchema
    .unwrap()
    .omit({ kind: true })
    .extend({ stage: z.literal("wake") })
    .readonly(),
  tellConfirmationStopSchema
    .unwrap()
    .omit({ kind: true })
    .extend({ stage: z.literal("confirmation") })
    .readonly(),
  z.strictObject({ stage: z.literal("observation"), diagnostic: z.string() }).readonly(),
]);
type TellFailure = z.output<typeof tellFailureSchema>;
const akumaTextObservationSchema = z.union([
  z
    .strictObject({ kind: z.literal("answered"), answer: z.string(), completedAt: z.string().exactOptional() })
    .readonly(),
  z
    .strictObject({ kind: z.literal("failed"), diagnostic: z.string(), completedAt: z.string().exactOptional() })
    .readonly(),
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
  action: tellActionSchema.exactOptional(),
  wake: pendingWakeSchema.exactOptional(),
  input: completedTextObservationSchema.exactOptional(),
  interrupt: interruptReceiptSchema.exactOptional(),
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
  z.strictObject({ kind: z.literal("answered"), answer: z.json(), completedAt: z.string().exactOptional() }).readonly(),
  akumaTextObservationSchema.options[1],
  z
    .strictObject({
      kind: z.literal("invalid-output"),
      diagnostic: z.string(),
      answer: z.string(),
      completedAt: z.string().exactOptional(),
    })
    .readonly(),
  akumaTextObservationSchema.options[2],
  akumaTextObservationSchema.options[3],
]);
const settledAskSubject = { ...askSubject, wake: failedWakeSchema.exactOptional() };
const pendingAskSubject = { ...askSubject, wake: z.union([pendingWakeSchema, failedWakeSchema]).exactOptional() };
export const akumaAskNormalResultSchema = z.union([
  akumaAskObservationSchema.options[0].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[3].unwrap().extend(pendingAskSubject).readonly(),
  akumaAskObservationSchema.options[4].unwrap().extend(pendingAskSubject).readonly(),
]);
export const akumaAskResultSchema = z.union([
  ...akumaAskNormalResultSchema.options,
  akumaAskObservationSchema.options[1].unwrap().extend(settledAskSubject).readonly(),
  akumaAskObservationSchema.options[2].unwrap().extend(settledAskSubject).readonly(),
]);

export type AkumaObservation = z.output<typeof akumaObservationSchema>;
export type AkumaUnobserved = Readonly<{ id: AkumaId; diagnostic: string }>;
export type AkumaWaitItem = z.output<typeof akumaWaitItemSchema>;
export type AkumaWaitResult = z.output<typeof akumaWaitResultSchema>;
export type AkumaKillResult = z.output<typeof akumaKillResultSchema>;
export type AkumaTellResult = z.output<typeof akumaTellResultSchema>;
export type AkumaAskObservation = z.output<typeof akumaAskObservationSchema>;
export type AkumaAskResult = z.output<typeof akumaAskResultSchema>;

type TellAdmissionEvidence = Readonly<{
  akumaId: AkumaId;
  tellId: string;
  action?: z.output<typeof tellActionSchema>;
  interrupt?: z.output<typeof interruptReceiptSchema>;
  wake?: z.output<typeof pendingWakeSchema | typeof failedWakeSchema | typeof tellConfirmationStopSchema>;
}>;

/** Project this invocation's already observed admission, never reread it. */
export function tellAdmissionEvidence(akumaId: AkumaId, tell: TellResult): TellAdmissionEvidence {
  const { interruption, wake } = tell;
  const subject = {
    akumaId,
    tellId: tell.admission.tellId,
    ...(interruption === undefined
      ? {}
      : {
          interrupt:
            interruption.kind === "unavailable"
              ? { kind: interruption.kind, evidence: interruption.evidence }
              : { kind: interruption.kind },
        }),
  };
  return wake.kind === "started" || wake.kind === "steering"
    ? { ...subject, action: wake }
    : { ...subject, wake: wake as NonNullable<TellAdmissionEvidence["wake"]> };
}

/** Tell judges wake and observation together; an answer cannot erase a failed wake. */
export function completeTell(
  receipt: ReturnType<typeof tellAdmissionEvidence>,
  observation?: z.output<typeof akumaTextObservationSchema>,
  exceptional = false,
): AkumaTellResult {
  const { wake, interrupt, ...subject } = receipt;
  const failures: TellFailure[] = [];
  if (wake?.kind === "failed") {
    const { kind: _kind, ...failure } = wake;
    failures.push({ stage: "wake", ...failure });
  } else if (wake?.kind === "confirmation-stopped") {
    failures.push({ stage: "confirmation", reason: wake.reason, diagnostic: wake.diagnostic });
  }
  if (observation?.kind === "failed") failures.push({ stage: "observation", diagnostic: observation.diagnostic });
  const answer = {
    ...subject,
    ...(wake?.kind === "pending" ? { wake } : {}),
    ...(observation === undefined || observation.kind === "failed" ? {} : { input: observation }),
  };
  const [first, ...rest] = failures;
  const result: AkumaTellResult =
    first === undefined
      ? {
          kind: "admitted",
          ...answer,
          ...(interrupt === undefined || (!exceptional && interrupt.kind === "completed") ? {} : { interrupt }),
        }
      : { kind: "failed", ...answer, ...(interrupt === undefined ? {} : { interrupt }), failures: [first, ...rest] };
  return exceptional ? akumaTellResultSchema.parse(result) : result;
}
