import { z } from "zod";
import { tellRowSchema } from "./projection.js";
import type { WorldRoot } from "../world.js";
import { bornStatus, defaultWaitComplete, readWaitComplete, waitForObservation } from "./akuma-observe.js";
import { recordTell, type TellFact } from "./heart/index.js";
import { pathsForAkumaId, type AkumaId } from "./identity.js";
import type { TellRow } from "./heart/facts.js";
import { BIRTH_TIMEOUT_MS } from "./publication.js";

export type CallInitialTell = Readonly<{
  tellId: string;
  body: string;
  schemaJson?: string;
  initiator?: string;
}>;

export type InitialTellAdmissionInput = Readonly<{
  id: AkumaId;
  initialTell: CallInitialTell;
  contractId?: string;
  signal?: AbortSignal;
}>;

export const tellWakeSchema = z.union([
  z.strictObject({ kind: z.literal("told") }).readonly(),
  z.strictObject({ kind: z.literal("held") }).readonly(),
  z.strictObject({ kind: z.literal("pursuing"), bodySequence: z.number() }).readonly(),
  z
    .strictObject({
      kind: z.literal("failed"),
      diagnostic: z.string(),
      child: z
        .strictObject({
          code: z.number().nullable(),
          signal: z.string().nullable(),
          log: z.strictObject({ path: z.string(), from: z.number(), to: z.number() }).readonly(),
        })
        .readonly()
        .exactOptional(),
    })
    .readonly(),
]);
export const tellResultSchema = z
  .strictObject({
    admission: z.strictObject({ fact: z.literal("recorded"), tellId: z.string() }).readonly(),
    row: tellRowSchema,
    wake: tellWakeSchema,
    interruption: z
      .union([
        z
          .strictObject({
            kind: z.literal("completed"),
            bodySequence: z.number(),
            putDown: z.enum(["was-idle", "self-aborted"]),
          })
          .readonly(),
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

export type TellWake =
  | Readonly<{ kind: "told" }>
  | Readonly<{ kind: "held" }>
  | Readonly<{ kind: "pursuing"; bodySequence: number }>
  | Readonly<{
      kind: "failed";
      diagnostic: string;
      child?: Readonly<{
        code: number | null;
        signal: string | null;
        log: Readonly<{ path: string; from: number; to: number }>;
      }>;
    }>;

export type TellResult = Readonly<{
  admission: Readonly<{ fact: "recorded"; tellId: string }>;
  row: TellRow;
  wake: TellWake;
  interruption?:
    | Readonly<{ kind: "completed"; bodySequence: number; putDown: "was-idle" | "self-aborted" }>
    | Readonly<{ kind: "pending"; bodySequence: number }>
    | Readonly<{ kind: "unavailable"; bodySequence: number; evidence: "hung" | "untidy" }>;
}>;

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
