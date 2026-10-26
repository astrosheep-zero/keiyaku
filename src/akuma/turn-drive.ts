import { abortableDelay } from "./abort.js";
/* eslint-disable max-lines-per-function -- Turn setup and consumption each preserve one ordered lifecycle transaction. */
import {
  appendActivity,
  beginTurn,
  bindTellsToTurn,
  breakBody,
  drainPendingTells,
  heartExists,
  readHeart,
  recordCurrentModel,
  recordSession,
  recordTellDeliveries,
  recordTellReceipt,
  type BodyControlSnapshot,
  type ResumeCoordinate,
  type Soul,
  type TellFact,
} from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";
import { withoutModel } from "./provider-recipe.js";
import type { CallInitialTellAdmission } from "./call-initial-tell.js";
import type { InitialTellAdmissionRequest } from "./call-request.js";
import {
  encodeAgentEvent,
  type AgentEvent,
  type ProviderAdapter,
  type ProviderAttempt,
  type Session,
  type TurnResult,
} from "./provider.js";
import { akumaCallRequestCommands, type AkumaCallRequestChildLaunch } from "./call-request.js";
import { BodyRequestPump } from "./request-serve.js";
import { composeRequestCommands, type ErasedRequestCommand } from "./request-wire.js";
import { BodySupervisor, CONTROL_RESPONSE_MS } from "./body-supervisor.js";
import type { OwnedProcess } from "../runtime/proc/run.js";

type EffectSerializer = {
  <T>(effect: () => Promise<T> | T): Promise<T>;
  drain(): Promise<void>;
};

function serializeEffects(): EffectSerializer {
  let tail = Promise.resolve();
  let failed = false;
  let failure: unknown;
  const serialize = async <T>(effect: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(effect);
    tail = result.then(
      () => undefined,
      (error: unknown) => {
        if (!failed) failure = error;
        failed = true;
      },
    );
    return await result;
  };
  serialize.drain = async () => {
    await tail;
    if (failed) throw failure;
  };
  return serialize;
}

export async function turnRecipe(
  paths: AkumaPaths,
  soul: Soul,
): Promise<Readonly<{ cwd: string; options: Soul["options"]; session?: ResumeCoordinate }>> {
  const heart = await readHeart(paths);
  const latest = heart.latestSession;
  const admitted = latest?.provider === soul.provider.name ? latest : undefined;
  const session = admitted?.coordinate;
  // The current model is the one mutable member of the recipe and lives only
  // in the Soul, so every Turn reads it freshly and no session copy, cached
  // birth Soul, or stale option can re-admit a model that already moved.
  const current = heart.soul?.options.model;
  return {
    cwd: soul.cwd,
    options: {
      ...withoutModel(admitted?.options ?? soul.options),
      ...(current === undefined ? {} : { model: current }),
    },
    ...(session === undefined ? {} : { session }),
  };
}

export type DrivenTurn =
  | (Extract<TurnResult, { kind: "answered" }> & Readonly<{ session?: ResumeCoordinate }>)
  | Extract<TurnResult, { kind: "failed" }>;

export type DriveTurnInput = Readonly<{
  paths: AkumaPaths;
  soul: Soul;
  adapter: ProviderAdapter;
  bodySequence: number;
  body: string;
  call?: string;
  launchTells: readonly TellFact[];
  initiator?: string;
  schemaJson?: string;
  supervisor: BodySupervisor;
  runtimeSpawn(launch: AkumaCallRequestChildLaunch): Promise<OwnedProcess | void>;
  admitInitialTell(input: InitialTellAdmissionRequest): Promise<CallInitialTellAdmission>;
  world: import("../world.js").WorldRoot;
  externalCommands: Readonly<Record<string, ErasedRequestCommand>>;
  turnStarted: Readonly<{ emit(turnSequence: number): Promise<void> }>;
  now(): string;
}>;

type ActiveTurn = Readonly<{
  turnSequence: number;
  attempt: ProviderAttempt<Session>;
  attemptClosure: Promise<AttemptClosure>;
  drive: Session;
  requests: BodyRequestPump;
  cwd: string;
  options: Soul["options"];
  releaseDriveSignal(): void;
  resume?: ResumeCoordinate;
}>;

