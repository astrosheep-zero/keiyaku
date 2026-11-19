import { projectAkumaBirth } from "./caller.js";
import { appendFile } from "node:fs/promises";
import { abortable, abortableDelay } from "./abort.js";
import { BodySupervisor } from "./body-supervisor.js";
import { driveTurn, type DrivenTurn } from "./turn-drive.js";
import {
  HeldAkumaLeash,
  BodyControlledError,
  breakBody,
  cancelBodyTurns,
  drainPendingTells,
  endTurn,
  failOpenBoundTurns,
  finishBodyIfIdle,
  heartExists,
  isHeartAbsent,
  readHeart,
  readLatestTurnForBody,
  readOpenBoundTurns,
  readTellAction,
  readTurn,
  readTurnParticipants,
  type BodyEnd,
  type Soul,
  type TurnOutcome,
} from "./heart/index.js";
import { worldRootForAkumaPaths, type AkumaPaths } from "./identity.js";
import type { TellWake } from "./call-initial-tell.js";
export type { TellResult, TellWake } from "./call-initial-tell.js";
import { emitPluginSignal } from "../plugin/akuma-signals.js";
import { World, type WorldRoot } from "../world.js";
import type { ProviderAdapter } from "./provider.js";
import type { ExecutionAssociationReader } from "./execution-instructions.js";
import { resolveProviderExecution } from "./providers/index.js";
import { observeBodyLaunch, type BodyLaunch, type BodyLauncher, type LiveBodyLaunch } from "./body-launch.js";

const LEASH_RETRY_MS = 100;
export { CONTROL_RESPONSE_MS } from "./body-supervisor.js";

export type TellWakeRuntime = Readonly<{
  spawn(paths: AkumaPaths): Promise<LiveBodyLaunch>;
  schedule?(milliseconds: number, signal: AbortSignal): Promise<void>;
}>;

export type BodyRuntime = Readonly<{
  now(): string;
  signal?: AbortSignal;
  forceSignal?: AbortSignal;
  world: WorldRoot;
  executionAssociation?: ExecutionAssociationReader;
}>;

export function tellWakeRuntime(spawn: BodyLauncher): TellWakeRuntime {
  return { spawn: async (paths) => await spawn({ paths, refuseIfHeld: true }) };
}

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

async function putDownBody(
  paths: AkumaPaths,
  bodySequence: number,
  now: () => string,
  turnOutcome?: TurnOutcomeEmitter,
): Promise<void> {
  const settled = await cancelBodyTurns(paths, { bodySequence, at: now() });
  for (const sequence of settled.canceled) await turnOutcome?.emit(sequence);
}

async function putDownIfControlled(
  paths: AkumaPaths,
  supervisor: BodySupervisor,
  bodySequence: number,
  now: () => string,
  turnOutcome?: TurnOutcomeEmitter,
): Promise<void> {
  if ((supervisor.reason === "control" || supervisor.reason === "launch") && (await heartExists(paths)))
    await putDownBody(paths, bodySequence, now, turnOutcome);
}

async function takeLeash(
  paths: AkumaPaths,
  refuseIfHeld = false,
  signal?: AbortSignal,
): Promise<HeldAkumaLeash | "held" | "absent"> {
  for (;;) {
    signal?.throwIfAborted();
    try {
      const leash = await HeldAkumaLeash.try(paths);
      if (leash !== null) return leash;
      if (refuseIfHeld) return "held";
    } catch (error) {
      if (missing(error)) return "absent";
      throw error;
    }
    await abortableDelay(LEASH_RETRY_MS, signal);
  }
}

async function bornSoul(
  launch: BodyLaunch,
  leash: HeldAkumaLeash,
  now: string,
): Promise<Readonly<{ soul: Soul; created: boolean }> | null> {
  const before = await readHeart(launch.paths);
  if (before.soul !== null) return { soul: before.soul, created: false };
  if (launch.seed === undefined) throw new Error("Akuma wake has no born soul");
  const candidate: Soul = { ...launch.seed, createdAt: now };
  const result = await leash.birth(launch.paths, candidate, launch.birthSession);
  if (result === "sealed") return null;
  const born = (await readHeart(launch.paths)).soul;
  if (born === null || born.id !== candidate.id) {
    throw new Error("Akuma birth identity does not match its directory");
  }
  return { soul: born, created: result === "born" };
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
    let answerJson: string | undefined;
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
      answerJson = parsed.json;
    }
    await endTurn(paths, {
      turnSequence,
      outcome: {
        kind: "answered",
        session: result.session,
        answer: result.answer,
        ...(answerJson === undefined ? {} : { answerJson }),
        ...(result.historyId === undefined ? {} : { historyId: result.historyId }),
      },
      completedAt,
    });
    return { outcome: "answered" };
  }
  const diagnostic = result.kind === "answered" ? "Provider answered without a resumable session" : result.diagnostic;
  await endTurn(paths, { turnSequence, outcome: { kind: "failed", diagnostic }, completedAt });
  return { outcome: "failed", diagnostic };
}

