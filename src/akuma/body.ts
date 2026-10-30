import { projectAkumaBirth } from "./caller.js";
import { appendFile } from "node:fs/promises";
import { abortableDelay } from "./abort.js";
import { BodySupervisor } from "./body-supervisor.js";
import type { InitialTellAdmissionRequest } from "./call-request.js";
import { driveTurn, type DrivenTurn } from "./turn-drive.js";
import {
  HeldAkumaLeash,
  BodyControlledError,
  breakBody,
  cancelBodyTurns,
  decidePendingTellDisposition,
  drainPendingTells,
  endTurn,
  failOpenBoundTurns,
  finishBodyIfIdle,
  heartExists,
  isHeartAbsent,
  probeLeash,
  projectTell,
  readHeart,
  readLatestTurnForBody,
  readOpenBoundTurns,
  readOpenPendingTellDisposition,
  readTell,
  readTurn,
  readTurnParticipants,
  readNonterminalRequests,
  resolvePendingTellDisposition,
  type PendingTellDisposition,
  type BodyEnd,
  type Soul,
  type TurnOutcome,
} from "./heart/index.js";
import { pathsForAkuId, worldRootForAkumaPaths, type AkumaPaths } from "./identity.js";
import { recordAkumaLineage } from "./lineage-cache.js";
import {
  admitCallInitialTell,
  type CallInitialTellAdmission,
  type TellResult,
  type TellWake,
} from "./call-initial-tell.js";
export type { TellResult, TellWake } from "./call-initial-tell.js";
import { emitPluginSignal } from "../plugin/akuma-signals.js";
import { World, type WorldRoot } from "../world.js";
import type { ProviderAdapter } from "./provider.js";
import type { ExecutionAssociationReader } from "./execution-instructions.js";
import { resolveProviderExecution } from "./providers/index.js";
import { clearBodyRequestTransport, settleBodyRequests } from "./request-serve.js";
import type { ErasedRequestCommand } from "./request-wire.js";
import {
  observeBodyLaunch,
  launchEndWake,
  type BodyLaunch,
  type BodyLauncher,
  type LiveBodyLaunch,
} from "./body-launch.js";

const LEASH_RETRY_MS = 100;
export { CONTROL_RESPONSE_MS } from "./body-supervisor.js";

export type TellWakeRuntime = Readonly<{
  spawn(paths: AkumaPaths): Promise<LiveBodyLaunch>;
  schedule?(milliseconds: number, signal: AbortSignal): Promise<void>;
}>;

export type BodyRuntime = Readonly<{
  now(): string;
  spawn: BodyLauncher;
  requestSpawn: BodyLauncher;
  signal?: AbortSignal;
  forceSignal?: AbortSignal;
  world: WorldRoot;
  externalCommands: Readonly<Record<string, ErasedRequestCommand>>;
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
  handoff = false,
): Promise<BodyTurnEnd> {
  const settled = await cancelBodyTurns(paths, { bodySequence, at: now(), handoff });
  for (const sequence of settled.canceled) await turnOutcome?.emit(sequence);
  return settled.disposition ?? undefined;
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
  // The immutable caller edge refreshes after Soul durability, best-effort.
  if (birth.created) void recordAkumaLineage(runtime.world, birth.soul);
  const { soul } = birth;
  if (launch.handoffFromBodySequence === undefined && !(await prepareBodyStart(launch.paths, leash))) return null;
  if (launch.seed === undefined && launch.initialBody === undefined) {
    const [heart, requests] = await Promise.all([readHeart(launch.paths), readNonterminalRequests(launch.paths)]);
    if (heart.pending.length === 0 && requests.length === 0) return null;
  }
  runtime.signal?.throwIfAborted();
  const selected = adapter ?? (await resolveProviderExecution(soul.provider)).adapter;
  runtime.signal?.throwIfAborted();
  return { ...birth, adapter: selected };
}

async function runPreparedBody(input: BodyExecution): Promise<BodyTurnEnd> {
  return (await recoverBodyRequests(input)) ? await runBodyTurns(input) : undefined;
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
    await putDownIfControlled(launch.paths, supervisor, bodySequence, runtime.now, input.turnOutcome);
  }
  return false;
}

type TurnStartedEmitter = Readonly<{
  emit(turnSequence: number): Promise<void>;
}>;

type TurnOutcomeEmitter = Readonly<{
  emit(turnSequence: number): Promise<void>;
}>;

async function emitBodyBirth(launch: BodyLaunch, soul: Soul, world: WorldRoot, bodySequence: number): Promise<void> {
  await emitPluginSignal(
    {
      world,
      reportDiagnostic: (message) => {
        void recordPluginDiagnostic(launch.paths, "birth", message);
      },
    },
    {
      kind: "akuma.born",
      akumaId: soul.id,
      bodySequence,
      ...projectAkumaBirth(soul),
      ...(launch.birthInitiator === undefined ? {} : { initiator: launch.birthInitiator }),
      ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
    },
  );
}