type TurnWriters = Readonly<{
  input: DriveTurnInput;
  turnSequence: number;
  drive: Session;
  writeWitness: EffectSerializer;
  mayWrite(): boolean;
}>;

type Retirement = Readonly<{ kind: "retired" }> | Readonly<{ kind: "hung" }>;
type AttemptClosure = Readonly<{ kind: "closed" }> | Readonly<{ kind: "failed"; error: unknown }>;
type StartTurnResult =
  | ActiveTurn
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "hung" }>
  | Readonly<{ kind: "resume-unsupported" }>
  | (Extract<DrivenTurn, { kind: "failed" }> & Readonly<{ turnSequence: number }>);
type TurnDriveResult =
  | DrivenTurn
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "hung" }>
  | Readonly<{ kind: "handoff" }>;

async function failedTurnSetup(
  input: DriveTurnInput,
  turnSequence: number,
  requests: BodyRequestPump,
  cancelDrive: () => void,
  error: unknown,
): Promise<StartTurnResult> {
  try {
    await requests.close();
  } catch {
    /* Preserve the setup or pump failure. */
  }
  input.supervisor.signal.removeEventListener("abort", cancelDrive);
  if (input.supervisor.signal.aborted) {
    if (input.supervisor.reason === "heart-gone") throw error;
    return { kind: "stopped" };
  }
  return { kind: "failed", turnSequence, diagnostic: error instanceof Error ? error.message : String(error) };
}

/**
 * The runtime model one attempt has already observed. Equal observations
 * coalesce inside the attempt; a successor attempt starts empty, so its own
 * first observation always reaches the Soul.
 */
type ModelWitness = { written: boolean; model: string | undefined };

async function writeProviderEvent(
  input: DriveTurnInput,
  active: ActiveTurn,
  event: AgentEvent,
  witness: ModelWitness,
): Promise<void> {
  if (input.supervisor.signal.aborted) return;
  const at = input.now();
  if (event.type === "session") {
    await recordSession(input.paths, {
      provider: input.soul.provider.name,
      coordinate: event.coordinate,
      cwd: active.cwd,
      options: active.options,
      admittedAt: at,
    });
  }
  if (event.type === "model") {
    // Native model evidence is authoritative current state, not narration: it
    // moves the Soul's one model and is never appended to activity.
    if (witness.written && witness.model === event.model) return;
    witness.written = true;
    witness.model = event.model;
    await recordCurrentModel(input.paths, { bodySequence: input.bodySequence, model: event.model });
    return;
  }
  await appendActivity(input.paths, { turnSequence: active.turnSequence, event: encodeAgentEvent(event), at });
}

