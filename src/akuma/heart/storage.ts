import { DatabaseSync } from "node:sqlite";
import { watch as watchDirectory } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { AkumaPaths } from "../identity.js";
import type { BodyFact, LeashProbe, SessionFact, Soul, StopFact, TellFact } from "./facts.js";
import {
  HEART_SCHEMA,
  LEASH_SCHEMA,
  assertHeartSchemaVersion,
  assertLeashSchemaVersion,
  heartSchemaIsCurrent,
} from "./schema.js";
import {
  deletePauseControl,
  deleteStopControl,
  insertBodyFact,
  insertKillFact,
  insertSealFact,
  insertSessionFact,
  killFactForBody,
  latestBodyFact,
  latestKillFact,
  markBodyHung,
  sealExists,
  sealFact,
  stopFact,
} from "./rows.js";
import { insertTellFact } from "./tells.js";
import { pruneActivityFacts } from "./timeline.js";
import { insertSoulFact, soulFact } from "./soul.js";

const ACTIVITY_LIMIT = 5_000;
const SQLITE_CANTOPEN = 14;

export async function watchHeart(paths: AkumaPaths, signal: AbortSignal): Promise<AsyncGenerator<void>> {
  const heart = basename(paths.heart);
  let changed = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  // fs.watch opens the directory synchronously. Its throw is therefore the
  // observer's ready/failure boundary, before a waker can spawn a child.
  const watcher = watchDirectory(dirname(paths.heart), { signal }, (_event, filename) => {
    const name = filename?.toString();
    if (name === undefined || name === heart || name === `${heart}-wal`) {
      changed = true;
      wake?.();
    }
  });
  watcher.on("error", (error) => {
    failure = error;
    wake?.();
  });
  const abort = (): void => {
    wake?.();
    watcher.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  return (async function* (): AsyncGenerator<void> {
    try {
      for (;;) {
        if (changed) {
          changed = false;
          yield;
          continue;
        }
        if (failure !== undefined) throw failure;
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } catch (error) {
      if (signal.aborted && (error as NodeJS.ErrnoException).name === "AbortError") return;
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      watcher.close();
    }
  })();
}

export class HeartAbsentError extends Error {
  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`Akuma Heart database is absent: ${path}`, options);
    this.name = "HeartAbsentError";
  }
}

export function isHeartAbsent(error: unknown): error is HeartAbsentError {
  return error instanceof HeartAbsentError;
}

function isBusy(error: unknown): boolean {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown };
  const message = String(value?.message ?? "").toLowerCase();
  return (
    value?.code === "ERR_SQLITE_BUSY" ||
    value?.code === "ERR_SQLITE_LOCKED" ||
    value?.errcode === 5 ||
    message.includes("database is locked") ||
    message.includes("database is busy")
  );
}

async function openExistingDatabase(path: string, timeout?: number, mode: "rw" | "ro" = "rw"): Promise<DatabaseSync> {
  const uri = pathToFileURL(path);
  uri.searchParams.set("mode", mode);
  try {
    return timeout === undefined ? new DatabaseSync(uri.href) : new DatabaseSync(uri.href, { timeout });
  } catch (error) {
    if ((error as { errcode?: unknown }).errcode === SQLITE_CANTOPEN) {
      try {
        await lstat(path);
      } catch (metadataError) {
        if ((metadataError as NodeJS.ErrnoException).code === "ENOENT") {
          throw new HeartAbsentError(path, { cause: error });
        }
      }
    }
    throw error;
  }
}

