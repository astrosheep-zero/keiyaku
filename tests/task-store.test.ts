import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { Tasks } from "../src/task/index.js";
import { nukeTask } from "../src/task/operations.js";
import { parseTaskId } from "../src/task/identity.js";
import { authorityPath } from "../src/task/store.js";
import { World } from "../src/world.js";

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
    assert.equal(ownedTask.kind, "accepted");
    if (ownedTask.kind !== "accepted") return;
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
    assert.equal(added.kind, "accepted");
    if (added.kind !== "accepted") return;

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