type CommittedOutcome = Readonly<{ outcome: "answered" }> | Readonly<{ outcome: "failed"; diagnostic: string }>;

function boundedDiagnostic(error: unknown): string {
  const text = diagnostic(error);
  return text.length <= 500 ? text : `${text.slice(0, 500)}...`;
}

export async function recordPluginDiagnostic(paths: AkumaPaths, occurrence: string, error: unknown): Promise<void> {
  try {
    await appendFile(paths.log, `plugin ${occurrence} failed: ${boundedDiagnostic(error)}\n`);
  } catch {
    /* plugin diagnostic loss never changes Heart truth */
  }
}

/** The plugin host bag for one Body occurrence; diagnostics are appended to its log. */
function pluginHost(launch: BodyLaunch, world: WorldRoot, occurrence: string) {
  return {
    world,
    reportDiagnostic: (message: string): void => {
      void recordPluginDiagnostic(launch.paths, occurrence, message);
    },
  };
}

type BodyExecution = Readonly<{
  launch: BodyLaunch;
  soul: Soul;
  adapter: ProviderAdapter;
  bodySequence: number;
  supervisor: BodySupervisor;
  runtime: BodyRuntime;
  turnStarted: TurnStartedEmitter;
  turnOutcome: TurnOutcomeEmitter;
}>;

async function prepareBodyExecution(
  launch: BodyLaunch,
  leash: HeldAkumaLeash,
  runtime: BodyRuntime,
  adapter: ProviderAdapter | undefined,
): Promise<Readonly<{ soul: Soul; created: boolean; adapter: ProviderAdapter }> | null> {
  runtime.signal?.throwIfAborted();
  const birth = await bornSoul(launch, leash, runtime.now());
  runtime.signal?.throwIfAborted();
  if (birth === null) return null;
  const { soul } = birth;
  if (!(await prepareBodyStart(launch.paths, leash))) return null;
  if (launch.seed === undefined && launch.initialBody === undefined) {
    if ((await readHeart(launch.paths)).pending.length === 0) return null;
  }
  runtime.signal?.throwIfAborted();
  const selected = adapter ?? (await resolveProviderExecution(soul.provider)).adapter;
  runtime.signal?.throwIfAborted();
  return { ...birth, adapter: selected };
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
  const completion = await leash.completeInterruptBarrier(paths);
  if (completion.kind === "unavailable") return false;
  const before = await readHeart(paths);
  if (before.stop === null) return true;
  if (before.latestBody?.sequence === before.stop.bodySequence && before.latestBody.end === "put-down") {
    await leash.settleStop(paths);
  } else {
    await leash.clearStop(paths);
  }
  return true;
}

type TurnStartedEmitter = Readonly<{
  emit(turnSequence: number): Promise<void>;
}>;

type TurnOutcomeEmitter = Readonly<{
  emit(turnSequence: number): Promise<void>;
}>;

async function emitBodyBirth(launch: BodyLaunch, soul: Soul, world: WorldRoot, bodySequence: number): Promise<void> {
  await emitPluginSignal(pluginHost(launch, world, "birth"), {
    kind: "akuma.born",
    akumaId: soul.id,
    bodySequence,
    ...projectAkumaBirth(soul),
    ...(launch.birthInitiator === undefined ? {} : { initiator: launch.birthInitiator }),
    ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
  });
}

function turnStartedEmitter(launch: BodyLaunch, soul: Soul, world: WorldRoot): TurnStartedEmitter {
  return {
    async emit(turnSequence: number): Promise<void> {
      try {
        const turn = await readTurn(launch.paths, turnSequence);
        if (turn === null) throw new Error(`Committed Turn ${turnSequence} is missing from Heart`);
        await emitPluginSignal(pluginHost(launch, world, "turn started"), {
          kind: "akuma.turn-started",
          akumaId: soul.id,
          turnSequence,
          ...(turn.initiator === undefined ? {} : { initiator: turn.initiator }),
        });
      } catch (error) {
        await recordPluginDiagnostic(launch.paths, "turn started", error);
      }
    },
  };
}

