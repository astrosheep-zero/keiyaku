import { z } from "zod";
import { tellRowSchema } from "./projection.js";
import type { WorldRoot } from "../world.js";
import { bornStatus, defaultWaitComplete, readWaitComplete, waitForObservation } from "./akuma-observe.js";
import { recordTell, type TellFact } from "./heart/index.js";
import { pathsForAkumaId, type AkumaId } from "./identity.js";
export const BIRTH_TIMEOUT_MS = 30_000;

export type CallInitialTell = Readonly<{
  tellId: string;
  body: string;
  schemaJson?: string;
  initiator?: string;
}>;

export type InitialTellAdmissionInput = Readonly<{
  id: AkumaId;
  initialTell: CallInitialTell;
  signal?: AbortSignal;
}>;

export const tellWakeSchema = z.union([
  z.strictObject({ kind: z.literal("told") }).readonly(),
  z.strictObject({ kind: z.literal("held") }).readonly(),
  z.strictObject({ kind: z.literal("pursuing") }).readonly(),
  z
    .strictObject({
      kind: z.literal("failed"),
      diagnostic: z.string(),
      child: z
        .strictObject({
          log: z.strictObject({ path: z.string() }).readonly(),
        })
        .readonly()
        .exactOptional(),
    })
    .readonly(),
]);
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
export function pendingTellReceipt(tell: TellFact): TellResult {
  return {
    admission: { tellId: tell.id },
    row: { sequence: tell.sequence, at: tell.recordedAt, text: tell.body },
    wake: { kind: "pursuing" },
  };
}

export type CallInitialTellAdmission =
  | Readonly<{ kind: "admitted"; tell: TellFact; wake: Promise<TellResult> }>
  | Readonly<{ kind: "not-born" }>
  | Readonly<{ kind: "birth-failed"; diagnostic: string }>;

export async function admitCallInitialTell(
  input: Readonly<{
    world: WorldRoot;
    id: AkumaId;
    initialTell: CallInitialTell;
    signal?: AbortSignal;
    now?: () => string;
    wake(tell: TellFact): Promise<TellResult>;
  }>,
): Promise<CallInitialTellAdmission> {
  const paths = pathsForAkumaId(input.world, input.id);
  const birth = await waitForObservation({
    timeoutMs: BIRTH_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    probe: async () => await readWaitComplete(input.world, [input.id], "all", input.signal),
    observe: async () => (await bornStatus(paths, input.id, { aperture: "receipt" })).status,
    complete: defaultWaitComplete,
  });
  if (birth.reason !== "completed" || birth.value.life !== "asleep") {
    return {
      kind: "birth-failed",
      diagnostic: `Akuma ${input.id} prompt-free birth did not settle cleanly`,
    };
  }
  input.signal?.throwIfAborted();
  const recorded = await recordTell(paths, {
    kind: "tell",
    id: input.initialTell.tellId,
    body: input.initialTell.body,
    recordedAt: input.now?.() ?? new Date().toISOString(),
    ...(input.initialTell.schemaJson === undefined ? {} : { schemaJson: input.initialTell.schemaJson }),
    ...(input.initialTell.initiator === undefined ? {} : { initiator: input.initialTell.initiator }),
  });
  if (recorded.kind === "not-born") return recorded;
  return { kind: "admitted", tell: recorded.tell, wake: input.wake(recorded.tell) };
}
