import { z } from "zod";
import { tellRowSchema } from "./projection.js";
const nonblankTextSchema = z.string().refine((value) => value.trim() !== "");
import { defaultWaitComplete, bornStatus, readWaitComplete, waitForObservation } from "./akuma-observe.js";
import { recordTell, type TellFact } from "./heart/index.js";
import { pathsForAkuId, type AkuId } from "./identity.js";
import { BIRTH_TIMEOUT_MS } from "./publication.js";
import type { WorldRoot } from "../world.js";

export type CallInitialTell = Readonly<{
  tellId: string;
  body: string;
  schemaJson?: string;
  initiator?: string;
}>;

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
export const tellWakeSchema = z.union([
  z.object({ kind: z.literal("told") }).strict(),
  z.object({ kind: z.literal("held") }).strict(),
  z.object({ kind: z.literal("pursuing"), bodySequence: z.number().int().nonnegative() }).strict(),
  failedTellWakeSchema,
]);
export const tellResultSchema = z
  .object({
    admission: z.object({ fact: z.literal("recorded"), tellId: nonblankTextSchema }).strict(),
    row: tellRowSchema,
    wake: tellWakeSchema,
  })
  .strict();
export type TellWake = z.infer<typeof tellWakeSchema>;
export type TellResult = z.infer<typeof tellResultSchema>;

export type CallInitialTellAdmission =
  | Readonly<{ kind: "admitted"; tell: TellFact; wake: Promise<TellResult> }>
  | Readonly<{ kind: "not-born" }>
  | Readonly<{ kind: "birth-failed"; diagnostic: string }>;

export async function admitCallInitialTell(
  input: Readonly<{
    world: WorldRoot;
    id: AkuId;
    initialTell: CallInitialTell;
    signal?: AbortSignal;
    now?: () => string;
    wake(tell: TellFact): Promise<TellResult>;
  }>,
): Promise<CallInitialTellAdmission> {
  const paths = pathsForAkuId(input.world, input.id);
  const birth = await waitForObservation({
    timeoutMs: BIRTH_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    probe: async () => await readWaitComplete(input.world, input.id),
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
