import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AkuId, AkumaPaths } from "../identity.js";
import type {
  BodyEnd,
  BodyFact,
  Collar,
  ForkPoint,
  HeartSnapshot,
  KillFact,
  LeashProbe,
  RequestFact,
  RequestInput,
  SealFact,
  SessionFact,
  Soul,
  StopFact,
  TellDeliveryInput,
  TellFact,
  TellReceiptInput,
  TurnFact,
} from "./facts.js";
import {
  HEART_SCHEMA,
  LEASH_SCHEMA,
  assertHeartSchemaVersion,
  assertLeashSchemaVersion,
} from "./schema.js";
import {
  answeredTurnFact,
  deletePauseControl,
  deleteStopControl,
  endBodyFact,
  finishBodyFact,
  historyFacts,
  insertActivityFact,
  insertAnsweredTurnFact,
  insertBodyFact,
  insertKillFact,
  insertFailedTurnFact,
  insertPauseControl,
  insertRequestFact,
  insertSealFact,
  insertSessionFact,
  insertSoulFact,
  insertStopControl,
  killFactForBody,
  latestBodyFact,
  latestKillFact,
  latestSessionFact,
  latestTurnFact,
  lastAnsweredTurnFact,
  nonterminalRequestFacts,
  pauseExists,
  requestFact,
  sealExists,
  sealFact,
  sessionFactForCoordinate,
  soulFact,
  stopFact,
  updateRequestRefused,
  updateRequestReserved,
  updateRequestServed,
  updateRequestVoided,
} from "./rows.js";
import type { ActivityFact } from "./rows.js";
import {
  activityFactSlice,
  insertTellDeliveryFact,
  insertTellFact,
  insertTellReceiptFact,
  pendingTellFacts,
  pruneActivityFacts,
  tellFact,
  tellIdsForFence,
  type ActivityFactSlice,
} from "./tells.js";

export { life } from "./facts.js";
export type {
  AkumaLife,
  AkumaOrigin,
  BodyEnd,
  BodyFact,
  Collar,
  CollarProbe,
  Confinement,
  HeartSnapshot,
  ForkPoint,
  KillEvidence,
  KillFact,
  LeashProbe,
  ProviderOptions,
  ProviderExecution,
  RequestFact,
  RequestInput,
  RequestRecipe,
  ResumeCoordinate,
  SealFact,
  SessionFact,
  Soul,
  StopFact,
  TellFact,
  TellDeliveryInput,
  TellReceiptInput,
  TurnFact,
  TurnOutcome,
} from "./facts.js";

const ACTIVITY_LIMIT = 5_000;

function isBusy(error: unknown): boolean {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown };
  const message = String(value?.message ?? "").toLowerCase();
  return value?.code === "ERR_SQLITE_BUSY" || value?.code === "ERR_SQLITE_LOCKED"
    || value?.errcode === 5 || message.includes("database is locked") || message.includes("database is busy");
}

function openHeart(path: string, verify = true): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
  if (verify) assertHeartSchemaVersion(database);
  return database;
}

function withHeart<T>(paths: AkumaPaths, body: (database: DatabaseSync) => T): T {
  const database = openHeart(paths.heart);
  try { return body(database); } finally { database.close(); }
}

function transaction<T>(database: DatabaseSync, body: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the adjudication failure */ }
    throw error;
  }
}

export function initializeHeart(paths: AkumaPaths): void {
  const heart = openHeart(paths.heart, false);
  try {
    heart.exec(HEART_SCHEMA);
    assertHeartSchemaVersion(heart);
  } finally { heart.close(); }
  const leash = new DatabaseSync(paths.leash);
  try {
    leash.exec(LEASH_SCHEMA);
    assertLeashSchemaVersion(leash);
  } finally { leash.close(); }
}

export class HeldAkumaLeash {
  private closed = false;

  private constructor(private readonly database: DatabaseSync) {}

  static try(paths: AkumaPaths): HeldAkumaLeash | null {
    const database = new DatabaseSync(paths.leash, { timeout: 0 });
    try {
      assertLeashSchemaVersion(database);
      database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
      return new HeldAkumaLeash(database);
    } catch (error) {
      database.close();
      if (isBusy(error)) return null;
      throw error;
    }
  }

