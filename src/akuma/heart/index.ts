import type { AkumaPaths } from "../identity.js";
import { parsePublicHistoryId } from "../identity.js";
import type {
  BodyEnd,
  BodyFact,
  ForkPoint,
  HeartSnapshot,
  KillFact,
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
import {
  answeredTurnFact,
  endBodyFact,
  finishBodyFact,
  deleteStopControl,
  insertActivityFact,
  insertTurnEndFact,
  insertTurnStartFact,
  insertPauseControl,
  insertKillFact,
  insertSessionFact,
  insertStopControl,
  killFactForBody,
  latestBodyFact,
  latestKillFact,
  latestSessionFact,
  latestTurnFactForBody,
  lastAnsweredTurnFact,
  pauseFact,
  sessionFactForCoordinate,
  stopFact,
  turnFact,
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
  readSealFromLeash,
  recordPendingTell,
  withHeartTransaction,
  withReadOnlyHeart,
} from "./storage.js";
import { soulFact } from "./soul.js";
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

export { AkumaBusyError, life, lifeAt, projectTell } from "./facts.js";
export { drainPendingTells } from "./tells.js";
export type {
  AkumaLife,
  AkumaOrigin,
  BodyEnd,
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

/** One live observation's successful raw input and decoded frontier, never a connection. */
export function createStatusFactReader(paths: AkumaPaths) {
  let memo: Readonly<{ batch: ReturnType<typeof readStatusBatch>; facts: ActivitySlice["rows"] }> | undefined;
  return {
    clear(): void {
      memo = undefined;
    },
    async read(input: StatusFactInput, signal?: AbortSignal): Promise<ActivitySlice["rows"]> {
      try {
        const next = await withReadOnlyHeart(
          paths,
          (heart) => {
            const batch = readStatusBatch(heart, input);
            if (memo !== undefined && sameStatusBatch(batch, memo.batch)) return memo;
            return { batch, facts: decodeTimelineBatch(batch) };
          },
          signal,
        );
        // Publication follows COMMIT, so failed reads can never supply a fallback.
        memo = next;
        return next.facts;
      } catch (error) {
        memo = undefined;
        throw error;
      }
    },
  };
}

type LifeSnapshot = Pick<HeartSnapshot, "soul" | "latestBody" | "latestSession" | "latestKill"> &
  Readonly<{ hasPendingTell: boolean }>;

/** Lifecycle probes do not load narration, Tell bodies, or delivery histories. */
export async function readLifeSnapshot(paths: AkumaPaths, signal?: AbortSignal): Promise<LifeSnapshot> {
  try {
    return await withReadOnlyHeart(
      paths,
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

function sameTellInput(
  existing: TellFact,
  tell: Omit<TellFact, "sequence" | "state" | "deliveries" | "binding">,
): boolean {
  return (
    existing.body === tell.body &&
    existing.recordedAt === tell.recordedAt &&
    existing.schemaJson === tell.schemaJson &&
    existing.initiator === tell.initiator
  );
}

export async function recordTell(
  paths: AkumaPaths,
  tell: Omit<TellFact, "sequence" | "state" | "deliveries" | "binding">,
  options: Readonly<{ interrupt?: boolean }> = {},
): Promise<Readonly<{ kind: "not-born" } | { kind: "recorded"; tell: TellFact }>> {
  return await withHeartTransaction(paths, (heart) => {
    if (soulFact(heart) === null) return { kind: "not-born" };
    const existing = tellFact(heart, tell.id);
    if (existing !== null) {
      if (!sameTellInput(existing, tell)) throw new Error(`tell ${tell.id} reused different input`);
      return { kind: "recorded", tell: existing };
    }
    const body = latestBodyFact(heart);
    const running = body !== null && body.end === undefined && body.hung === undefined;
    if (tell.schemaJson !== undefined && running && options.interrupt !== true) throw new AkumaBusyError();
    return recordPendingTell(heart, tell);
  });
}

export async function readTell(paths: AkumaPaths, id: string): Promise<TellFact | null> {
  return await withReadOnlyHeart(paths, (heart) => tellFact(heart, id));
}

export async function recordTellDeliveries(paths: AkumaPaths, inputs: readonly TellDeliveryInput[]): Promise<void> {
  await withHeartTransaction(paths, (heart) => {
    for (const input of inputs) {
      const current = tellFact(heart, input.tellId);
      if (current === null) throw new Error(`unknown tell ${input.tellId}`);
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
    const changed = insertTellReceiptFact(heart, input);
    pruneActivityFacts(heart, ACTIVITY_LIMIT, changed);
  });
}

export type PendingTellDisposition = Readonly<{
  bodySequence: number;
  tellIds: readonly string[];
}>;

export async function decidePendingTellDisposition(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; at: string; handoff: boolean }>,
): Promise<PendingTellDisposition | null> {
  return await withHeartTransaction(paths, (heart) => {
    const body = latestBodyFact(heart);
    if (body === null || body.sequence !== input.bodySequence) return null;
    if (tellDispositionResolved(heart, input.bodySequence) === true) return null;
    const existing = openTellDispositionIds(heart, input.bodySequence);
    if (existing !== null) return { bodySequence: input.bodySequence, tellIds: existing };
    const pending = pendingTellFacts(heart);
    const tellIds = pending.map((tell) => tell.id);
    if (tellIds.length === 0) return null;
    if (body.end === undefined) {
      if (!input.handoff) return null;
      endBodyFact(heart, { sequence: input.bodySequence, end: "put-down", at: input.at });
    } else if (body.end === "broke-off") {
      return null;
    }
    insertTellDispositionSnapshot(heart, input.bodySequence, tellIds, input.at);
    pruneActivityFacts(heart, ACTIVITY_LIMIT);
    return { bodySequence: input.bodySequence, tellIds };
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

export async function requestPause(
  paths: AkumaPaths,
  at: string,
  signal?: AbortSignal,
): Promise<Readonly<{ kind: "not-born" } | { kind: "requested"; body: BodyFact }>> {
  return await withHeartTransaction(
    paths,
    (heart) => {
      if (soulFact(heart) === null) return { kind: "not-born" };
      const body = latestBodyFact(heart);
      if (body === null) throw new Error("Akuma has no Body to interrupt");
      insertPauseControl(heart, at);
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

export async function beginTurn(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; startedAt: string; call?: string; schemaJson?: string; initiator?: string }>,
): Promise<TurnStartFact> {
  return await withHeartTransaction(paths, (heart) => {
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
    for (const tellId of input.tellIds) {
      if (tellFact(heart, tellId) === null) throw new Error(`unknown tell ${tellId}`);
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
      endBodyFact(heart, { ...input, end: "put-down" });
      return { kind: "controlled" };
    }
    const pending = pendingTellFacts(heart);
    if (pending.length > 0) return { kind: "pending", tells: pending.map((tell) => tell.id) };
    finishBodyFact(heart, input);
    return { kind: "finished" };
  });
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
      return {
        historyId: outcome.historyId,
        session: outcome.session,
        provider: recipe.provider,
        cwd: recipe.cwd,
        options: recipe.options,
      };
    });
  } catch (error) {
    if (isHeartAbsent(error)) return null;
    throw error;
  }
}
