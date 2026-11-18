import { z } from "zod";
import { tellRowSchema } from "./projection.js";
import type { PauseFact, TellFact } from "./heart/index.js";
import { turnHistoryIdSchema, type AkumaId } from "./identity.js";

export type CallInitialTell = Readonly<{
  tellId: string;
  body: string;
  initiator?: string;
}>;

export type InitialTellAdmissionInput = Readonly<{
  id: AkumaId;
  initialTell: CallInitialTell;
  signal?: AbortSignal;
}>;

export const tellActionSchema = z
  .strictObject({
    kind: z.enum(["started", "steering"]),
    historyId: turnHistoryIdSchema,
  })
  .readonly();
export const tellConfirmationStopSchema = z
  .strictObject({
    kind: z.literal("confirmation-stopped"),
    reason: z.enum(["deadline", "hung", "untidy", "stopped"]),
    diagnostic: z.string(),
  })
  .readonly();
export const pendingWakeSchema = z.strictObject({ kind: z.literal("pending") }).readonly();
export const failedWakeSchema = z
  .strictObject({
    kind: z.literal("failed"),
    diagnostic: z.string(),
    reason: z.literal("undelivered").exactOptional(),
    logPath: z.string().exactOptional(),
  })
  .readonly();
const tellWakeSchema = z.union([tellActionSchema, tellConfirmationStopSchema, pendingWakeSchema, failedWakeSchema]);
export const tellResultSchema = z
  .strictObject({
    admission: z.strictObject({ tellId: z.string() }).readonly(),
    row: tellRowSchema.unwrap().pick({ sequence: true, at: true, text: true }).strict().readonly(),
    wake: tellWakeSchema,
    interruption: z
      .union([
        z.strictObject({ kind: z.literal("completed"), bodySequence: z.number() }).readonly(),
        z.strictObject({ kind: z.literal("pending"), bodySequence: z.number() }).readonly(),
        z
          .strictObject({
            kind: z.literal("unavailable"),
            bodySequence: z.number(),
            evidence: z.enum(["hung", "untidy"]),
          })
          .readonly(),
      ])
      .exactOptional(),
  })
  .readonly();

export type TellWake = z.output<typeof tellWakeSchema>;

/** The progress receipt carries only the Tell coordinates progress needs; Heart keeps the native row. */
export type TellResult = z.output<typeof tellResultSchema>;

/** Freeze known admission before waiting for wake; no later read can replace it. */
export function pendingTellReceipt(tell: TellFact, barrier?: PauseFact): TellResult {
  return {
    admission: { tellId: tell.id },
    row: { sequence: tell.sequence, at: tell.recordedAt, text: tell.body },
    wake: { kind: "pending" },
    ...(barrier === undefined ? {} : { interruption: { kind: "pending", bodySequence: barrier.bodySequence } }),
  };
}

export type CallInitialTellAdmission =
  | Readonly<{ kind: "admitted"; tell: TellFact; wake: Promise<TellResult> }>
  | Readonly<{ kind: "not-born" }>;
