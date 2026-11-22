import { projectAkumaBirth } from "./caller.js";
import { recordPluginDiagnostic } from "./plugin-diagnostic.js";
import { abortable, abortableDelay } from "./abort.js";
import { AkumaWorkdirMissingError } from "./akuma-errors.js";
import { BodySupervisor } from "./body-supervisor.js";
import { driveTurn } from "./turn-drive.js";
import {
  HeldAkumaLeash,
  BodyControlledError,
  cancelBodyTurns,
  drainPendingTells,
  failOpenBoundTurns,
  finishBodyIfIdle,
  heartExists,
  isHeartAbsent,
  readHeart,
  readOpenBoundTurns,
  readTellAction,
  readTurn,
  type AbnormalBodyEnd,
  type ObservedTurnEnd,
  type Soul,
} from "./heart/index.js";
import { worldRootForAkumaPaths, type AkumaPaths } from "./identity.js";
import type { TellSettlement, TellWake } from "./call-initial-tell.js";
export type { TellResult, TellWake } from "./call-initial-tell.js";
import { emitPluginSignal } from "../plugin/akuma-signals.js";
import { World, type WorldRoot } from "../world.js";
import type { ProviderAdapter } from "./provider.js";
import type { ExecutionAssociationReader } from "./execution-instructions.js";
import { resolveProviderExecution } from "./providers/index.js";
import {
  observeBodyLaunch,
  type BodyLaunch,
  type BodyLaunchEnd,
  type BodyLauncher,
  type LiveBodyLaunch,
} from "./body-launch.js";

const LEASH_RETRY_MS = 100;
export { CONTROL_RESPONSE_MS } from "./body-supervisor.js";

type WakeEvidence = Pick<TellSettlement, "wake" | "action">;