function turnOutcomeEmitter(launch: BodyLaunch, soul: Soul, world: WorldRoot): TurnOutcomeEmitter {
  return {
    async emit(turnSequence: number): Promise<void> {
      try {
        const turn = await readTurn(launch.paths, turnSequence);
        if (turn?.end === undefined) throw new Error(`Committed Turn ${turnSequence} outcome is missing from Heart`);
        const outcome = turn.end.outcome;
        const participants = await readTurnParticipants(launch.paths, turnSequence);
        await emitPluginSignal(pluginHost(launch, world, "turn outcome"), {
          kind: "akuma.turn-outcome",
          akumaId: soul.id,
          bodySequence: turn.bodySequence,
          turnSequence,
          at: turn.end.completedAt,
          ...(turn.initiator === undefined ? {} : { initiator: turn.initiator }),
          ...(participants.length === 0 ? {} : { participants }),
          outcome:
            outcome.kind === "answered"
              ? { kind: "answered", text: outcome.answer }
              : outcome.kind === "canceled"
                ? { kind: "canceled" }
                : { kind: "failed", reason: outcome.diagnostic },
          ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
        });
      } catch (error) {
        await recordPluginDiagnostic(launch.paths, "turn outcome", error);
      }
    },
  };
}

function bodyEndEmitter(
  launch: BodyLaunch,
  soul: Soul,
  world: WorldRoot,
): (bodySequence: number, end: BodyEnd | "hung", diagnostic?: string) => Promise<void> {
  return async (bodySequence, end, diagnostic) => {
    try {
      const latestTurn = await readLatestTurnForBody(launch.paths, bodySequence);
      const latestBody = (await readHeart(launch.paths)).latestBody;
      const at = latestBody?.sequence === bodySequence ? (latestBody.hung?.at ?? latestBody.endedAt) : undefined;
      const initiator = latestTurn?.initiator;
      const participants = latestTurn === null ? [] : await readTurnParticipants(launch.paths, latestTurn.sequence);
      await emitPluginSignal(pluginHost(launch, world, "body end"), {
        kind: "akuma.body-ended",
        akumaId: soul.id,
        bodySequence,
        end,
        ...(at === undefined ? {} : { at }),
        ...(initiator === undefined ? {} : { initiator }),
        ...(participants.length === 0 ? {} : { participants }),
        ...(diagnostic === undefined ? {} : { diagnostic }),
        ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
      });
    } catch (error) {
      await recordPluginDiagnostic(launch.paths, "body end", error);
    }
  };
}

async function runBodyTurns(input: BodyExecution): Promise<void> {
  const { launch, soul, adapter, bodySequence, supervisor, runtime, turnStarted, turnOutcome } = input;
  let initial = launch.initialBody;
  for (;;) {
    const control = supervisor.current();
    const launchTells = drainPendingTells(
      control.pending,
      await readOpenBoundTurns(launch.paths, bodySequence),
      control.pause,
      bodySequence,
    );
    if (supervisor.signal.aborted) {
      await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now, turnOutcome);
      return;
    }
    if (initial === undefined && launchTells.length === 0) {
      const finished = await finishBodyIfIdle(launch.paths, { sequence: bodySequence, at: runtime.now() });
      if (finished.kind === "finished") return;
      if (finished.kind === "controlled") {
        supervisor.cancel("control");
        await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now, turnOutcome);
        return;
      }
      await supervisor.refresh();
      continue;
    }
    const schema =
      launchTells.find((tell) => tell.schemaJson !== undefined)?.schemaJson ??
      (initial === undefined ? undefined : launch.initialSchemaJson);
    const result = await driveTurn({
      paths: launch.paths,
      soul,
      adapter,
      bodySequence,
      supervisor,
      body: initial ?? "",
      ...(initial === undefined ? {} : { call: initial }),
      ...(launch.initiator === undefined ? {} : { initiator: launch.initiator }),
      launchTells,
      ...(schema === undefined ? {} : { schemaJson: schema }),
      world: runtime.world,
      ...(runtime.executionAssociation === undefined ? {} : { executionAssociation: runtime.executionAssociation }),
      now: runtime.now,
      turnStarted,
    });
    if (result.kind === "hung") {
      await failOpenBoundTurnsIfPresent(launch.paths, bodySequence, "Body hung with open bound Turns", runtime.now());
      return;
    }
    if (result.kind === "stopped") {
      await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now, turnOutcome);
      return;
    }
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
    await turnOutcome.emit(result.turnSequence);
    if (outcome.outcome === "failed") {
      await failOpenBoundTurnsIfPresent(launch.paths, bodySequence, outcome.diagnostic, runtime.now());
      await breakBody(launch.paths, { sequence: bodySequence, end: "broke-off", at: runtime.now() });
      return;
    }
    await supervisor.refresh();
    initial = undefined;
  }
}

