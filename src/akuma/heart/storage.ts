import { DatabaseSync } from "node:sqlite";
import type { AkumaPaths } from "../identity.js";
import type { LeashProbe, SessionFact, Soul, StopFact, TellFact } from "./facts.js";
import { HEART_SCHEMA, LEASH_SCHEMA, assertHeartSchemaVersion, assertLeashSchemaVersion } from "./schema.js";
import {
  deletePauseControl,
  deleteStopControl,
  insertKillFact,
  insertSealFact,
  insertSessionFact,
  insertSoulFact,
  killFactForBody,
  latestBodyFact,
  latestKillFact,
  sealExists,
  sealFact,
  soulFact,
  stopFact,
} from "./rows.js";
import { insertTellFact } from "./tells.js";
import { pruneActivityFacts } from "./timeline.js";

const ACTIVITY_LIMIT = 5_000;

function isBusy(error: unknown): boolean {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown };
  const message = String(value?.message ?? "").toLowerCase();
  return value?.code === "ERR_SQLITE_BUSY" || value?.code === "ERR_SQLITE_LOCKED"
    || value?.errcode === 5 || message.includes("database is locked") || message.includes("database is busy");
}

export function openHeart(path: string, verify = true): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
  if (verify) assertHeartSchemaVersion(database);
  return database;
}

export function withHeart<T>(paths: AkumaPaths, body: (database: DatabaseSync) => T): T {
  const database = openHeart(paths.heart);
  try { return body(database); } finally { database.close(); }
}

export function transaction<T>(database: DatabaseSync, body: () => T): T {
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

  birth(paths: AkumaPaths, soul: Soul, session?: Omit<SessionFact, "sequence">): "born" | "already-born" | "sealed" {
    if (sealExists(this.database)) return "sealed";
    return withHeart(paths, (heart) => transaction(heart, () => {
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

  settleStop(paths: AkumaPaths, expectedBodySequence?: number): Readonly<{ target: StopFact; result: "recorded" | "already-killed" }> | null {
    return withHeart(paths, (heart) => transaction(heart, () => {
      const target = stopFact(heart);
      if (target === null) {
        if (expectedBodySequence === undefined) return null;
        const existing = killFactForBody(heart, expectedBodySequence);
        return existing === null ? null : { target: { bodySequence: expectedBodySequence, requestedAt: existing.at }, result: "already-killed" };
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

  recordInterruptTell(paths: AkumaPaths, tell: Omit<TellFact, "sequence" | "state" | "deliveries">): Readonly<{ kind: "not-born" } | { kind: "recorded"; tell: TellFact }> {
    return withHeart(paths, (heart) => transaction(heart, () => {
      deletePauseControl(heart);
      if (soulFact(heart) === null) return { kind: "not-born" };
      const sequence = insertTellFact(heart, tell);
      pruneActivityFacts(heart, ACTIVITY_LIMIT);
      return { kind: "recorded", tell: { sequence, ...tell, state: "pending", deliveries: [] } };
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

export function readSealFromLeash(paths: AkumaPaths): ReturnType<typeof sealFact> {
  const leash = new DatabaseSync(paths.leash);
  try {
    assertLeashSchemaVersion(leash);
    return sealFact(leash);
  } finally { leash.close(); }
}
