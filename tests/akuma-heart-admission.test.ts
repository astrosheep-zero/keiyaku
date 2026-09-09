import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { initializeHeart, withReadOnlyHeart } from "../src/akuma/heart/storage.js";
import { World } from "../src/world.js";

async function fixture() {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-heart-admission-")));
  const { paths } = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
  await initializeHeart(paths);
  return { paths, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("Heart read admission yields through an exclusive WAL reader lock and executes once", async () => {
  const value = await fixture();
  const blocker = new DatabaseSync(value.paths.heart);
  let calls = 0;
  try {
    blocker.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    const expected = blocker.prepare("SELECT version FROM akuma_schema").get();
    let settled = false;
    const reading = withReadOnlyHeart(value.paths, (database) => {
      calls += 1;
      return database.prepare("SELECT version FROM akuma_schema").get();
    }).then(
      (result) => {
        settled = true;
        return { result };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    await delay(20);
    assert.equal(calls, 0);
    assert.equal(settled, false, "read admission must wait asynchronously, not fail or block the timer");
    blocker.close();
    assert.deepEqual(await reading, { result: expected });
    assert.equal(calls, 1);
  } finally {
    if (blocker.isOpen) blocker.close();
    value.close();
  }
});

test("cancelled Heart read admission never enters the callback", async () => {
  const value = await fixture();
  const blocker = new DatabaseSync(value.paths.heart);
  const controller = new AbortController();
  const reason = new Error("read caller cancelled");
  let calls = 0;
  try {
    blocker.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    blocker.prepare("SELECT version FROM akuma_schema").get();
    const reading = withReadOnlyHeart(
      value.paths,
      () => {
        calls += 1;
      },
      controller.signal,
    );
    const rejected = assert.rejects(reading, (error) => error === reason);
    await delay(20);
    controller.abort(reason);
    await rejected;
    assert.equal(calls, 0);
  } finally {
    blocker.close();
    value.close();
  }
});

test("Heart read callback and commit failures are not retried after snapshot admission", async (context) => {
  const value = await fixture();
  const busy = Object.assign(new Error("post-admission busy"), { errcode: 5 });
  const exec = DatabaseSync.prototype.exec;
  let begins = 0;
  let calls = 0;
  let failCommit = false;
  context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "BEGIN DEFERRED") begins += 1;
    if (sql === "COMMIT" && failCommit) throw busy;
    return exec.call(this, sql);
  });
  try {
    await assert.rejects(
      withReadOnlyHeart(value.paths, () => {
        calls += 1;
        throw busy;
      }),
      (error) => error === busy,
    );
    assert.equal(begins, 1);
    assert.equal(calls, 1);
    failCommit = true;
    await assert.rejects(
      withReadOnlyHeart(value.paths, () => {
        calls += 1;
      }),
      (error) => error === busy,
    );
    assert.equal(begins, 2);
    assert.equal(calls, 2);
    failCommit = false;
    await withReadOnlyHeart(value.paths, () => {
      calls += 1;
    });
    assert.equal(begins, 3);
    assert.equal(calls, 3);
  } finally {
    value.close();
  }
});
