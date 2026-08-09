import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AkumaPaths } from "../identity.js";
import type {
  AkuId,
  BodyEnd,
  BodyFact,
  Collar,
  DeathFact,
  ForkPoint,
  HeartSnapshot,
  LeashProbe,
  RequestFact,
  RequestInput,
  SealFact,
  SessionFact,
  Soul,
  TellFact,
  TellState,
  TurnFact,
} from "./facts.js";
import {
  HEART_SCHEMA,
  LEASH_SCHEMA,
  assertHeartSchemaVersion,
  assertLeashSchemaVersion,
} from "./schema.js";
import {
  activityFactsAfter,
  answeredTurnFact,
  deathExists,
  deathFact,
  deleteAbandonedControls,
  deletePauseControl,
  endBodyFact,
  finishBodyFact,
  historyFacts,
  insertActivityFact,
  insertAnsweredTurnFact,
  insertBodyFact,
  insertDeathFact,
  insertFailedTurnFact,
  insertPauseControl,
  insertRequestFact,
  insertSealFact,
  insertSessionFact,
  insertSoulFact,
  insertStopControl,
  insertTellFact,
  latestBodyFact,
  latestSessionFact,
  latestTurnFact,
  nonterminalRequestFacts,
  pauseExists,
  pendingTellFacts,
  pruneActivityFacts,
  requestFact,
  sealExists,
  sealFact,
  sessionFactForCoordinate,
  soulFact,
  stopExists,
  tellState,
  updateRequestRefused,
  updateRequestReserved,
  updateRequestServed,
  updateRequestVoided,
  updateTellState,
  voidRequestsByDeath,
  voidTellsByDeath,
} from "./rows.js";

export { life } from "./facts.js";
export type {
  AkuId,
  AkumaLife,
  AkumaOrigin,
  BodyEnd,
  BodyFact,
  Collar,
  CollarProbe,
  Confinement,
  DeathFact,
  HeartSnapshot,
  ForkPoint,
  KillEvidence,
  LeashProbe,
  ProviderOptions,
  RequestFact,
  RequestInput,
  ResumeCoordinate,
  SealFact,
  SessionFact,
  Soul,
  TellFact,
  TellState,
  TurnFact,
  TurnOutcome,
} from "./facts.js";

const ACTIVITY_LIMIT = 200;

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

export function appendActivity(paths: AkumaPaths, input: Readonly<{ event: unknown; at: string }>): number {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      const sequence = insertActivityFact(heart, input);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
      return sequence;
    }));
}

export function activityAfter(paths: AkumaPaths, sequence: number): readonly Readonly<{ sequence: number; event: unknown; at: string }>[] {
  return withHeart(paths, (heart) => activityFactsAfter(heart, sequence));
}

export function recordTell(paths: AkumaPaths, tell: Omit<TellFact, "state">): "recorded" | "dead" {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (deathExists(heart)) return "dead";
      insertTellFact(heart, tell);
      return "recorded";
    }));
}

const TELL_ORDER: Readonly<Record<TellState, number>> = {
  recorded: 0,
  delivered: 1,
  seen: 2,
  consumed: 3,
  "voided-by-death": 3,
};

export function advanceTell(paths: AkumaPaths, id: string, state: Exclude<TellState, "recorded" | "voided-by-death">): void {
  withHeart(paths, (heart) =>
    transaction(heart, () => {
      const current = tellState(heart, id);
      if (current === null) throw new Error(`unknown tell ${id}`);
      if (TELL_ORDER[state] < TELL_ORDER[current] || current === "voided-by-death") return;
      updateTellState(heart, id, state);
    }));
}

function sameRequestInput(fact: RequestFact, input: RequestInput): boolean {
  return fact.id === input.id
    && fact.persona === input.persona
    && fact.body === input.body
    && fact.cwd === input.cwd
    && fact.world === input.world;
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

export function requestStop(paths: AkumaPaths, at: string): "requested" | "dead" {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (deathExists(heart)) return "dead";
      insertStopControl(heart, at);
      return "requested";
    }));
}

export function requestPause(paths: AkumaPaths, at: string): "requested" | "dead" {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (deathExists(heart)) return "dead";
      insertPauseControl(heart, at);
      return "requested";
    }));
}

export function stopRequested(paths: AkumaPaths): boolean { return withHeart(paths, stopExists); }

export function pauseRequested(paths: AkumaPaths): boolean { return withHeart(paths, pauseExists); }

export function clearAbandonedControl(paths: AkumaPaths): void {
  // A control row without settlement belongs to a vanished caller; the next leash holder revokes it.
  withHeart(paths, deleteAbandonedControls);
}

export function recordDeath(paths: AkumaPaths, death: DeathFact): "recorded" | "already-dead" {
  return withHeart(paths, (heart) =>
    transaction(heart, () => {
      if (deathExists(heart)) return "already-dead";
      insertDeathFact(heart, death);
      voidTellsByDeath(heart);
      voidRequestsByDeath(heart, `death:${death.evidence}`);
      return "recorded";
    }));
}

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
    return { soul: null, latestBody: null, latestSession: null, pending: [], death: null };
  }
  return withHeart(paths, (heart) => ({
      soul: soulFact(heart),
      latestBody: latestBodyFact(heart),
      latestSession: latestSessionFact(heart),
      pending: pendingTellFacts(heart),
      death: deathFact(heart),
  }));
}

export function readHistory(paths: AkumaPaths): readonly TurnFact[] {
  return withHeart(paths, historyFacts);
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
