import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { abortableDelay } from "./abort.js";
import { BodySupervisor } from "./body-supervisor.js";
import type { AkumaCallRequestChildLaunch } from "./call-request.js";
import { driveTurn, turnRecipe, type DrivenTurn } from "./turn-drive.js";
import {
  HeldAkumaLeash,
  breakBody,
  decidePendingTellDisposition,
  drainPendingTells,
  endTurn,
  failOpenBoundTurns,
  finishBodyIfIdle,
  heartExists,
  isHeartAbsent,
  probeLeash,
  projectTell,
  provePendingTellDispositionCustody,
  readHeart,
  readOpenPendingTellDisposition,
  readTell,
  readTurn,
  readNonterminalRequests,
  recordUndeliveredPendingTells,
  resolvePendingTellDisposition,
  type PendingTellDisposition,
  type BodyEnd,
  type SessionFact,
  type Soul,
  type TellRow,
  type TurnOutcome,
} from "./heart/index.js";
import { worldRootForAkumaPaths, type AkumaPaths } from "./identity.js";
import { pluginRuntime, type PluginRuntime } from "../plugin/runtime.js";
import { World, type WorldRoot } from "../world.js";
import type { ProviderAdapter } from "./provider.js";
import { resolveProviderExecution } from "./providers/index.js";
import { clearBodyRequestTransport, settleBodyRequests } from "./request-serve.js";
import type { ErasedRequestCommand } from "./request-wire.js";
import {
  spawnDetachedProcess,
  type DetachedProcessExit,
  type OwnedProcess,
  type RunLogReference,
} from "../runtime/proc/run.js";

const LEASH_RETRY_MS = 100;
const WAKE_REREAD_MS = 100;
export const LEASH_HELD_EXIT = 75;
export { CONTROL_RESPONSE_MS } from "./body-supervisor.js";

export type BodyLaunch = Readonly<{
  paths: AkumaPaths;
  seed?: Omit<Soul, "createdAt">;
  birthSession?: Omit<SessionFact, "sequence">;
  initialBody?: string;
  initialSchemaJson?: string;
  refuseIfHeld?: boolean;
  completion?: Readonly<{ contractId?: string }>;
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
  row: TellRow;
  wake: TellWake;
}>;

export type TellWakeRuntime = Readonly<{
  spawn(paths: AkumaPaths): Promise<OwnedProcess>;
  schedule?(milliseconds: number, signal: AbortSignal): Promise<void>;
}>;

type BodyRuntime = Readonly<{
  now(): string;
  spawnChild?(launch: AkumaCallRequestChildLaunch): Promise<OwnedProcess>;
  spawnBody?(launch: BodyLaunch): Promise<OwnedProcess>;
  world: WorldRoot;
  externalCommands: Readonly<Record<string, ErasedRequestCommand>>;
}>;

