import { decodeAkumaCaller, type AkumaCaller } from "./caller.js";
import { errorCategory, KeiyakuError } from "../errors.js";
import { HeldAkumaLeash, initializeHeart, readHeart, readSoul, type Soul } from "./heart/index.js";
import { acquireLeash } from "./control.js";
import { allocateAkumaDirectory, type AllocatedAkuma, type AkumaPaths } from "./identity.js";
import { abortableDelay } from "./abort.js";
import type { ChildBodyLaunch, LiveBodyLaunch } from "./body-launch.js";
import {
  pendingTellReceipt,
  type CallInitialTell,
  type CallInitialTellAdmission,
  type InitialTellAdmissionInput,
  type TellResult,
} from "./call-initial-tell.js";
import { resolveProviderExecution } from "./providers/index.js";
import type { WorldRoot } from "../world.js";

const BIRTH_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const CUSTODY_HANDOFF_MS = 1_000;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PublicationError extends KeiyakuError {
  readonly allocated: Readonly<{ id: AllocatedAkuma["id"]; directory: string }>;

  constructor(
    child: AllocatedAkuma,
    readonly verdict: "sealed" | "unresolved",
    cause: unknown,
    signal?: AbortSignal,
  ) {
    super(
      errorCategory(cause, signal),
      `Akuma birth ${verdict}: allocated ${child.id} at ${child.paths.directory}: ${diagnostic(cause)}`,
      { cause },
    );
    this.allocated = Object.freeze({ id: child.id, directory: child.paths.directory });
    Object.freeze(this);
  }
}

async function awaitAsleepBirth(paths: AkumaPaths, signal?: AbortSignal): Promise<void> {
  const leash = await acquireLeash(paths, {
    deadline: performance.now() + BIRTH_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });
  if (leash === null) throw new Error("Akuma did not finish its birth body");
  try {
    const body = (await readHeart(paths, signal)).latestBody;
    if (body?.end !== "exited" || body.hung !== undefined) {
      throw new Error("Akuma birth body did not exit cleanly");
    }
    signal?.throwIfAborted();
  } finally {
    leash.release();
  }
}

async function cancelUnbornLaunch(owned: LiveBodyLaunch): Promise<void> {
  const timer = new AbortController();
  try {
    await Promise.race([owned.cancel(), abortableDelay(CUSTODY_HANDOFF_MS, timer.signal)]);
  } catch {
    // Neither cancellation failure nor completion decides durable birth.
  } finally {
    timer.abort();
  }
}

type Launch = (allocated: AllocatedAkuma) => Promise<LiveBodyLaunch>;
type ConfirmedBirth = Readonly<{ child: AllocatedAkuma; failure?: unknown; failureStage?: "birth" }>;

async function publishAllocated(
  child: AllocatedAkuma,
  launch: Launch | Readonly<{ stopped: unknown }>,
  signal?: AbortSignal,
  awaitAsleep = false,
): Promise<ConfirmedBirth> {
  const { id, paths } = child;
  let owned: LiveBodyLaunch | undefined;
  const completion: { exit?: { cause: unknown } } = {};
  let failure: { cause: unknown } | undefined;
  let confirmed = false;
  let verdict: PublicationError["verdict"] = "unresolved";
  const observeSoul = async (): Promise<boolean> => {
    const soul = await readSoul(paths);
    if (soul !== null && soul.id !== id)
      throw new KeiyakuError("authority-corruption", `Akuma birth found a different Soul: ${soul.id}`);
    return (confirmed = soul !== null);
  };
  const watchBirth = async () => {
    const deadline = performance.now() + BIRTH_TIMEOUT_MS;
    for (;;) {
      signal?.throwIfAborted();
      if (await observeSoul()) return;
      const leash = await HeldAkumaLeash.try(paths);
      try {
        const seal = leash?.readSeal();
        if (seal != null) throw new Error(seal.evidence);
      } finally {
        leash?.release();
      }
      if (completion.exit !== undefined) throw completion.exit.cause;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("Akuma birth timed out before Soul admission");
      await abortableDelay(Math.min(POLL_MS, remaining), signal);
    }
  };
  const settleUnborn = async (cause: unknown) => {
    if (await observeSoul()) return;
    if (owned !== undefined && completion.exit === undefined) await cancelUnbornLaunch(owned);
    const leash = await HeldAkumaLeash.try(paths);
    try {
      const judged = await leash?.sealIfUnborn(paths, {
        evidence: diagnostic(cause),
        at: new Date().toISOString(),
      });
      if (judged === "sealed") verdict = "sealed";
      else await observeSoul();
    } finally {
      leash?.release();
    }
  };
  try {
    await initializeHeart(paths);
    signal?.throwIfAborted();
    if (typeof launch !== "function") throw launch.stopped;
    owned = await launch(child);
    const noteExit = (cause: unknown) => {
      completion.exit = { cause };
    };
    void owned.completed.then((end) => noteExit(new Error(end.diagnostic)), noteExit);
    await watchBirth();
    if (awaitAsleep) await awaitAsleepBirth(paths, signal);
  } catch (error) {
    const cause = signal?.aborted === true ? signal.reason : typeof launch === "function" ? error : launch.stopped;
    failure = { cause };
    if (!confirmed)
      await settleUnborn(cause).catch(() => {
        // An unavailable judgment cannot replace the first failure or prove a seal.
      });
  } finally {
    try {
      owned?.release();
    } catch (cause) {
      failure ??= { cause };
    }
  }
  if (failure === undefined) return { child };
  if (!confirmed) throw new PublicationError(child, verdict, failure.cause, signal);
  if (!awaitAsleep && signal?.aborted === true && failure.cause === signal.reason) return { child };
  return { child, failure: failure.cause, failureStage: "birth" };
}

