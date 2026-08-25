import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { abortableDelay } from "./abort.js";
import { BodySupervisor } from "./body-supervisor.js";
import { driveTurn, turnRecipe, type DrivenTurn } from "./turn-drive.js";
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
import { worldRootForAkumaPaths, type AkumaPaths } from "./identity.js";
import type { ProviderAdapter } from "./provider.js";
import { resolveProviderExecution } from "./providers/index.js";
import {
  clearBodyRequestTransport,
  settleBodyRequests,
  type UpstreamExecutionPort,
  type RequestChildLaunch,
} from "./request-serve.js";
import {
  spawnDetachedProcess,
  type DetachedProcessExit,
  type OwnedProcess,
  type RunLogReference,
} from "../runtime/proc/run.js";

const LEASH_RETRY_MS = 100;
export const LEASH_HELD_EXIT = 75;
export { CONTROL_RESPONSE_MS } from "./body-supervisor.js";

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
  spawnChild?(launch: RequestChildLaunch): Promise<OwnedProcess>;
  spawnBody?(launch: BodyLaunch): Promise<OwnedProcess>;
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
): Promise<CommittedOutcome> {
  if (result.kind === "answered" && result.session !== undefined) {
    await endTurn(paths, {
      turnSequence,
      outcome: {
        kind: "answered",
        session: result.session,
        answer: result.answer,
        ...(result.historyId === undefined ? {} : { historyId: result.historyId }),
      },
      completedAt,
    });
    return { outcome: "answered", answer: result.answer };
  }
  const diagnostic = result.kind === "answered" ? "Provider answered without a resumable session" : result.diagnostic;
  await endTurn(paths, { turnSequence, outcome: { kind: "failed", diagnostic }, completedAt });
  return { outcome: "failed", diagnostic };
}

type CommittedOutcome =
  | Readonly<{ outcome: "answered"; answer: string }>
  | Readonly<{ outcome: "failed"; diagnostic: string }>;

const OUTCOME_PREVIEW_LIMIT = 1_000;

function outcomePreview(identity: string, outcome: CommittedOutcome): string {
  const text = outcome.outcome === "answered" ? outcome.answer : outcome.diagnostic;
  if (text.length <= OUTCOME_PREVIEW_LIMIT) return text;
  return `${text.slice(0, OUTCOME_PREVIEW_LIMIT)}\n\nkeiyaku history ${identity} --last`;
}

function boundedDiagnostic(error: unknown): string {
  const text = diagnostic(error);
  return text.length <= 500 ? text : `${text.slice(0, 500)}...`;
}

async function expressInitialOutcome(launch: BodyLaunch, outcome: CommittedOutcome): Promise<void> {
  try {
    const { Square } = await import("@astrosheep/square");
    const identity = launch.seed?.id ?? (await readHeart(launch.paths)).soul?.id;
    if (identity === undefined) return;
    const square = await Square.at({ path: join(worldRootForAkumaPaths(launch.paths), ".square", "PUBLIC.square") });
    try {
      const joined = await square.implicitJoin(identity);
      if (joined.state === "done" || joined.participant === undefined) return;
      await joined.participant.express(outcomePreview(identity, outcome));
    } finally {
      await square.close();
    }
  } catch (error) {
    try {
      await appendFile(launch.paths.log, `square outcome express failed: ${boundedDiagnostic(error)}\n`);
    } catch {
      /* express loss never changes Heart truth */
    }
  }
}

function defaultRuntime(): BodyRuntime {
  return {
    now: () => new Date().toISOString(),
    spawnChild: spawnAkumaBody,
    spawnBody: spawnAkumaBody,
  };
}

export async function bodyProcessInput(launch: BodyLaunch, bodyModuleUrl = import.meta.url) {
  const encoded = Buffer.from(JSON.stringify(launch), "utf8").toString("base64url");
  const actorId = launch.seed?.id ?? (await readHeart(launch.paths)).soul?.id;
  if (actorId === undefined) throw new Error("Akuma wake has no born soul");
  const source = bodyModuleUrl.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "../akuma-body.ts" : "../akuma-body.js", bodyModuleUrl));
  return {
    argv: source
      ? [process.execPath, "--import", import.meta.resolve("tsx"), entry, encoded]
      : [process.execPath, entry, encoded],
    cwd: await launchCwd(launch),
    env: { ...process.env, KEIYAKU_ACTOR_ID: actorId },
    log: launch.paths.log,
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
    if (result.kind === "resume-unsupported") {
      await breakBody(launch.paths, { sequence: bodySequence, end: "broke-off", at: runtime.now() });
      return;
    }
    const outcome = await persistTurn(launch.paths, result.turnSequence, result, runtime.now());
    if (initial !== undefined) await expressInitialOutcome(launch, outcome);
    if (outcome.outcome === "failed") {
      await breakBody(launch.paths, { sequence: bodySequence, end: "broke-off", at: runtime.now() });
      return;
    }
    await supervisor.refresh();
    initial = undefined;
  }
}

export async function handoffPendingTells(
  paths: AkumaPaths,
  spawn: (launch: BodyLaunch) => Promise<OwnedProcess> = spawnAkumaBody,
): Promise<void> {
  try {
    if ((await readHeart(paths)).pending.length === 0) return;
    (await spawn({ paths, refuseIfHeld: true })).release();
  } catch {
    /* a later Heart interaction retries the unchanged pending Tell */
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
    if (bodyStarted) await handoffPendingTells(launch.paths, runtime.spawnBody ?? spawnAkumaBody);
  }
}

export async function spawnAkumaBody(launch: BodyLaunch): Promise<OwnedProcess> {
  return await spawnDetachedProcess(await bodyProcessInput(launch));
}

export async function runAkumaBody(launch: BodyLaunch, upstream: UpstreamExecutionPort): Promise<"held" | void> {
  return await driveAkumaBody(launch, undefined, { ...defaultRuntime(), upstream });
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