function missing(error: unknown): boolean {
  return isHeartAbsent(error) || (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function failOpenBoundTurnsIfPresent(
  paths: AkumaPaths,
  bodySequence: number,
  diagnostic: string,
  at: string,
): Promise<void> {
  if (!(await heartExists(paths))) return;
  await failOpenBoundTurns(paths, { bodySequence, diagnostic, completedAt: at });
}

async function putDownIfControlled(
  paths: AkumaPaths,
  supervisor: BodySupervisor,
  bodySequence: number,
  now: () => string,
): Promise<void> {
  if (supervisor.reason === "control" && (await heartExists(paths))) {
    await failOpenBoundTurnsIfPresent(paths, bodySequence, "Body put-down with open bound Turns", now());
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

function parseSchemaAnswerJson(
  raw: string,
): Readonly<{ kind: "json"; json: string }> | Readonly<{ kind: "invalid"; diagnostic: string }> {
  try {
    JSON.parse(raw);
    return { kind: "json", json: raw };
  } catch (error) {
    return {
      kind: "invalid",
      diagnostic: error instanceof Error ? error.message : "Answer is not valid JSON",
    };
  }
}

async function persistTurn(
  paths: AkumaPaths,
  turnSequence: number,
  result: DrivenTurn,
  completedAt: string,
): Promise<CommittedOutcome> {
  const turn = await readTurn(paths, turnSequence);
  const schemaJson = turn?.schemaJson;
  if (result.kind === "answered" && result.session !== undefined) {
    if (schemaJson !== undefined) {
      const parsed = parseSchemaAnswerJson(result.answer);
      if (parsed.kind === "invalid") {
        const outcome: TurnOutcome = {
          kind: "invalid-output",
          diagnostic: parsed.diagnostic,
          answer: result.answer,
          session: result.session,
          ...(result.historyId === undefined ? {} : { historyId: result.historyId }),
        };
        await endTurn(paths, { turnSequence, outcome, completedAt });
        return { outcome: "failed", diagnostic: parsed.diagnostic };
      }
      await endTurn(paths, {
        turnSequence,
        outcome: {
          kind: "answered",
          session: result.session,
          answer: result.answer,
          answerJson: parsed.json,
          ...(result.historyId === undefined ? {} : { historyId: result.historyId }),
        },
        completedAt,
      });
      return { outcome: "answered", answer: result.answer };
    }
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

function boundedDiagnostic(error: unknown): string {
  const text = diagnostic(error);
  return text.length <= 500 ? text : `${text.slice(0, 500)}...`;
}

async function recordPluginDiagnostic(paths: AkumaPaths, occurrence: string, error: unknown): Promise<void> {
  try {
    await appendFile(paths.log, `plugin ${occurrence} failed: ${boundedDiagnostic(error)}\n`);
  } catch {
    /* plugin diagnostic loss never changes Heart truth */
  }
}

const DEFAULT_RUNTIME: Omit<BodyRuntime, "world"> = {
  now: () => new Date().toISOString(),
  spawnChild: spawnAkumaBody,
  externalCommands: {},
  spawnBody: spawnAkumaBody,
};

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

async function prepareBodyExecution(
  launch: BodyLaunch,
  leash: HeldAkumaLeash,
  runtime: BodyRuntime,
  adapter: ProviderAdapter | undefined,
): Promise<Readonly<{ soul: Soul; adapter: ProviderAdapter }> | null> {
  const soul = await bornSoul(launch, leash, runtime.now());
  if (soul === null) return null;
  if (launch.seed === undefined && launch.initialBody === undefined) {
    const [heart, requests] = await Promise.all([readHeart(launch.paths), readNonterminalRequests(launch.paths)]);
    if (heart.pending.length === 0 && requests.length === 0) return null;
  }
  const selected = adapter ?? (await resolveProviderExecution(soul.provider)).adapter;
  if (!(await prepareBodyStart(launch.paths, leash))) return null;
  return { soul, adapter: selected };
}

async function runPreparedBody(input: BodyExecution): Promise<BodyTurnEnd> {
  let pendingTellDisposition: BodyTurnEnd = undefined;
  try {
    if (await recoverBodyRequests(input)) pendingTellDisposition = await runBodyTurns(input);
  } finally {
    await input.supervisor.close();
  }
  return pendingTellDisposition;
}

async function preserveBodyFailure(
  paths: AkumaPaths,
  leash: HeldAkumaLeash,
  error: unknown,
  at: string,
): Promise<void> {
  if (!(await heartExists(paths))) return;
  try {
    await leash.sealIfUnborn(paths, {
      evidence: error instanceof Error ? error.message : String(error),
      at,
    });
  } catch {
    /* the original Body failure remains authoritative */
  }
}

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

type TurnOutcomeEmitter = Readonly<{
  emit(turnSequence: number, outcome: CommittedOutcome): Promise<void>;
  drain(): Promise<void>;
}>;

function turnOutcomeEmitter(launch: BodyLaunch, soul: Soul): TurnOutcomeEmitter {
  let plugins: Promise<PluginRuntime> | undefined;
  const pending = new Set<Promise<void>>();
  const reportDiagnostic = (message: string): void => {
    void recordPluginDiagnostic(launch.paths, "turn outcome", message);
  };
  const emit = (turnSequence: number, outcome: CommittedOutcome): Promise<void> => {
    let delivery!: Promise<void>;
    delivery = (async () => {
      try {
        plugins ??= pluginRuntime({
          world: await World.at(worldRootForAkumaPaths(launch.paths)),
          reportDiagnostic,
        });
        await (
          await plugins
        ).emit(
          {
            kind: "akuma.turn-outcome",
            akumaId: soul.id,
            turnSequence,
            outcome:
              outcome.outcome === "answered"
                ? { kind: "answered", text: outcome.answer }
                : { kind: "failed", reason: outcome.diagnostic },
            ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
          },
          reportDiagnostic,
        );
      } catch (error) {
        await recordPluginDiagnostic(launch.paths, "turn outcome", error);
      }
    })().finally(() => pending.delete(delivery));
    pending.add(delivery);
    return delivery;
  };
  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
    if (plugins !== undefined) await (await plugins).drain();
  };
  return { emit, drain };
}

function bodyEndEmitter(
  launch: BodyLaunch,
  soul: Soul,
): (bodySequence: number, end: BodyEnd | "hung", diagnostic?: string) => void {
  let plugins: Promise<PluginRuntime> | undefined;
  const reportDiagnostic = (message: string): void => {
    void recordPluginDiagnostic(launch.paths, "body end", message);
  };
  return (bodySequence, end, diagnostic) => {
    void (async () => {
      try {
        plugins ??= pluginRuntime({
          world: await World.at(worldRootForAkumaPaths(launch.paths)),
          reportDiagnostic,
        });
        const runtime = await plugins;
        await runtime.emit(
          {
            kind: "akuma.body-ended",
            akumaId: soul.id,
            bodySequence,
            end,
            ...(diagnostic === undefined ? {} : { diagnostic }),
            ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
          },
          reportDiagnostic,
        );
      } catch (error) {
        await recordPluginDiagnostic(launch.paths, "body end", error);
      }
    })();
  };
}

type BodyTurnEnd = "handoff" | undefined;

async function runBodyTurns(input: BodyExecution): Promise<BodyTurnEnd> {
  const { launch, soul, adapter, bodySequence, supervisor, runtime } = input;
  let initial = launch.initialBody;
  const emitTurnOutcome = turnOutcomeEmitter(launch, soul);
  try {
    for (;;) {
      const launchTells = drainPendingTells(supervisor.current().pending);
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
        ...(launchTells.find((tell) => tell.schemaJson !== undefined)?.schemaJson === undefined
          ? launch.initialSchemaJson === undefined
            ? {}
            : { schemaJson: launch.initialSchemaJson }
          : { schemaJson: launchTells.find((tell) => tell.schemaJson !== undefined)!.schemaJson }),
        world: runtime.world,
        externalCommands: runtime.externalCommands,
        now: runtime.now,
      });
      if (result.kind === "hung") {
        await failOpenBoundTurnsIfPresent(launch.paths, bodySequence, "Body hung with open bound Turns", runtime.now());
        return;
      }
      if (result.kind === "stopped") {
        await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now);
        return;
      }
      if (result.kind === "handoff") return "handoff";
      if (result.kind === "resume-unsupported") {
        await failOpenBoundTurnsIfPresent(
          launch.paths,
          bodySequence,
          "resume-unsupported with open bound Turns",
          runtime.now(),
        );
        await breakBody(launch.paths, { sequence: bodySequence, end: "broke-off", at: runtime.now() });
        return;
      }
      const outcome = await persistTurn(launch.paths, result.turnSequence, result, runtime.now());
      void emitTurnOutcome.emit(result.turnSequence, outcome);
      if (outcome.outcome === "failed") {
        await failOpenBoundTurnsIfPresent(launch.paths, bodySequence, outcome.diagnostic, runtime.now());
        await breakBody(launch.paths, { sequence: bodySequence, end: "broke-off", at: runtime.now() });
        return;
      }
      await supervisor.refresh();
      initial = undefined;
    }
  } finally {
    await emitTurnOutcome.drain();
  }
}

async function projectUndeliveredPendingTellEvidence(paths: AkumaPaths, error: unknown): Promise<void> {
  try {
    await appendFile(paths.log, `pending Tell disposition undelivered: ${boundedDiagnostic(error)}\n`);
  } catch {
    /* log evidence loss never changes Heart truth */
  }
}

async function settleUndeliveredDisposition(
  paths: AkumaPaths,
  disposition: PendingTellDisposition,
  error: unknown,
): Promise<void> {
  await projectUndeliveredPendingTellEvidence(paths, error);
  if (!(await heartExists(paths))) return;
  const at = new Date().toISOString();
  await recordUndeliveredPendingTells(paths, at, disposition.tellIds);
  await resolvePendingTellDisposition(paths, disposition.bodySequence, at);
}

async function consumeProvenDisposition(paths: AkumaPaths, disposition: PendingTellDisposition): Promise<boolean> {
  const proof = await provePendingTellDispositionCustody(paths, disposition);
  if (proof.kind !== "proven") return false;
  await resolvePendingTellDisposition(paths, disposition.bodySequence, new Date().toISOString());
  return true;
}

/**
 * Wait for Heart custody proof of the frozen Tell-id snapshot, or for the
 * spawned child to exit without that proof. Sequence growth, spawn resolution,
 * and an unqualified held leash never consume the disposition.
 */
async function awaitDispositionCustody(
  paths: AkumaPaths,
  disposition: PendingTellDisposition,
  child: OwnedProcess,
  schedule: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<TellWake | Readonly<{ kind: "proven" }>> {
  for (;;) {
    if ((await provePendingTellDispositionCustody(paths, disposition)).kind === "proven") {
      child.release();
      return { kind: "proven" };
    }
    const timerController = new AbortController();
    const timer = schedule(WAKE_REREAD_MS, timerController.signal).then(() => ({ kind: "timer" as const }));
    let winner: Awaited<typeof timer> | { kind: "exited"; exit: DetachedProcessExit };
    try {
      winner = await Promise.race([child.exited.then((exit) => ({ kind: "exited" as const, exit })), timer]);
    } catch (error) {
      timerController.abort();
      await timer.catch(() => undefined);
      throw error;
    }
    if (winner.kind === "timer") continue;
    timerController.abort();
    await timer.catch(() => undefined);
    if ((await provePendingTellDispositionCustody(paths, disposition)).kind === "proven") {
      child.release();
      return { kind: "proven" };
    }
    return winner.exit.code === LEASH_HELD_EXIT ? { kind: "held" } : failedChild(winner.exit);
  }
}

async function resolveDecidedPendingTellDisposition(
  paths: AkumaPaths,
  disposition: PendingTellDisposition,
  spawn: (launch: BodyLaunch) => Promise<OwnedProcess>,
): Promise<void> {
  try {
    if (await consumeProvenDisposition(paths, disposition)) return;
    const wake = await awaitDispositionCustody(
      paths,
      disposition,
      await spawn({ paths, refuseIfHeld: true }),
      abortableDelay,
    );
    if (wake.kind === "proven") {
      await resolvePendingTellDisposition(paths, disposition.bodySequence, new Date().toISOString());
      return;
    }
    // Predecessor still holds the leash: leave the Heart disposition open.
    if (wake.kind === "held") return;
    await settleUndeliveredDisposition(
      paths,
      disposition,
      wake.kind === "failed" ? wake.diagnostic : "successor custody unproven",
    );
  } catch (error) {
    await settleUndeliveredDisposition(paths, disposition, error);
  }
}

export async function handoffPendingTells(
  paths: AkumaPaths,
  spawn: (launch: BodyLaunch) => Promise<OwnedProcess> = spawnAkumaBody,
): Promise<void> {
  const open = await readOpenPendingTellDisposition(paths);
  if (open !== null) {
    await resolveDecidedPendingTellDisposition(paths, open, spawn);
    return;
  }
  const before = await readHeart(paths);
  if (before.pending.length === 0) return;
  if ((await probeLeash(paths)) === "held") return;
  const bodySequence = before.latestBody?.sequence;
  if (bodySequence === undefined || before.latestBody?.end === undefined) return;
  const decided = await decidePendingTellDisposition(paths, {
    bodySequence,
    at: new Date().toISOString(),
    handoff: before.latestBody.end === "put-down",
  });
  if (decided === null) return;
  await resolveDecidedPendingTellDisposition(paths, decided, spawn);
}

export async function driveAkumaBody(
  launch: BodyLaunch,
  adapter?: ProviderAdapter,
  runtimeInput: Partial<BodyRuntime> = {},
): Promise<"held" | void> {
  const world = runtimeInput.world ?? (await World.at(worldRootForAkumaPaths(launch.paths)));
  const runtime: BodyRuntime = { ...DEFAULT_RUNTIME, ...runtimeInput, world };
  const acquired = await takeLeash(launch.paths, launch.refuseIfHeld);
  if (acquired === "held") return "held";
  if (acquired === "absent") return;
  const leash = acquired;
  let pendingTellDisposition: BodyTurnEnd = undefined;
  let bodySequence: number | undefined;
  let decidedDisposition: PendingTellDisposition | null = null;
  let emitBodyEnd: ReturnType<typeof bodyEndEmitter> | undefined;
  try {
    const prepared = await prepareBodyExecution(launch, leash, runtime, adapter);
    if (prepared === null) return;
    emitBodyEnd = bodyEndEmitter(launch, prepared.soul);
    const body = await leash.recordBody(launch.paths, { leashTakenAt: runtime.now() });
    bodySequence = body.sequence;
    const supervisor = await BodySupervisor.open(launch.paths, body.sequence, leash);
    pendingTellDisposition = await runPreparedBody({
      launch,
      soul: prepared.soul,
      adapter: prepared.adapter,
      bodySequence: body.sequence,
      supervisor,
      runtime,
    });
  } catch (error) {
    await preserveBodyFailure(launch.paths, leash, error, runtime.now());
    throw error;
  } finally {
    if (bodySequence !== undefined && (await heartExists(launch.paths))) {
      const body = (await readHeart(launch.paths)).latestBody;
      const inert = body?.sequence === bodySequence && (body.end !== undefined || body.hung !== undefined);
      if (inert) {
        await failOpenBoundTurns(launch.paths, {
          bodySequence,
          diagnostic: body.hung?.diagnostic ?? `Body ${body.end ?? "ended"} with open bound Turns`,
          completedAt: runtime.now(),
        });
      }
      decidedDisposition = await decidePendingTellDisposition(launch.paths, {
        bodySequence,
        at: runtime.now(),
        handoff: pendingTellDisposition === "handoff",
      });
      const finalBody = (await readHeart(launch.paths)).latestBody;
      if (
        emitBodyEnd !== undefined &&
        finalBody?.sequence === bodySequence &&
        (finalBody.end !== undefined || finalBody.hung !== undefined)
      ) {
        emitBodyEnd(bodySequence, finalBody.hung === undefined ? finalBody.end! : "hung", finalBody.hung?.diagnostic);
      }
    }
    leash.release();
    if (decidedDisposition !== null) {
      await resolveDecidedPendingTellDisposition(launch.paths, decidedDisposition, runtime.spawnBody ?? spawnAkumaBody);
    }
  }
}

export async function spawnAkumaBody(launch: BodyLaunch): Promise<OwnedProcess> {
  return await spawnDetachedProcess(await bodyProcessInput(launch));
}

export async function runAkumaBody(
  launch: BodyLaunch,
  world: WorldRoot,
  externalCommands: Readonly<Record<string, ErasedRequestCommand>>,
): Promise<"held" | void> {
  try {
    return await driveAkumaBody(launch, undefined, { world, externalCommands });
  } finally {
    await (await pluginRuntime({ world })).drain();
  }
}

const DIRECT_TELL_WAKE: TellWakeRuntime = {
  spawn: async (paths) => await spawnAkumaBody({ paths, refuseIfHeld: true }),
  schedule: abortableDelay,
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
  schedule: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<TellWake> {
  for (;;) {
    const settled = await settledWake(paths, tellId, after);
    if (settled !== null) {
      child.release();
      return settled;
    }
    const timerController = new AbortController();
    const timer = schedule(WAKE_REREAD_MS, timerController.signal).then(() => ({ kind: "timer" as const }));
    let winner: Awaited<typeof timer> | { kind: "exited"; exit: DetachedProcessExit };
    try {
      winner = await Promise.race([child.exited.then((exit) => ({ kind: "exited" as const, exit })), timer]);
    } catch (error) {
      timerController.abort();
      await timer.catch(() => undefined);
      throw error;
    }
    if (winner.kind === "timer") continue;
    timerController.abort();
    await timer.catch(() => undefined);
    const final = await settledWake(paths, tellId, after);
    if (final !== null) {
      child.release();
      return final;
    }
    return winner.exit.code === LEASH_HELD_EXIT ? { kind: "held" } : failedChild(winner.exit);
  }
}

async function wakePendingTells(
  paths: AkumaPaths,
  tellId: string | undefined,
  runtime: TellWakeRuntime,
): Promise<TellWake | null> {
  try {
    const beforeHeart = await readHeart(paths);
    if (tellId === undefined && beforeHeart.pending.length === 0) return null;
    const before = beforeHeart.latestBody?.sequence ?? 0;
    return await awaitWake(paths, tellId, before, await runtime.spawn(paths), runtime.schedule ?? abortableDelay);
  } catch (error) {
    return { kind: "failed", diagnostic: diagnostic(error) };
  }
}

export async function wakeRecordedTell(
  paths: AkumaPaths,
  tellId: string,
  runtime: TellWakeRuntime = DIRECT_TELL_WAKE,
): Promise<TellResult> {
  const wake = (await wakePendingTells(paths, tellId, runtime))!;
  const tell = await readTell(paths, tellId);
  if (tell === null) throw new Error(`recorded Tell ${tellId} is missing from Heart`);
  return {
    admission: { tellId, fact: "recorded" },
    row: projectTell(tell),
    wake,
  };
}