  birth(
    paths: AkumaPaths,
    soul: Soul,
    session?: Omit<SessionFact, "sequence">,
  ): "born" | "already-born" | "sealed" {
    if (sealExists(this.database)) return "sealed";
    return withHeart(paths, (heart) =>
      transaction(heart, () => {
        if (soulFact(heart) !== null) return "already-born";
        insertSoulFact(heart, soul);
        if (session !== undefined) insertSessionFact(heart, session);
        return "born";
      }));
  }

  sealIfUnborn(paths: AkumaPaths, input: Readonly<{ evidence: string; at: string }>): "born" | "sealed" {
    if (withHeart(paths, (heart) => soulFact(heart)) !== null) return "born";
    insertSealFact(this.database, input);
    this.database.exec("COMMIT");
    this.closed = true;
    this.database.close();
    return "sealed";
  }

  clearPause(paths: AkumaPaths): void { withHeart(paths, deletePauseControl); }

  settleStop(
    paths: AkumaPaths,
    expectedBodySequence?: number,
  ): Readonly<{ target: StopFact; result: "recorded" | "already-killed" }> | null {
    return withHeart(paths, (heart) =>
      transaction(heart, () => {
        const target = stopFact(heart);
        if (target === null) {
          if (expectedBodySequence === undefined) return null;
          const existing = killFactForBody(heart, expectedBodySequence);
          return existing === null
            ? null
            : { target: { bodySequence: expectedBodySequence, requestedAt: existing.at }, result: "already-killed" };
        }
        if (expectedBodySequence !== undefined && target.bodySequence !== expectedBodySequence) {
          throw new Error("Akuma stop target changed while kill was in progress");
        }
        const latest = latestBodyFact(heart);
        if (latest?.sequence !== target.bodySequence) throw new Error("Akuma stop target is not the latest Body");
        const result = latestKillFact(heart)?.bodySequence === target.bodySequence
          ? "already-killed" as const
          : (insertKillFact(heart, target.bodySequence, target.requestedAt), "recorded" as const);
        deleteStopControl(heart);
        return { target, result };
      }));
  }

  recordInterruptTell(
    paths: AkumaPaths,
    tell: Omit<TellFact, "sequence" | "state">,
  ): Readonly<{ kind: "not-born" } | { kind: "recorded"; tell: TellFact }> {
    return withHeart(paths, (heart) =>
      transaction(heart, () => {
        deletePauseControl(heart);
        if (soulFact(heart) === null) return { kind: "not-born" };
        const sequence = insertTellFact(heart, tell);
        pruneActivityFacts(heart, ACTIVITY_LIMIT);
        return { kind: "recorded", tell: { sequence, ...tell, state: "pending" } };
      }));
  }

  release(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.database.exec("ROLLBACK"); } finally { this.database.close(); }
  }
}

export function probeLeash(paths: AkumaPaths): LeashProbe {
  const claim = HeldAkumaLeash.try(paths);
  if (claim === null) return "held";
  claim.release();
  return "free";
}

export function readSoul(paths: AkumaPaths): Soul | null {
  if (!existsSync(paths.heart)) return null;
  return withHeart(paths, soulFact);
}

export function heartExists(paths: AkumaPaths): boolean { return existsSync(paths.heart); }

export function readSeal(paths: AkumaPaths): SealFact | null {
  if (!existsSync(paths.leash)) return null;
  const leash = new DatabaseSync(paths.leash);
  try {
    assertLeashSchemaVersion(leash);
    return sealFact(leash);
  } finally { leash.close(); }
}

export function recordBody(paths: AkumaPaths, input: Readonly<{ collar: Collar; leashTakenAt: string }>): BodyFact {
  return withHeart(paths, (heart) => {
    return { sequence: insertBodyFact(heart, input), collar: input.collar, leashTakenAt: input.leashTakenAt };
  });
}

export function recordSession(paths: AkumaPaths, input: Omit<SessionFact, "sequence">): SessionFact {
  return withHeart(paths, (heart) => ({ sequence: insertSessionFact(heart, input), ...input }));
}

export function appendActivity(
  paths: AkumaPaths,
  input: Readonly<{ bodySequence: number; event: unknown; at: string }>,
): number {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      const sequence = insertActivityFact(heart, input);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
      return sequence;
    }));
}

export type ActivitySliceInput = Readonly<{ before?: number; since?: number; limit?: number }>;
export type ActivitySlice = ActivityFactSlice;
export type { ActivityFact };
export type { TimelineFact } from "./tells.js";

