import { z } from "zod";
import { abortableDelay } from "./abort.js";
import type { Soul } from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";
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
    completion: z.object({ contractId: z.string().optional() }).strict().optional(),
  })
  .strict();
export type BodyLaunch = z.infer<typeof bodyLaunchSchema>;

export type ChildBodyLaunch = Readonly<{
  paths: AkumaPaths;
  seed: Omit<Soul, "createdAt">;
  birthInitiator?: string;
  completion?: Readonly<{ contractId?: string }>;
}>;

/** Live launch evidence only; Heart and leash alone judge birth and settlement. */
export type BodyLaunchEnd = Readonly<{
  diagnostic: string;
  held?: boolean;
  child?: Readonly<{ log: Readonly<{ path: string }> }>;
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
  let end: BodyLaunchEnd | undefined;
  let polling: AbortController | undefined;
  const complete = (value: BodyLaunchEnd): void => {
    end = value;
    polling?.abort();
  };
  void child.completed.then(complete, (error: unknown) => {
    complete({ diagnostic: error instanceof Error ? error.message : String(error) });
  });
  for (;;) {
    signal?.throwIfAborted();
    const completed = end;
    const value = await observe();
    if (value !== null) return { kind: "observed", value };
    if (completed !== undefined) return { kind: "completed", end: completed };
    if (end !== undefined) continue;
    const poll = (polling = new AbortController());
    try {
      await schedule(100, signal === undefined ? poll.signal : AbortSignal.any([poll.signal, signal]));
    } catch (error) {
      signal?.throwIfAborted();
      if (!poll.signal.aborted) throw error;
    } finally {
      polling = undefined;
    }
  }
}
