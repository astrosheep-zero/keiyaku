import { decodeAkumaCaller, type AkumaCaller } from "./caller.js";
import { errorCategory } from "../errors.js";
import { HeldAkumaLeash, initializeHeart, readHeart, readSeal, readSoul, type Soul } from "./heart/index.js";
import { acquireLeash } from "./control.js";
import { allocateAkumaDirectory, type AllocatedAkuma, type AkumaPaths } from "./identity.js";
import { abortableDelay } from "./abort.js";
import type { BodyLaunchEnd, ChildBodyLaunch, LiveBodyLaunch } from "./body-launch.js";
import type {
  CallInitialTell,
  CallInitialTellAdmission,
  InitialTellAdmissionInput,
  TellResult,
} from "./call-initial-tell.js";
import { BIRTH_TIMEOUT_MS, pendingTellReceipt } from "./call-initial-tell.js";
import { resolveProviderExecution, withWritableDirectories } from "./providers/index.js";
import { writableDirectoriesOption } from "./call-input.js";
import type { WorldRoot } from "../world.js";

const POLL_MS = 100;
const CUSTODY_HANDOFF_MS = 1_000;

class LaunchCompletedError extends Error {}

export type BirthInput = Readonly<{ worldPath: string; akumaName: string; signal?: AbortSignal }>;
export type LaunchInput = Readonly<{
  allocated: AllocatedAkuma;
  awaitAsleep?: boolean;
  launch(allocated: AllocatedAkuma): Promise<LiveBodyLaunch | void>;
  signal?: AbortSignal;
}>;

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

async function observeSettledExit(
  owned: LiveBodyLaunch | undefined,
): Promise<{ kind: "pending" } | { kind: "exited"; exit: BodyLaunchEnd } | { kind: "exit-error"; error: unknown }> {
  if (owned === undefined) return { kind: "pending" };
  const pending = Symbol("pending");
  try {
    const exit = await Promise.race([owned.completed, Promise.resolve(pending)]);
    return exit === pending ? { kind: "pending" } : { kind: "exited", exit };
  } catch (error) {
    return { kind: "exit-error", error };
  }
}

async function observeExitWithin(
  owned: LiveBodyLaunch,
  milliseconds: number,
): Promise<{ kind: "timeout" } | { kind: "exited"; exit: BodyLaunchEnd } | { kind: "exit-error"; error: unknown }> {
  return await Promise.race([
    owned.completed.then(
      (exit) => ({ kind: "exited" as const, exit }),
      (error) => ({ kind: "exit-error" as const, error }),
    ),
    abortableDelay(milliseconds).then(() => ({ kind: "timeout" as const })),
  ]);
}

async function attemptTermination(owned: LiveBodyLaunch, force = false): Promise<unknown | undefined> {
  const outcome = await Promise.race([
    Promise.resolve()
      .then(() => owned.cancel(force))
      .then(
        () => ({ kind: "terminated" as const }),
        (error) => ({ kind: "error" as const, error }),
      ),
    abortableDelay(CUSTODY_HANDOFF_MS).then(() => ({ kind: "timeout" as const })),
  ]);
  return outcome.kind === "error" ? outcome.error : undefined;
}

async function awaitBirth(paths: AkumaPaths, owned: LiveBodyLaunch | undefined, signal?: AbortSignal): Promise<Soul> {
  const deadline = performance.now() + BIRTH_TIMEOUT_MS;
  for (;;) {
    signal?.throwIfAborted();
    const soul = await readSoul(paths);
    if (soul !== null) return soul;
    const failure = await observedBirthFailure(paths);
    if (failure !== null) {
      const settled = await observeSettledExit(owned);
      if (settled.kind === "exited") throw new LaunchCompletedError(settled.exit.diagnostic);
      if (settled.kind === "exit-error") throw new Error(diagnostic(settled.error));
      throw new Error(failure);
    }
    if (performance.now() >= deadline) {
      const settled = await settleTimedOutBirth(paths);
      if (settled !== null) return settled;
      if (owned !== undefined) await attemptTermination(owned, true);
      throw new Error("Akuma birth timed out before Soul admission");
    }
    if (owned === undefined) {
      await abortableDelay(Math.min(POLL_MS, Math.max(0, deadline - performance.now())), signal);
      continue;
    }
    const outcome = await Promise.race([
      abortableDelay(Math.min(POLL_MS, Math.max(0, deadline - performance.now())), signal).then(() => "poll" as const),
      owned.completed.then(
        (exit) => ({ kind: "exited" as const, exit }),
        (error) => ({ kind: "exit-error" as const, error }),
      ),
    ]);
    if (outcome === "poll") continue;
    if (outcome.kind === "exited") {
      const settledSoul = await readSoul(paths);
      if (settledSoul !== null) return settledSoul;
      throw new LaunchCompletedError(outcome.exit.diagnostic);
    }
    throw new Error(diagnostic(outcome.error));
  }
}

async function allocatedSoul(allocated: AllocatedAkuma): Promise<Soul> {
  const soul = await readSoul(allocated.paths);
  if (soul === null) throw new Error("Akuma birth settled without a soul");
  if (soul.id !== allocated.id) throw new Error("Akuma birth returned a different identity");
  return soul;
}