async function startTurnDrive(input: DriveTurnInput): Promise<StartTurnResult> {
  const { cwd, options, session } = await turnRecipe(input.paths, input.soul);
  if (session !== undefined && input.adapter.resume === undefined) return { kind: "resume-unsupported" };
  const boundTells = drainPendingTells(input.launchTells);
  const schemaJson = input.schemaJson ?? boundTells.find((tell) => tell.schemaJson !== undefined)?.schemaJson;
  const initiator = input.call === undefined ? boundTells[0]?.initiator : input.initiator;
  const turn = await beginTurn(input.paths, {
    ...(initiator === undefined ? {} : { initiator }),
    bodySequence: input.bodySequence,
    startedAt: input.now(),
    ...(input.call === undefined ? {} : { call: input.call }),
    ...(schemaJson === undefined ? {} : { schemaJson }),
  });
  if (boundTells.length > 0) {
    await bindTellsToTurn(input.paths, {
      turnSequence: turn.sequence,
      tellIds: boundTells.map((tell) => tell.id),
      boundAt: input.now(),
    });
  }
  await input.turnStarted.emit(turn.sequence);
  const { world, paths, soul: parent, runtimeSpawn: spawn, externalCommands, admitInitialTell } = input;
  const commands = composeRequestCommands(
    akumaCallRequestCommands({ world, paths, parent, spawn, admitInitialTell }),
    externalCommands,
  );
  const requests = await BodyRequestPump.open({
    paths: input.paths,
    allowed: input.soul.allowed,
    bodySequence: input.bodySequence,
    now: input.now,
    commands,
    signal: input.supervisor.signal,
  });
  const driveController = new AbortController();
  const cancelDrive = (): void => {
    if (!driveController.signal.aborted) driveController.abort(input.supervisor.signal.reason);
  };
  input.supervisor.signal.addEventListener("abort", cancelDrive, { once: true });
  if (input.supervisor.signal.aborted) cancelDrive();
  void requests.failure.catch((error: unknown) => {
    if (!driveController.signal.aborted) driveController.abort(error);
  });
  const driveInput = {
    body: input.body,
    launchTells: boundTells.map((tell) => ({ id: tell.id, text: tell.body })),
    cwd,
    options,
    signal: driveController.signal,
    requests: { dir: requests.directory, entry: requests.entry },
    ...(schemaJson === undefined ? {} : { schemaJson }),
  };
  const attempt =
    session === undefined
      ? input.adapter.start({ ...driveInput, session: { kind: "fresh" } })
      : input.adapter.resume!({ ...driveInput, session: { kind: "resume", coordinate: session } });
  const attemptClosure: Promise<AttemptClosure> = attempt.closed.then(
    () => ({ kind: "closed" as const }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  const custodyFailure = attemptClosure.then((closure) => {
    if (closure.kind === "failed") throw closure.error;
    return new Promise<never>(() => undefined);
  });
  try {
    const selected = await Promise.race([attempt.result, requests.failure, custodyFailure]);
    if (input.supervisor.signal.aborted) {
      try {
        const retirement = await retireProviderCustody(input, turn.sequence, attempt);
        await requests.close();
        if (retirement.kind === "hung") return retirement;
      } finally {
        input.supervisor.signal.removeEventListener("abort", cancelDrive);
      }
      return { kind: "stopped" };
    }
    if (boundTells.length > 0)
      await recordTellDeliveries(
        input.paths,
        boundTells.map((tell) => ({
          tellId: tell.id,
          route: "launch" as const,
          turnSequence: turn.sequence,
          fence: selected.admission.fence,
          deliveredAt: input.now(),
        })),
      );
    void selected.completion.then(
      () => requests.stopAdmission(),
      () => undefined,
    );
    return {
      turnSequence: turn.sequence,
      attempt,
      attemptClosure,
      drive: selected,
      requests,
      cwd,
      options,
      releaseDriveSignal: () => input.supervisor.signal.removeEventListener("abort", cancelDrive),
      ...(session === undefined ? {} : { resume: session }),
    };
  } catch (error) {
    const retirement = await retireProviderCustody(input, turn.sequence, attempt);
    if (retirement.kind === "hung") {
      try {
        await requests.close();
      } finally {
        input.supervisor.signal.removeEventListener("abort", cancelDrive);
      }
      return retirement;
    }
    return await failedTurnSetup(input, turn.sequence, requests, cancelDrive, error);
  }
}

async function retireProviderCustody(
  input: DriveTurnInput,
  turnSequence: number,
  attempt: ProviderAttempt<Session>,
): Promise<Retirement> {
  const dispose = async (
    operation: () => Promise<void>,
  ): Promise<Readonly<{ kind: "retired" }> | Readonly<{ kind: "held"; error: unknown }>> =>
    await Promise.race([
      operation().then(
        async () => {
          try {
            await attempt.closed;
            return { kind: "retired" as const };
          } catch (error: unknown) {
            return { kind: "held" as const, error };
          }
        },
        (error: unknown) => ({ kind: "held" as const, error }),
      ),
      abortableDelay(CONTROL_RESPONSE_MS).then(() => ({
        kind: "held" as const,
        error: new Error(`provider custody remained live after ${CONTROL_RESPONSE_MS}ms`),
      })),
    ]);
  let outcome = await dispose(attempt.abort);
  if (outcome.kind === "retired") return outcome;
  outcome = await dispose(attempt.forceDispose);
  if (outcome.kind === "retired") return outcome;
  if (await heartExists(input.paths)) {
    const diagnostic = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    const at = input.now();
    try {
      await input.supervisor.recordHung(diagnostic, at);
      await appendActivity(input.paths, {
        turnSequence,
        event: encodeAgentEvent({ type: "note", text: `Provider custody was not retired: ${diagnostic}` }),
        at,
      });
    } catch {
      /* Undisposed provider custody still owns the leash. */
    }
  }
  await breakBody(input.paths, { sequence: input.bodySequence, end: "broke-off", at: input.now() });
  return { kind: "hung" };
}

function pumpReceipts(writers: TurnWriters): Promise<void> {
  const { input, turnSequence, drive, writeWitness, mayWrite } = writers;
  return (async () => {
    if (drive.receipts === undefined) return;
    for await (const receipt of drive.receipts) {
      if (!mayWrite()) return;
      await writeWitness(async () => {
        if (!mayWrite()) return;
        await recordTellReceipt(
          input.paths,
          receipt.evidence === "exact"
            ? { ...receipt, receivedAt: input.now() }
            : { ...receipt, turnSequence, receivedAt: input.now() },
        );
      });
    }
  })();
}

function observeFailure(settlement: Promise<unknown>): Promise<never> {
  return settlement.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(error),
  );
}

async function submitPendingLiveTells(
  writers: TurnWriters,
  pending: readonly TellFact[],
  attempted: Set<string>,
  tellLive: NonNullable<Session["tell"]>,
): Promise<"live" | "turn-ended"> {
  const { input, turnSequence, drive, writeWitness, mayWrite } = writers;
  for (const tell of pending) {
    if (attempted.has(tell.id) || tell.schemaJson !== undefined) continue;
    attempted.add(tell.id);
    const outcome = await writeWitness(async () => {
      const submission = await tellLive({ id: tell.id, text: tell.body });
      if (!mayWrite() || submission.kind === "turn-ended") return "turn-ended" as const;
      await bindTellsToTurn(input.paths, { turnSequence, tellIds: [tell.id], boundAt: input.now() });
      await recordTellDeliveries(input.paths, [
        {
          tellId: tell.id,
          route: "live",
          turnSequence,
          fence: submission.fence,
          receipt: drive.receipts === undefined ? "unavailable" : "required",
          deliveredAt: input.now(),
        },
      ]);
      return "accepted" as const;
    });
    if (outcome === "turn-ended") return outcome;
  }
  return "live";
}

async function stopActiveDrive(input: DriveTurnInput, active: ActiveTurn): Promise<Retirement> {
  try {
    const retirement = await retireProviderCustody(input, active.turnSequence, active.attempt);
    await active.requests.close();
    return retirement;
  } finally {
    active.releaseDriveSignal();
  }
}
function hasUnattemptedTell(
  liveTells: boolean,
  tellPump: Promise<"live" | "turn-ended"> | null,
  pending: readonly TellFact[],
  attempted: ReadonlySet<string>,
): boolean {
  return (
    liveTells && tellPump === null && pending.some((tell) => !attempted.has(tell.id) && tell.schemaJson === undefined)
  );
}

async function settleCompletion(
  result: TurnResult,
  session: ResumeCoordinate | undefined,
  active: ActiveTurn,
): Promise<DrivenTurn> {
  try {
    await active.requests.close();
    return result.kind === "answered" ? { ...result, ...(session === undefined ? {} : { session }) } : result;
  } finally {
    active.releaseDriveSignal();
  }
}

type TurnWakeup =
  | Readonly<{ kind: "event"; event: IteratorResult<AgentEvent> }>
  | Readonly<{ kind: "heart"; observation: BodyControlSnapshot }>
  | Readonly<{ kind: "tell"; result: "live" | "turn-ended" }>
  | Readonly<{ kind: "completion"; result: TurnResult }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "drained" }>
  | Readonly<{ kind: "failed"; error: unknown }>;

