import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { akumaIdFromDirectoryName, parsePublicHistoryId, type AkumaPaths } from "../identity.js";
import { decodeRuntimeModel, withoutModel } from "../provider-recipe.js";
import type {
  BodyEnd,
  BodyFact,
  ForkPoint,
  HeartSnapshot,
  InterruptCompletion,
  PauseFact,
  SealFact,
  SessionFact,
  Soul,
  TellDeliveryInput,
  TellFact,
  TellReceiptInput,
  TurnEndFact,
  TurnFact,
  TurnOutcome,
  TurnStartFact,
  ReportAdmission,
} from "./facts.js";
import { BodyControlledError, HeartAuthorityCorruptionError, HeartUnbornError } from "./facts.js";
import {
  answeredTurnFact,
  bodyFact,
  completeInterruptBarrier as judgeInterruptBarrier,
  endBodyFact,
  finishBodyFact,
  deleteStopControl,
  insertReportFact,
  insertActivityFact,
  insertTurnEndFact,
  insertTurnStartFact,
  insertKillFact,
  insertSessionFact,
  insertStopControl,
  killFactForBody,
  latestBodyFact,
  insertInterruptBarrier,
  isTellProtectedByPause,
  latestKillFact,
  latestSessionFact,
  latestTurnFactForBody,
  latestTurnEndFact,
  lastAnsweredTurnFact,
  pauseFact,
  sessionFactForCoordinate,
  stopFact,
  turnFact,
  openTurnsForBody,
  terminalTurnForTell,
} from "./rows.js";
import type { AgentEvent } from "./activity-schema.js";
import {
  insertTellDeliveryFact,
  insertTellBindingFact,
  openBoundTurns,
  pendingTellFacts,
  hasPendingTell,
  requireTell,
  tellFact,
  tellIdsForFence,
  tellTerminalWriter,
  tellWasUndelivered,
  turnParticipants,
} from "./tells.js";
import {
  activityFactSlice,
  statusFacts,
  timelineDataVersion,
  lastActivityAt as readLastActivityAt,
  pruneActivityFacts,
  waitReportFrontier,
  type ActivityFactSlice,
} from "./timeline.js";
import {
  createHeartReader,
  isHeartAbsent,
  type HeartRead,
  readSealFromLeash,
  recordPendingTell,
  withHeartTransaction,
  withReadOnlyHeart,
} from "./storage.js";
import { setSoulModel, soulFact } from "./soul.js";
import { AkumaBusyError } from "./facts.js";
export {
  HeartAbsentError,
  HeldAkumaLeash,
  classifyHeartSchema,
  initializeHeart,
  isHeartAbsent,
  probeLeash,
} from "./storage.js";

export { AkumaBusyError, BodyControlledError, life, lifeAt, projectTell } from "./facts.js";
export { drainPendingTells } from "./tells.js";
export type {
  AkumaLife,
  AkumaOrigin,
  BodyEnd,
  BodyFact,
  InterruptCompletion,
  PauseFact,
  HeartSnapshot,
  KillEvidence,
  SessionFact,
  Soul,
  TellFact,
  TurnEndFact,
  TurnOutcome,
} from "./facts.js";
export type { ResumeCoordinate } from "../coordinate.js";

const ACTIVITY_LIMIT = 5_000;

export async function readInterruptCompletion(
  paths: AkumaPaths,
  expected: PauseFact,
  signal?: AbortSignal,
): Promise<Extract<InterruptCompletion, { kind: "completed" | "unavailable" }>> {
  const result = await withReadOnlyHeart(paths, (heart) => judgeInterruptBarrier(heart, expected, false), signal);
  return result.kind === "clear" ? { kind: "unavailable", evidence: "untidy" } : result;
}

export async function readSoul(paths: AkumaPaths): Promise<Soul | null> {
  try {
    return await withReadOnlyHeart(paths, soulFact);
  } catch (error) {
    if (isHeartAbsent(error)) return null;
    throw error;
  }
}

export async function heartExists(paths: AkumaPaths): Promise<boolean> {
  try {
    return await withReadOnlyHeart(paths, () => true);
  } catch (error) {
    if (isHeartAbsent(error)) return false;
    throw error;
  }
}

