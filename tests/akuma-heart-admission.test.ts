import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { bornBody, heartFixture } from "./support/akuma-fixtures.js";
import { withReadOnlyHeart } from "../src/akuma/heart/storage.js";
import { activitySlice, appendActivity, beginTurn } from "../src/akuma/heart/index.js";
import { projectTurns } from "../src/akuma/projection.js";
import type { AgentEvent } from "../src/akuma/provider.js";

async function fixture() {
  const { allocated, close } = await heartFixture("keiyaku-heart-admission-");
  return { paths: allocated.paths, close };
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

test("Heart retains observed tool output and per-change patches beside rows written without them", async () => {
  const value = await heartFixture("keiyaku-heart-observed-output-");
  const { allocated, holder, body } = await bornBody(value.root, "c0ffee01", "2026-08-08T00:00:00.000Z");
  try {
    const turn = await beginTurn(allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const patch = ["@@ -1 +1 @@", "-before", "+after"].join("\n");
    const observed: AgentEvent = {
      type: "tool",
      phase: "completed",
      id: "edit-1",
      name: "edit",
      call: {
        kind: "fileChange",
        changes: [{ op: "update", path: "src/edited.ts", diffstat: { added: 1, removed: 1 }, patch }],
      },
      result: { status: "ok", output: "edited src/edited.ts" },
    };
    const legacy: AgentEvent = {
      type: "tool",
      phase: "completed",
      id: "read-1",
      name: "read",
      call: { kind: "read", path: "src/read.ts" },
      result: { status: "ok" },
    };
    await appendActivity(allocated.paths, { turnSequence: turn.sequence, event: observed, at: "2026-08-08T00:00:01.000Z" });
    await appendActivity(allocated.paths, { turnSequence: turn.sequence, event: legacy, at: "2026-08-08T00:00:02.000Z" });

    const slice = await activitySlice(allocated.paths);
    assert.deepEqual(
      slice.rows.flatMap((row) => (row.kind === "activity" ? [row.event] : [])),
      [observed, legacy],
      "both rows survive the durable write and read unchanged",
    );
    const ledger = projectTurns(slice.rows, {
      lowestRetained: slice.lowestRetained,
      highest: slice.highest,
    });
    const toolRows = ledger.rows.filter((row) => row.kind === "tool");
    assert.deepEqual(toolRows.map((row) => row.call), [observed.call, legacy.call]);
    assert.deepEqual(toolRows.map((row) => (row.state === "active" || row.state === "unsettled" ? null : row.state)), [
      { status: "ok", output: "edited src/edited.ts" },
      { status: "ok" },
    ]);
  } finally {
    holder.release();
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