/**
 * One bounded wake slot per live Turn source.
 *
 * A stalled provider leaves its current event pull pending, so attaching a fresh reaction to that
 * pull on every control observation retains a reaction and a derived promise per tick. Here each
 * source registers exactly one reaction and is re-armed only after the wake it produced has been
 * consumed; terminal sources settle once and are never re-armed. The queue therefore holds at most
 * one wake per source. A new Heart observation is armed only after the prior observation is
 * consumed, so the wait never falls back to an older snapshot. Stop clears the queue and its
 * waiter; later notifications are ignored rather than written, though the one reaction already
 * registered on a source that never settled stays attached until that source settles.
 */
function createTurnWakeups(observeHeart: (after: BodyControlSnapshot) => Promise<BodyControlSnapshot>) {
  const queue: TurnWakeup[] = [];
  let waiter: ((wakeup: TurnWakeup) => void) | undefined;
  let stopped = false;
  const publish = (wakeup: TurnWakeup): void => {
    if (stopped) return;
    const waiting = waiter;
    waiter = undefined;
    if (waiting === undefined) queue.push(wakeup);
    else waiting(wakeup);
  };
  return {
    event: (pull: Promise<IteratorResult<AgentEvent>>): void => {
      void pull.then(
        (event) => publish({ kind: "event", event }),
        (error: unknown) => publish({ kind: "failed", error }),
      );
    },
    heart: (after: BodyControlSnapshot): void => {
      void observeHeart(after).then(
        (observation) => publish({ kind: "heart", observation }),
        (error: unknown) => publish({ kind: "failed", error }),
      );
    },
    tell: (submission: Promise<"live" | "turn-ended">): void => {
      void submission.then(
        (result) => publish({ kind: "tell", result }),
        (error: unknown) => publish({ kind: "failed", error }),
      );
    },
    failure: (source: Promise<unknown>): void => {
      void source.then(
        () => undefined,
        (error: unknown) => publish({ kind: "failed", error }),
      );
    },
    completion: (source: Promise<TurnResult>): void => {
      void source.then(
        (result) => publish({ kind: "completion", result }),
        (error: unknown) => publish({ kind: "failed", error }),
      );
    },
    closure: (source: Promise<AttemptClosure>): void => {
      void source.then((closure) =>
        publish(closure.kind === "closed" ? { kind: "closed" } : { kind: "failed", error: closure.error }),
      );
    },
    drained: (source: Promise<void>): void => {
      void source.then(
        () => publish({ kind: "drained" }),
        (error: unknown) => publish({ kind: "failed", error }),
      );
    },
    next: (): Promise<TurnWakeup> => {
      const ready = queue.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise<TurnWakeup>((resolve) => {
        waiter = resolve;
      });
    },
    stop: (): void => {
      stopped = true;
      waiter = undefined;
      queue.length = 0;
    },
  };
}