export async function readSeal(paths: AkumaPaths): Promise<SealFact | null> {
  try {
    return await readSealFromLeash(paths);
  } catch (error) {
    if (isHeartAbsent(error)) return null;
    throw error;
  }
}

export async function recordSession(paths: AkumaPaths, input: Omit<SessionFact, "sequence">): Promise<SessionFact> {
  return await withHeartTransaction(paths, (heart) => ({ sequence: insertSessionFact(heart, input), ...input }));
}

export async function appendActivity(
  paths: AkumaPaths,
  input: Readonly<{ turnSequence: number; event: AgentEvent; at: string }>,
): Promise<number> {
  return await withHeartTransaction(paths, (heart) => {
    const sequence = insertActivityFact(heart, input);
    pruneActivityFacts(heart, ACTIVITY_LIMIT);
    return sequence;
  });
}

type ActivitySlice = ActivityFactSlice;
export type { TimelineFact } from "./timeline.js";
import type { TimelineFact } from "./timeline.js";

export type CurrentModelUpdate = "recorded" | "unchanged" | "not-current-body";

/**
 * Admit one runtime-model observation from the Body that is actually running.
 * The model is the one mutable member of an otherwise frozen recipe, so only
 * the exact latest Running Body may move it: evidence that arrives after that
 * Body settled, or from a superseded Body, is refused rather than applied.
 */
export async function recordCurrentModel(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; model: string | undefined }>,
): Promise<CurrentModelUpdate> {
  const model = decodeRuntimeModel(input.model);
  return await withHeartTransaction(paths, (heart) => {
    const body = latestBodyFact(heart);
    if (body === null || body.sequence !== input.bodySequence || body.end !== undefined || body.hung !== undefined) {
      return "not-current-body";
    }
    return setSoulModel(heart, model) ? "recorded" : "unchanged";
  });
}

export async function activitySlice(paths: AkumaPaths): Promise<ActivitySlice> {
  return await withReadOnlyHeart(paths, (heart) => activityFactSlice(heart));
}

export async function readStatusFacts(paths: AkumaPaths, signal?: AbortSignal): Promise<ActivitySlice["rows"]> {
  return await withReadOnlyHeart(paths, statusFacts, signal);
}

/** One live observation's current retained timeline, or a no-change witness. */
export type TimelineRead =
  | Readonly<{ changed: false }>
  | Readonly<{ changed: true; born: boolean; slice: ActivityFactSlice }>;

/**
 * One operation-owned reader of the retained timeline. It keeps its read
 * custody between observations, skips decoding when the same connection's
 * change counter still names the observed snapshot, and renews that gate
 * whenever a replaced Heart gives it a new connection.
 */
export function createTimelineReader(paths: AkumaPaths): Readonly<{
  read(signal?: AbortSignal): Promise<TimelineRead>;
  clear(): void;
}> {
  const reader = createHeartReader(paths);
  let generation = -1;
  let version: number | undefined;
  return {
    clear: reader.clear,
    async read(signal?: AbortSignal): Promise<TimelineRead> {
      // Publication follows COMMIT, so a failed read never leaves a memo behind.
      return await reader.read((heart) => {
        const current = reader.generation();
        if (current !== generation) {
          generation = current;
          version = undefined;
        }
        const observed = timelineDataVersion(heart);
        if (version !== undefined && observed === version) return { changed: false } as const;
        version = observed;
        return { changed: true as const, born: soulFact(heart) !== null, slice: activityFactSlice(heart) };
      }, signal);
    },
  };
}

