import type { DatabaseSync } from "node:sqlite";
import type { AkumaPaths } from "../identity.js";
import { parsePublicHistoryId } from "../identity.js";
import { decodeRuntimeModel, withoutModel } from "../provider-recipe.js";
import type {
  BodyEnd,
  BodyFact,
  ForkPoint,
  HeartSnapshot,
  InterruptCompletion,
  KillFact,
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
} from "./facts.js";
import { BodyControlledError } from "./facts.js";
import {
  answeredTurnFact,
  completeInterruptBarrier as judgeInterruptBarrier,
  endBodyFact,
  finishBodyFact,
  deleteStopControl,
  insertActivityFact,
  insertTurnEndFact,
  insertTurnStartFact,
  insertKillFact,
  insertSessionFact,
  insertStopControl,
  killFactForBody,
  hasBodyHandoffControl,
  latestBodyFact,
  insertInterruptBarrier,
  isTellProtectedByPause,
  latestKillFact,
  latestSessionFact,
  latestTurnFactForBody,
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
  dispositionSnapshotProven,
  insertTellBindingFact,
  insertTellDispositionSnapshot,
  insertTellReceiptFact,
  insertUndeliveredTellReceipts,
  latestOpenTellDisposition,
  openBoundTurns,
  openTellDispositionIds,
  pendingTellFacts,
  hasPendingTell,
  resolveTellDispositionSnapshot,
  sameTellInput,
  tellDispositionResolved,
  tellFact,
  tellIdsForFence,
  turnParticipants,
} from "./tells.js";
import {
  activityFactSlice,
  statusFacts,
  readStatusBatch,
  decodeTimelineBatch,
  timelineDataVersion,
  type StatusFactInput,
  lastActivityAt as readLastActivityAt,
  pruneActivityFacts,
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
import { AkumaBusyError, HeartAuthorityCorruptionError } from "./facts.js";
export {
  HeartAbsentError,
  HeldAkumaLeash,
  classifyHeartSchema,
  initializeHeart,
  isHeartAbsent,
  probeLeash,
} from "./storage.js";
export {
  admitRequest,
  beginRequest,
  isRequestInputConflict,
  readNonterminalRequests,
  readRequest,
  refuseRequest,
  reserveRequest,
  serveRequest,
  serveUpstreamRequest,
  unproveRequest,
  voidRequest,
} from "./request-authority.js";

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
  RequestFact,
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
): Promise<Extract<InterruptCompletion, { kind: "completed" | "unavailable" }>> {
  const result = await withReadOnlyHeart(paths, (heart) => judgeInterruptBarrier(heart, expected, false));
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

export async function readStatusFacts(
  paths: AkumaPaths,
  input: StatusFactInput,
  signal?: AbortSignal,
): Promise<ActivitySlice["rows"]> {
  return await withReadOnlyHeart(paths, (heart) => statusFacts(heart, input), signal);
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

// Each query returns a fixed set of scalar columns; compare JSON columns as text.
function sameRawRows<Row extends object>(left: readonly Row[], right: readonly Row[]): boolean {
  if (left.length !== right.length) return false;
  if (left.length === 0) return true;
  const columns = Object.keys(left[0]!) as (keyof Row)[];
  return left.every((row, index) => columns.every((column) => row[column] === right[index]![column]));
}

function sameStatusBatch(left: ReturnType<typeof readStatusBatch>, right: ReturnType<typeof readStatusBatch>): boolean {
  return (
    left.frontier === right.frontier &&
    sameRawRows(left.rows, right.rows) &&
    sameRawRows(left.turns, right.turns) &&
    sameRawRows(left.calls, right.calls) &&
    sameRawRows(left.activity, right.activity) &&
    sameRawRows(left.tells.rows, right.tells.rows) &&
    sameRawRows(left.tells.deliveries, right.tells.deliveries) &&
    sameRawRows(left.tells.bindings, right.tells.bindings)
  );
}

/** One observer owns its connection and successful decoded frontier. */
export function createStatusFactReader(paths: AkumaPaths) {
  const reader = createHeartReader(paths);
  let memo: Readonly<{ batch: ReturnType<typeof readStatusBatch>; facts: ActivitySlice["rows"] }> | undefined;
  return {
    life: (signal?: AbortSignal) => readLifeSnapshot(paths, signal, reader.read),
    tellOutcome: (id: string, signal?: AbortSignal) =>
      reader.read((heart) => {
        const tell = tellFact(heart, id);
        // A pending Tell may be retried by a successor after cancellation. Its
        // first retained terminal still belongs to this exact admission.
        const end = terminalTurnForTell(heart, id)?.end;
        return { tell, end };
      }, signal),
    clear(): void {
      reader.clear();
      memo = undefined;
    },
    async read(input: StatusFactInput, signal?: AbortSignal): Promise<ActivitySlice["rows"]> {
      try {
        const next = await reader.read((heart) => {
          const batch = readStatusBatch(heart, input);
          if (memo !== undefined && sameStatusBatch(batch, memo.batch)) return memo;
          return { batch, facts: decodeTimelineBatch(batch) };
        }, signal);
        // Publication follows COMMIT, so failed reads can never supply a fallback.
        memo = next;
        return next.facts;
      } catch (error) {
        reader.clear();
        memo = undefined;
        throw error;
      }
    },
  };
}

type LifeSnapshot = Pick<HeartSnapshot, "soul" | "latestBody" | "latestSession" | "latestKill"> &
  Readonly<{ hasPendingTell: boolean }>;

/** Lifecycle probes do not load narration, Tell bodies, or delivery histories. */
export async function readLifeSnapshot(
  paths: AkumaPaths,
  signal?: AbortSignal,
  read: HeartRead = (body, signal) => withReadOnlyHeart(paths, body, signal),
): Promise<LifeSnapshot> {
  try {
    return await read(
      (heart) => ({
        soul: soulFact(heart),
        latestBody: latestBodyFact(heart),
        latestSession: latestSessionFact(heart),
        latestKill: latestKillFact(heart),
        hasPendingTell: hasPendingTell(heart),
      }),
      signal,
    );
  } catch (error) {
    if (isHeartAbsent(error))
      return { soul: null, latestBody: null, latestSession: null, latestKill: null, hasPendingTell: false };
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
      predecessorWasRunning: boolean;
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
  if (!sameTellInput(existing, interrupt ? { ...tell, recordedAt: existing.recordedAt } : tell))
    throw new Error(`tell ${tell.id} reused different input`);
  if (!interrupt) return { kind: "recorded", tell: existing };
  const barrier =
    body !== null && pause !== null && isTellProtectedByPause(heart, tell.id, body.sequence) ? pause : undefined;
  return {
    kind: "recorded",
    tell: existing,
    predecessorWasRunning: body !== null && body.end === undefined,
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
    return { ...admitted, predecessorWasRunning: body.end === undefined, barrier };
  }
  const running = body !== null && body.end === undefined && body.hung === undefined;
  if (tell.schemaJson !== undefined && running) throw new AkumaBusyError();
  return recordPendingTell(heart, tell);
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
      if (soulFact(heart) === null) return { kind: "not-born" };
      const existing = tellFact(heart, tell.id);
      const body = latestBodyFact(heart);
      const pause = interrupt ? pauseFact(heart) : null;
      const inputs: TellAdmissionInputs = { heart, tell, body, pause, interrupt };
      return existing === null ? judgeNewTell(inputs) : judgeExistingTell(inputs, existing);
    },
    options.signal,
  );
}

export async function readTell(paths: AkumaPaths, id: string): Promise<TellFact | null> {
  return await withReadOnlyHeart(paths, (heart) => tellFact(heart, id));
}

export async function recordTellDeliveries(paths: AkumaPaths, inputs: readonly TellDeliveryInput[]): Promise<void> {
  await withHeartTransaction(paths, (heart) => {
    for (const input of inputs) {
      const current = tellFact(heart, input.tellId);
      if (current === null) throw new Error(`unknown tell ${input.tellId}`);
      const turn = turnFact(heart, input.turnSequence);
      if (turn === null) throw new Error(`unknown Akuma Turn ${input.turnSequence}`);
      if (isTellProtectedByPause(heart, input.tellId, turn.bodySequence)) throw new BodyControlledError();
    }
    let changed = false;
    for (const input of inputs) changed = insertTellDeliveryFact(heart, input) || changed;
    pruneActivityFacts(heart, ACTIVITY_LIMIT, changed);
  });
}

export async function recordTellReceipt(paths: AkumaPaths, input: TellReceiptInput): Promise<void> {
  await withHeartTransaction(paths, (heart) => {
    const tellIds =
      input.evidence === "exact" ? [input.tellId] : tellIdsForFence(heart, input.turnSequence, input.fence);
    if (tellIds.length === 0) throw new Error("tell receipt has no delivery mapping");
    const pause = pauseFact(heart);
    for (const tellId of tellIds) {
      if (tellFact(heart, tellId) === null) throw new Error(`unknown tell ${tellId}`);
      if (pause !== null && isTellProtectedByPause(heart, tellId, pause.bodySequence)) throw new BodyControlledError();
    }
    const changed = insertTellReceiptFact(heart, input);
    pruneActivityFacts(heart, ACTIVITY_LIMIT, changed);
  });
}

export type PendingTellDisposition = Readonly<{
  bodySequence: number;
  tellIds: readonly string[];
}>;

function decidePendingTellDispositionInHeart(
  heart: DatabaseSync,
  input: Readonly<{ bodySequence: number; at: string; handoff: boolean }>,
): PendingTellDisposition | null {
  const body = latestBodyFact(heart);
  if (body === null || body.sequence !== input.bodySequence) return null;
  if (tellDispositionResolved(heart, input.bodySequence) === true) return null;
  if (hasBodyHandoffControl(heart, input.bodySequence)) {
    if (input.handoff && body.end === undefined)
      endBodyFact(heart, { sequence: input.bodySequence, end: "put-down", at: input.at });
    return null;
  }
  const existing = openTellDispositionIds(heart, input.bodySequence);
  if (existing !== null) return { bodySequence: input.bodySequence, tellIds: existing };
  const tellIds = pendingTellFacts(heart).map((tell) => tell.id);
  if (tellIds.length === 0) return null;
  if (body.end === undefined) {
    if (!input.handoff) return null;
    endBodyFact(heart, { sequence: input.bodySequence, end: "put-down", at: input.at });
  } else if (body.end === "broke-off") {
    return null;
  }
  insertTellDispositionSnapshot(heart, input.bodySequence, tellIds, input.at);
  return { bodySequence: input.bodySequence, tellIds };
}

export async function decidePendingTellDisposition(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; at: string; handoff: boolean }>,
): Promise<PendingTellDisposition | null> {
  return await withHeartTransaction(paths, (heart) => {
    const decided = decidePendingTellDispositionInHeart(heart, input);
    pruneActivityFacts(heart, ACTIVITY_LIMIT);
    return decided;
  });
}

