import { abortableDelay } from "./abort.js";
import { HeldAkumaLeash, readHeart } from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";

const LEASH_RETRY_MS = 100;
const LEASH_ACQUISITION_TIMEOUT_MS = 1_000;

/** Acquire the execution seat with one bounded control-side wait. */
export async function acquireLeash(
  paths: AkumaPaths,
  input: Readonly<{ deadline?: number; signal?: AbortSignal; bodySequence?: number }> = {},
): Promise<HeldAkumaLeash | null> {
  const deadline =
    input.deadline ?? (input.signal === undefined ? performance.now() + LEASH_ACQUISITION_TIMEOUT_MS : undefined);
  for (;;) {
    input.signal?.throwIfAborted();
    const leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) return leash;
    if (input.bodySequence !== undefined) {
      const latest = (await readHeart(paths)).latestBody;
      if (latest?.sequence !== input.bodySequence || latest.end !== undefined || latest.hung !== undefined) return null;
    }
    if (deadline !== undefined && performance.now() >= deadline) return null;
    const remaining =
      deadline === undefined ? LEASH_RETRY_MS : Math.min(LEASH_RETRY_MS, Math.max(0, deadline - performance.now()));
    await abortableDelay(remaining, input.signal);
  }
}