/** One observation owns read custody; every read decodes its current transaction. */
export function createStatusFactReader(paths: AkumaPaths) {
  const reader = createHeartReader(paths);
  return {
    life: (signal?: AbortSignal) => readLifeSnapshot(paths, signal, reader.read),
    wait: (
      recent: boolean,
      reportAfter: number | null | undefined,
      needsOutcome: (snapshot: LifeSnapshot) => boolean,
      signal?: AbortSignal,
    ): Promise<WaitFacts> =>
      reader.read((heart) => {
        const snapshot = lifeSnapshot(heart);
        const reportFrontier = reportAfter === undefined ? undefined : waitReportFrontier(heart, reportAfter);
        const outcomeRead = reportFrontier?.report !== undefined || needsOutcome(snapshot);
        const outcome = outcomeRead ? latestTurnEndFact(heart) : undefined;
        let activity: readonly TimelineFact[] | undefined;
        let activityDiagnostic: string | undefined;
        if (recent) {
          try {
            activity = statusFacts(heart);
          } catch (error) {
            activityDiagnostic = error instanceof Error ? error.message : String(error);
          }
        }
        return { ...snapshot, reportFrontier, outcomeRead, outcome, activity, activityDiagnostic };
      }, signal),
    tellOutcome: (id: string, signal?: AbortSignal) =>
      reader.read((heart) => {
        const tell = tellFact(heart, id);
        // A retry cannot replace this exact admission's first retained terminal.
        const end = terminalTurnForTell(heart, id)?.end;
        return { ...lifeSnapshot(heart), tell, end };
      }, signal),
    clear: reader.clear,
    read: (signal?: AbortSignal) =>
      reader.read((heart) => ({ ...lifeSnapshot(heart), timeline: statusFacts(heart) }), signal),
  };
}

type LifeSnapshot = Pick<HeartSnapshot, "soul" | "latestBody" | "latestSession" | "latestKill" | "lastActivityAt"> &
  Readonly<{ hasPendingTell: boolean }>;

export type WaitReportFrontier = ReturnType<typeof waitReportFrontier>;

export type WaitFacts = LifeSnapshot &
  Readonly<{
    reportFrontier: WaitReportFrontier;
    outcomeRead: boolean;
    outcome: TurnEndFact | undefined;
    activity: readonly TimelineFact[] | undefined;
    activityDiagnostic: string | undefined;
  }>;

function lifeSnapshot(heart: DatabaseSync): LifeSnapshot {
  return {
    soul: soulFact(heart),
    latestBody: latestBodyFact(heart),
    latestSession: latestSessionFact(heart),
    latestKill: latestKillFact(heart),
    hasPendingTell: hasPendingTell(heart),
    lastActivityAt: readLastActivityAt(heart),
  };
}

/** Lifecycle probes do not load narration, Tell bodies, or delivery histories. */
export async function readLifeSnapshot(
  paths: AkumaPaths,
  signal?: AbortSignal,
  read: HeartRead = (body, signal) => withReadOnlyHeart(paths, body, signal),
): Promise<LifeSnapshot> {
  try {
    return await read(lifeSnapshot, signal);
  } catch (error) {
    if (isHeartAbsent(error))
      return {
        soul: null,
        latestBody: null,
        latestSession: null,
        latestKill: null,
        hasPendingTell: false,
        lastActivityAt: null,
      };
    throw error;
  }
}

export type InterruptTellAdmission =
  | Readonly<{
      kind: "not-born";
    }>
  | Readonly<{ kind: "unavailable"; evidence: "hung" | "untidy" }>
  | Readonly<{
      kind: "recorded";
      tell: TellFact;
      barrier?: PauseFact;
    }>;

type TellAdmission = Readonly<{ kind: "not-born" }> | Readonly<{ kind: "recorded"; tell: TellFact }>;

type TellInput = Omit<TellFact, "sequence" | "state" | "deliveries" | "binding">;

type TellAdmissionInputs = Readonly<{
  heart: DatabaseSync;
  tell: TellInput;
  body: BodyFact | null;
  pause: PauseFact | null;
  interrupt: boolean;
}>;

function judgeExistingTell(inputs: TellAdmissionInputs, existing: TellFact): TellAdmission | InterruptTellAdmission {
  const { heart, tell, body, pause, interrupt } = inputs;
  if (
    existing.body !== tell.body ||
    existing.schemaJson !== tell.schemaJson ||
    existing.initiator !== tell.initiator ||
    (!interrupt && existing.recordedAt !== tell.recordedAt)
  )
    throw new Error(`tell ${tell.id} reused different input`);
  if (!interrupt) return { kind: "recorded", tell: existing };
  const barrier =
    body !== null && pause !== null && isTellProtectedByPause(heart, tell.id, body.sequence) ? pause : undefined;
  return {
    kind: "recorded",
    tell: existing,
    ...(barrier === undefined ? {} : { barrier }),
  };
}