async function finishBody(
  paths: AkumaPaths,
  bodySequence: number | undefined,
  emitBodyEnd: ReturnType<typeof bodyEndEmitter> | undefined,
  now: () => string,
): Promise<Readonly<{ notification?: Promise<void>; hung?: true }> | null> {
  if (bodySequence === undefined || !(await heartExists(paths))) return null;
  const body = (await readHeart(paths)).latestBody;
  if (body?.sequence === bodySequence && (body.hung !== undefined || body.end === "broke-off"))
    await failOpenBoundTurns(paths, {
      bodySequence,
      diagnostic: body.hung?.diagnostic ?? `Body ${body.end ?? "ended"} with open bound Turns`,
      completedAt: now(),
    });
  const finalBody = (await readHeart(paths)).latestBody;
  if (finalBody?.sequence !== bodySequence) return {};
  const hung = finalBody.hung !== undefined;
  const notification =
    emitBodyEnd && (finalBody.end || hung)
      ? emitBodyEnd(bodySequence, hung ? "hung" : finalBody.end!, finalBody.hung?.diagnostic)
      : undefined;
  return { ...(notification === undefined ? {} : { notification }), ...(hung ? { hung: true } : {}) };
}

export async function driveAkumaBody(
  launch: BodyLaunch,
  adapter: ProviderAdapter | undefined,
  runtimeInput: Partial<BodyRuntime> = {},
): Promise<"held" | "hung" | void> {
  runtimeInput.signal?.throwIfAborted();
  const world = runtimeInput.world ?? (await World.at(worldRootForAkumaPaths(launch.paths)));
  const runtime: BodyRuntime = { now: () => new Date().toISOString(), ...runtimeInput, world };
  const acquired = await takeLeash(launch.paths, launch.refuseIfHeld, runtime.signal);
  if (acquired === "held") return "held";
  if (acquired === "absent") return;
  const leash = acquired;
  let bodySequence: number | undefined;
  let emitBodyEnd: ReturnType<typeof bodyEndEmitter> | undefined;
  let emitTurnOutcome: TurnOutcomeEmitter | undefined;
  let supervisor: BodySupervisor | undefined;
  let hung = false;
  try {
    const prepared = await prepareBodyExecution(launch, leash, runtime, adapter);
    if (prepared === null) {
      if ((await readHeart(launch.paths)).pause !== null) return "held";
      return;
    }
    emitBodyEnd = bodyEndEmitter(launch, prepared.soul, world);
    const emitTurnStarted = turnStartedEmitter(launch, prepared.soul, world);
    emitTurnOutcome = turnOutcomeEmitter(launch, prepared.soul, world);
    runtime.signal?.throwIfAborted();
    const body = await leash.recordBody(launch.paths, {
      leashTakenAt: runtime.now(),
    });
    bodySequence = body.sequence;
    supervisor = await BodySupervisor.open(launch.paths, body.sequence, leash, runtime.signal, runtime.forceSignal);
    if (prepared.created) await emitBodyBirth(launch, prepared.soul, world, body.sequence);
    await runBodyTurns({
      launch,
      soul: prepared.soul,
      adapter: prepared.adapter,
      bodySequence: body.sequence,
      supervisor,
      runtime,
      turnStarted: emitTurnStarted,
      turnOutcome: emitTurnOutcome,
    });
  } catch (error) {
    if (error instanceof BodyControlledError) {
      if (bodySequence !== undefined) await putDownBody(launch.paths, bodySequence, runtime.now, emitTurnOutcome);
      return "held";
    }
    await preserveBodyFailure(launch.paths, leash, error, runtime.now());
    throw error;
  } finally {
    let finished: Awaited<ReturnType<typeof finishBody>>;
    try {
      await supervisor?.close();
      finished = await finishBody(launch.paths, bodySequence, emitBodyEnd, runtime.now);
    } finally {
      leash.release();
    }
    if (finished?.notification !== undefined) await finished.notification;
    hung = finished?.hung === true;
  }
  if (hung) return "hung";
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type TellActionEvidence = Awaited<ReturnType<typeof readTellAction>>;

export function evidencedTellWake(observed: TellActionEvidence): TellWake | null {
  switch (observed.kind) {
    case "pending":
      return null;
    case "launch":
    case "live":
      return { kind: observed.kind === "launch" ? "started" : "steering", historyId: `turn/${observed.turnSequence}` };
    case "undelivered":
      return { kind: "failed", reason: "undelivered", diagnostic: "Heart recorded this Tell as undelivered" };
    case "submission-failed":
      return { kind: "failed", diagnostic: observed.diagnostic };
    case "hung":
      return { kind: "confirmation-stopped", reason: "hung", diagnostic: observed.diagnostic };
    case "untidy":
      return { kind: "confirmation-stopped", reason: "untidy", diagnostic: "Interrupt predecessor custody changed" };
  }
}

async function launchForTell(
  paths: AkumaPaths,
  runtime: TellWakeRuntime,
  signal: AbortSignal,
  read: () => Promise<TellActionEvidence>,
  successorAfter: number | undefined,
): Promise<TellWake | null> {
  signal.throwIfAborted();
  const launched = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return runtime.spawn(paths);
  });
  let child: LiveBodyLaunch;
  try {
    child = await abortable(launched, signal);
  } catch (error) {
    // Launch may yield a handle even after our observer is gone. Only release it.
    void launched.then((late) => late.release()).catch(() => undefined);
    signal.throwIfAborted();
    return evidencedTellWake(await read()) ?? { kind: "failed", diagnostic: diagnostic(error) };
  }
  try {
    const result = await observeBodyLaunch(
      child,
      async () => {
        const current = await read();
        if (
          current.kind === "pending" &&
          successorAfter !== undefined &&
          (current.body?.sequence ?? 0) > successorAfter
        )
          return { kind: "pending" } as const;
        return evidencedTellWake(current);
      },
      runtime.schedule ?? abortableDelay,
      signal,
    );
    if (result.kind === "observed") return result.value;
    if (result.end.held) return null;
    const { diagnostic, child: failedChild } = result.end;
    return { kind: "failed", diagnostic, ...(failedChild === undefined ? {} : { logPath: failedChild.log.path }) };
  } finally {
    child.release();
  }
}

