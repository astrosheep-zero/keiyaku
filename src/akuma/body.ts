import { fileURLToPath } from "node:url";
import {
  HeldAkumaLeash,
  appendActivity,
  beginTurn,
  breakBody,
  endTurn,
  finishBodyIfIdle,
  heartExists,
  pauseRequested,
  readHeart,
  recordBody,
  recordSession,
  recordTellDeliveries,
  recordTellReceipt,
  stopRequested,
  type ResumeCoordinate,
  type TellFact,
  type SessionFact,
  type Soul,
  type BodyFact,
} from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";
import { encodeAgentEvent, type ProviderAdapter, type Session, type TurnResult } from "./provider.js";
import { providerNamed } from "./providers/index.js";
import {
  BodyRequestPump,
  clearBodyRequestTransport,
  settleBodyRequests,
  type RequestChildLaunch,
} from "./requests.js";
import {
  currentProcessCollar,
  probeProcessTree,
  putDownProcessTree,
  spawnDetachedProcess,
  type ProcessCollar,
} from "../runtime/proc/run.js";

const LEASH_RETRY_MS = 25;

export type BodyLaunch = Readonly<{
  paths: AkumaPaths;
  seed?: Omit<Soul, "createdAt">;
  birthSession?: Omit<SessionFact, "sequence">;
  initialBody?: string;
}>;

type BodyRuntime = Readonly<{
  collar: ProcessCollar;
  now(): string;
  putDownOwnTree(collar: ProcessCollar): Promise<void>;
  spawnChild?(launch: RequestChildLaunch): Promise<ProcessCollar>;
}>;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serializeEffects() {
  let tail = Promise.resolve();
  return async <T>(effect: () => Promise<T> | T): Promise<T> => {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await before;
    try { return await effect(); } finally { release(); }
  };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function turnRecipe(paths: AkumaPaths, soul: Soul): Readonly<{
  cwd: string;
  options: Soul["options"];
  session?: ResumeCoordinate;
}> {
  const latest = readHeart(paths).latestSession;
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
      const leash = HeldAkumaLeash.try(paths);
      if (leash !== null) return leash;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    await wait(LEASH_RETRY_MS);
  }
}