function judgeNewTell(inputs: TellAdmissionInputs): TellAdmission | InterruptTellAdmission {
  const { heart, tell, body, pause, interrupt } = inputs;
  if (interrupt) {
    if (body?.hung !== undefined) return { kind: "unavailable", evidence: "hung" };
    if (body === null) return { kind: "unavailable", evidence: "untidy" };
    if (pause !== null && pause.bodySequence !== body.sequence) return { kind: "unavailable", evidence: "untidy" };
    const admitted = recordPendingTell(heart, tell);
    const barrier =
      pause ??
      insertInterruptBarrier(heart, {
        bodySequence: body.sequence,
        tellId: tell.id,
        at: tell.recordedAt,
      });
    return { ...admitted, barrier };
  }
  const running = body !== null && body.end === undefined && body.hung === undefined;
  if (tell.schemaJson !== undefined && running) throw new AkumaBusyError();
  return recordPendingTell(heart, tell);
}

function birthMatches(heart: DatabaseSync, id: Soul["id"]): boolean {
  const soul = soulFact(heart);
  if (soul !== null && soul.id !== id)
    throw new HeartAuthorityCorruptionError("Akuma soul does not match its coordinate");
  return soul !== null;
}

export function recordTell(
  paths: AkumaPaths,
  tell: TellInput,
  options: Readonly<{ interrupt: true; signal?: AbortSignal }>,
): Promise<InterruptTellAdmission>;
export function recordTell(
  paths: AkumaPaths,
  tell: TellInput,
  options?: Readonly<{ interrupt?: false; signal?: AbortSignal }>,
): Promise<TellAdmission>;
export async function recordTell(
  paths: AkumaPaths,
  tell: TellInput,
  options: Readonly<{ interrupt?: boolean; signal?: AbortSignal }> = {},
): Promise<TellAdmission | InterruptTellAdmission> {
  const interrupt = options.interrupt === true;
  return await withHeartTransaction(
    paths,
    (heart) => {
      if (!birthMatches(heart, akumaIdFromDirectoryName(basename(paths.directory)).id)) return { kind: "not-born" };
      const existing = tellFact(heart, tell.id);
      const body = latestBodyFact(heart);
      const pause = interrupt ? pauseFact(heart) : null;
      const inputs: TellAdmissionInputs = { heart, tell, body, pause, interrupt };
      return existing === null ? judgeNewTell(inputs) : judgeExistingTell(inputs, existing);
    },
    options.signal,
  );
}

export async function recordReport(
  paths: AkumaPaths,
  input: Readonly<{ text: string; at: string }>,
  signal?: AbortSignal,
): Promise<ReportAdmission> {
  try {
    return await withHeartTransaction(
      paths,
      (heart): ReportAdmission => {
        if (soulFact(heart) === null) return { kind: "refused", reason: "not-born" };
        const body = latestBodyFact(heart);
        const turn = body === null ? null : latestTurnFactForBody(heart, body.sequence);
        if (
          body === null ||
          body.end !== undefined ||
          body.hung !== undefined ||
          turn === null ||
          turn.end !== undefined
        )
          return { kind: "refused", reason: "not-executing" };
        const report = insertReportFact(heart, { ...input, bodySequence: body.sequence, turnSequence: turn.sequence });
        pruneActivityFacts(heart, ACTIVITY_LIMIT);
        return {
          kind: "recorded",
          report,
          ...(turn.initiator === undefined ? {} : { initiator: turn.initiator }),
        };
      },
      signal,
    );
  } catch (error) {
    if (isHeartAbsent(error)) return { kind: "refused", reason: "not-born" };
    throw error;
  }
}

export async function readTell(paths: AkumaPaths, id: string): Promise<TellFact | null> {
  return await withReadOnlyHeart(paths, (heart) => tellFact(heart, id));
}

