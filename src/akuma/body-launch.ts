import { z } from "zod";
import { abortable, abortableDelay } from "./abort.js";
import type { TellWake } from "./call-initial-tell.js";
import { decodeSoulSeed } from "./heart/soul.js";
import { sessionAdmissionSchema } from "./heart/rows.js";
import { akumaPathsSchema } from "./identity.js";

const launchSeedSchema = z.unknown().transform((value, context) => {
  try {
    return decodeSoulSeed(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid Body birth seed" });
    return z.NEVER;
  }
});
export const bodyLaunchSchema = z
  .object({
    paths: akumaPathsSchema,
    seed: launchSeedSchema.optional(),
    birthSession: sessionAdmissionSchema.optional(),
    initialBody: z.string().optional(),
    initiator: z.string().optional(),
    birthInitiator: z.string().optional(),
    initialSchemaJson: z.string().optional(),
    refuseIfHeld: z.boolean().optional(),
    handoffFromBodySequence: z.number().int().positive().optional(),
    completion: z.object({ contractId: z.string().optional() }).strict().optional(),
  })
  .strict();
export type BodyLaunch = z.infer<typeof bodyLaunchSchema>;

/** Live launch evidence only; Heart and leash alone judge birth and settlement. */
export type BodyLaunchEnd = Readonly<{
  diagnostic: string;
  held?: boolean;
  child?: Extract<TellWake, { child: unknown }>["child"];
}>;
export type LiveBodyLaunch = Readonly<{
  /** Launch completion evidence, never a product outcome or closure proof. */
  completed: Promise<BodyLaunchEnd>;
  /** Ask owned resources to retire; force requests supported disposal, not shared-host termination or rollback. */
  cancel(force?: boolean): Promise<void>;
  /** Relinquish this holder's custody, not kill or closure, with no guarantee of host survival. */
  release(): void;
}>;
export type BodyLauncher = (launch: BodyLaunch) => Promise<LiveBodyLaunch>;

/** Observe durable custody first, including once more after live launch completion. */
export async function observeBodyLaunch<T>(
  child: LiveBodyLaunch,
  observe: () => Promise<T | null>,
  schedule: (milliseconds: number, signal: AbortSignal) => Promise<void> = abortableDelay,
  signal?: AbortSignal,
): Promise<Readonly<{ kind: "observed"; value: T }> | Readonly<{ kind: "completed"; end: BodyLaunchEnd }>> {
  for (;;) {
    signal?.throwIfAborted();
    const value = await observe();
    if (value !== null) return { kind: "observed", value };
    const controller = new AbortController();
    const timer = schedule(100, controller.signal).then(() => ({ kind: "timer" as const }));
    let winner;
    try {
      const waited = Promise.race([child.completed.then((end) => ({ kind: "completed" as const, end })), timer]);
      winner = signal === undefined ? await waited : await abortable(waited, signal);
    } finally {
      controller.abort();
      await timer.catch(() => undefined);
    }
    if (winner.kind === "timer") continue;
    const final = await observe();
    return final === null ? winner : { kind: "observed", value: final };
  }
}

export function launchEndWake(end: BodyLaunchEnd): Extract<TellWake, { kind: "held" | "failed" }> {
  return end.held
    ? { kind: "held" }
    : { kind: "failed", diagnostic: end.diagnostic, ...(end.child === undefined ? {} : { child: end.child }) };
}
