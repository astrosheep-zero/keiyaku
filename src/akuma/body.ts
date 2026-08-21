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
  readNonterminalRequests,
  watchHeart,
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
  spawnDetachedProcess,
  type DetachedProcessExit,
  type OwnedProcess,
  type RunLogReference,
} from "../runtime/proc/run.js";

const LEASH_RETRY_MS = 100;
export const LEASH_HELD_EXIT = 75;
export { CONTROL_RESPONSE_MS } from "./body-turn.js";

export type BodyLaunch = Readonly<{
  paths: AkumaPaths;
  seed?: Omit<Soul, "createdAt">;
  birthSession?: Omit<SessionFact, "sequence">;
  initialBody?: string;
  refuseIfHeld?: boolean;
}>;

export type TellWake =
  | Readonly<{ kind: "told" }>
  | Readonly<{ kind: "pursuing"; bodySequence: number }>
  | Readonly<{ kind: "held" }>
  | Readonly<{
      kind: "failed";
      diagnostic: string;
      child?: Readonly<{
        code: number | null;
        signal: string | null;
        log: RunLogReference;
      }>;
    }>;

export type TellResult = Readonly<{
  admission: Readonly<{ tellId: string; fact: "recorded" }>;
  wake: TellWake;
}>;

export type TellWakeRuntime = Readonly<{
  observeHeart(paths: AkumaPaths, signal: AbortSignal): Promise<AsyncGenerator<void>>;
  spawn(paths: AkumaPaths): Promise<OwnedProcess>;
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
  if (supervisor.reason === "control" && (await heartExists(paths))) {
    await breakBody(paths, { sequence: bodySequence, end: "put-down", at: now() });
  }
}

