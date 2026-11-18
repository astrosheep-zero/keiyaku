import { abortableDelay } from "./abort.js";
import { HeldAkumaLeash, readHeart } from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";

const LEASH_RETRY_MS = 100;
const LEASH_ACQUISITION_TIMEOUT_MS = 1_000;
const ACTION_CONFIRMATION_MS = 30_000;
const FINAL_OBSERVATION_MS = 100;
const confirmationExpired = new Error("Akuma action confirmation deadline");

/** Reserve the last slice of the action budget for a final, read-only judgment. */
export async function confirmAction<T>(
  signal: AbortSignal | undefined,
  observe: (signal: AbortSignal) => Promise<T>,
  atDeadline: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const working = new AbortController();
  const final = new AbortController();
  const combine = (owned: AbortSignal) => (signal === undefined ? owned : AbortSignal.any([signal, owned]));
  const stop = setTimeout(() => working.abort(confirmationExpired), ACTION_CONFIRMATION_MS - FINAL_OBSERVATION_MS);
  const end = setTimeout(() => final.abort(confirmationExpired), ACTION_CONFIRMATION_MS);
  try {
    return await observe(combine(working.signal));
  } catch (error) {
    signal?.throwIfAborted();
    if (error !== confirmationExpired) throw error;
    return await atDeadline(combine(final.signal));
  } finally {
    clearTimeout(stop);
    clearTimeout(end);
  }
}

export function confirmationTimedOut(error: unknown): boolean {
  return error === confirmationExpired;
}

/** Acquire the execution seat with one bounded control-side wait. */
export async function acquireLeash(
  paths: AkumaPaths,
  input: Readonly<{ deadline?: number; signal?: AbortSignal; bodySequence?: number }> = {},
): Promise<HeldAkumaLeash | null> {
  const deadline = input.deadline ?? performance.now() + LEASH_ACQUISITION_TIMEOUT_MS;
  for (;;) {
    input.signal?.throwIfAborted();
    const leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) {
      if (input.signal?.aborted) leash.release();
      input.signal?.throwIfAborted();
      return leash;
    }
    if (input.bodySequence !== undefined) {
      const latest = (await readHeart(paths, input.signal)).latestBody;
      if (latest?.sequence !== input.bodySequence || latest.hung !== undefined) return null;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    await abortableDelay(Math.min(LEASH_RETRY_MS, remaining), input.signal);
  }
}