export async function publishAkuma(
  input: Readonly<{
    worldPath: string;
    akumaName: string;
    signal?: AbortSignal;
    launch: Launch;
  }>,
): Promise<ConfirmedBirth> {
  input.signal?.throwIfAborted();
  const child = await allocateAkumaDirectory({ worldRoot: input.worldPath, akumaName: input.akumaName });
  return await publishAllocated(child, input.launch, input.signal);
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
  tell?: TellResult;
  failure?: unknown;
  failureStage?: "birth" | "tell" | "wake";
}>;

type PreparedCallInput = Readonly<{
  akumaName: string;
  cwd: string;
  caller?: AkumaCaller;
  initialTell?: CallInitialTell;
  signal?: AbortSignal;
  world: WorldRoot;
  recipe: PreparedCallRecipe;
  spawn(launch: ChildBodyLaunch): Promise<LiveBodyLaunch>;
  admitInitialTell(input: InitialTellAdmissionInput): Promise<CallInitialTellAdmission>;
}>;

async function admittedRecipe(recipe: PreparedCallRecipe): Promise<PreparedCallRecipe> {
  let selected: Awaited<ReturnType<typeof resolveProviderExecution>>;
  try {
    selected = await resolveProviderExecution(recipe.provider);
  } catch (error) {
    if (errorCategory(error) === "invalid-input") throw new PreparedCallAdmissionError("resolve", diagnostic(error));
    throw error;
  }
  const admission = selected.adapter.admitOptions(recipe.options);
  if (admission.kind === "refused") {
    throw new PreparedCallAdmissionError("options", admission.diagnostic);
  }
  return Object.freeze({ ...recipe, provider: selected.execution, options: admission.options });
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
  const recipe = await admittedRecipe(input.recipe);
  input.signal?.throwIfAborted();
  const allocated = await allocateAkumaDirectory({ worldRoot: input.world, akumaName: input.akumaName });
  return { allocated, input, recipe, caller };
}

/** A canceled observer still owes its allocated coordinate the ordinary birth judgment. */
export async function discardPreparedCall(prepared: PreparedCall, reason: unknown): Promise<void> {
  await publishAllocated(prepared.allocated, { stopped: reason }, prepared.input.signal);
}

export async function publishPreparedCall(prepared: PreparedCall): Promise<PreparedCallResult> {
  const { allocated, input, recipe, caller } = prepared;
  const birth = await publishAllocated(
    allocated,
    ({ id, paths, akumaName }) =>
      input.spawn({
        paths,
        seed: {
          ...recipe,
          id,
          akumaName,
          cwd: input.cwd,
          origin: { kind: "direct" },
          ...(caller === undefined ? {} : { caller }),
        },
      }),
    input.signal,
    true,
  );
  if (birth.failureStage !== undefined || input.initialTell === undefined) return birth;
  const { child } = birth;
  let told: TellResult | undefined;
  try {
    const admitted = await input.admitInitialTell({
      id: child.id,
      initialTell: input.initialTell,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (admitted.kind === "not-born") throw new Error(`Akuma ${child.id} was not born for its initial Tell`);
    told = pendingTellReceipt(admitted.tell);
    return { child, tell: await admitted.wake };
  } catch (error) {
    return {
      child,
      ...(told === undefined ? {} : { tell: told }),
      failure: error,
      failureStage: told === undefined ? "tell" : "wake",
    };
  }
}