function wakeFromFreeSeat(current: TellActionEvidence, followedBody: number | undefined): TellWake | null {
  if (current.kind !== "pending") return evidencedTellWake(current);
  const { body, control } = current;
  if (body !== null && body.end === undefined && (control !== null || body.sequence === followedBody))
    return {
      kind: "confirmation-stopped",
      reason: "untidy",
      diagnostic: "Previous Body released custody without settlement",
    };
  if (control !== "interrupt" && body !== null && body.sequence === followedBody && body.end !== "exited")
    return {
      kind: "confirmation-stopped",
      reason: "stopped",
      diagnostic: "Body stopped before confirming submission; admitted input is retained",
    };
  return null;
}

export async function wakeRecordedTell(
  paths: AkumaPaths,
  tellId: string,
  runtime: TellWakeRuntime,
  signal: AbortSignal,
  submission: boolean,
): Promise<TellWake> {
  const read = () => readTellAction(paths, tellId, signal);
  const delay = runtime.schedule ?? abortableDelay;
  let followedBody: number | undefined;
  for (;;) {
    const before = await read();
    if (before.kind !== "pending") return evidencedTellWake(before)!;
    const leash = await HeldAkumaLeash.try(paths);
    if (leash === null) {
      if (before.body !== null && before.body.end === undefined) followedBody = before.body.sequence;
      if (!submission && (before.control === "interrupt" || followedBody !== undefined)) return { kind: "pending" };
      await delay(LEASH_RETRY_MS, signal);
      continue;
    }
    try {
      const wake = wakeFromFreeSeat(await read(), followedBody);
      if (wake !== null) return wake;
    } finally {
      leash.release();
    }
    const wake = await launchForTell(
      paths,
      runtime,
      signal,
      read,
      submission ? undefined : (before.body?.sequence ?? 0),
    );
    if (wake !== null) return wake;
    await delay(LEASH_RETRY_MS, signal);
  }
}