export type TellWakeRuntime = Readonly<{
  admissionOnly?: boolean;
  witness?(evidence: WakeEvidence): void;
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

async function putDownBody(
  paths: AkumaPaths,
  bodySequence: number,
  now: () => string,
  turnOutcome?: TurnOutcomeEmitter,
): Promise<void> {
  const settled = await cancelBodyTurns(paths, { bodySequence, at: now() });
  for (const terminal of settled) await turnOutcome?.emit(terminal);
}

async function putDownIfControlled(
  paths: AkumaPaths,
  supervisor: BodySupervisor,
  bodySequence: number,
  now: () => string,
  turnOutcome: TurnOutcomeEmitter,
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
  const result = await leash.birth(launch.paths, candidate, launch.birthSession, launch.birthInitiator);
  if (result === "sealed") return null;
  const born = (await readHeart(launch.paths)).soul;
  if (born === null || born.id !== candidate.id) {
    throw new Error("Akuma birth identity does not match its directory");
  }
  return { soul: born, created: result === "born" };
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
  turnStarted: ReturnType<typeof turnStartedEmitter>;
  turnOutcome: TurnOutcomeEmitter;
  failedTurns: ObservedTurnEnd[];
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
  if (launch.seed === undefined) {
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

type TurnOutcomeEmitter = Readonly<{ emit(terminal: ObservedTurnEnd, caller?: AbortSignal): Promise<void> }>;
type BodyEndObservation =
  | AbnormalBodyEnd
  | Readonly<{
      bodySequence: number;
      end: "exited" | "put-down";
      at: string | undefined;
      diagnostic?: never;
      audience?: never;
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

function turnStartedEmitter(launch: BodyLaunch, soul: Soul, world: WorldRoot) {
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
  const host = pluginHost(launch, world, "turn outcome");
  return {
    async emit({ bodySequence, turnSequence, completedAt, audience, outcome }, producerControl): Promise<void> {
      if (audience.kind === "unavailable") host.reportDiagnostic(`audience unavailable: ${audience.diagnostic}`);
      await emitPluginSignal(
        { ...host, producerControl },
        {
          kind: "akuma.turn-outcome",
          akumaId: soul.id,
          bodySequence,
          turnSequence,
          at: completedAt,
          ...(audience.kind === "known" ? { audience: audience.owners } : {}),
          outcome:
            outcome.kind === "answered"
              ? { kind: "answered", text: outcome.answer }
              : outcome.kind === "canceled"
                ? { kind: "canceled" }
                : { kind: "failed", reason: outcome.diagnostic },
          ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
        },
      );
    },
  };
}

function bodyEndEmitter(launch: BodyLaunch, soul: Soul, world: WorldRoot) {
  const host = pluginHost(launch, world, "body end");
  return async ({ bodySequence, end, at, diagnostic, audience }: BodyEndObservation): Promise<void> => {
    if (audience?.kind === "unavailable") host.reportDiagnostic(`audience unavailable: ${audience.diagnostic}`);
    await emitPluginSignal(host, {
      kind: "akuma.body-ended",
      akumaId: soul.id,
      bodySequence,
      end,
      ...(at === undefined ? {} : { at }),
      ...(audience?.kind === "known" ? { audience: audience.owners } : {}),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
    });
  };
}

async function failRemainingTurns(
  paths: AkumaPaths,
  bodySequence: number,
  diagnostic: string,
  now: () => string,
  failedTurns: ObservedTurnEnd[],
): Promise<void> {
  if (!(await heartExists(paths))) return;
  failedTurns.push(...(await failOpenBoundTurns(paths, { bodySequence, diagnostic, completedAt: now() })));
}

async function runBodyTurns(input: BodyExecution): Promise<void> {
  const { launch, soul, adapter, bodySequence, supervisor, runtime, turnStarted, turnOutcome, failedTurns } = input;
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
    if (launchTells.length === 0) {
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
    const result = await driveTurn({
      paths: launch.paths,
      soul,
      adapter,
      bodySequence,
      supervisor,
      launchTells,
      world: runtime.world,
      ...(runtime.executionAssociation === undefined ? {} : { executionAssociation: runtime.executionAssociation }),
      now: runtime.now,
      turnStarted,
      turnOutcome,
    });
    if (result.kind === "continue") {
      await supervisor.refresh();
      continue;
    }
    if (result.kind === "stopped") {
      await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now, turnOutcome);
    } else if (result.kind !== "hung") {
      const diagnostic = result.kind === "failed" ? result.diagnostic : "resume-unsupported with open bound Turns";
      await failRemainingTurns(launch.paths, bodySequence, diagnostic, runtime.now, failedTurns);
      await supervisor.breakOff(runtime.now());
    }
    return;
  }
}

async function finishBody(
  paths: AkumaPaths,
  bodySequence: number | undefined,
  abnormal: Awaited<ReturnType<BodySupervisor["close"]>>,
  failedTurns: ObservedTurnEnd[],
  now: () => string,
): Promise<BodyEndObservation | null> {
  if (abnormal !== undefined) {
    const { end, cleanupDiagnostic } = abnormal;
    if (cleanupDiagnostic !== undefined)
      await failRemainingTurns(paths, end.bodySequence, cleanupDiagnostic, now, failedTurns);
    return end;
  }
  if (bodySequence === undefined || !(await heartExists(paths))) return null;
  const body = (await readHeart(paths)).latestBody;
  if (body?.sequence !== bodySequence || body.hung !== undefined || (body.end !== "exited" && body.end !== "put-down"))
    return null;
  return { bodySequence, end: body.end, at: body.endedAt };
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
  const failedTurns: ObservedTurnEnd[] = [];
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
      failedTurns,
    });
  } catch (error) {
    if (error instanceof BodyControlledError) {
      if (bodySequence !== undefined) await putDownBody(launch.paths, bodySequence, runtime.now, emitTurnOutcome);
      return "held";
    }
    await preserveBodyFailure(launch.paths, leash, error, runtime.now());
    throw error;
  } finally {
    let finished: BodyEndObservation | null;
    try {
      const abnormal = await supervisor?.close();
      finished = await finishBody(launch.paths, bodySequence, abnormal, failedTurns, runtime.now);
    } finally {
      leash.release();
      for (const terminal of failedTurns) await emitTurnOutcome?.emit(terminal);
    }
    if (finished !== null) await emitBodyEnd?.(finished);
    hung = finished?.end === "hung";
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

function failedLaunch({ diagnostic, child }: BodyLaunchEnd, action?: TellWake | null): WakeEvidence {
  return {
    wake: { kind: "failed", diagnostic, ...(child === undefined ? {} : { logPath: child.log.path }) },
    ...(action?.kind === "started" || action?.kind === "steering" ? { action } : {}),
  };
}

async function settleMissingWorkdir(
  paths: AkumaPaths,
  tellId: string,
  signal: AbortSignal,
  launchFailure: AkumaWorkdirMissingError,
): Promise<WakeEvidence> {
  const details = [launchFailure.message];
  let leash: HeldAkumaLeash | null = null;
  let undelivered = false;
  try {
    leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) undelivered = await leash.settleUndeliveredTell(paths, tellId, signal);
  } catch (error) {
    if (!signal.aborted || error !== signal.reason)
      details.push(`Could not settle the exact Tell: ${diagnostic(error)}`);
  } finally {
    try {
      leash?.release();
    } catch (error) {
      details.push(`Could not release settlement custody: ${diagnostic(error)}`);
    }
  }
  let action: TellWake | null = null;
  if (!undelivered && !signal.aborted) {
    try {
      const observed = await readTellAction(paths, tellId, signal);
      action = evidencedTellWake(observed);
      undelivered = observed.kind === "undelivered";
    } catch (error) {
      if (!signal.aborted || error !== signal.reason)
        details.push(`Could not observe the exact Tell: ${diagnostic(error)}`);
    }
  }
  const wake = {
    kind: "failed" as const,
    ...(undelivered ? { reason: "undelivered" as const } : {}),
    diagnostic: details.join("\n"),
  };
  return { wake, ...(action?.kind === "started" || action?.kind === "steering" ? { action } : {}) };
}

async function launchForTell(
  paths: AkumaPaths,
  tellId: string,
  runtime: TellWakeRuntime,
  signal: AbortSignal,
  successorAfter: number | undefined,
): Promise<WakeEvidence | null> {
  signal.throwIfAborted();
  const read = () => readTellAction(paths, tellId, signal);
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
    if (signal.aborted && error === signal.reason) throw error;
    const end = { diagnostic: diagnostic(error) };
    runtime.witness?.(failedLaunch(end));
    const evidence =
      error instanceof AkumaWorkdirMissingError
        ? await settleMissingWorkdir(paths, tellId, signal, error)
        : failedLaunch(end, evidencedTellWake(await read()));
    runtime.witness?.(evidence);
    return evidence;
  }
  try {
    const result = await observeBodyLaunch(
      child,
      async () => {
        const current = await read();
        if (
          current.kind === "pending" &&
          successorAfter !== undefined &&
          current.body !== null &&
          current.body.sequence > successorAfter &&
          current.body.end === undefined
        )
          return { kind: "pending" } as const;
        return evidencedTellWake(current);
      },
      runtime.schedule ?? abortableDelay,
      signal,
      (end) => runtime.witness?.(failedLaunch(end)),
    );
    const { end, value } = result;
    let evidence: WakeEvidence;
    if (end?.failed) evidence = failedLaunch(end, value);
    else if (value !== null) evidence = { wake: value };
    else if (end.held) return null;
    else
      evidence =
        end.failed === false && runtime.admissionOnly === true ? { wake: { kind: "pending" } } : failedLaunch(end);
    runtime.witness?.(evidence);
    return evidence;
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
): Promise<WakeEvidence> {
  const read = () => readTellAction(paths, tellId, signal);
  const delay = runtime.schedule ?? abortableDelay;
  let followedBody: number | undefined;
  for (;;) {
    const before = await read();
    if (before.kind !== "pending") return { wake: evidencedTellWake(before)! };
    const leash = await HeldAkumaLeash.try(paths);
    if (leash === null) {
      if (before.body !== null && before.body.end === undefined) followedBody = before.body.sequence;
      if (!submission && (before.control === "interrupt" || followedBody !== undefined))
        return { wake: { kind: "pending" } };
      await delay(LEASH_RETRY_MS, signal);
      continue;
    }
    try {
      const wake = wakeFromFreeSeat(await read(), followedBody);
      if (wake !== null) return { wake };
    } finally {
      leash.release();
    }
    const wake = await launchForTell(
      paths,
      tellId,
      runtime,
      signal,
      submission ? undefined : (before.body?.sequence ?? 0),
    );
    if (wake !== null) return wake;
    await delay(LEASH_RETRY_MS, signal);
  }
}
