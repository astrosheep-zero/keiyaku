import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("SQLite releases an exclusive leash when its holder is killed", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-leash-"));
  const path = join(root, "leash.db");
  const source = [
    'import { DatabaseSync } from "node:sqlite";',
    "const db = new DatabaseSync(process.argv[1]);",
    "db.exec('CREATE TABLE IF NOT EXISTS leash (singleton INTEGER PRIMARY KEY) STRICT');",
    "db.exec('BEGIN EXCLUSIVE');",
    "process.stdout.write('ready\\n');",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", source, path], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", () => resolve());
    });
    const blocked = new DatabaseSync(path, { timeout: 0 });
    assert.throws(() => blocked.exec("BEGIN EXCLUSIVE"), /database is locked/);
    blocked.close();

    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    const successor = new DatabaseSync(path, { timeout: 0 });
    successor.exec("BEGIN EXCLUSIVE");
    successor.exec("ROLLBACK");
    successor.close();
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