export async function readOpenPendingTellDisposition(paths: AkumaPaths): Promise<PendingTellDisposition | null> {
  return await withReadOnlyHeart(paths, (heart) => latestOpenTellDisposition(heart));
}

/** Prove and consume the persisted decision in one transaction, never a caller's stale member list. */
export async function resolvePendingTellDisposition(
  paths: AkumaPaths,
  bodySequence: number,
  at: string,
  outcome: "custody" | "undelivered" = "custody",
): Promise<boolean> {
  return await withHeartTransaction(paths, (heart) => {
    if (tellDispositionResolved(heart, bodySequence) === true) return true;
    const tellIds = openTellDispositionIds(heart, bodySequence);
    if (tellIds === null) throw new HeartAuthorityCorruptionError(`Akuma disposition ${bodySequence} is missing`);
    if (hasBodyHandoffControl(heart, bodySequence)) {
      resolveTellDispositionSnapshot(heart, bodySequence, at);
      pruneActivityFacts(heart, ACTIVITY_LIMIT, true);
      return true;
    }
    if (outcome === "undelivered") insertUndeliveredTellReceipts(heart, tellIds, at);
    if (!dispositionSnapshotProven(heart, tellIds)) return false;
    resolveTellDispositionSnapshot(heart, bodySequence, at);
    pruneActivityFacts(heart, ACTIVITY_LIMIT, true);
    return true;
  });
}

