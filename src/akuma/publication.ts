import { HeldAkumaLeash, initializeHeart, readHeart, readSeal, readSoul, type Soul } from "./heart/index.js";
import { allocateAkumaDirectory, type AllocatedAkuma, type AkumaPaths } from "./identity.js";
import { abortableDelay } from "./abort.js";
import type { DetachedProcessExit, OwnedProcess } from "../runtime/proc/run.js";

const POLL_MS = 100;
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
  } finally {
    leash.release();
  }
  if (result === "sealed") {
    const seal = await readSeal(paths);
    throw new Error(
      seal?.evidence === "call-timeout" || seal === null ? "Akuma body failed before birth" : seal.evidence,
    );
  }
  const soul = await readSoul(paths);
  if (soul === null) throw new Error("Akuma birth settled without a soul");
  return soul;
}

async function observedBirthFailure(paths: AkumaPaths): Promise<string | null> {
  const leash = await HeldAkumaLeash.try(paths);
  if (leash === null) return null;
  try {
    return leash.readSeal()?.evidence ?? null;
  } finally {
    leash.release();
  }
}

function preAdmissionDiagnostic(exit: DetachedProcessExit): string {
  return exit.code === null ? `pre-admission signal ${exit.signal ?? "unknown"}` : `pre-admission exit ${exit.code}`;
}

async function sealObservedExit(paths: AkumaPaths, exit: DetachedProcessExit): Promise<never> {
  const evidence = preAdmissionDiagnostic(exit);
  try {
    const leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) {
      try {
        await leash.sealIfUnborn(paths, { evidence, at: new Date().toISOString() });
      } finally {
        leash.release();
      }
    }
  } catch {
    /* Parent evidence remains authoritative when best-effort sealing fails. */
  }
  throw new Error(evidence);
}

async function observeSettledExit(
  owned: OwnedProcess | undefined,
): Promise<
  | { kind: "pending" }
  | { kind: "exited"; exit: DetachedProcessExit }
  | { kind: "exit-error"; error: unknown }
> {
  if (owned === undefined) return { kind: "pending" };
  const pending = Symbol("pending");
  try {
    const exit = await Promise.race([owned.exited, Promise.resolve(pending)]);
    return exit === pending ? { kind: "pending" } : { kind: "exited", exit };
  } catch (error) {
    return { kind: "exit-error", error };
  }
}

async function awaitBirth(paths: AkumaPaths, owned: OwnedProcess | undefined, signal?: AbortSignal): Promise<Soul> {
  const deadline = performance.now() + BIRTH_TIMEOUT_MS;
  for (;;) {
    signal?.throwIfAborted();
    const soul = await readSoul(paths);
    if (soul !== null) return soul;
    const failure = await observedBirthFailure(paths);
    if (failure !== null) {
      const settled = await observeSettledExit(owned);
      if (settled.kind === "exited") await sealObservedExit(paths, settled.exit);
      if (settled.kind === "exit-error") throw new Error(diagnostic(settled.error));
      throw new Error(failure);
    }
    if (performance.now() >= deadline) {
      const settled = await settleTimedOutBirth(paths);
      if (settled !== null) return settled;
    }
    if (owned === undefined) {
      await abortableDelay(Math.min(POLL_MS, Math.max(0, deadline - performance.now())), signal);
      continue;
    }
    const outcome = await Promise.race([
      abortableDelay(Math.min(POLL_MS, Math.max(0, deadline - performance.now())), signal).then(() => "poll" as const),
      owned.exited.then(
        (exit) => ({ kind: "exited" as const, exit }),
        (error) => ({ kind: "exit-error" as const, error }),
      ),
    ]);
    if (outcome === "poll") continue;
    if (outcome.kind === "exited") {
      const settledSoul = await readSoul(paths);
      if (settledSoul !== null) return settledSoul;
      await sealObservedExit(paths, outcome.exit);
      continue;
    }
    throw new Error(diagnostic(outcome.error));
  }
}

async function takeLeashUntil(paths: AkumaPaths, deadline: number): Promise<HeldAkumaLeash | null> {
  for (;;) {
    const leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) return leash;
    if (performance.now() >= deadline) return null;
    await abortableDelay(Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
  }
}

async function awaitAsleepBirth(paths: AkumaPaths): Promise<void> {
  const leash = await takeLeashUntil(paths, performance.now() + BIRTH_TIMEOUT_MS);
  if (leash === null) throw new Error("Forked Akuma did not finish its birth body");
  try {
    if ((await readHeart(paths)).latestBody?.end !== "exited") {
      throw new Error("Forked Akuma birth body did not exit cleanly");
    }
  } finally {
    leash.release();
  }
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
    } finally {
      leash.release();
    }
  } catch {
    /* the original local publication failure remains authoritative */
  }
}

export async function publishAkuma(
  input: Readonly<{
    worldPath: string;
    archetype: string;
    awaitAsleep?: boolean;
    reserve?(allocated: AllocatedAkuma): Promise<void>;
    launch(allocated: AllocatedAkuma): Promise<OwnedProcess | void>;
    signal?: AbortSignal;
  }>,
): Promise<AllocatedAkuma> {
  input.signal?.throwIfAborted();
  const allocated = await allocateAkumaDirectory({ worldRoot: input.worldPath, archetype: input.archetype });
  try {
    await initializeHeart(allocated.paths);
    input.signal?.throwIfAborted();
    await input.reserve?.(allocated);
    input.signal?.throwIfAborted();
    const owned = await input.launch(allocated);
    try {
      input.signal?.throwIfAborted();
      const soul = await awaitBirth(allocated.paths, owned ?? undefined, input.signal);
      if (soul.id !== allocated.id) throw new Error("Akuma birth returned a different identity");
      if (input.awaitAsleep === true) await awaitAsleepBirth(allocated.paths);
      return allocated;
    } finally {
      owned?.release();
    }
  } catch (error) {
    await sealLocalFailure(allocated, error);
    throw error;
  }
}