export function activitySlice(paths: AkumaPaths, input: ActivitySliceInput = {}): ActivitySlice {
  const limit = input.limit ?? ACTIVITY_LIMIT;
  return withHeart(paths, (heart) => activityFactSlice(heart, { ...input, limit }));
}

export function recordTell(
  paths: AkumaPaths,
  tell: Omit<TellFact, "sequence" | "state">,
): Readonly<{ kind: "not-born" } | { kind: "recorded"; tell: TellFact }> {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (soulFact(heart) === null) return { kind: "not-born" };
      const sequence = insertTellFact(heart, tell);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
      return { kind: "recorded", tell: { sequence, ...tell, state: "pending" } };
    }));
}

export function recordTellDeliveries(
  paths: AkumaPaths,
  inputs: readonly TellDeliveryInput[],
): void {
  withHeart(paths, (heart) =>
    transaction(heart, () => {
      for (const input of inputs) {
        const current = tellFact(heart, input.tellId);
        if (current === null) throw new Error(`unknown tell ${input.tellId}`);
      }
      for (const input of inputs) insertTellDeliveryFact(heart, input);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
    }));
}

export function recordTellReceipt(
  paths: AkumaPaths,
  input: TellReceiptInput,
): void {
  withHeart(paths, (heart) =>
    transaction(heart, () => {
      const tellIds = input.evidence === "exact"
        ? [input.tellId]
        : tellIdsForFence(heart, input.bodySequence, input.fence);
      if (tellIds.length === 0) throw new Error("tell receipt has no delivery mapping");
      insertTellReceiptFact(heart, input);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
    }));
}

function sameRequestInput(fact: RequestFact, input: RequestInput): boolean {
  return fact.id === input.id
    && fact.archetype === input.archetype
    && fact.body === input.body
    && fact.cwd === input.cwd
    && fact.world === input.world
    && JSON.stringify(fact.recipe) === JSON.stringify(input.recipe);
}

export function admitRequest(
  paths: AkumaPaths,
  input: RequestInput & Readonly<{ admittedAt: string }>,
): RequestFact {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      insertRequestFact(heart, input);
      const fact = requestFact(heart, input.id);
      if (fact === null) throw new Error(`Akuma request ${input.id} was not admitted`);
      if (!sameRequestInput(fact, input)) throw new Error(`Akuma request ${input.id} reused different input`);
      return fact;
    }));
}

export function reserveRequest(paths: AkumaPaths, id: string, child: AkuId): RequestFact {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted") updateRequestReserved(heart, id, child);
      else if ((before.state !== "reserved" && before.state !== "served") || before.child !== child) {
        throw new Error(`Akuma request ${id} cannot reserve ${child}`);
      }
      return requestFact(heart, id)!;
    }));
}

export function serveRequest(paths: AkumaPaths, id: string, child: AkuId): RequestFact {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "reserved" && before.child === child) updateRequestServed(heart, id, child);
      else if (before.state !== "served" || before.child !== child) {
        throw new Error(`Akuma request ${id} cannot serve ${child}`);
      }
      return requestFact(heart, id)!;
    }));
}

export function refuseRequest(paths: AkumaPaths, id: string, diagnostic: string): RequestFact {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted") updateRequestRefused(heart, id, diagnostic);
      else if (before.state !== "refused" || before.diagnostic !== diagnostic) {
        throw new Error(`Akuma request ${id} cannot be refused`);
      }
      return requestFact(heart, id)!;
    }));
}

export function voidRequest(paths: AkumaPaths, id: string, evidence: string): RequestFact {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      const before = requestFact(heart, id);
      if (before === null) throw new Error(`unknown Akuma request ${id}`);
      if (before.state === "admitted" || before.state === "reserved") updateRequestVoided(heart, id, evidence);
      else if (before.state !== "voided" || before.evidence !== evidence) {
        throw new Error(`Akuma request ${id} cannot be voided`);
      }
      return requestFact(heart, id)!;
    }));
}

export function readRequest(paths: AkumaPaths, id: string): RequestFact | null {
  return withHeart(paths, (heart) => requestFact(heart, id));
}

export function readNonterminalRequests(paths: AkumaPaths): readonly RequestFact[] {
  return withHeart(paths, nonterminalRequestFacts);
}