async function consumeTurnDrive(input: DriveTurnInput, active: ActiveTurn): Promise<TurnDriveResult> {
  const { turnSequence, drive, requests, resume } = active;
  let heart = input.supervisor.current();
  let turnSession = resume;
  const attempted = new Set(drainPendingTells(input.launchTells).map((tell) => tell.id));
  const writeWitness = serializeEffects();
  let writesOpen = true;
  const mayWrite = (): boolean => writesOpen && !input.supervisor.signal.aborted;
  const writers: TurnWriters = { input, turnSequence, drive, writeWitness, mayWrite };
  const receiptFailure = observeFailure(pumpReceipts(writers));
  const iterator = drive.events[Symbol.asyncIterator]();
  const witness: ModelWitness = { written: false, model: undefined };
  let liveTells = true;
  let tellPump: Promise<"live" | "turn-ended"> | null = null;
  let eventsEnded = false;
  let result: TurnResult | undefined;
  let attemptClosed = false;
  let effectsDrained = false;
  let drainArmed = false;
  let drainingEffects: Promise<void> | undefined;
  const wakeups = createTurnWakeups((after) => input.supervisor.next(after));
  wakeups.event(iterator.next());
  wakeups.heart(heart);
  wakeups.failure(receiptFailure);
  wakeups.failure(requests.failure);
  wakeups.completion(drive.completion);
  wakeups.closure(active.attemptClosure);
  try {
    for (;;) {
      if (input.supervisor.signal.aborted) {
        writesOpen = false;
        const retirement = await stopActiveDrive(input, active);
        return retirement.kind === "hung" ? retirement : { kind: "stopped" };
      }
      if (result === undefined && hasUnattemptedTell(liveTells, tellPump, heart.pending, attempted)) {
        if (drive.tell === undefined) {
          writesOpen = false;
          const retirement = await stopActiveDrive(input, active);
          return retirement.kind === "hung" ? retirement : { kind: "handoff" };
        }
        tellPump = submitPendingLiveTells(writers, heart.pending, attempted, drive.tell);
        wakeups.tell(tellPump);
      }
      const next = await wakeups.next();
      if (next.kind === "failed") throw next.error;
      if (next.kind === "heart") {
        heart = next.observation;
        wakeups.heart(heart);
      } else if (next.kind === "tell") {
        tellPump = null;
        liveTells = next.result === "live";
      } else if (next.kind === "completion") {
        result = next.result;
        liveTells = false;
        requests.stopAdmission();
      } else if (next.kind === "closed") {
        attemptClosed = true;
      } else if (next.kind === "drained") {
        effectsDrained = true;
        drainArmed = false;
      } else if (next.kind === "event") {
        if (next.event.done) eventsEnded = true;
        else {
          await writeProviderEvent(input, active, next.event.value, witness);
          if (next.event.value.type === "session") turnSession = next.event.value.coordinate;
          wakeups.event(iterator.next());
        }
      }
      if (eventsEnded && result !== undefined && attemptClosed && tellPump === null && !drainArmed) {
        drainingEffects ??= writeWitness.drain();
        drainArmed = true;
        wakeups.drained(drainingEffects);
      }
      if (eventsEnded && result !== undefined && attemptClosed && tellPump === null && effectsDrained) {
        writesOpen = false;
        return await settleCompletion(result, turnSession, active);
      }
    }
  } catch (error) {
    writesOpen = false;
    if (input.supervisor.signal.aborted) {
      const retirement = await stopActiveDrive(input, active);
      return retirement.kind === "hung" ? retirement : { kind: "stopped" };
    }
    const retirement = await retireProviderCustody(input, turnSequence, active.attempt);
    try {
      await requests.close();
    } catch {
      /* Preserve the first pump failure. */
    }
    active.releaseDriveSignal();
    if (retirement.kind === "hung") return retirement;
    return { kind: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
  } finally {
    wakeups.stop();
  }
}

export async function driveTurn(
  input: DriveTurnInput,
): Promise<
  | (DrivenTurn & Readonly<{ turnSequence: number }>)
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "hung" }>
  | Readonly<{ kind: "handoff" }>
  | Readonly<{ kind: "resume-unsupported" }>
> {
  let active: ActiveTurn;
  try {
    const started = await startTurnDrive(input);
    if ("kind" in started) return started;
    active = started;
  } catch (error) {
    if (!(await heartExists(input.paths))) {
      input.supervisor.cancel("heart-gone");
      return { kind: "stopped" };
    }
    throw error;
  }
  try {
    const result = await consumeTurnDrive(input, active);
    return result.kind === "stopped" || result.kind === "hung" || result.kind === "handoff"
      ? result
      : { ...result, turnSequence: active.turnSequence };
  } catch (error) {
    if (await heartExists(input.paths)) {
      try {
        await active.requests.close();
      } finally {
        active.releaseDriveSignal();
      }
      return {
        kind: "failed",
        diagnostic: error instanceof Error ? error.message : String(error),
        turnSequence: active.turnSequence,
      };
    }
    input.supervisor.cancel("heart-gone");
    const retirement = await stopActiveDrive(input, active);
    return retirement.kind === "hung" ? retirement : { kind: "stopped" };
  }
}
