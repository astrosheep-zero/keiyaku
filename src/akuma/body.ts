import { fileURLToPath } from "node:url";
import {
  HeldAkumaLeash,
  advanceTell,
  appendActivity,
  breakBody,
  clearAbandonedControl,
  finishBodyIfIdle,
  heartExists,
  pauseRequested,
  readHeart,
  recordBody,
  recordSession,
  recordTurn,
  stopRequested,
  type ResumeCoordinate,
  type SessionFact,
  type Soul,
  type BodyFact,
} from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";
import { encodeAgentEvent, type Drive, type ProviderAdapter, type TurnResult } from "./provider.js";
import { providerNamed } from "./providers/index.js";
import {
  BodyRequestPump,
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
  prompt: string;
  tellId?: string;
  runtimeSpawn(launch: RequestChildLaunch): Promise<ProcessCollar>;
  now(): string;
}>;

type ActiveTurn = Readonly<{
  drive: Drive;
  requests: BodyRequestPump | null;
  cwd: string;
  options: Soul["options"];
  session?: ResumeCoordinate;
}>;

async function startTurnDrive(input: DriveTurnInput): Promise<ActiveTurn> {
  const { cwd, options, session } = turnRecipe(input.paths, input.soul);
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
    const drive = await input.adapter.start({
      prompt: input.prompt,
      cwd,
      options,
      ...(session === undefined ? {} : { session }),
      ...(requests === null ? {} : { requests: { dir: requests.directory } }),
    });
    if (requests !== null) void drive.completion.then(() => requests.stopAdmission());
    return { drive, requests, cwd, options, ...(session === undefined ? {} : { session }) };
  } catch (error) {
    if (requests !== null) await requests.close();
    throw error;
  }
}

async function consumeTurnDrive(
  input: DriveTurnInput,
  active: ActiveTurn,
): Promise<DrivenTurn | Readonly<{ kind: "stopped" }>> {
  const { drive, requests, cwd, options, session } = active;
  let turnSession = session;
  let entered = false;
  const iterator = drive.events[Symbol.asyncIterator]();
  let pending = iterator.next();
  for (;;) {
    if (stopRequested(input.paths) || pauseRequested(input.paths)) {
      const draining = requests?.close();
      try { await drive.abort(); } finally { await draining; }
      return { kind: "stopped" };
    }
    const next = await Promise.race([
      pending,
      wait(LEASH_RETRY_MS).then(() => null),
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
    appendActivity(input.paths, { event: encodeAgentEvent(event), at });
    if (!entered && input.tellId !== undefined) {
      entered = true;
      advanceTell(input.paths, input.tellId, "seen");
      advanceTell(input.paths, input.tellId, "consumed");
    }
    pending = iterator.next();
  }
  const result = await drive.completion;
  if (requests !== null) await requests.close();
  if (!entered && result.kind === "answered" && input.tellId !== undefined) {
    advanceTell(input.paths, input.tellId, "seen");
    advanceTell(input.paths, input.tellId, "consumed");
  }
  return result.kind === "answered"
    ? { ...result, ...(turnSession === undefined ? {} : { session: turnSession }) }
    : result;
}

async function driveTurn(
  input: DriveTurnInput,
): Promise<DrivenTurn | Readonly<{ kind: "stopped" }> | Readonly<{ kind: "heart-gone" }>> {
  const active = await startTurnDrive(input);
  try {
    return await consumeTurnDrive(input, active);
  } catch (error) {
    const draining = active.requests?.close();
    if (heartExists(input.paths)) {
      await draining;
      throw error;
    }
    try { await active.drive.abort(); } catch { /* the heart loss still owns shutdown */ }
    try { await draining; } catch { /* the vanished heart owns the request loss */ }
    return { kind: "heart-gone" };
  }
}

function bornSoul(launch: BodyLaunch, leash: HeldAkumaLeash, now: string): Soul | null {
  const before = readHeart(launch.paths);
  if (before.death !== null) return null;
  if (before.soul !== null) {
    clearAbandonedControl(launch.paths);
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
  bodySequence: number,
  result: DrivenTurn,
  completedAt: string,
): "answered" | "failed" {
  recordTurn(paths, {
    bodySequence,
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

async function beginBody(paths: AkumaPaths, soul: Soul, runtime: BodyRuntime): Promise<BodyFact | null> {
  if (!await settlePredecessor(paths)) return null;
  const body = recordBody(paths, { collar: runtime.collar, leashTakenAt: runtime.now() });
  if (await settleBodyRequests(paths, soul, runtime.now) === "settled") return body;
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

    const body = await beginBody(launch.paths, soul, runtime);
    if (body === null) return;
    let initial = launch.initialBody;
    for (;;) {
      const snapshot = readHeart(launch.paths);
      if (snapshot.death !== null) {
        breakBody(launch.paths, { sequence: body.sequence, end: "put-down", at: runtime.now() });
        return;
      }
      const tell = initial === undefined ? snapshot.pending[0] : undefined;
      const prompt = initial ?? tell?.body;
      if (prompt === undefined) {
        const finished = finishBodyIfIdle(launch.paths, { sequence: body.sequence, at: runtime.now() });
        if (finished.kind === "finished") return;
        continue;
      }
      if (tell !== undefined) advanceTell(launch.paths, tell.id, "delivered");
      const result = await driveTurn({
        paths: launch.paths,
        soul,
        adapter: selected,
        bodySequence: body.sequence,
        runtimeSpawn: childSpawner(runtime),
        prompt,
        ...(tell === undefined ? {} : { tellId: tell.id }),
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
      if (persistTurn(launch.paths, body.sequence, result, runtime.now()) === "failed") {
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
