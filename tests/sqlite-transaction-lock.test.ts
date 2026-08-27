import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
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

test("process death releases the SQLite transaction", async () => {
  const path = lockPath();
  const source = [
    'import { DatabaseSync } from "node:sqlite";',
    "const database = new DatabaseSync(process.argv[1]);",
    'database.exec("PRAGMA journal_mode=DELETE");',
    'database.exec("CREATE TABLE IF NOT EXISTS lock_anchor (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))");',
    'database.exec("BEGIN IMMEDIATE");',
    'database.prepare("SELECT singleton FROM lock_anchor LIMIT 1").get();',
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, path], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", (bytes) =>
      bytes.toString().includes("ready") ? resolve() : reject(new Error("child did not acquire lock")),
    );
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const acquired = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 500 });
  acquired.close();
});
