import { fileURLToPath } from "node:url";
import { abortableDelay } from "./abort.js";
import { BodySupervisor, driveTurn, turnRecipe, type DrivenTurn } from "./body-turn.js";
import {
  HeldAkumaLeash,
  breakBody,
  endTurn,
  finishBodyIfIdle,
  heartExists,
  isHeartAbsent,
  readHeart,
  type SessionFact,
  type Soul,
} from "./heart/index.js";
import type { AkumaPaths } from "./identity.js";
import type { ProviderAdapter } from "./provider.js";
import { resolveProviderExecution } from "./providers/index.js";
import {
  clearBodyRequestTransport,
  settleBodyRequests,
  type UpstreamExecutionPort,
  type RequestChildLaunch,
} from "./request-serve.js";
import {
  handoffProcess,
} from "../runtime/proc/run.js";

const LEASH_RETRY_MS = 25;
export { CONTROL_RESPONSE_MS } from "./body-turn.js";

export type BodyLaunch = Readonly<{
  paths: AkumaPaths;
  seed?: Omit<Soul, "createdAt">;
  birthSession?: Omit<SessionFact, "sequence">;
  initialBody?: string;
}>;

type BodyRuntime = Readonly<{
  now(): string;
  spawnChild?(launch: RequestChildLaunch): Promise<void>;
  upstream?: UpstreamExecutionPort;
}>;


function missing(error: unknown): boolean {
  return isHeartAbsent(error) || (error as NodeJS.ErrnoException).code === "ENOENT";
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
    const result = await settleBodyRequests(
      launch.paths,
      soul,
      runtime.now,
      supervisor.signal,
    );
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
      ...(runtime.upstream === undefined ? {} : { upstream: runtime.upstream }),
      now: runtime.now,
    });
    if (result.kind === "hung") return;
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
    const selected = adapter ?? (await resolveProviderExecution(soul.provider)).adapter;
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
    if (!await heartExists(launch.paths)) return;
    try {
      await leash.sealIfUnborn(launch.paths, {
        evidence: error instanceof Error ? error.message : String(error),
        at: runtime.now(),
      });
    } catch { /* the original Body failure remains authoritative */ }
    throw error;
  } finally {
    leash.release();
  }
}

export async function spawnAkumaBody(launch: BodyLaunch): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(launch), "utf8").toString("base64url");
  const actorId = launch.seed?.id ?? (await readHeart(launch.paths)).soul?.id;
  if (actorId === undefined) throw new Error("Akuma wake has no born soul");
  await handoffProcess({
    argv: [process.execPath, ...process.execArgv, fileURLToPath(new URL("../akuma-body.js", import.meta.url)), encoded],
    cwd: await launchCwd(launch),
    env: { ...process.env, KEIYAKU_ACTOR_ID: actorId },
    log: launch.paths.log,
  });
}

export async function runAkumaBody(launch: BodyLaunch, upstream: UpstreamExecutionPort): Promise<void> {
  await driveAkumaBody(launch, undefined, {
    now: () => new Date().toISOString(),
    spawnChild: spawnAkumaBody,
    upstream,
  });
}
