import { stat } from "node:fs/promises";
import { z } from "zod";
import { abortableDelay } from "./abort.js";
import { AkumaWorkdirMissingError } from "./akuma-errors.js";
import type { Soul } from "./heart/index.js";
import { akumaPathsSchema, type AkumaId, type AkumaPaths } from "./identity.js";
import { decodeSoulSeed } from "./heart/soul.js";
import { sessionAdmissionSchema } from "./heart/rows.js";

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
    birthInitiator: z.string().optional(),
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
  failed?: boolean;
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

/** Only positive absence is a missing frozen coordinate, not an unreadable path. */
export async function observeLaunchPath(path: string): Promise<"present" | "absent" | Readonly<{ cause: unknown }>> {
  try {
    await stat(path);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : { cause: error };
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function diagnoseLaunchFailure(
  { argv: [executable], cwd, akumaId }: Readonly<{ argv: readonly string[]; cwd: string; akumaId: AkumaId }>,
  wake: boolean,
  cause: unknown,
): Promise<Error> {
  const action = wake ? `Wake of ${akumaId}` : `Body birth for ${akumaId}`;
  const native = cause as NodeJS.ErrnoException | undefined;
  const options = { cause };
  // Native launch evidence is distinct from filesystem errors opening the run log.
  if (executable === undefined || !(native?.syscall === "spawn" || native?.syscall?.startsWith("spawn ") === true))
    return new Error(`${action} failed in ${cwd}: ${diagnostic(cause)}`, options);
  const detail = [`${native.code ?? "launch error"}: executable ${executable}, frozen execution directory ${cwd}`];
  if (native.code === "ENOENT") {
    const [directory, program] = await Promise.all([observeLaunchPath(cwd), observeLaunchPath(executable)]);
    const executableDiagnostic =
      program === "present"
        ? undefined
        : program === "absent"
          ? `waking process executable ${executable} no longer exists; re-enter with a live runtime`
          : `cannot observe executable ${executable}: ${diagnostic(program.cause)}`;
    if (directory === "absent") {
      if (wake) return new AkumaWorkdirMissingError(akumaId, cwd, options, executableDiagnostic);
      detail.push(`frozen execution directory ${cwd} no longer exists`);
    } else if (directory !== "present") {
      detail.push(`cannot observe frozen execution directory ${cwd}: ${diagnostic(directory.cause)}`);
    }
    if (executableDiagnostic !== undefined) detail.push(executableDiagnostic);
  }
  return Object.assign(new Error(`${action} failed: ${detail.join("; ")}`, options), { code: native.code });
}

/** Observe durable custody first, including once more after live launch completion. */
export async function observeBodyLaunch<T>(
  child: LiveBodyLaunch,
  observe: () => Promise<T | null>,
  schedule: (milliseconds: number, signal: AbortSignal) => Promise<void> = abortableDelay,
  signal?: AbortSignal,
  witnessFailure?: (end: BodyLaunchEnd) => void,
): Promise<Readonly<{ value: T; end?: BodyLaunchEnd }> | Readonly<{ value: null; end: BodyLaunchEnd }>> {
  let end: BodyLaunchEnd | undefined;
  let polling: AbortController | undefined;
  const complete = (value: BodyLaunchEnd): void => {
    end = value;
    polling?.abort();
  };
  void child.completed.then(complete, (error: unknown) => {
    complete({ failed: true, diagnostic: error instanceof Error ? error.message : String(error) });
  });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const completed = end;
      const value = await observe();
      if (value !== null) return { value, ...(end === undefined ? {} : { end }) };
      if (completed !== undefined) return { value: null, end: completed };
      if (end !== undefined) continue;
      const poll = (polling = new AbortController());
      try {
        await schedule(100, signal === undefined ? poll.signal : AbortSignal.any([poll.signal, signal]));
      } catch (error) {
        if (!poll.signal.aborted || error !== poll.signal.reason) throw error;
      } finally {
        polling = undefined;
      }
    }
  } catch (error) {
    if (end?.failed) witnessFailure?.(end);
    throw error;
  }
}