export async function readKill(paths: AkumaPaths, bodySequence: number): Promise<KillFact | null> {
  return await withReadOnlyHeart(paths, (heart) => killFactForBody(heart, bodySequence));
}

export async function requestStop(
  paths: AkumaPaths,
  at: string,
  signal?: AbortSignal,
): Promise<
  | Readonly<{ kind: "requested"; body: BodyFact }>
  | Readonly<{ kind: "witnessed"; body: BodyFact }>
  | Readonly<{ kind: "already-killed" | "already-stopped"; body: BodyFact }>
> {
  return await withHeartTransaction(
    paths,
    (heart) => {
      const body = latestBodyFact(heart);
      if (body === null) throw new Error("Akuma has no Body to kill");
      if (latestKillFact(heart)?.bodySequence === body.sequence) return { kind: "already-killed", body };
      if (body.end !== undefined) {
        // A stranded Body is already explicitly settled: kill witnesses it in
        // place rather than requesting a stop from a dead process. A normally
        // exited Body remains already-stopped, and hung custody is untouched.
        if (body.hung === undefined && body.end !== "exited") {
          insertKillFact(heart, body.sequence, at);
          const released = tellDispositionResolved(heart, body.sequence) === false;
          resolveTellDispositionSnapshot(heart, body.sequence, at);
          pruneActivityFacts(heart, ACTIVITY_LIMIT, released);
          if (stopFact(heart)?.bodySequence === body.sequence) deleteStopControl(heart);
          return { kind: "witnessed", body };
        }
        return { kind: "already-stopped", body };
      }
      const existing = stopFact(heart);
      if (existing !== null && existing.bodySequence !== body.sequence) {
        throw new Error("Akuma stop target is not the latest Body");
      }
      insertStopControl(heart, body.sequence, at);
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
  input: Readonly<{ bodySequence: number; at: string; handoff?: boolean }>,
): Promise<Readonly<{ canceled: readonly number[]; disposition: PendingTellDisposition | null }>> {
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
    const disposition =
      input.handoff === true ? decidePendingTellDispositionInHeart(heart, { ...input, handoff: true }) : null;
    pruneActivityFacts(heart, ACTIVITY_LIMIT, sequences.length > 0);
    return { canceled: sequences, disposition };
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
      if (tellFact(heart, tellId) === null) throw new Error(`unknown tell ${tellId}`);
      if (isTellProtectedByPause(heart, tellId, turn.bodySequence)) throw new BodyControlledError();
      insertTellBindingFact(heart, { tellId, turnSequence: input.turnSequence, boundAt: input.boundAt });
    }
    pruneActivityFacts(heart, ACTIVITY_LIMIT);
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
    pruneActivityFacts(heart, ACTIVITY_LIMIT, sequences.length > 0);
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

export async function readHeart(paths: AkumaPaths): Promise<HeartSnapshot> {
  try {
    return await withReadOnlyHeart(paths, (heart) => ({
      soul: soulFact(heart),
      latestBody: latestBodyFact(heart),
      latestSession: latestSessionFact(heart),
      pending: pendingTellFacts(heart),
      latestKill: latestKillFact(heart),
      stop: stopFact(heart),
      pause: pauseFact(heart),
      lastActivityAt: readLastActivityAt(heart),
    }));
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