async function openHeart(path: string, verify = true): Promise<DatabaseSync> {
  const database = await openExistingDatabase(path);
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
    if (verify) assertHeartSchemaVersion(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function openHeartReadOnly(path: string, verify = true): Promise<DatabaseSync> {
  const database = await openExistingDatabase(path, undefined, "ro");
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    if (verify) assertHeartSchemaVersion(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function classifyHeartSchema(paths: AkumaPaths): Promise<"current" | "unsupported"> {
  let database: DatabaseSync;
  try {
    database = await openExistingDatabase(paths.heart);
  } catch (error) {
    if (isHeartAbsent(error)) return "unsupported";
    throw error;
  }
  try {
    return heartSchemaIsCurrent(database) ? "current" : "unsupported";
  } finally {
    database.close();
  }
}

export async function withHeart<T>(paths: AkumaPaths, body: (database: DatabaseSync) => T): Promise<T> {
  const database = await openHeart(paths.heart);
  try {
    return body(database);
  } finally {
    database.close();
  }
}

export async function withReadOnlyHeart<T>(paths: AkumaPaths, body: (database: DatabaseSync) => T): Promise<T> {
  const database = await openHeartReadOnly(paths.heart);
  try {
    return body(database);
  } finally {
    database.close();
  }
}

export function transaction<T>(database: DatabaseSync, body: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* preserve the adjudication failure */
    }
    throw error;
  }
}

export function readTransaction<T>(database: DatabaseSync, body: () => T): T {
  database.exec("BEGIN DEFERRED");
  try {
    const result = body();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* preserve the original failure */
    }
    throw error;
  }
}

export async function initializeHeart(paths: AkumaPaths): Promise<void> {
  const heart = new DatabaseSync(paths.heart);
  try {
    heart.exec(HEART_SCHEMA);
    assertHeartSchemaVersion(heart);
  } finally {
    heart.close();
  }
  const leash = new DatabaseSync(paths.leash);
  try {
    leash.exec(LEASH_SCHEMA);
    assertLeashSchemaVersion(leash);
  } finally {
    leash.close();
  }
}

export class HeldAkumaLeash {
  private closed = false;
  private bodySequence: number | undefined;

  private constructor(private readonly database: DatabaseSync) {}

  static async try(paths: AkumaPaths): Promise<HeldAkumaLeash | null> {
    const database = await openExistingDatabase(paths.leash, 0);
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

  async birth(
    paths: AkumaPaths,
    soul: Soul,
    session?: Omit<SessionFact, "sequence">,
  ): Promise<"born" | "already-born" | "sealed"> {
    if (sealExists(this.database)) return "sealed";
    return await withHeart(paths, (heart) =>
      transaction(heart, () => {
        if (soulFact(heart) !== null) return "already-born";
        insertSoulFact(heart, soul);
        if (session !== undefined) insertSessionFact(heart, session);
        return "born";
      }),
    );
  }

  async sealIfUnborn(paths: AkumaPaths, input: Readonly<{ evidence: string; at: string }>): Promise<"born" | "sealed"> {
    if (sealExists(this.database)) return "sealed";
    if ((await withHeart(paths, (heart) => soulFact(heart))) !== null) return "born";
    insertSealFact(this.database, input);
    this.database.exec("COMMIT");
    this.closed = true;
    this.database.close();
    return "sealed";
  }

  readSeal(): ReturnType<typeof sealFact> {
    return sealFact(this.database);
  }

  async clearPause(paths: AkumaPaths): Promise<void> {
    await withHeart(paths, deletePauseControl);
  }
  async clearStop(paths: AkumaPaths): Promise<void> {
    await withHeart(paths, deleteStopControl);
  }

  async recordBody(paths: AkumaPaths, input: Readonly<{ leashTakenAt: string }>): Promise<BodyFact> {
    if (this.closed || this.bodySequence !== undefined) throw new Error("Akuma leash cannot start another Body");
    const sequence = await withHeart(paths, (heart) => insertBodyFact(heart, input));
    this.bodySequence = sequence;
    return { sequence, leashTakenAt: input.leashTakenAt };
  }

  async recordBodyHung(
    paths: AkumaPaths,
    input: Readonly<{ sequence: number; diagnostic: string; at: string }>,
  ): Promise<void> {
    if (this.closed || this.bodySequence !== input.sequence) {
      throw new Error(`Akuma Body ${input.sequence} is not owned by this leash`);
    }
    await withHeart(paths, (heart) => markBodyHung(heart, input));
  }

  async settleStop(
    paths: AkumaPaths,
    expectedBodySequence?: number,
  ): Promise<Readonly<{ target: StopFact; result: "recorded" | "already-killed" }> | null> {
    return await withHeart(paths, (heart) =>
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
        if (latest.end !== "put-down") return null;
        const result =
          latestKillFact(heart)?.bodySequence === target.bodySequence
            ? ("already-killed" as const)
            : (insertKillFact(heart, target.bodySequence, target.requestedAt), "recorded" as const);
        deleteStopControl(heart);
        return { target, result };
      }),
    );
  }

  async recordInterruptTell(
    paths: AkumaPaths,
    tell: Omit<TellFact, "sequence" | "state" | "deliveries">,
  ): Promise<Readonly<{ kind: "not-born" } | { kind: "recorded"; tell: TellFact }>> {
    return await withHeart(paths, (heart) =>
      transaction(heart, () => {
        deletePauseControl(heart);
        if (soulFact(heart) === null) return { kind: "not-born" };
        const sequence = insertTellFact(heart, tell);
        pruneActivityFacts(heart, ACTIVITY_LIMIT);
        return { kind: "recorded", tell: { sequence, ...tell, state: "pending", deliveries: [] } };
      }),
    );
  }

  release(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.exec("ROLLBACK");
    } finally {
      this.database.close();
    }
  }
}

export async function probeLeash(paths: AkumaPaths): Promise<LeashProbe> {
  const claim = await HeldAkumaLeash.try(paths);
  if (claim === null) return "held";
  claim.release();
  return "free";
}

export async function readSealFromLeash(paths: AkumaPaths): Promise<ReturnType<typeof sealFact>> {
  const leash = await openExistingDatabase(paths.leash);
  try {
    assertLeashSchemaVersion(leash);
    return sealFact(leash);
  } finally {
    leash.close();
  }
}
