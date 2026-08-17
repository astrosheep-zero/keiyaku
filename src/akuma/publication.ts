import {
  HeldAkumaLeash,
  initializeHeart,
  readHeart,
  readSeal,
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
export const BIRTH_TIMEOUT_MS = 30_000;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settleTimedOutBirth(paths: AkumaPaths): Promise<Soul | null> {
  const leash = await HeldAkumaLeash.try(paths);
  if (leash === null) return null;
  let result: "born" | "sealed";
  try {
    result = await leash.sealIfUnborn(paths, {
      evidence: "call-timeout",
      at: new Date().toISOString(),
    });
  } finally { leash.release(); }
  if (result === "sealed") {
    const seal = await readSeal(paths);
    throw new Error(seal?.evidence === "call-timeout" || seal === null
      ? "Akuma body failed before birth"
      : seal.evidence);
  }
  const soul = await readSoul(paths);
  if (soul === null) throw new Error("Akuma birth settled without a soul");
  return soul;
}

async function observedBirthFailure(paths: AkumaPaths): Promise<string | null> {
  const leash = await HeldAkumaLeash.try(paths);
  if (leash === null) return null;
  try { return leash.readSeal()?.evidence ?? null; }
  finally { leash.release(); }
}

async function awaitBirth(paths: AkumaPaths, signal?: AbortSignal): Promise<Soul> {
  const deadline = performance.now() + BIRTH_TIMEOUT_MS;
  for (;;) {
    signal?.throwIfAborted();
    const soul = await readSoul(paths);
    if (soul !== null) return soul;
    const failure = await observedBirthFailure(paths);
    if (failure !== null) throw new Error(failure);
    if (performance.now() >= deadline) {
      const settled = await settleTimedOutBirth(paths);
      if (settled !== null) return settled;
    }
    await abortableDelay(POLL_MS, signal);
  }
}

async function takeLeashUntil(paths: AkumaPaths, deadline: number): Promise<HeldAkumaLeash | null> {
  for (;;) {
    const leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) return leash;
    if (performance.now() >= deadline) return null;
    await abortableDelay(POLL_MS);
  }
}

async function awaitAsleepBirth(paths: AkumaPaths): Promise<void> {
  const leash = await takeLeashUntil(paths, performance.now() + BIRTH_TIMEOUT_MS);
  if (leash === null) throw new Error("Forked Akuma did not finish its birth body");
  try {
    if ((await readHeart(paths)).latestBody?.end !== "exited") {
      throw new Error("Forked Akuma birth body did not exit cleanly");
    }
  } finally { leash.release(); }
}

async function sealLocalFailure(allocated: AllocatedAkuma, error: unknown): Promise<void> {
  try {
    const leash = await HeldAkumaLeash.try(allocated.paths);
    if (leash === null) return;
    try {
      await leash.sealIfUnborn(allocated.paths, {
        evidence: diagnostic(error),
        at: new Date().toISOString(),
      });
    } finally { leash.release(); }
  } catch { /* the original local publication failure remains authoritative */ }
}

export async function publishAkuma(input: Readonly<{
  worldPath: string;
  archetype: string;
  awaitAsleep?: boolean;
  reserve?(allocated: AllocatedAkuma): Promise<void>;
  launch(allocated: AllocatedAkuma): Promise<void>;
  signal?: AbortSignal;
}>): Promise<AllocatedAkuma> {
  input.signal?.throwIfAborted();
  const allocated = await allocateAkumaDirectory({ worldRoot: input.worldPath, archetype: input.archetype });
  try {
    await initializeHeart(allocated.paths);
    input.signal?.throwIfAborted();
    await input.reserve?.(allocated);
    input.signal?.throwIfAborted();
    await input.launch(allocated);
    input.signal?.throwIfAborted();
  } catch (error) {
    await sealLocalFailure(allocated, error);
    throw error;
  }
  const soul = await awaitBirth(allocated.paths, input.signal);
  if (soul.id !== allocated.id) throw new Error("Akuma birth returned a different identity");
  if (input.awaitAsleep === true) await awaitAsleepBirth(allocated.paths);
  return allocated;
}