/** The receipt judge observes only retained witnesses of this exact admitted input. */
export async function readTellAction(paths: AkumaPaths, id: string, signal?: AbortSignal) {
  return await withReadOnlyHeart(
    paths,
    (heart) => {
      const tell = tellFact(heart, id);
      if (tell === null) throw new Error(`Recorded Tell ${id} is missing from Heart`);
      if (tellWasUndelivered(heart, id)) return { kind: "undelivered" } as const;
      const delivery = tell.deliveries[0];
      if (delivery !== undefined) {
        const turn = turnFact(heart, delivery.turnSequence);
        if (turn === null || bodyFact(heart, turn.bodySequence) === null)
          throw new HeartAuthorityCorruptionError(`Akuma Tell ${id} delivery has no owning Turn and Body`);
        return { kind: delivery.route, turnSequence: turn.sequence } as const;
      }
      const body = latestBodyFact(heart);
      if (body?.hung !== undefined) return { kind: "hung", diagnostic: body.hung.diagnostic } as const;
      const pause = pauseFact(heart);
      if (pause !== null && pause.bodySequence !== body?.sequence) return { kind: "untidy" } as const;
      if (tell.binding !== undefined) {
        const bound = turnFact(heart, tell.binding.turnSequence);
        if (bound?.bodySequence === body?.sequence && bound?.end?.outcome.kind === "failed")
          return { kind: "submission-failed", diagnostic: bound.end.outcome.diagnostic } as const;
      }
      const control = pause !== null ? "interrupt" : stopFact(heart) !== null ? "stop" : null;
      return { kind: "pending", body, control } as const;
    },
    signal,
  );
}

export async function recordTellDeliveries(paths: AkumaPaths, inputs: readonly TellDeliveryInput[]): Promise<void> {
  await withHeartTransaction(paths, (heart) => {
    let changed = false;
    for (const input of inputs) {
      requireTell(heart, input.tellId);
      const turn = turnFact(heart, input.turnSequence);
      if (turn === null) throw new Error(`unknown Akuma Turn ${input.turnSequence}`);
      if (isTellProtectedByPause(heart, input.tellId, turn.bodySequence)) throw new BodyControlledError();
      changed = insertTellDeliveryFact(heart, input) || changed;
    }
    if (changed) pruneActivityFacts(heart, ACTIVITY_LIMIT, true);
  });
}

export async function recordTellReceipt(paths: AkumaPaths, input: TellReceiptInput): Promise<void> {
  await withHeartTransaction(paths, (heart) => {
    const tellIds =
      input.evidence === "exact" ? [input.tellId] : tellIdsForFence(heart, input.turnSequence, input.fence);
    if (tellIds.length === 0) throw new Error("tell receipt has no delivery mapping");
    const pause = pauseFact(heart);
    const write = tellTerminalWriter(heart, input.kind, input.receivedAt, input.evidence === "exact");
    let changed = false;
    for (const tellId of tellIds) {
      requireTell(heart, tellId);
      if (pause !== null && isTellProtectedByPause(heart, tellId, pause.bodySequence)) throw new BodyControlledError();
      changed = write(tellId) || changed;
    }
    if (changed) pruneActivityFacts(heart, ACTIVITY_LIMIT, true);
  });
}

export async function readStopEvidence(paths: AkumaPaths, sequence: number, signal: AbortSignal) {
  return await withReadOnlyHeart(
    paths,
    (heart) => {
      const latest = latestBodyFact(heart);
      const body = latest?.sequence === sequence ? latest : null;
      if (body?.hung !== undefined) return { body, outcome: "hung" } as const;
      if (killFactForBody(heart, sequence) !== null) return { body, outcome: "killed" } as const;
      return { body, outcome: body === null ? "unavailable" : undefined } as const;
    },
    signal,
  );
}

export async function requestStop(
  paths: AkumaPaths,
  at: string,
  signal?: AbortSignal,
): Promise<
  | Readonly<{ kind: "requested"; body: BodyFact }>
  | Readonly<{ kind: "witnessed"; body: BodyFact }>
  | Readonly<{ kind: "already-killed" | "already-stopped" | "hung"; body: BodyFact }>
> {
  return await withHeartTransaction(
    paths,
    (heart) => {
      const id = akumaIdFromDirectoryName(basename(paths.directory)).id;
      if (!birthMatches(heart, id)) throw new HeartUnbornError(id);
      const body = latestBodyFact(heart);
      if (body === null) throw new Error("Akuma has no Body to kill");
      if (body.hung !== undefined) return { kind: "hung", body };
      if (latestKillFact(heart)?.bodySequence === body.sequence) return { kind: "already-killed", body };
      if (body.end !== undefined) {
        if (body.end !== "exited") {
          insertKillFact(heart, body.sequence, at);
          if (stopFact(heart)?.bodySequence === body.sequence) deleteStopControl(heart);
          return { kind: "witnessed", body };
        }
        return { kind: "already-stopped", body };
      }
      const existing = stopFact(heart);
      if (existing === null) insertStopControl(heart, body.sequence, at);
      else if (existing.bodySequence !== body.sequence) throw new Error("Akuma stop target is not the latest Body");
      return { kind: "requested", body };
    },
    signal,
  );
}

