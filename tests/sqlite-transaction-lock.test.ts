import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireSqliteTransactionLock,
  SqliteTransactionLockError,
} from "../src/coordination/sqlite-transaction-lock.js";

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "keiyaku-lock-")), "lock.sqlite");
}

test("SQLite transaction handles close idempotently and can be reacquired", async () => {
  const path = lockPath(),
    first = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  first.close();
  first.close();
  const second = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  second.close();
});

test("SQLite transaction lock classifies timeout and propagates cancellation", async () => {
  const path = lockPath(),
    held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  try {
    await assert.rejects(
      acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 30 }),
      (error: unknown) => error instanceof SqliteTransactionLockError && error.reason === "timeout",
    );
    const controller = new AbortController();
    const pending = acquireSqliteTransactionLock({
      path,
      mode: "immediate",
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/u);
  } finally {
    held.close();
  }
});
