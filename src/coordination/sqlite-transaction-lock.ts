import { randomInt } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY = 5;
const INITIAL_RETRY_MS = 10;
const MAX_RETRY_MS = 100;

export type SqliteTransactionLockMode = "immediate" | "exclusive";

export class SqliteTransactionLockError extends Error {
  constructor(
    message: string,
    readonly reason: "timeout" | "invalid" | "open-failed" | "release-failed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteTransactionLockError";
  }
}

export type HeldSqliteTransactionLock = Readonly<{
  close(): void;
}>;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown };
  const message = String(value.message ?? "").toLowerCase();
  return (
    value.errcode === SQLITE_BUSY ||
    value.code === "ERR_SQLITE_BUSY" ||
    value.code === "ERR_SQLITE_LOCKED" ||
    message.includes("database is locked") ||
    message.includes("database is busy")
  );
}

function closeDatabase(database: DatabaseSync): unknown {
  let failure: unknown;
  try {
    database.exec("ROLLBACK");
  } catch (error) {
    failure = error;
  }
  try {
    database.close();
  } catch (error) {
    failure ??= error;
  }
  return failure;
}

async function openLock(path: string, mode: SqliteTransactionLockMode): Promise<HeldSqliteTransactionLock> {
  try {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new SqliteTransactionLockError(`SQLite lock is not a regular file: ${path}`, "invalid");
    }
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    if (error instanceof SqliteTransactionLockError) throw error;
    throw new SqliteTransactionLockError(`cannot prepare SQLite lock: ${detail(error)}`, "open-failed", {
      cause: error,
    });
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout=0");
    database.exec("PRAGMA journal_mode=DELETE");
    database.exec("CREATE TABLE IF NOT EXISTS lock_anchor (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))");
    database.exec(`BEGIN ${mode.toUpperCase()}`);
    database.prepare("SELECT singleton FROM lock_anchor LIMIT 1").get();
  } catch (error) {
    if (database) closeDatabase(database);
    if (isBusy(error)) throw error;
    throw new SqliteTransactionLockError(`cannot acquire SQLite lock: ${detail(error)}`, "open-failed", {
      cause: error,
    });
  }

  let closed = false;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      const failure = closeDatabase(database!);
      if (failure !== undefined) {
        throw new SqliteTransactionLockError(`cannot release SQLite lock: ${detail(failure)}`, "release-failed", {
          cause: failure,
        });
      }
    },
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function acquireSqliteTransactionLock(input: {
  path: string;
  mode: SqliteTransactionLockMode;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<HeldSqliteTransactionLock> {
  if (
    input.path.length === 0 ||
    (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0))
  ) {
    throw new SqliteTransactionLockError("SQLite lock path and timeout must be valid", "invalid");
  }
  const started = performance.now();
  let cap = INITIAL_RETRY_MS;
  for (;;) {
    input.signal?.throwIfAborted();
    try {
      return await openLock(input.path, input.mode);
    } catch (error) {
      if (!isBusy(error)) throw error;
      const elapsed = performance.now() - started;
      if (input.timeoutMs !== undefined && elapsed >= input.timeoutMs) {
        throw new SqliteTransactionLockError(
          `SQLite lock timed out after ${input.timeoutMs}ms: ${input.path}`,
          "timeout",
          { cause: error },
        );
      }
      const delay = randomInt(Math.ceil(cap / 2), cap + 1);
      const remaining = input.timeoutMs === undefined ? delay : Math.min(delay, input.timeoutMs - elapsed);
      await wait(Math.max(0, remaining), input.signal);
      cap = Math.min(MAX_RETRY_MS, cap * 2);
    }
  }
}

export async function tryAcquireSqliteTransactionLock(input: {
  path: string;
  mode: SqliteTransactionLockMode;
}): Promise<HeldSqliteTransactionLock | null> {
  if (input.path.length === 0) {
    throw new SqliteTransactionLockError("SQLite lock path must be valid", "invalid");
  }
  try {
    return await openLock(input.path, input.mode);
  } catch (error) {
    if (isBusy(error)) return null;
    throw error;
  }
}