export async function breakBody(
  paths: AkumaPaths,
  input: Readonly<{ sequence: number; end: Exclude<BodyEnd, "exited">; at: string }>,
): Promise<void> {
  await withHeartTransaction(paths, (heart) => endBodyFact(heart, input));
}

/** The owning Body calls this only after proving its provider custody retired. */
export async function cancelBodyTurns(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; at: string }>,
): Promise<Readonly<{ canceled: readonly number[] }>> {
  return await withHeartTransaction(paths, (heart) => {
    const body = latestBodyFact(heart);
    if (
      body?.sequence !== input.bodySequence ||
      body.hung !== undefined ||
      (body.end !== undefined && body.end !== "put-down")
    )
      throw new Error(`Akuma Body ${input.bodySequence} cannot settle controlled cancellation`);
    const sequences = openTurnsForBody(heart, input.bodySequence);
    for (const turnSequence of sequences)
      insertTurnEndFact(heart, {
        kind: "turn-end",
        turnSequence,
        outcome: { kind: "canceled" },
        completedAt: input.at,
      });
    endBodyFact(heart, { sequence: input.bodySequence, end: "put-down", at: input.at });
    if (sequences.length > 0) pruneActivityFacts(heart, ACTIVITY_LIMIT, true);
    return { canceled: sequences };
  });
}

export async function beginTurn(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; startedAt: string; call?: string; schemaJson?: string; initiator?: string }>,
): Promise<TurnStartFact> {
  return await withHeartTransaction(paths, (heart) => {
    if (pauseFact(heart)?.bodySequence === input.bodySequence) throw new BodyControlledError();
    if (stopFact(heart)?.bodySequence === input.bodySequence) throw new BodyControlledError();
    const fact = insertTurnStartFact(heart, input);
    pruneActivityFacts(heart, ACTIVITY_LIMIT);
    return fact;
  });
}

export async function bindTellsToTurn(
  paths: AkumaPaths,
  input: Readonly<{ turnSequence: number; tellIds: readonly string[]; boundAt: string }>,
): Promise<void> {
  await withHeartTransaction(paths, (heart) => {
    const turn = turnFact(heart, input.turnSequence);
    if (turn === null) throw new Error(`Akuma Turn ${input.turnSequence} is missing`);
    for (const tellId of input.tellIds) {
      requireTell(heart, tellId);
      if (isTellProtectedByPause(heart, tellId, turn.bodySequence)) throw new BodyControlledError();
      insertTellBindingFact(heart, { tellId, turnSequence: input.turnSequence, boundAt: input.boundAt });
    }
  });
}

export async function readOpenBoundTurns(paths: AkumaPaths, bodySequence: number): Promise<readonly number[]> {
  return await withReadOnlyHeart(paths, (heart) => openBoundTurns(heart, bodySequence));
}

export async function failOpenBoundTurns(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; diagnostic: string; completedAt: string }>,
): Promise<readonly number[]> {
  return await withHeartTransaction(paths, (heart) => {
    const sequences = openBoundTurns(heart, input.bodySequence);
    for (const turnSequence of sequences) {
      insertTurnEndFact(heart, {
        kind: "turn-end",
        turnSequence,
        outcome: { kind: "failed", diagnostic: input.diagnostic },
        completedAt: input.completedAt,
      });
    }
    if (sequences.length > 0) pruneActivityFacts(heart, ACTIVITY_LIMIT, true);
    return sequences;
  });
}

export async function readTurn(paths: AkumaPaths, sequence: number): Promise<TurnFact | null> {
  return await withReadOnlyHeart(paths, (heart) => turnFact(heart, sequence));
}

export async function readTurnParticipants(paths: AkumaPaths, sequence: number): Promise<readonly string[]> {
  return await withReadOnlyHeart(paths, (heart) => turnParticipants(heart, sequence));
}

