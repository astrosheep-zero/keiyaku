import {
  HeldAkumaLeash,
  initializeHeart,
  readHeart,
  readSoul,
  type Soul,
} from "./heart/index.js";
import {
  allocateAkumaDirectory,
  type AllocatedAkuma,
  type AkumaPaths,
} from "./identity.js";
import { abortableDelay } from "./abort.js";

const POLL_MS = 25;
export const BIRTH_TIMEOUT_MS = 5_000;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settleTimedOutBirth(paths: AkumaPaths): Soul | null {
  const leash = HeldAkumaLeash.try(paths);
  if (leash === null) return null;
  const result = leash.sealIfUnborn(paths, { evidence: "call-timeout", at: new Date().toISOString() });
  if (result === "sealed") throw new Error("Akuma body failed before birth");
  leash.release();
  const soul = readSoul(paths);
  if (soul === null) throw new Error("Akuma birth settled without a soul");
  return soul;
}

async function awaitBirth(paths: AkumaPaths, signal?: AbortSignal): Promise<Soul> {
  const deadline = performance.now() + BIRTH_TIMEOUT_MS;
  for (;;) {
    signal?.throwIfAborted();
    const soul = readSoul(paths);
    if (soul !== null) return soul;
    if (performance.now() >= deadline) {
      const settled = settleTimedOutBirth(paths);
      if (settled !== null) return settled;
    }
    await abortableDelay(POLL_MS, signal);
  }
}

async function takeLeashUntil(paths: AkumaPaths, deadline: number): Promise<HeldAkumaLeash | null> {
  for (;;) {
    const leash = HeldAkumaLeash.try(paths);
    if (leash !== null) return leash;
    if (performance.now() >= deadline) return null;
    await abortableDelay(POLL_MS);
  }
}

async function awaitAsleepBirth(paths: AkumaPaths): Promise<void> {
  const leash = await takeLeashUntil(paths, performance.now() + BIRTH_TIMEOUT_MS);
  if (leash === null) throw new Error("Forked Akuma did not finish its birth body");
  try {
    if (readHeart(paths).latestBody?.end !== "exited") {
      throw new Error("Forked Akuma birth body did not exit cleanly");
    }
  } finally { leash.release(); }
}

function sealLocalFailure(allocated: AllocatedAkuma, error: unknown): void {
  try {
    const leash = HeldAkumaLeash.try(allocated.paths);
    if (leash === null) return;
    try {
      leash.sealIfUnborn(allocated.paths, { evidence: diagnostic(error), at: new Date().toISOString() });
    } finally { leash.release(); }
  } catch { /* the original local publication failure remains authoritative */ }
}

export async function publishAkuma(input: Readonly<{
  worldPath: string;
  archetype: string;
  awaitAsleep?: boolean;
  reserve?(allocated: AllocatedAkuma): void;
  launch(allocated: AllocatedAkuma): Promise<void>;
  signal?: AbortSignal;
}>): Promise<AllocatedAkuma> {
  input.signal?.throwIfAborted();
  const allocated = allocateAkumaDirectory({ worldRoot: input.worldPath, archetype: input.archetype });
  try {
    initializeHeart(allocated.paths);
    input.signal?.throwIfAborted();
    input.reserve?.(allocated);
    input.signal?.throwIfAborted();
    await input.launch(allocated);
    input.signal?.throwIfAborted();
  } catch (error) {
    sealLocalFailure(allocated, error);
    throw error;
  }
  const soul = await awaitBirth(allocated.paths, input.signal);
  if (soul.id !== allocated.id) throw new Error("Akuma birth returned a different identity");
  if (input.awaitAsleep === true) await awaitAsleepBirth(allocated.paths);
  return allocated;
}
