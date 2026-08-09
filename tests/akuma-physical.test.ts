import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

test("a detached orphan process group remains reachable by its leader", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-tree-"));
  const coordinates = join(root, "coordinates.json");
  const body = [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    "const provider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });",
    "writeFileSync(process.argv[1], JSON.stringify({ body: process.pid, provider: provider.pid }));",
    "setInterval(() => {}, 1_000);",
  ].join(" ");
  const launcher = [
    'import { spawn } from "node:child_process";',
    "const child = spawn(process.execPath, ['--input-type=module', '-e', process.argv[1], process.argv[2]], { detached: true, stdio: 'ignore' });",
    "child.unref();",
  ].join(" ");
  let bodyPid: number | undefined;
  let providerPid: number | undefined;
  try {
    const caller = spawn(process.execPath, ["--input-type=module", "-e", launcher, body, coordinates], {
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      caller.once("error", reject);
      caller.once("exit", () => resolve());
    });
    const deadline = performance.now() + 2_000;
    while (!existsSync(coordinates)) {
      if (performance.now() >= deadline) throw new Error("detached body did not publish coordinates");
      await wait(20);
    }
    ({ body: bodyPid, provider: providerPid } = JSON.parse(readFileSync(coordinates, "utf8")) as {
      body: number;
      provider: number;
    });
    const processGroup = (pid: number): number => Number(execFileSync(
      "ps",
      ["-o", "pgid=", "-p", String(pid)],
      { encoding: "utf8" },
    ).trim());
    assert.equal(processGroup(bodyPid), bodyPid);
    assert.equal(processGroup(providerPid), bodyPid);

    process.kill(-bodyPid, "SIGKILL");
    const stopped = (pid: number): boolean => {
      try {
        const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
        return state === "" || state.startsWith("Z");
      } catch {
        return true;
      }
    };
    const stopDeadline = performance.now() + 2_000;
    while (!stopped(bodyPid) || !stopped(providerPid)) {
      if (performance.now() >= stopDeadline) throw new Error("detached process group survived SIGKILL");
      await wait(20);
    }
  } finally {
    if (bodyPid !== undefined) {
      try { process.kill(-bodyPid, "SIGKILL"); } catch { /* already gone */ }
    }
    if (providerPid !== undefined) {
      try { process.kill(providerPid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