export async function readLatestTurnForBody(paths: AkumaPaths, bodySequence: number): Promise<TurnFact | null> {
  return await withReadOnlyHeart(paths, (heart) => latestTurnFactForBody(heart, bodySequence));
}

export async function endTurn(
  paths: AkumaPaths,
  input: Readonly<{ turnSequence: number; outcome: TurnOutcome; completedAt: string }>,
): Promise<TurnEndFact> {
  return await withHeartTransaction(paths, (heart) => {
    const fact = insertTurnEndFact(heart, { kind: "turn-end", ...input });
    pruneActivityFacts(heart, ACTIVITY_LIMIT, true);
    return fact;
  });
}

export async function finishBodyIfIdle(
  paths: AkumaPaths,
  input: Readonly<{ sequence: number; at: string }>,
): Promise<Readonly<{ kind: "controlled" | "finished" } | { kind: "pending"; tells: readonly string[] }>> {
  return await withHeartTransaction(paths, (heart) => {
    if (stopFact(heart)?.bodySequence === input.sequence || pauseFact(heart)?.bodySequence === input.sequence) {
      return { kind: "controlled" };
    }
    const pending = pendingTellFacts(heart);
    if (pending.length > 0) return { kind: "pending", tells: pending.map((tell) => tell.id) };
    finishBodyFact(heart, input);
    return { kind: "finished" };
  });
}

export type BodyControlSnapshot = Pick<HeartSnapshot, "soul" | "pending" | "stop" | "pause">;

export function createBodyHeartReader(paths: AkumaPaths) {
  const reader = createHeartReader(paths);
  return {
    clear: reader.clear,
    async read(): Promise<BodyControlSnapshot> {
      try {
        return await reader.read((heart) => ({
          soul: soulFact(heart),
          pending: pendingTellFacts(heart),
          stop: stopFact(heart),
          pause: pauseFact(heart),
        }));
      } catch (error) {
        if (isHeartAbsent(error)) return { soul: null, pending: [], stop: null, pause: null };
        throw error;
      }
    },
  };
}

export async function readHeart(paths: AkumaPaths, signal?: AbortSignal): Promise<HeartSnapshot> {
  try {
    return await withReadOnlyHeart(
      paths,
      (heart) => ({
        soul: soulFact(heart),
        latestBody: latestBodyFact(heart),
        latestSession: latestSessionFact(heart),
        pending: pendingTellFacts(heart),
        latestKill: latestKillFact(heart),
        stop: stopFact(heart),
        pause: pauseFact(heart),
        lastActivityAt: readLastActivityAt(heart),
      }),
      signal,
    );
  } catch (error) {
    if (isHeartAbsent(error)) {
      return {
        soul: null,
        latestBody: null,
        latestSession: null,
        pending: [],
        latestKill: null,
        stop: null,
        pause: null,
        lastActivityAt: null,
      };
    }
    throw error;
  }
}

export async function readLastAnsweredTurn(paths: AkumaPaths): Promise<TurnFact | null> {
  return await withReadOnlyHeart(paths, lastAnsweredTurnFact);
}

export async function readForkPoint(paths: AkumaPaths, historyId: string): Promise<ForkPoint | null> {
  const turnSequence = parsePublicHistoryId(historyId);
  if (turnSequence === null) return null;
  try {
    return await withReadOnlyHeart(paths, (heart) => {
      const turn = answeredTurnFact(heart, turnSequence);
      const outcome = turn?.end?.outcome;
      if (outcome?.kind !== "answered" || outcome.historyId === undefined) return null;
      const recipe = sessionFactForCoordinate(heart, outcome.session);
      if (recipe === null) throw new Error(`Akuma fork point ${historyId} has no session recipe`);
      // The source's current model is the admitted child selection. The session
      // row's obsolete copy is dropped, and an absent current model stays absent.
      const current = soulFact(heart)?.options.model;
      return {
        historyId: outcome.historyId,
        session: outcome.session,
        provider: recipe.provider,
        cwd: recipe.cwd,
        options: { ...withoutModel(recipe.options), ...(current === undefined ? {} : { model: current }) },
      };
    });
  } catch (error) {
    if (isHeartAbsent(error)) return null;
    throw error;
  }
}