async function takeLeash(paths: AkumaPaths, refuseIfHeld = false): Promise<HeldAkumaLeash | "held" | "absent"> {
  for (;;) {
    try {
      const leash = await HeldAkumaLeash.try(paths);
      if (leash !== null) return leash;
      if (refuseIfHeld) return "held";
    } catch (error) {
      if (missing(error)) return "absent";
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
  if ((await leash.birth(launch.paths, candidate, launch.birthSession)) === "sealed") return null;
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
    outcome:
      result.kind === "answered" && result.session !== undefined
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
    spawnChild: handoffAkumaBody,
  };
}

async function bodyProcessInput(launch: BodyLaunch) {
  const encoded = Buffer.from(JSON.stringify(launch), "utf8").toString("base64url");
  const actorId = launch.seed?.id ?? (await readHeart(launch.paths)).soul?.id;
  if (actorId === undefined) throw new Error("Akuma wake has no born soul");
  return {
    argv: [process.execPath, ...process.execArgv, fileURLToPath(new URL("../akuma-body.js", import.meta.url)), encoded],
    cwd: await launchCwd(launch),
    env: { ...process.env, KEIYAKU_ACTOR_ID: actorId },
    log: launch.paths.log,
  };
}

async function handoffAkumaBody(launch: BodyLaunch): Promise<void> {
  await handoffProcess(await bodyProcessInput(launch));
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
      runtimeSpawn: runtime.spawnChild ?? handoffAkumaBody,
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
    if (
      result.kind === "resume-unsupported" ||
      (await persistTurn(launch.paths, result.turnSequence, result, runtime.now())) === "failed"
    ) {
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
): Promise<"held" | void> {
  const acquired = await takeLeash(launch.paths, launch.refuseIfHeld);
  if (acquired === "held") return "held";
  if (acquired === "absent") return;
  const leash = acquired;
  let bodyStarted = false;
  try {
    const soul = await bornSoul(launch, leash, runtime.now());
    if (soul === null) return;
    if (launch.seed === undefined && launch.initialBody === undefined) {
      const [heart, requests] = await Promise.all([readHeart(launch.paths), readNonterminalRequests(launch.paths)]);
      if (heart.pending.length === 0 && requests.length === 0) return;
    }
    const selected = adapter ?? (await resolveProviderExecution(soul.provider)).adapter;
    if (!(await prepareBodyStart(launch.paths, leash))) return;
    const body = await leash.recordBody(launch.paths, { leashTakenAt: runtime.now() });
    bodyStarted = true;
    const supervisor = await BodySupervisor.open(launch.paths, body.sequence, leash);
    const execution = { launch, soul, adapter: selected, bodySequence: body.sequence, supervisor, runtime };
    try {
      if (await recoverBodyRequests(execution)) await runBodyTurns(execution);
    } finally {
      await supervisor.close();
    }
  } catch (error) {
    if (!(await heartExists(launch.paths))) return;
    try {
      await leash.sealIfUnborn(launch.paths, {
        evidence: error instanceof Error ? error.message : String(error),
        at: runtime.now(),
      });
    } catch {
      /* the original Body failure remains authoritative */
    }
    throw error;
  } finally {
    leash.release();
    if (bodyStarted) await recoverPendingTells(launch.paths);
  }
}

export async function spawnAkumaBody(launch: BodyLaunch): Promise<OwnedProcess> {
  return await spawnDetachedProcess(await bodyProcessInput(launch));
}

export async function runAkumaBody(launch: BodyLaunch, upstream: UpstreamExecutionPort): Promise<"held" | void> {
  return await driveAkumaBody(launch, undefined, {
    now: () => new Date().toISOString(),
    spawnChild: handoffAkumaBody,
    upstream,
  });
}

const DIRECT_TELL_WAKE: TellWakeRuntime = {
  observeHeart: watchHeart,
  spawn: async (paths) => await spawnAkumaBody({ paths, refuseIfHeld: true }),
};

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preAdmissionDiagnostic(exit: DetachedProcessExit): string {
  return exit.code === null ? `pre-admission signal ${exit.signal ?? "unknown"}` : `pre-admission exit ${exit.code}`;
}

async function settledWake(
  paths: AkumaPaths,
  tellId: string | undefined,
  after: number,
): Promise<Exclude<TellWake, Readonly<{ kind: "held" }> | Extract<TellWake, { kind: "failed" }>> | null> {
  const heart = await readHeart(paths);
  if (tellId !== undefined && !heart.pending.some((tell) => tell.id === tellId)) return { kind: "told" };
  if (heart.latestBody !== null && heart.latestBody.sequence > after) {
    return { kind: "pursuing", bodySequence: heart.latestBody.sequence };
  }
  return null;
}

function failedChild(exit: DetachedProcessExit): Extract<TellWake, { kind: "failed" }> {
  return {
    kind: "failed",
    diagnostic: preAdmissionDiagnostic(exit),
    child: { code: exit.code, signal: exit.signal, log: exit.log },
  };
}

async function awaitWake(
  paths: AkumaPaths,
  tellId: string | undefined,
  after: number,
  child: OwnedProcess,
  changed: AsyncGenerator<void>,
): Promise<TellWake> {
  let nextChange = changed.next();
  for (;;) {
    const settled = await settledWake(paths, tellId, after);
    if (settled !== null) {
      child.release();
      return settled;
    }
    const winner = await Promise.race([
      nextChange.then(
        ({ done }) => ({ kind: done ? ("closed" as const) : ("changed" as const) }),
        (error) => ({ kind: "observer-failed" as const, error }),
      ),
      child.exited.then((exit) => ({ kind: "exited" as const, exit })),
    ]);
    if (winner.kind === "changed") {
      nextChange = changed.next();
      continue;
    }
    const final = await settledWake(paths, tellId, after);
    if (final !== null) {
      child.release();
      return final;
    }
    if (winner.kind === "exited") {
      return winner.exit.code === LEASH_HELD_EXIT ? { kind: "held" } : failedChild(winner.exit);
    }
    await child.terminate();
    await child.exited;
    return winner.kind === "observer-failed"
      ? { kind: "failed", diagnostic: diagnostic(winner.error) }
      : { kind: "failed", diagnostic: "Heart observer closed" };
  }
}

async function wakePendingTells(
  paths: AkumaPaths,
  tellId: string | undefined,
  runtime: TellWakeRuntime,
): Promise<TellWake | null> {
  const watching = new AbortController();
  let changed: AsyncGenerator<void> | undefined;
  try {
    const beforeHeart = await readHeart(paths);
    if (tellId === undefined && beforeHeart.pending.length === 0) return null;
    const before = beforeHeart.latestBody?.sequence ?? 0;
    changed = await runtime.observeHeart(paths, watching.signal);
    return await awaitWake(paths, tellId, before, await runtime.spawn(paths), changed);
  } catch (error) {
    return { kind: "failed", diagnostic: diagnostic(error) };
  } finally {
    watching.abort();
    await changed?.return(undefined);
  }
}

export async function wakeRecordedTell(
  paths: AkumaPaths,
  tellId: string,
  runtime: TellWakeRuntime = DIRECT_TELL_WAKE,
): Promise<TellResult> {
  return {
    admission: { tellId, fact: "recorded" },
    wake: (await wakePendingTells(paths, tellId, runtime))!,
  };
}

export async function recoverPendingTells(paths: AkumaPaths): Promise<void> {
  await wakePendingTells(paths, undefined, DIRECT_TELL_WAKE);
}
