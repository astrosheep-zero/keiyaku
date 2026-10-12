import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fsPromises, { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { deferred as promiseBarrier } from "./support/process.js";
import { taskDocument, writeTaskAuthority } from "./support/task.js";
import { TaskAuthorityCorruptionError } from "../src/task/document.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { Tasks } from "../src/task/index.js";
import { nukeTask } from "../src/task/operations.js";
import { parseTaskId, type TaskId } from "../src/task/identity.js";
import { authorityPath, readBoard } from "../src/task/store.js";
import { World } from "../src/world.js";

test("complete Task reads bound in-flight I/O and retain canonical board and byte order", async (t) => {
  const root = await world();
  const ids = Array.from({ length: 24 }, (_, index) => `task/read-${String(index).padStart(2, "0")}` as TaskId);
  for (const id of [...ids].reverse()) writeTaskAuthority(root, taskDocument({ id, title: id }));
  const firstWave = promiseBarrier<void>();
  const released = promiseBarrier<void>();
  const originalRead = fsPromises.readFile;
  let active = 0, maximum = 0, started = 0, completed = 0;
  const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
    if (!String(args[0]).startsWith(join(root, ".keiyaku", "tasks"))) return originalRead(...args);
    active += 1;
    started += 1;
    maximum = Math.max(maximum, active);
    if (started === 8) firstWave.resolve();
    try {
      await released.promise;
      return await originalRead(...args);
    } finally {
      active -= 1;
      completed += 1;
    }
  });
  syncBuiltinESMExports();
  const pending = readBoard(root);
  try {
    await firstWave.promise;
    assert.equal(started, 8);
    assert.equal(active, 8);
    released.resolve();
    const snapshot = await pending;
    assert.equal(maximum, 8);
    assert.equal(completed, ids.length);
    assert.equal(active, 0);
    assert.deepEqual([...snapshot.board.tasks.keys()], ids);
    assert.deepEqual([...snapshot.bytes.keys()], ids);
    for (const id of ids) assert.deepEqual(snapshot.bytes.get(id), readFileSync(authorityPath(root, id)));
  } finally {
    released.resolve();
    await pending.catch(() => undefined);
    mock.mock.restore();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete Task reads drain before reporting the first canonical authority failure", async (t) => {
  for (const corrupt of [false, true]) {
    await t.test(corrupt ? "earlier corrupt Markdown" : "earlier I/O failure", async (t) => {
      const root = await world();
      const ids = Array.from({ length: 16 }, (_, index) => `task/failure-${String(index).padStart(2, "0")}` as TaskId);
      for (const id of ids) writeTaskAuthority(root, taskDocument({ id, title: id }));
      const first = authorityPath(root, ids[0]!);
      const later = authorityPath(root, ids[1]!);
      if (corrupt) writeFileSync(first, "not Task authority\n");
      const earlyError = new Error("earlier read failed");
      const laterError = new Error("later read failed");
      const released = promiseBarrier<void>();
      const othersFinished = promiseBarrier<void>();
      const originalRead = fsPromises.readFile;
      let completed = 0, settled = false;
      const mock = t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof readFile>) => {
        const path = String(args[0]);
        if (!path.startsWith(join(root, ".keiyaku", "tasks"))) return originalRead(...args);
        try {
          if (path === first) {
            await released.promise;
            if (!corrupt) throw earlyError;
          }
          if (path === later) throw laterError;
          return await originalRead(...args);
        } finally {
          completed += 1;
          if (completed === ids.length - 1) othersFinished.resolve();
        }
      });
      syncBuiltinESMExports();
      const pending = readBoard(root).then(
        () => { settled = true; assert.fail("expected authority failure"); },
        (error: unknown) => { settled = true; return error; },
      );
      try {
        await othersFinished.promise;
        assert.equal(settled, false);
        released.resolve();
        const error = await pending;
        assert.equal(completed, ids.length);
        if (corrupt) {
          assert.ok(error instanceof TaskAuthorityCorruptionError);
          assert.equal(error.message, "task document must begin with YAML front matter");
        } else assert.equal(error, earlyError);
      } finally {
        released.resolve();
        await pending;
        mock.mock.restore();
        syncBuiltinESMExports();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

async function world() {
  return await World.at(mkdtempSync(join(tmpdir(), "keiyaku-v4-task-store-")));
}

test("Task nuke lock contention is busy and does not delete unlocked files", async () => {
  const root = await world();
  try {
    const tasks = Tasks.of(root);
    const locked = await tasks.add({ title: "Keep locked" });
    const otherTask = await tasks.add({ title: "Also owned" });
    assert.equal(locked.kind, "accepted");
    assert.equal(otherTask.kind, "accepted");
    if (locked.kind !== "accepted" || otherTask.kind !== "accepted") return;
    const owned = authorityPath(root, locked.value.id);
    const other = authorityPath(root, otherTask.value.id);
    const foreign = join(root, ".keiyaku", "tasks", "Not-Valid.md");
    writeFileSync(foreign, "invalid coordinate\n");
    const ownedBytes = readFileSync(owned);
    const otherBytes = readFileSync(other);
    const held = await acquireSqliteTransactionLock({
      path: join(root, ".keiyaku", "locks", "task", `${parseTaskId(locked.value.id).localId}.sqlite`),
      mode: "immediate",
      timeoutMs: 100,
    });
    try {
      await assert.rejects(nukeTask(root, { timeoutMs: 25 }), /Task reset lock contention/u);
      assert.deepEqual(readFileSync(owned), ownedBytes);
      assert.deepEqual(readFileSync(other), otherBytes);
      assert.equal(readFileSync(foreign, "utf8"), "invalid coordinate\n");
    } finally {
      held.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task nuke re-enumerates after the allocation lock so a Task created while waiting is removed", async () => {
  const root = await world();
  try {
    const tasks = Tasks.of(root);
    const ownedTask = await tasks.add({ title: "Already owned" });
    assert.ok(ownedTask.kind === "accepted", "expected ownedTask.kind = \"accepted\"");
    const existing = authorityPath(root, ownedTask.value.id);
    const created = join(root, ".keiyaku", "tasks", "created-while-waiting.md");
    const held = await acquireSqliteTransactionLock({
      path: join(root, ".keiyaku", "locks", "task-allocation.sqlite"),
      mode: "immediate",
      timeoutMs: 100,
    });
    const pending = nukeTask(root, { timeoutMs: 1000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(created, "not Task authority\n");
    } finally {
      held.close();
    }
    await pending;
    assert.equal(existsSync(existing), false);
    assert.equal(existsSync(created), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task nuke removes empty nested Task directories when there are no owned files", async () => {
  const root = await world();
  try {
    const tasks = join(root, ".keiyaku", "tasks");
    mkdirSync(join(tasks, "nested", "deeper"), { recursive: true });
    await nukeTask(root);
    assert.equal(existsSync(join(tasks, "nested", "deeper")), false);
    assert.equal(existsSync(join(tasks, "nested")), false);
    assert.equal(existsSync(tasks), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested Task authority remains discoverable after a fresh World observation", async () => {
  const root = await world();
  try {
    const first = Tasks.of(root);
    const added = await first.add({ title: "Nested durable", namespace: ["deep", "inside"] });
    assert.ok(added.kind === "accepted", "expected added.kind = \"accepted\"");

    const second = Tasks.of(await World.at(root));
    const read = await second.task({ id: added.value.id }).read();
    assert.equal(read?.task.title, "Nested durable");
    const listed = await second.list({ namespace: ["deep", "inside"] });
    assert.equal(listed.kind, "accepted");
    if (listed.kind === "accepted")
      assert.deepEqual(
        listed.value.rows.map((row) => row.id),
        [added.value.id],
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
