import { z } from "zod";
import { akumaStatusSchema } from "./akuma.js";
import {
  canceledTurnSchema,
  doneTurnSchema,
  failedTurnSchema,
  settledTurnSchema,
  turnHistoryIdSchema,
  type SettledTurn,
} from "./projection.js";
import {
  failedWakeSchema,
  pendingWakeSchema,
  tellActionSchema,
  tellConfirmationStopSchema,
  type TellSettlement,
} from "./call-initial-tell.js";
import { dispatchAssociationSchema } from "./dispatch-association.js";
import { killEvidenceSchema } from "./heart/facts.js";
import { akumaAliasSchema } from "../identity/selector.js";
import { akumaIdSchema, type AkumaId } from "./identity.js";

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

const nativeStatus = akumaStatusSchema.unwrap();
export const akumaObservationSchema = nativeStatus
  .omit({ birth: true })
  .extend({
    kind: z.literal("akuma"),
    cwd: nativeStatus.shape.cwd.unwrap(),
    provider: nativeStatus.shape.provider.unwrap(),
    contract: z.union([dispatchAssociationSchema.options[1], dispatchAssociationSchema.options[2]]).exactOptional(),
  })
  .readonly();
const waitIdentity = { akuma: akumaIdSchema };
const observedWait = { ...waitIdentity, lastActivityAt: nativeStatus.shape.lastActivityAt };
const previousTurn = { last: settledTurnSchema.exactOptional() };
export const observedAkumaWaitItemSchema = z.union([
  ...settledTurnSchema.options.map((schema) => schema.unwrap().extend(observedWait).readonly()),
  z
    .strictObject({
      ...observedWait,
      ...previousTurn,
      state: z.literal("running"),
      turn: turnHistoryIdSchema.exactOptional(),
      events: z
        .union([nativeStatus.shape.recent.unwrap(), z.strictObject({ reason: z.string() }).readonly()])
        .exactOptional(),
    })
    .readonly(),
  z.strictObject({ ...observedWait, ...previousTurn, state: z.literal("waiting") }).readonly(),
  z
    .strictObject({ ...observedWait, ...previousTurn, state: z.enum(["failed", "canceled"]), reason: z.string() })
    .readonly(),
  z.strictObject({ ...observedWait, state: z.literal("idle") }).readonly(),
]);
export const akumaUnavailableWaitSchema = z
  .strictObject({
    ...observedWait,
    ...previousTurn,
    state: z.literal("unavailable"),
    reason: z.string().exactOptional(),
  })
  .readonly();
export const akumaWaitItemSchema = z.union([
  ...observedAkumaWaitItemSchema.options,
  akumaUnavailableWaitSchema,
  z.strictObject({ ...waitIdentity, state: z.literal("missing") }).readonly(),
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
const tellSubject = { akumaId: akumaIdSchema, tellId: z.string() };
const toldSchema = z
  .strictObject({ result: z.literal("told"), ...tellSubject, turn: turnHistoryIdSchema.exactOptional() })
  .readonly();
const noTellOutcome = z.strictObject({ ...tellSubject, state: z.enum(["idle", "waiting"]) }).readonly();
const tellFailedSchema = z
  .strictObject({
    result: z.literal("failed"),
    ...tellSubject,
    turn: turnHistoryIdSchema.exactOptional(),
    interrupt: interruptReceiptSchema.exactOptional(),
    failures: z.tuple([tellFailureSchema], tellFailureSchema).readonly(),
    outcome: settledTurnSchema.exactOptional(),
  })
  .readonly();
export const akumaTellNormalResultSchema = z.union([
  toldSchema,
  doneTurnSchema.unwrap().extend(tellSubject).readonly(),
  canceledTurnSchema.unwrap().extend(tellSubject).readonly(),
  noTellOutcome,
]);
export const akumaTellResultSchema = z.union([
  ...akumaTellNormalResultSchema.options,
  failedTurnSchema.unwrap().extend(tellSubject).readonly(),
  tellFailedSchema,
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
export function tellAdmissionEvidence(akumaId: AkumaId, tell: TellSettlement): TellAdmissionEvidence {
  const { interruption, wake, action } = tell;
  const subject = {
    ...(action === undefined ? {} : { action }),
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

/** Keep wake and control evidence shared with Spawn's independent initial-input receipt. */
export function completeTell(receipt: TellAdmissionEvidence) {
  const { wake, interrupt, ...subject } = receipt;
  const failures: TellFailure[] = [];
  if (wake?.kind === "failed") {
    const { kind: _kind, ...failure } = wake;
    failures.push({ stage: "wake", ...failure });
  } else if (wake?.kind === "confirmation-stopped") {
    failures.push({ stage: "confirmation", reason: wake.reason, diagnostic: wake.diagnostic });
  }
  const answer = { ...subject, ...(wake?.kind === "pending" ? { wake } : {}) };
  const [first, ...rest] = failures;
  return first === undefined
    ? { kind: "admitted" as const, ...answer }
    : {
        kind: "failed" as const,
        ...answer,
        ...(interrupt === undefined ? {} : { interrupt }),
        failures: [first, ...rest] as const,
      };
}

export function tellAnswerResult(
  id: AkumaId,
  receipt: TellSettlement,
  observed?: SettledTurn | Readonly<{ state: "idle" | "waiting" }>,
): AkumaTellResult {
  const evidence = tellAdmissionEvidence(id, receipt);
  return projectTellAnswer(evidence, observed);
}

export function interruptedTellAnswer(
  id: AkumaId,
  receipt: TellSettlement,
  reason: unknown,
  outcome?: SettledTurn,
): AkumaTellResult {
  const diagnostic = reason instanceof Error ? reason.message : String(reason);
  return projectTellAnswer(tellAdmissionEvidence(id, receipt), outcome, { stage: "observation", diagnostic });
}

function projectTellAnswer(
  admission: TellAdmissionEvidence,
  observed?: SettledTurn | Readonly<{ state: "idle" | "waiting" }>,
  stopped?: TellFailure,
): AkumaTellResult {
  const evidence = completeTell(admission);
  const subject = { akumaId: evidence.akumaId, tellId: evidence.tellId };
  const action = evidence.action === undefined ? {} : { turn: evidence.action.historyId };
  const failures: [TellFailure, ...TellFailure[]] | undefined =
    evidence.kind === "failed"
      ? [...evidence.failures, ...(stopped === undefined ? [] : [stopped])]
      : stopped === undefined
        ? undefined
        : [stopped];
  if (failures !== undefined) {
    for (const failure of failures) Object.freeze(failure);
    return {
      result: "failed",
      ...subject,
      ...action,
      failures: Object.freeze(failures),
      ...(admission.interrupt === undefined ? {} : { interrupt: admission.interrupt }),
      ...(observed !== undefined && "turn" in observed ? { outcome: observed } : {}),
    };
  }
  return observed === undefined ? { result: "told", ...subject, ...action } : { ...subject, ...observed };
}