async function settlePredecessor(paths: AkumaPaths): Promise<boolean> {
  const predecessor = readHeart(paths).latestBody;
  if (predecessor === null) return true;
  const probe = probeProcessTree(predecessor.collar);
  if (probe.kind === "gone") return true;
  if (probe.kind === "unverifiable") return false;
  const evidence = await putDownProcessTree(predecessor.collar);
  return evidence !== "unavailable" && evidence !== "alive-after-sigkill";
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
  runtimeSpawn(launch: RequestChildLaunch): Promise<ProcessCollar>;
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

type StartTurnResult = ActiveTurn
  | Readonly<{ kind: "resume-unsupported" }>
  | Readonly<{ kind: "start-failed"; turnSequence: number; diagnostic: string }>;

async function startTurnDrive(input: DriveTurnInput): Promise<StartTurnResult> {
  const { cwd, options, session } = turnRecipe(input.paths, input.soul);
  if (session !== undefined && input.adapter.resume === undefined) return { kind: "resume-unsupported" };
  const turn = beginTurn(input.paths, {
    bodySequence: input.bodySequence,
    startedAt: input.now(),
    ...(input.call === undefined ? {} : { call: input.call }),
  });
  const requests = input.soul.confinement.kind === "declared"
    ? new BodyRequestPump({
        paths: input.paths,
        parent: input.soul,
        bodySequence: input.bodySequence,
        now: input.now,
        spawn: input.runtimeSpawn,
      })
    : null;
  try {
    const driveInput = {
      body: input.body,
      launchTells: input.launchTells.map((tell) => ({ id: tell.id, text: tell.body })),
      cwd,
      options,
      ...(requests === null ? {} : { requests: { dir: requests.directory } }),
    };
    const selected = session === undefined
      ? await input.adapter.start({ ...driveInput, session: { kind: "fresh" } })
      : await input.adapter.resume!({ ...driveInput, session: { kind: "resume", coordinate: session } });
    if (input.launchTells.length > 0) {
      recordTellDeliveries(input.paths, input.launchTells.map((tell) => ({
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
    if (requests !== null) await requests.close();
    const diagnostic = error instanceof Error ? error.message : String(error);
    endTurn(input.paths, {
      turnSequence: turn.sequence,
      outcome: { kind: "failed", diagnostic },
      completedAt: input.now(),
    });
    return { kind: "start-failed", turnSequence: turn.sequence, diagnostic };
  }
}

function pumpReceipts(
  input: DriveTurnInput,
  turnSequence: number,
  drive: Session,
  writeWitness: ReturnType<typeof serializeEffects>,
): Promise<void> {
  return (async () => {
    if (drive.receipts === undefined) return;
    for await (const receipt of drive.receipts) {
      await writeWitness(() => recordTellReceipt(input.paths, receipt.evidence === "exact"
        ? { ...receipt, receivedAt: input.now() }
        : { ...receipt, turnSequence, receivedAt: input.now() }));
    }
  })();
}

async function submitPendingLiveTells(
  input: DriveTurnInput,
  turnSequence: number,
  drive: Session,
  attempted: Set<string>,
  writeWitness: ReturnType<typeof serializeEffects>,
): Promise<"live" | "turn-ended"> {
  if (drive.tell === undefined) return "live";
  for (const tell of readHeart(input.paths).pending) {
    if (attempted.has(tell.id)) continue;
    attempted.add(tell.id);
    const outcome = await writeWitness(async () => {
      const submission = await drive.tell!({ id: tell.id, text: tell.body });
      if (submission.kind === "turn-ended") return "turn-ended" as const;
      recordTellDeliveries(input.paths, [{
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

async function consumeTurnDrive(
  input: DriveTurnInput,
  active: ActiveTurn,
): Promise<DrivenTurn | Readonly<{ kind: "stopped" }>> {
  const { turnSequence, drive, requests, cwd, options, resume } = active;
  let turnSession = resume;
  const attempted = new Set(input.launchTells.map((tell) => tell.id));
  const writeWitness = serializeEffects();
  const receiptPump = pumpReceipts(input, turnSequence, drive, writeWitness);
  const receiptFailure = receiptPump.then(
    () => new Promise<never>(() => {}),
    (error: unknown) => Promise.reject(error),
  );
  const iterator = drive.events[Symbol.asyncIterator]();
  let pending = iterator.next();
  let liveTells = true;
  try {
    for (;;) {
      if (stopRequested(input.paths, input.bodySequence) || pauseRequested(input.paths)) {
        const draining = requests?.close();
        try { await drive.abort(); } finally {
          await draining;
          await receiptPump;
        }
        return { kind: "stopped" };
      }
      if (liveTells) {
        liveTells = await submitPendingLiveTells(input, turnSequence, drive, attempted, writeWitness) === "live";
      }
      const next = await Promise.race([
        pending,
        wait(LEASH_RETRY_MS).then(() => null),
        receiptFailure,
        ...(requests === null ? [] : [requests.failure]),
      ]);
      if (next === null) continue;
      if (next.done) break;
      const event = next.value;
      const at = input.now();
      if (event.type === "session") {
        turnSession = event.coordinate;
        recordSession(input.paths, {
          provider: input.soul.provider.name,
          coordinate: event.coordinate,
          cwd,
          options,
          admittedAt: at,
        });
      }
      appendActivity(input.paths, {
        turnSequence,
        event: encodeAgentEvent(event),
        at,
      });
      pending = iterator.next();
    }
    const result = await drive.completion;
    await receiptPump;
    if (requests !== null) await requests.close();
    return result.kind === "answered"
      ? { ...result, ...(turnSession === undefined ? {} : { session: turnSession }) }
      : result;
  } catch (error) {
    const draining = requests?.close();
    try { await drive.abort(); } catch { /* the pump failure owns the turn result */ }
    try { await receiptPump; } catch { /* preserve the first pump failure */ }
    try { await draining; } catch { /* preserve the first pump failure */ }
    return { kind: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

async function driveTurn(
  input: DriveTurnInput,
): Promise<(DrivenTurn & Readonly<{ turnSequence: number }>)
  | Readonly<{ kind: "stopped"; turnSequence: number }>
  | Readonly<{ kind: "start-failed"; turnSequence: number; diagnostic: string }>
  | Readonly<{ kind: "heart-gone" }>
  | Readonly<{ kind: "resume-unsupported" }>> {
  let active: ActiveTurn;
  try {
    const started = await startTurnDrive(input);
    if ("kind" in started) return started;
    active = started;
  } catch (error) {
    if (!heartExists(input.paths)) return { kind: "heart-gone" };
    throw error;
  }
  try {
    return { ...await consumeTurnDrive(input, active), turnSequence: active.turnSequence };
  } catch (error) {
    const draining = active.requests?.close();
    if (heartExists(input.paths)) {
      await draining;
      return { kind: "failed", diagnostic: error instanceof Error ? error.message : String(error),
        turnSequence: active.turnSequence };
    }
    try { await active.drive.abort(); } catch { /* the heart loss still owns shutdown */ }
    try { await draining; } catch { /* the vanished heart owns the request loss */ }
    return { kind: "heart-gone" };
  }
}

function bornSoul(launch: BodyLaunch, leash: HeldAkumaLeash, now: string): Soul | null {
  const before = readHeart(launch.paths);
  if (before.soul !== null) {
    leash.clearPause(launch.paths);
    return before.soul;
  }
  if (launch.seed === undefined) throw new Error("Akuma wake has no born soul");
  const candidate: Soul = { ...launch.seed, createdAt: now };
  if (leash.birth(launch.paths, candidate, launch.birthSession) === "sealed") return null;
  const born = readHeart(launch.paths).soul;
  if (born === null || born.id !== candidate.id) {
    throw new Error("Akuma birth identity does not match its directory");
  }
  return born;
}

function launchCwd(launch: BodyLaunch): string {
  if (launch.seed !== undefined) return launch.seed.cwd;
  const snapshot = readHeart(launch.paths);
  const soul = snapshot.soul;
  if (soul === null) throw new Error("Akuma wake has no born soul");
  return snapshot.latestSession?.provider === soul.provider.name
    ? snapshot.latestSession.cwd
    : soul.cwd;
}

function persistTurn(
  paths: AkumaPaths,
  turnSequence: number,
  result: DrivenTurn,
  completedAt: string,
): "answered" | "failed" {
  endTurn(paths, {
    turnSequence,
    outcome: result.kind === "answered" && result.session !== undefined
      ? { kind: "answered", historyId: result.historyId, session: result.session, answer: result.answer }
      : result.kind === "answered"
        ? { kind: "failed", diagnostic: "Provider answered without a resumable session" }
      : { kind: "failed", diagnostic: result.diagnostic },
    completedAt,
  });
  return result.kind === "answered" && result.session === undefined ? "failed" : result.kind;
}

function defaultRuntime(): BodyRuntime {
  return {
    collar: currentProcessCollar(),
    now: () => new Date().toISOString(),
    putDownOwnTree: async (collar) => { await putDownProcessTree(collar); },
    spawnChild: async (launch) => await spawnAkumaBody(launch),
  };
}

function childSpawner(runtime: BodyRuntime): (launch: RequestChildLaunch) => Promise<ProcessCollar> {
  return runtime.spawnChild ?? spawnAkumaBody;
}

async function beginBody(
  paths: AkumaPaths,
  soul: Soul,
  leash: HeldAkumaLeash,
  runtime: BodyRuntime,
): Promise<BodyFact | null> {
  if (!await settlePredecessor(paths)) return null;
  leash.settleStop(paths);
  const body = recordBody(paths, { collar: runtime.collar, leashTakenAt: runtime.now() });
  const requests = await settleBodyRequests(paths, soul, runtime.now);
  clearBodyRequestTransport(paths);
  if (requests === "settled") return body;
  breakBody(paths, { sequence: body.sequence, end: "broke-off", at: runtime.now() });
  return null;
}

export async function driveAkumaBody(
  launch: BodyLaunch,
  adapter?: ProviderAdapter,
  runtime: BodyRuntime = defaultRuntime(),
): Promise<void> {
  const leash = await takeLeash(launch.paths);
  if (leash === null) return;
  try {
    const soul = bornSoul(launch, leash, runtime.now());
    if (soul === null) return;
    const selected = adapter ?? providerNamed(soul.provider);

    const body = await beginBody(launch.paths, soul, leash, runtime);
    if (body === null) return;
    let initial = launch.initialBody;
    for (;;) {
      const snapshot = readHeart(launch.paths);
      const launchTells = snapshot.pending;
      if (initial === undefined && launchTells.length === 0) {
        const finished = finishBodyIfIdle(launch.paths, { sequence: body.sequence, at: runtime.now() });
        if (finished.kind === "finished") return;
        continue;
      }
      const result = await driveTurn({
        paths: launch.paths,
        soul,
        adapter: selected,
        bodySequence: body.sequence,
        runtimeSpawn: childSpawner(runtime),
        body: initial ?? "",
        ...(initial === undefined ? {} : { call: initial }),
        launchTells,
        now: runtime.now,
      });
      if (result.kind === "heart-gone") {
        await runtime.putDownOwnTree(runtime.collar);
        return;
      }
      if (result.kind === "stopped") {
        breakBody(launch.paths, { sequence: body.sequence, end: "put-down", at: runtime.now() });
        return;
      }
      if (result.kind === "resume-unsupported") {
        breakBody(launch.paths, { sequence: body.sequence, end: "broke-off", at: runtime.now() });
        return;
      }
      if (result.kind === "start-failed") {
        breakBody(launch.paths, { sequence: body.sequence, end: "broke-off", at: runtime.now() });
        return;
      }
      if (persistTurn(launch.paths, result.turnSequence, result, runtime.now()) === "failed") {
        breakBody(launch.paths, { sequence: body.sequence, end: "broke-off", at: runtime.now() });
        return;
      }
      initial = undefined;
    }
  } catch (error) {
    if (heartExists(launch.paths)) throw error;
    await runtime.putDownOwnTree(runtime.collar);
  } finally {
    leash.release();
  }
}

export async function spawnAkumaBody(launch: BodyLaunch): Promise<ProcessCollar> {
  const encoded = Buffer.from(JSON.stringify(launch), "utf8").toString("base64url");
  return await spawnDetachedProcess({
    argv: [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), encoded],
    cwd: launchCwd(launch),
    log: launch.paths.log,
  });
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