function settlementEvidence(primary: unknown, terminationError: unknown, exitError: unknown): string {
  const reason = primary === undefined || primary === null ? "" : diagnostic(primary).trim();
  if (reason.length > 0) return reason;
  const details = [terminationError, exitError]
    .filter((error): error is unknown => error !== undefined)
    .map((error) => diagnostic(error).trim())
    .filter((detail) => detail.length > 0);
  return details[0] ?? "Akuma publication failed";
}

async function settleLaunch(
  allocated: AllocatedAkuma,
  owned: LiveBodyLaunch,
  failure: unknown,
): Promise<"born" | "sealed" | "handoff"> {
  if ((await readSoul(allocated.paths)) !== null) {
    await allocatedSoul(allocated);
    const settled = await observeExitWithin(owned, CUSTODY_HANDOFF_MS);
    if (settled.kind === "timeout") {
      const leash = await HeldAkumaLeash.try(allocated.paths);
      if (leash === null) return "handoff";
      leash.release();
    }
    if (settled.kind === "exit-error") throw failure;
    return "born";
  }

  let terminationError: unknown;
  let exitError: unknown;
  let outcome: "born" | "sealed";
  const settled =
    failure instanceof LaunchCompletedError ? await observeSettledExit(owned) : { kind: "pending" as const };
  if (settled.kind !== "exited") {
    terminationError = await attemptTermination(owned);
    const exit = await observeSettledExit(owned);
    if (exit.kind === "exit-error") exitError = exit.error;
  } else {
    /* An already-observed launch completion needs no second cancellation request. */
  }

  if ((await readSoul(allocated.paths)) !== null) {
    await allocatedSoul(allocated);
    return "born";
  }

  const leash = await HeldAkumaLeash.try(allocated.paths);
  if (leash === null) return "handoff";
  try {
    outcome = await leash.sealIfUnborn(allocated.paths, {
      evidence: settlementEvidence(failure, terminationError, exitError),
      at: new Date().toISOString(),
    });
  } finally {
    leash.release();
  }
  if (outcome === "born") {
    await allocatedSoul(allocated);
    return "born";
  }
  if ((await readSeal(allocated.paths)) === null) throw new Error("Akuma birth settled without a seal");
  return "sealed";
}