function turnStartedEmitter(launch: BodyLaunch, soul: Soul, world: WorldRoot): TurnStartedEmitter {
  const reportDiagnostic = (message: string): void => {
    void recordPluginDiagnostic(launch.paths, "turn started", message);
  };
  return {
    async emit(turnSequence: number): Promise<void> {
      try {
        const turn = await readTurn(launch.paths, turnSequence);
        if (turn === null) throw new Error(`Committed Turn ${turnSequence} is missing from Heart`);
        await emitPluginSignal(
          { world, reportDiagnostic },
          {
            kind: "akuma.turn-started",
            akumaId: soul.id,
            turnSequence,
            ...(turn.initiator === undefined ? {} : { initiator: turn.initiator }),
          },
        );
      } catch (error) {
        await recordPluginDiagnostic(launch.paths, "turn started", error);
      }
    },
  };
}

function turnOutcomeEmitter(launch: BodyLaunch, soul: Soul, world: WorldRoot): TurnOutcomeEmitter {
  const reportDiagnostic = (message: string): void => {
    void recordPluginDiagnostic(launch.paths, "turn outcome", message);
  };
  return {
    async emit(turnSequence: number): Promise<void> {
      try {
        const turn = await readTurn(launch.paths, turnSequence);
        if (turn?.end === undefined) throw new Error(`Committed Turn ${turnSequence} outcome is missing from Heart`);
        const outcome = turn.end.outcome;
        const participants = await readTurnParticipants(launch.paths, turnSequence);
        await emitPluginSignal(
          { world, reportDiagnostic },
          {
            kind: "akuma.turn-outcome",
            akumaId: soul.id,
            bodySequence: turn.bodySequence,
            turnSequence,
            ...(turn.initiator === undefined ? {} : { initiator: turn.initiator }),
            ...(participants.length === 0 ? {} : { participants }),
            outcome:
              outcome.kind === "answered"
                ? { kind: "answered", text: outcome.answer }
                : outcome.kind === "canceled"
                  ? { kind: "canceled" }
                  : { kind: "failed", reason: outcome.diagnostic },
            ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
          },
        );
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
  const reportDiagnostic = (message: string): void => {
    void recordPluginDiagnostic(launch.paths, "body end", message);
  };
  return async (bodySequence, end, diagnostic) => {
    try {
      const latestTurn = await readLatestTurnForBody(launch.paths, bodySequence);
      const initiator = latestTurn?.initiator;
      const participants = latestTurn === null ? [] : await readTurnParticipants(launch.paths, latestTurn.sequence);
      await emitPluginSignal(
        { world, reportDiagnostic },
        {
          kind: "akuma.body-ended",
          akumaId: soul.id,
          bodySequence,
          end,
          ...(initiator === undefined ? {} : { initiator }),
          ...(participants.length === 0 ? {} : { participants }),
          ...(diagnostic === undefined ? {} : { diagnostic }),
          ...(launch.completion?.contractId === undefined ? {} : { contractId: launch.completion.contractId }),
        },
      );
    } catch (error) {
      await recordPluginDiagnostic(launch.paths, "body end", error);
    }
  };
}

type BodyTurnEnd = PendingTellDisposition | undefined;

async function admitInitialCallTell(
  runtime: BodyRuntime,
  input: InitialTellAdmissionRequest,
): Promise<CallInitialTellAdmission> {
  const paths = pathsForAkuId(runtime.world, input.id);
  return await admitCallInitialTell({
    world: runtime.world,
    id: input.id,
    initialTell: input.initialTell,
    signal: input.signal,
    now: runtime.now,
    wake: async (tell) =>
      await wakeRecordedTell(
        paths,
        tell.id,
        {
          spawn: async (tellPaths) =>
            await runtime.requestSpawn({
              paths: tellPaths,
              refuseIfHeld: true,
              ...(input.contractId === undefined ? {} : { completion: { contractId: input.contractId } }),
            }),
          schedule: abortableDelay,
        },
        input.signal,
      ),
  });
}

async function runBodyTurns(input: BodyExecution): Promise<BodyTurnEnd> {
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
      continue;
    }
    const schema = launchTells.find((tell) => tell.schemaJson !== undefined)?.schemaJson ?? launch.initialSchemaJson;
    const result = await driveTurn({
      paths: launch.paths,
      soul,
      adapter,
      bodySequence,
      supervisor,
      runtimeSpawn: runtime.requestSpawn,
      admitInitialTell: async (admission) => await admitInitialCallTell(runtime, admission),
      body: initial ?? "",
      ...(initial === undefined ? {} : { call: initial }),
      ...(launch.initiator === undefined ? {} : { initiator: launch.initiator }),
      launchTells,
      ...(schema === undefined ? {} : { schemaJson: schema }),
      world: runtime.world,
      externalCommands: runtime.externalCommands,
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
    if (result.kind === "handoff") return await putDownBody(launch.paths, bodySequence, runtime.now, turnOutcome, true);
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
  await resolvePendingTellDisposition(paths, disposition.bodySequence, at, "undelivered");
}

async function consumeProvenDisposition(paths: AkumaPaths, disposition: PendingTellDisposition): Promise<boolean> {
  return await resolvePendingTellDisposition(paths, disposition.bodySequence, new Date().toISOString());
}

async function resolveDecidedPendingTellDisposition(
  paths: AkumaPaths,
  disposition: PendingTellDisposition,
  spawn: BodyLauncher,
): Promise<void> {
  try {
    if (await consumeProvenDisposition(paths, disposition)) return;
    const child = await spawn({ paths, refuseIfHeld: true, handoffFromBodySequence: disposition.bodySequence });
    const result = await observeBodyLaunch(child, async () =>
      (await consumeProvenDisposition(paths, disposition)) ? true : null,
    );
    if (result.kind === "observed") {
      child.release();
      return;
    }
    const wake = launchEndWake(result.end);
    // Predecessor still holds the leash: leave the Heart disposition open.
    if (wake.kind === "held") return;
    await settleUndeliveredDisposition(paths, disposition, wake.diagnostic);
  } catch (error) {
    await settleUndeliveredDisposition(paths, disposition, error);
  }
}

export async function handoffPendingTells(paths: AkumaPaths, spawn: BodyLauncher): Promise<void> {
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
  runtimeInput: Pick<BodyRuntime, "spawn" | "requestSpawn"> & Partial<Omit<BodyRuntime, "spawn" | "requestSpawn">>,
): Promise<"held" | "hung" | void> {
  runtimeInput.signal?.throwIfAborted();
  const world = runtimeInput.world ?? (await World.at(worldRootForAkumaPaths(launch.paths)));
  const runtime: BodyRuntime = { now: () => new Date().toISOString(), externalCommands: {}, ...runtimeInput, world };
  const acquired = await takeLeash(launch.paths, launch.refuseIfHeld, runtime.signal);
  if (acquired === "held") return "held";
  if (acquired === "absent") return;
  const leash = acquired;
  let pendingTellDisposition: BodyTurnEnd = undefined;
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
      ...(launch.handoffFromBodySequence === undefined
        ? {}
        : { handoffFromBodySequence: launch.handoffFromBodySequence }),
    });
    bodySequence = body.sequence;
    supervisor = await BodySupervisor.open(launch.paths, body.sequence, leash, runtime.signal, runtime.forceSignal);
    if (prepared.created) await emitBodyBirth(launch, prepared.soul, world, body.sequence);
    pendingTellDisposition = await runPreparedBody({
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
    if (finished !== null && pendingTellDisposition !== undefined)
      await resolveDecidedPendingTellDisposition(launch.paths, pendingTellDisposition, runtime.spawn);
    if (finished?.notification !== undefined) await finished.notification;
    hung = finished?.hung === true;
  }
  if (hung) return "hung";
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

async function awaitWake(
  paths: AkumaPaths,
  input: Readonly<{
    tellId?: string;
    after: number;
    child: LiveBodyLaunch;
    schedule: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
  }>,
): Promise<TellWake> {
  const { tellId, after, child, schedule, signal } = input;
  try {
    const result = await observeBodyLaunch(
      child,
      async () => await settledWake(paths, tellId, after),
      schedule,
      signal,
    );
    if (result.kind === "completed") return launchEndWake(result.end);
    child.release();
    return result.value;
  } catch (error) {
    child.release();
    throw error;
  }
}

async function wakePendingTells(
  paths: AkumaPaths,
  tellId: string | undefined,
  runtime: TellWakeRuntime,
  signal?: AbortSignal,
): Promise<TellWake | null> {
  try {
    signal?.throwIfAborted();
    const beforeHeart = await readHeart(paths);
    if (tellId === undefined && beforeHeart.pending.length === 0) return null;
    const before = beforeHeart.latestBody?.sequence ?? 0;
    return await awaitWake(paths, {
      ...(tellId === undefined ? {} : { tellId }),
      after: before,
      child: await runtime.spawn(paths),
      schedule: runtime.schedule ?? abortableDelay,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "failed", diagnostic: diagnostic(error) };
  }
}

export async function wakeRecordedTell(
  paths: AkumaPaths,
  tellId: string,
  runtime: TellWakeRuntime,
  signal?: AbortSignal,
): Promise<TellResult> {
  const wake = (await wakePendingTells(paths, tellId, runtime, signal))!;
  const tell = await readTell(paths, tellId);
  if (tell === null) throw new Error(`recorded Tell ${tellId} is missing from Heart`);
  return {
    admission: { tellId, fact: "recorded" },
    row: projectTell(tell),
    wake,
  };
}
