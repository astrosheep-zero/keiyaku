import { abortableDelay } from "./abort.js";
/* eslint-disable max-lines-per-function -- Turn setup and consumption each preserve one ordered lifecycle transaction. */
import {
  appendActivity,
  beginTurn,
  breakBody,
  heartExists,
  readHeart,
  recordSession,
  recordTellDeliveries,
  recordTellReceipt,
  type ResumeCoordinate,
  type Soul,
  type TellFact,
} from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";
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
  const latest = (await readHeart(paths)).latestSession;
  const admitted = latest?.provider === soul.provider.name ? latest : undefined;
  const session = admitted?.coordinate;
  return {
    cwd: soul.cwd,
    options: admitted?.options ?? soul.options,
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
  supervisor: BodySupervisor;
  runtimeSpawn(launch: AkumaCallRequestChildLaunch): Promise<OwnedProcess | void>;
  world: import("../world.js").WorldRoot;
  externalCommands: Readonly<Record<string, ErasedRequestCommand>>;
  now(): string;
}>;

type ActiveTurn = Readonly<{
  turnSequence: number;
  attempt: ProviderAttempt<Session>;
  custodyFailure: Promise<never>;
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

async function writeProviderEvent(input: DriveTurnInput, active: ActiveTurn, event: AgentEvent): Promise<void> {
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
  await appendActivity(input.paths, { turnSequence: active.turnSequence, event: encodeAgentEvent(event), at });
}

async function startTurnDrive(input: DriveTurnInput): Promise<StartTurnResult> {
  const { cwd, options, session } = await turnRecipe(input.paths, input.soul);
  if (session !== undefined && input.adapter.resume === undefined) return { kind: "resume-unsupported" };
  const turn = await beginTurn(input.paths, {
    bodySequence: input.bodySequence,
    startedAt: input.now(),
    ...(input.call === undefined ? {} : { call: input.call }),
  });
  const { world, paths, soul: parent, runtimeSpawn: spawn, externalCommands } = input;
  const commands = composeRequestCommands(akumaCallRequestCommands({ world, paths, parent, spawn }), externalCommands);
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
    launchTells: input.launchTells.map((tell) => ({ id: tell.id, text: tell.body })),
    cwd,
    options,
    signal: driveController.signal,
    requests: { dir: requests.directory },
  };
  const attempt =
    session === undefined
      ? input.adapter.start({ ...driveInput, session: { kind: "fresh" } })
      : input.adapter.resume!({ ...driveInput, session: { kind: "resume", coordinate: session } });
  const custodyFailure = observeFailure(attempt.closed);
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
    if (input.launchTells.length > 0)
      await recordTellDeliveries(
        input.paths,
        input.launchTells.map((tell) => ({
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
      custodyFailure,
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

function observeReceiptFailure(receiptPump: Promise<void>): Promise<never> {
  return observeFailure(receiptPump);
}

function observeCompletionFailure(drive: Session): Promise<Readonly<{ kind: "completion-failed"; error: unknown }>> {
  return drive.completion.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => ({ kind: "completion-failed" as const, error }),
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
    if (attempted.has(tell.id)) continue;
    attempted.add(tell.id);
    const outcome = await writeWitness(async () => {
      const submission = await tellLive({ id: tell.id, text: tell.body });
      if (!mayWrite() || submission.kind === "turn-ended") return "turn-ended" as const;
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
  return liveTells && tellPump === null && pending.some((tell) => !attempted.has(tell.id));
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

async function consumeTurnDrive(input: DriveTurnInput, active: ActiveTurn): Promise<TurnDriveResult> {
  const { turnSequence, drive, requests, resume } = active;
  let heart = input.supervisor.current();
  let turnSession = resume;
  const attempted = new Set(input.launchTells.map((tell) => tell.id));
  const writeWitness = serializeEffects();
  let writesOpen = true;
  const mayWrite = (): boolean => writesOpen && !input.supervisor.signal.aborted;
  const writers: TurnWriters = { input, turnSequence, drive, writeWitness, mayWrite };
  const receiptFailure = observeReceiptFailure(pumpReceipts(writers));
  const completionFailure = observeCompletionFailure(drive);
  const iterator = drive.events[Symbol.asyncIterator]();
  let pending = iterator.next();
  let liveTells = true;
  let tellPump: Promise<"live" | "turn-ended"> | null = null;
  let tellObservation: Promise<Readonly<{ kind: "tell"; result: "live" | "turn-ended" }>> | null = null;
  try {
    for (;;) {
      if (input.supervisor.signal.aborted) {
        writesOpen = false;
        const retirement = await stopActiveDrive(input, active);
        return retirement.kind === "hung" ? retirement : { kind: "stopped" };
      }
      if (hasUnattemptedTell(liveTells, tellPump, heart.pending, attempted)) {
        if (drive.tell === undefined) {
          writesOpen = false;
          const retirement = await stopActiveDrive(input, active);
          return retirement.kind === "hung" ? retirement : { kind: "handoff" };
        }
        tellPump = submitPendingLiveTells(writers, heart.pending, attempted, drive.tell);
        tellObservation = tellPump.then((result) => ({ kind: "tell" as const, result }));
      }
      const next = await Promise.race([
        pending.then((event) => ({ kind: "event" as const, event })),
        input.supervisor.next(heart).then((observation) => ({ kind: "heart" as const, observation })),
        ...(tellObservation === null ? [] : [tellObservation]),
        receiptFailure,
        requests.failure,
        completionFailure,
        active.custodyFailure,
      ]);
      if (next.kind === "completion-failed") {
        requests.stopAdmission();
        throw next.error;
      }
      if (next.kind === "heart") {
        heart = next.observation;
        continue;
      }
      if (next.kind === "tell") {
        tellPump = null;
        tellObservation = null;
        liveTells = next.result === "live";
        continue;
      }
      if (next.event.done) break;
      await writeProviderEvent(input, active, next.event.value);
      if (next.event.value.type === "session") turnSession = next.event.value.coordinate;
      pending = iterator.next();
    }
    const result = await drive.completion;
    await active.attempt.closed;
    if (tellPump !== null) await tellPump;
    await writeWitness.drain();
    writesOpen = false;
    return await settleCompletion(result, turnSession, active);
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
