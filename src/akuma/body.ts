import { fileURLToPath } from "node:url";
import { abortableDelay } from "./abort.js";
import {
  HeldAkumaLeash,
  appendActivity,
  beginTurn,
  breakBody,
  endTurn,
  finishBodyIfIdle,
  heartExists,
  isHeartAbsent,
  readHeart,
  recordSession,
  recordTellDeliveries,
  recordTellReceipt,
  type ResumeCoordinate,
  type TellFact,
  type SessionFact,
  type Soul,
  type HeartSnapshot,
} from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";
import {
  encodeAgentEvent,
  type AgentEvent,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "./provider.js";
import { resolveProviderExecution } from "./providers/index.js";
import {
  BodyRequestPump,
  clearBodyRequestTransport,
  settleBodyRequests,
  type RequestChildLaunch,
} from "./requests.js";
import {
  spawnDetachedProcess,
} from "../runtime/proc/run.js";

const LEASH_RETRY_MS = 25;
const BODY_CONTROL_OBSERVATION_MS = 100;
export const CONTROL_RESPONSE_MS = 1_000;

export type BodyLaunch = Readonly<{
  paths: AkumaPaths;
  seed?: Omit<Soul, "createdAt">;
  birthSession?: Omit<SessionFact, "sequence">;
  initialBody?: string;
}>;

type BodyRuntime = Readonly<{
  now(): string;
  spawnChild?(launch: RequestChildLaunch): Promise<void>;
}>;

type BodyStopReason = "control" | "heart-gone";

class BodySupervisor {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly finished = new AbortController();
  private readonly observer: Promise<void>;
  private waiter: ((snapshot: HeartSnapshot) => void) | undefined;
  private observation: HeartSnapshot;
  private stopping?: BodyStopReason;

  private constructor(
    private readonly paths: AkumaPaths,
    private readonly bodySequence: number,
    private readonly leash: HeldAkumaLeash,
    observation: HeartSnapshot,
  ) {
    this.signal = this.controller.signal;
    this.observation = observation;
    this.observer = this.observe();
  }

  static async open(paths: AkumaPaths, bodySequence: number, leash: HeldAkumaLeash): Promise<BodySupervisor> {
    return new BodySupervisor(paths, bodySequence, leash, await readHeart(paths));
  }

  get reason(): BodyStopReason | undefined { return this.stopping; }

  current(): HeartSnapshot { return this.observation; }

  async recordHung(diagnostic: string, at: string): Promise<void> {
    await this.leash.recordBodyHung(this.paths, { sequence: this.bodySequence, diagnostic, at });
  }

  async refresh(): Promise<HeartSnapshot> {
    this.publish(await readHeart(this.paths));
    return this.observation;
  }

  next(after: HeartSnapshot): Promise<HeartSnapshot> {
    if (this.observation !== after) return Promise.resolve(this.observation);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  cancel(reason: BodyStopReason): void {
    if (this.stopping !== undefined) return;
    this.stopping = reason;
    this.controller.abort(new Error(reason === "control"
      ? "Akuma Body interrupted by durable control"
      : "Akuma Heart disappeared"));
    this.waiter?.(this.observation);
    this.waiter = undefined;
  }

  async close(): Promise<void> {
    this.finished.abort();
    await this.observer;
    this.waiter = undefined;
  }

  private publish(snapshot: HeartSnapshot): void {
    this.observation = snapshot;
    this.waiter?.(snapshot);
    this.waiter = undefined;
  }

  private async observe(): Promise<void> {
    for (;;) {
      const snapshot = this.observation;
      if (!await heartExists(this.paths)) {
        this.cancel("heart-gone");
        return;
      }
      if (bodyControlRequested(snapshot, this.bodySequence)) {
        this.cancel("control");
        return;
      }
      try { await abortableDelay(BODY_CONTROL_OBSERVATION_MS, this.finished.signal); }
      catch { return; }
      try {
        await this.refresh();
      } catch (error) {
        if (await heartExists(this.paths)) throw error;
        this.cancel("heart-gone");
        return;
      }
    }
  }

}

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

function missing(error: unknown): boolean {
  return isHeartAbsent(error) || (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function writeProviderEvent(
  input: DriveTurnInput,
  active: ActiveTurn,
  event: AgentEvent,
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
  await appendActivity(input.paths, {
    turnSequence: active.turnSequence,
    event: encodeAgentEvent(event),
    at,
  });
}

function bodyControlRequested(snapshot: HeartSnapshot, bodySequence: number): boolean {
  return snapshot.stop?.bodySequence === bodySequence
    || snapshot.pause?.bodySequence === bodySequence;
}

async function putDownIfControlled(
  paths: AkumaPaths,
  supervisor: BodySupervisor,
  bodySequence: number,
  now: () => string,
): Promise<void> {
  if (supervisor.reason === "control" && await heartExists(paths)) {
    await breakBody(paths, { sequence: bodySequence, end: "put-down", at: now() });
  }
}

async function turnRecipe(paths: AkumaPaths, soul: Soul): Promise<Readonly<{
  cwd: string;
  options: Soul["options"];
  session?: ResumeCoordinate;
}>> {
  const latest = (await readHeart(paths)).latestSession;
  const admitted = latest?.provider === soul.provider.name ? latest : undefined;
  const session = admitted?.coordinate;
  return {
    cwd: admitted?.cwd ?? soul.cwd,
    options: admitted?.options ?? soul.options,
    ...(session === undefined ? {} : { session }),
  };
}

async function takeLeash(paths: AkumaPaths): Promise<HeldAkumaLeash | null> {
  for (;;) {
    try {
      const leash = await HeldAkumaLeash.try(paths);
      if (leash !== null) return leash;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    await abortableDelay(LEASH_RETRY_MS);
  }
}

type DrivenTurn =
  | (Extract<TurnResult, { kind: "answered" }> & Readonly<{ session?: ResumeCoordinate }>)
  | Extract<TurnResult, { kind: "failed" }>;

type DriveTurnInput = Readonly<{
  paths: AkumaPaths;
  soul: Soul;
  adapter: ProviderAdapter;
  bodySequence: number;
  body: string;
  call?: string;
  launchTells: readonly TellFact[];
  supervisor: BodySupervisor;
  runtimeSpawn(launch: RequestChildLaunch): Promise<void>;
  now(): string;
}>;

type ActiveTurn = Readonly<{
  turnSequence: number;
  drive: Session;
  requests: BodyRequestPump | null;
  cwd: string;
  options: Soul["options"];
  resume?: ResumeCoordinate;
}>;

type TurnWriters = Readonly<{
  input: DriveTurnInput;
  turnSequence: number;
  drive: Session;
  writeWitness: ReturnType<typeof serializeEffects>;
  mayWrite(): boolean;
}>;

type StartTurnResult = ActiveTurn
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "resume-unsupported" }>
  | (Extract<DrivenTurn, { kind: "failed" }> & Readonly<{ turnSequence: number }>);

type TurnDriveResult = DrivenTurn
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "handoff" }>;

async function startTurnDrive(input: DriveTurnInput): Promise<StartTurnResult> {
  const { cwd, options, session } = await turnRecipe(input.paths, input.soul);
  if (session !== undefined && input.adapter.resume === undefined) return { kind: "resume-unsupported" };
  const turn = await beginTurn(input.paths, {
    bodySequence: input.bodySequence,
    startedAt: input.now(),
    ...(input.call === undefined ? {} : { call: input.call }),
  });
  const requests = input.soul.confinement.kind === "declared"
    ? await BodyRequestPump.open({
        paths: input.paths,
        parent: input.soul,
        bodySequence: input.bodySequence,
        now: input.now,
        spawn: input.runtimeSpawn,
        signal: input.supervisor.signal,
      })
    : null;
  const driveInput = {
    body: input.body,
    launchTells: input.launchTells.map((tell) => ({ id: tell.id, text: tell.body })),
    cwd,
    options,
    signal: input.supervisor.signal,
    ...(requests === null ? {} : { requests: { dir: requests.directory } }),
  };
  const setup = session === undefined
    ? input.adapter.start({ ...driveInput, session: { kind: "fresh" } })
    : input.adapter.resume!({ ...driveInput, session: { kind: "resume", coordinate: session } });
  try {
    const selected = await setup;
    if (input.supervisor.signal.aborted) {
      await retireProviderCustody(input, turn.sequence, selected);
      await requests?.close();
      return { kind: "stopped" };
    }
    if (input.launchTells.length > 0) {
      await recordTellDeliveries(input.paths, input.launchTells.map((tell) => ({
        tellId: tell.id,
        route: "launch" as const,
        turnSequence: turn.sequence,
        fence: selected.admission.fence,
        deliveredAt: input.now(),
      })));
    }
    if (requests !== null) void selected.completion.then(() => requests.stopAdmission());
    return { turnSequence: turn.sequence, drive: selected, requests, cwd, options,
      ...(session === undefined ? {} : { resume: session }) };
  } catch (error) {
    await requests?.close();
    if (input.supervisor.signal.aborted) {
      if (input.supervisor.reason === "heart-gone") throw error;
      return { kind: "stopped" };
    }
    return {
      kind: "failed",
      turnSequence: turn.sequence,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}

async function retireProviderCustody(input: DriveTurnInput, turnSequence: number, drive: Session): Promise<void> {
  const outcome = await Promise.race([
    drive.abort().then(
      () => ({ kind: "retired" as const }),
      (error: unknown) => ({ kind: "held" as const, error }),
    ),
    abortableDelay(CONTROL_RESPONSE_MS).then(() => ({
      kind: "held" as const,
      error: new Error(`provider custody remained live after ${CONTROL_RESPONSE_MS}ms`),
    })),
  ]);
  if (outcome.kind === "retired") return;
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
    } catch { /* undisposed provider custody still owns the leash */ }
  }
  for (;;) await abortableDelay(60_000);
}

function pumpReceipts(writers: TurnWriters): Promise<void> {
  const { input, turnSequence, drive, writeWitness, mayWrite } = writers;
  return (async () => {
    if (drive.receipts === undefined) return;
    for await (const receipt of drive.receipts) {
      if (!mayWrite()) return;
      await writeWitness(async () => {
        if (!mayWrite()) return;
        await recordTellReceipt(input.paths, receipt.evidence === "exact"
          ? { ...receipt, receivedAt: input.now() }
          : { ...receipt, turnSequence, receivedAt: input.now() });
      });
    }
  })();
}

function observeReceiptFailure(receiptPump: Promise<void>): Promise<never> {
  return receiptPump.then(
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
    if (attempted.has(tell.id)) continue;
    attempted.add(tell.id);
    const outcome = await writeWitness(async () => {
      const submission = await tellLive({ id: tell.id, text: tell.body });
      if (!mayWrite()) return "turn-ended" as const;
      if (submission.kind === "turn-ended") return "turn-ended" as const;
      await recordTellDeliveries(input.paths, [{
        tellId: tell.id,
        route: "live",
        turnSequence,
        fence: submission.fence,
        receipt: drive.receipts === undefined ? "unavailable" : "required",
        deliveredAt: input.now(),
      }]);
      return "accepted" as const;
    });
    if (outcome === "turn-ended") return "turn-ended";
  }
  return "live";
}

async function stopActiveDrive(
  input: DriveTurnInput,
  active: ActiveTurn,
): Promise<void> {
  await retireProviderCustody(input, active.turnSequence, active.drive);
  await active.requests?.close();
}

function hasUnattemptedTell(
  liveTells: boolean,
  tellPump: Promise<"live" | "turn-ended"> | null,
  pending: readonly TellFact[],
  attempted: ReadonlySet<string>,
): boolean {
  return liveTells && tellPump === null && pending.some((tell) => !attempted.has(tell.id));
}

function persistProviderEvent(
  _input: DriveTurnInput,
  _active: ActiveTurn,
  event: AgentEvent,
): ResumeCoordinate | undefined {
  return event.type === "session" ? event.coordinate : undefined;
}

async function settleCompletion(
  result: TurnResult,
  session: ResumeCoordinate | undefined,
  requests: BodyRequestPump | null,
): Promise<DrivenTurn> {
  await requests?.close();
  return result.kind === "answered" ? { ...result, ...(session === undefined ? {} : { session }) } : result;
}

async function consumeTurnDrive(
  input: DriveTurnInput,
  active: ActiveTurn,
): Promise<TurnDriveResult> {
  const { turnSequence, drive, requests, resume } = active;
  let heart = input.supervisor.current();
  let turnSession = resume;
  const attempted = new Set(input.launchTells.map((tell) => tell.id));
  const writeWitness = serializeEffects();
  let writesOpen = true;
  const mayWrite = (): boolean => writesOpen && !input.supervisor.signal.aborted;
  const writers: TurnWriters = { input, turnSequence, drive, writeWitness, mayWrite };
  const receiptPump = pumpReceipts(writers);
  const receiptFailure = observeReceiptFailure(receiptPump);
  const iterator = drive.events[Symbol.asyncIterator]();
  let pending = iterator.next();
  let liveTells = true;
  let tellPump: Promise<"live" | "turn-ended"> | null = null;
  let tellObservation: Promise<Readonly<{ kind: "tell"; result: "live" | "turn-ended" }>> | null = null;
  try {
    for (;;) {
      if (input.supervisor.signal.aborted) {
        writesOpen = false;
        await stopActiveDrive(input, active);
        return { kind: "stopped" };
      }
      if (hasUnattemptedTell(liveTells, tellPump, heart.pending, attempted)) {
        if (drive.tell === undefined) {
          writesOpen = false;
          await stopActiveDrive(input, active);
          return { kind: "handoff" };
        }
        tellPump = submitPendingLiveTells(writers, heart.pending, attempted, drive.tell);
        tellObservation = tellPump.then((result) => ({ kind: "tell" as const, result }));
      }
      const next = await Promise.race([
        pending.then((event) => ({ kind: "event" as const, event })),
        input.supervisor.next(heart).then((observation) => ({ kind: "heart" as const, observation })),
        ...(tellObservation === null ? [] : [tellObservation]),
        receiptFailure,
        ...(requests === null ? [] : [requests.failure]),
      ]);
      if (next.kind === "event" && !next.event.done) {
        await writeProviderEvent(input, active, next.event.value);
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
      turnSession = persistProviderEvent(input, active, next.event.value) ?? turnSession;
      pending = iterator.next();
    }
    const result = await drive.completion;
    if (tellPump !== null) await tellPump;
    await writeWitness.drain();
    writesOpen = false;
    return await settleCompletion(result, turnSession, requests);
  } catch (error) {
    writesOpen = false;
    if (input.supervisor.signal.aborted) {
      await stopActiveDrive(input, active);
      return { kind: "stopped" };
    }
    await retireProviderCustody(input, turnSequence, drive);
    try { await requests?.close(); } catch { /* preserve the first pump failure */ }
    return { kind: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

async function driveTurn(
  input: DriveTurnInput,
): Promise<(DrivenTurn & Readonly<{ turnSequence: number }>)
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "handoff" }>
  | Readonly<{ kind: "resume-unsupported" }>> {
  let active: ActiveTurn;
  try {
    const started = await startTurnDrive(input);
    if ("kind" in started) return started;
    active = started;
  } catch (error) {
    if (!await heartExists(input.paths)) {
      input.supervisor.cancel("heart-gone");
      return { kind: "stopped" };
    }
    throw error;
  }
  try {
    const result = await consumeTurnDrive(input, active);
    return result.kind === "stopped" || result.kind === "handoff"
      ? result
      : { ...result, turnSequence: active.turnSequence };
  } catch (error) {
    if (await heartExists(input.paths)) {
      await active.requests?.close();
      return { kind: "failed", diagnostic: error instanceof Error ? error.message : String(error),
        turnSequence: active.turnSequence };
    }
    input.supervisor.cancel("heart-gone");
    await stopActiveDrive(input, active);
    return { kind: "stopped" };
  }
}

async function bornSoul(launch: BodyLaunch, leash: HeldAkumaLeash, now: string): Promise<Soul | null> {
  const before = await readHeart(launch.paths);
  if (before.soul !== null) return before.soul;
  if (launch.seed === undefined) throw new Error("Akuma wake has no born soul");
  const candidate: Soul = { ...launch.seed, createdAt: now };
  if (await leash.birth(launch.paths, candidate, launch.birthSession) === "sealed") return null;
  const born = (await readHeart(launch.paths)).soul;
  if (born === null || born.id !== candidate.id) {
    throw new Error("Akuma birth identity does not match its directory");
  }
  return born;
}

async function launchCwd(launch: BodyLaunch): Promise<string> {
  if (launch.seed !== undefined) return launch.seed.cwd;
  const soul = (await readHeart(launch.paths)).soul;
  if (soul === null) throw new Error("Akuma wake has no born soul");
  return (await turnRecipe(launch.paths, soul)).cwd;
}

async function persistTurn(
  paths: AkumaPaths,
  turnSequence: number,
  result: DrivenTurn,
  completedAt: string,
): Promise<"answered" | "failed"> {
  await endTurn(paths, {
    turnSequence,
    outcome: result.kind === "answered" && result.session !== undefined
      ? {
          kind: "answered",
          session: result.session,
          answer: result.answer,
          ...(result.historyId === undefined ? {} : { historyId: result.historyId }),
        }
      : result.kind === "answered"
        ? { kind: "failed", diagnostic: "Provider answered without a resumable session" }
      : { kind: "failed", diagnostic: result.diagnostic },
    completedAt,
  });
  return result.kind === "answered" && result.session === undefined ? "failed" : result.kind;
}

function defaultRuntime(): BodyRuntime {
  return {
    now: () => new Date().toISOString(),
    spawnChild: spawnAkumaBody,
  };
}

type BodyExecution = Readonly<{
  launch: BodyLaunch;
  soul: Soul;
  adapter: ProviderAdapter;
  bodySequence: number;
  supervisor: BodySupervisor;
  runtime: BodyRuntime;
}>;

async function prepareBodyStart(paths: AkumaPaths, leash: HeldAkumaLeash): Promise<boolean> {
  const before = await readHeart(paths);
  if (before.pause !== null) return false;
  if (before.stop === null) return true;
  if (before.latestBody?.sequence === before.stop.bodySequence && before.latestBody.end === "put-down") {
    await leash.settleStop(paths);
  } else {
    await leash.clearStop(paths);
  }
  return true;
}

async function recoverBodyRequests(input: BodyExecution): Promise<boolean> {
  const { launch, soul, bodySequence, supervisor, runtime } = input;
  try {
    const result = await settleBodyRequests(launch.paths, soul, runtime.now, supervisor.signal);
    await clearBodyRequestTransport(launch.paths);
    if (result === "settled") return true;
    await breakBody(launch.paths, { sequence: bodySequence, end: "broke-off", at: runtime.now() });
  } catch (error) {
    if (!supervisor.signal.aborted) throw error;
    await clearBodyRequestTransport(launch.paths);
    await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now);
  }
  return false;
}

async function runBodyTurns(input: BodyExecution): Promise<void> {
  const { launch, soul, adapter, bodySequence, supervisor, runtime } = input;
  let initial = launch.initialBody;
  for (;;) {
    const launchTells = supervisor.current().pending;
    if (supervisor.signal.aborted) {
      await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now);
      return;
    }
    if (initial === undefined && launchTells.length === 0) {
      const finished = await finishBodyIfIdle(launch.paths, { sequence: bodySequence, at: runtime.now() });
      if (finished.kind === "finished") return;
      if (finished.kind === "controlled") {
        supervisor.cancel("control");
        return;
      }
      continue;
    }
    const result = await driveTurn({
      paths: launch.paths,
      soul,
      adapter,
      bodySequence,
      supervisor,
      runtimeSpawn: runtime.spawnChild ?? spawnAkumaBody,
      body: initial ?? "",
      ...(initial === undefined ? {} : { call: initial }),
      launchTells,
      now: runtime.now,
    });
    if (result.kind === "stopped") {
      await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now);
      return;
    }
    if (result.kind === "handoff") {
      await breakBody(launch.paths, { sequence: bodySequence, end: "put-down", at: runtime.now() });
      return;
    }
    if (result.kind === "resume-unsupported"
      || await persistTurn(launch.paths, result.turnSequence, result, runtime.now()) === "failed") {
      await breakBody(launch.paths, { sequence: bodySequence, end: "broke-off", at: runtime.now() });
      return;
    }
    await supervisor.refresh();
    initial = undefined;
  }
}

export async function driveAkumaBody(
  launch: BodyLaunch,
  adapter?: ProviderAdapter,
  runtime: BodyRuntime = defaultRuntime(),
): Promise<void> {
  const leash = await takeLeash(launch.paths);
  if (leash === null) return;
  try {
    const soul = await bornSoul(launch, leash, runtime.now());
    if (soul === null) return;
    const selected = adapter ?? resolveProviderExecution(soul.provider).adapter;
    if (!await prepareBodyStart(launch.paths, leash)) return;
    const body = await leash.recordBody(launch.paths, { leashTakenAt: runtime.now() });
    const supervisor = await BodySupervisor.open(launch.paths, body.sequence, leash);
    const execution = { launch, soul, adapter: selected, bodySequence: body.sequence, supervisor, runtime };
    try {
      if (await recoverBodyRequests(execution)) await runBodyTurns(execution);
    } finally {
      await supervisor.close();
    }
  } catch (error) {
    if (await heartExists(launch.paths)) throw error;
  } finally {
    leash.release();
  }
}

export async function spawnAkumaBody(launch: BodyLaunch): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(launch), "utf8").toString("base64url");
  const owned = await spawnDetachedProcess({
    argv: [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), encoded],
    cwd: await launchCwd(launch),
    log: launch.paths.log,
  });
  owned.release();
}

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (encoded === undefined) throw new TypeError("Akuma body launch payload is missing");
  const launch = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as BodyLaunch;
  await driveAkumaBody(launch);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