export function readKill(paths: AkumaPaths, bodySequence: number): KillFact | null {
  return withHeart(paths, (heart) => killFactForBody(heart, bodySequence));
}

export function requestStop(
  paths: AkumaPaths,
  at: string,
): Readonly<{ kind: "requested"; body: BodyFact }> | Readonly<{ kind: "already-killed"; body: BodyFact }> {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      const body = latestBodyFact(heart);
      if (body === null) throw new Error("Akuma has no Body to kill");
      if (latestKillFact(heart)?.bodySequence === body.sequence) return { kind: "already-killed", body };
      const existing = stopFact(heart);
      if (existing !== null && existing.bodySequence !== body.sequence) {
        throw new Error("Akuma stop target is not the latest Body");
      }
      insertStopControl(heart, body.sequence, at);
      return { kind: "requested", body };
    }));
}

export function requestPause(
  paths: AkumaPaths,
  at: string,
): Readonly<{ kind: "not-born" } | { kind: "requested" }> {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (soulFact(heart) === null) return { kind: "not-born" };
      insertPauseControl(heart, at);
      return { kind: "requested" };
    }));
}

export function stopRequested(paths: AkumaPaths, bodySequence?: number): boolean {
  return withHeart(paths, (heart) => {
    const target = stopFact(heart);
    return target !== null && (bodySequence === undefined || target.bodySequence === bodySequence);
  });
}

export function pauseRequested(paths: AkumaPaths): boolean { return withHeart(paths, pauseExists); }

export function breakBody(paths: AkumaPaths, input: Readonly<{ sequence: number; end: Exclude<BodyEnd, "exited">; at: string }>): void {
  withHeart(paths, (heart) => endBodyFact(heart, input));
}

export function recordTurn(paths: AkumaPaths, input: Omit<TurnFact, "sequence">): TurnFact {
  return withHeart(paths, (heart) => {
    const sequence = input.outcome.kind === "answered"
      ? insertAnsweredTurnFact(heart, {
          bodySequence: input.bodySequence,
          outcome: input.outcome,
          completedAt: input.completedAt,
        })
      : insertFailedTurnFact(heart, {
          bodySequence: input.bodySequence,
          outcome: input.outcome,
          completedAt: input.completedAt,
        });
    return { sequence, ...input };
  });
}

export function finishBodyIfIdle(paths: AkumaPaths, input: Readonly<{ sequence: number; at: string }>):
Readonly<{ kind: "finished" } | { kind: "pending"; tells: readonly string[] }> {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      const pending = pendingTellFacts(heart);
      if (pending.length > 0) return { kind: "pending", tells: pending.map((tell) => tell.id) };
      finishBodyFact(heart, input);
      return { kind: "finished" };
    }));
}

export function readHeart(paths: AkumaPaths): HeartSnapshot {
  if (!existsSync(paths.heart)) {
    return { soul: null, latestBody: null, latestSession: null, pending: [], latestKill: null };
  }
  return withHeart(paths, (heart) => ({
      soul: soulFact(heart),
      latestBody: latestBodyFact(heart),
      latestSession: latestSessionFact(heart),
      pending: pendingTellFacts(heart),
      latestKill: latestKillFact(heart),
  }));
}

export function readTurns(paths: AkumaPaths): readonly TurnFact[] {
  return withHeart(paths, historyFacts);
}

export function readLastAnsweredTurn(paths: AkumaPaths): TurnFact | null {
  return withHeart(paths, lastAnsweredTurnFact);
}

export function readCurrentTurn(paths: AkumaPaths): TurnFact | null {
  return withHeart(paths, latestTurnFact);
}

export function readForkPoint(
  paths: AkumaPaths,
  historyId: string,
): ForkPoint | null {
  if (!existsSync(paths.heart)) return null;
  return withHeart(paths, (heart) => {
    const turn = answeredTurnFact(heart, historyId);
    if (turn?.outcome.kind !== "answered") return null;
    const recipe = sessionFactForCoordinate(heart, turn.outcome.session);
    if (recipe === null) throw new Error(`Akuma fork point ${historyId} has no session recipe`);
    return {
      historyId: turn.outcome.historyId,
      session: turn.outcome.session,
      provider: recipe.provider,
      cwd: recipe.cwd,
      options: recipe.options,
    };
  });
}