async function awaitAsleepBirth(paths: AkumaPaths, signal?: AbortSignal): Promise<void> {
  const leash = await acquireLeash(paths, {
    deadline: performance.now() + BIRTH_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
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

async function initializeAllocatedAkuma(allocated: AllocatedAkuma, signal?: AbortSignal): Promise<AllocatedAkuma> {
  try {
    await initializeHeart(allocated.paths);
    signal?.throwIfAborted();
    return allocated;
  } catch (error) {
    await sealLocalFailure(allocated, error);
    throw error;
  }
}

async function birthAkuma(input: BirthInput): Promise<AllocatedAkuma> {
  input.signal?.throwIfAborted();
  const allocated = await allocateAkumaDirectory({ worldRoot: input.worldPath, akumaName: input.akumaName });
  return await initializeAllocatedAkuma(allocated, input.signal);
}

async function launchAkuma(input: LaunchInput): Promise<AllocatedAkuma> {
  const { allocated } = input;
  let owned: LiveBodyLaunch | void = undefined;
  try {
    input.signal?.throwIfAborted();
    owned = await input.launch(allocated);
    input.signal?.throwIfAborted();
    const soul = await awaitBirth(allocated.paths, owned ?? undefined, input.signal);
    if (soul.id !== allocated.id) throw new Error("Akuma birth returned a different identity");
    if (input.awaitAsleep === true) await awaitAsleepBirth(allocated.paths, input.signal);
    owned?.release();
    return allocated;
  } catch (error) {
    if (owned !== undefined) {
      let outcome: "born" | "sealed" | "handoff";
      try {
        outcome = await settleLaunch(allocated, owned, error);
      } finally {
        owned.release();
      }
      if (outcome === "born" && input.signal?.aborted && error === input.signal.reason) {
        if (input.awaitAsleep === true) await awaitAsleepBirth(allocated.paths, input.signal);
        return allocated;
      }
      throw error;
    }
    await sealLocalFailure(allocated, error);
    throw error;
  }
}

export async function publishAkuma(input: BirthInput & Omit<LaunchInput, "allocated">): Promise<AllocatedAkuma> {
  const allocated = await birthAkuma(input);
  return await launchAkuma({ ...input, allocated });
}

/** The caller's prepared recipe; provider admission happens before allocation. */
export type PreparedCallRecipe = Pick<Soul, "description" | "provider" | "options" | "bare">;

/**
 * The one owner-typed admission failure the prepared executor raises before any
 * allocation. It carries only the failing stage and the provider owner's native
 * diagnostic; the initiating edge maps it back to its own refusal meaning.
 */
export class PreparedCallAdmissionError extends Error {
  readonly kind = "prepared-call-admission";
  constructor(
    readonly stage: "resolve" | "options",
    readonly diagnostic: string,
  ) {
    super(diagnostic);
    this.name = "PreparedCallAdmissionError";
  }
}

type PreparedCallResult = Readonly<{
  child: AllocatedAkuma;
  /** The exact initial TellResult, present only when its admission completed. */
  tell?: TellResult;
  /** The native launch or initial-Tell failure that stopped after a confirmed birth. */
  failure?: unknown;
  failureStage?: "birth" | "tell" | "wake";
}>;

type PreparedCallInput = Readonly<{
  akumaName: string;
  cwd: string;
  writableDirectories?: readonly string[];
  caller?: AkumaCaller;
  initialTell?: CallInitialTell;
  signal?: AbortSignal;
  world: WorldRoot;
  recipe: PreparedCallRecipe;
  /** Spawn one already-allocated child; publication already owns the allocated directory. */
  spawn(launch: ChildBodyLaunch): Promise<LiveBodyLaunch | void>;
  /** Admit the optional initial Tell against the just-confirmed child. */
  admitInitialTell(input: InitialTellAdmissionInput): Promise<CallInitialTellAdmission>;
}>;

/** Admit the provider recipe once before allocating any child. */
async function admittedRecipe(
  recipe: PreparedCallRecipe,
  input: Pick<PreparedCallInput, "cwd" | "writableDirectories" | "signal">,
): Promise<PreparedCallRecipe> {
  const directories = await writableDirectoriesOption(input.writableDirectories);
  const provider = await withWritableDirectories(recipe.provider, input.cwd, directories, input.signal);
  let selected: Awaited<ReturnType<typeof resolveProviderExecution>>;
  try {
    selected = await resolveProviderExecution(provider);
  } catch (error) {
    if (errorCategory(error) === "invalid-input")
      throw new PreparedCallAdmissionError("resolve", error instanceof Error ? error.message : String(error));
    throw error;
  }
  const admission = selected.adapter.admitOptions(recipe.options);
  if (admission.kind === "refused") {
    throw new PreparedCallAdmissionError("options", admission.diagnostic);
  }
  return Object.freeze({
    ...recipe,
    provider: selected.execution,
    options: admission.options,
    ...(recipe.bare === undefined ? {} : { bare: recipe.bare }),
  });
}

/** Judge durable birth from the allocated child's own evidence, never from the caught error. */
async function durablyBorn(allocated: AllocatedAkuma): Promise<boolean> {
  const soul = await readSoul(allocated.paths);
  return soul !== null && soul.id === allocated.id;
}

export type PreparedCall = Readonly<{
  allocated: AllocatedAkuma;
  input: PreparedCallInput;
  recipe: PreparedCallRecipe;
  caller: AkumaCaller | undefined;
}>;

/** Validate completely, then reserve one coordinate before any birth or input. */
export async function prepareCall(input: PreparedCallInput): Promise<PreparedCall> {
  const caller = decodeAkumaCaller(input.caller);
  const recipe = await admittedRecipe(input.recipe, input);
  input.signal?.throwIfAborted();
  const allocated = await allocateAkumaDirectory({ worldRoot: input.world, akumaName: input.akumaName });
  return { allocated, input, recipe, caller };
}

/** A canceled observer still owes its allocated coordinate the ordinary seal judgment. */
export async function discardPreparedCall(prepared: PreparedCall, reason: unknown): Promise<void> {
  await initializeAllocatedAkuma(prepared.allocated);
  await sealLocalFailure(prepared.allocated, reason);
}

/** Publish the same prepared allocation, retaining a confirmed child on later failure. */
export async function publishPreparedCall(prepared: PreparedCall): Promise<PreparedCallResult> {
  const { allocated, input, recipe, caller } = prepared;
  await initializeAllocatedAkuma(allocated, input.signal);
  let child = allocated;
  try {
    child = await launchAkuma({
      allocated,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      launch: async (ready) => {
        return await input.spawn({
          paths: ready.paths,
          seed: {
            id: ready.id,
            akumaName: ready.akumaName,
            ...(recipe.description === undefined ? {} : { description: recipe.description }),
            provider: recipe.provider,
            options: recipe.options,
            ...(recipe.bare === undefined ? {} : { bare: recipe.bare }),
            cwd: input.cwd,
            origin: { kind: "direct" },
            ...(caller === undefined ? {} : { caller }),
          },
        });
      },
    });
  } catch (error) {
    if (!(await durablyBorn(allocated))) throw error;
    return { child: allocated, failure: error, failureStage: "birth" };
  }
  if (input.initialTell === undefined) return { child };
  let told: TellResult | undefined;
  try {
    const admitted = await input.admitInitialTell({
      id: child.id,
      initialTell: input.initialTell,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (admitted.kind === "birth-failed") throw new Error(admitted.diagnostic);
    if (admitted.kind === "not-born") throw new Error(`Akuma ${child.id} was not born for its initial Tell`);
    told = pendingTellReceipt(admitted.tell);
    told = await admitted.wake;
    return { child, tell: told };
  } catch (error) {
    return {
      child,
      ...(told === undefined ? {} : { tell: told }),
      failure: error,
      failureStage: told === undefined ? "tell" : "wake",
    };
  }
}
