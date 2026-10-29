import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { bornBody, heartFixture } from "./support/akuma-fixtures.js";
import { withReadOnlyHeart } from "../src/akuma/heart/storage.js";
import {
  activitySlice, appendActivity, beginTurn, bindTellsToTurn, cancelBodyTurns, endTurn, HeldAkumaLeash,
  readHeart, readTurn, recordTell, recordTellDeliveries,
} from "../src/akuma/heart/index.js";
import { projectTurns } from "../src/akuma/projection.js";
import type { AgentEvent } from "../src/akuma/provider.js";

async function fixture() {
  const { allocated, close } = await heartFixture("keiyaku-heart-admission-");
  return { paths: allocated.paths, close };
}

test("controlled cancellation atomically closes all exact-Body open Turns and preserves winners and inputs", async (context) => {
  const value = await heartFixture("keiyaku-heart-cancel-");
  const { allocated, holder, body } = await bornBody(value.root, "ca1ce101", "2026-08-08T00:00:00.000Z");
  const paths = allocated.paths;
  const at = "2026-08-08T00:00:01.000Z";
  try {
    const unbound = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at, call: "direct call" });
    const bound = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    const answered = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    const failed = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    await recordTell(paths, { kind: "tell", id: "pending", body: "retain", recordedAt: at });
    await bindTellsToTurn(paths, { turnSequence: bound.sequence, tellIds: ["pending"], boundAt: at });
    await recordTellDeliveries(paths, [{ tellId: "pending", turnSequence: bound.sequence, route: "live", receipt: "required", fence: "pending", deliveredAt: at }]);
    await endTurn(paths, { turnSequence: answered.sequence, outcome: { kind: "answered", answer: "won", session: { sessionId: "native" } }, completedAt: at });
    await endTurn(paths, { turnSequence: failed.sequence, outcome: { kind: "failed", diagnostic: "real failure" }, completedAt: at });
    const before = await activitySlice(paths);
    const exec = DatabaseSync.prototype.prepare;
    const broken = context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.includes("outcome = 'canceled'")) throw new Error("cancellation write failed");
      return exec.call(this, sql);
    });
    await assert.rejects(cancelBodyTurns(paths, { bodySequence: body.sequence, at }), /cancellation write failed/u);
    broken.mock.restore();
    assert.equal((await readHeart(paths)).latestBody?.end, undefined);
    assert.deepEqual(await activitySlice(paths), before, "failed terminalization leaves neither Body end nor stray timeline row");
    assert.deepEqual(await cancelBodyTurns(paths, { bodySequence: body.sequence, at }), { canceled: [unbound.sequence, bound.sequence], disposition: null });
    assert.deepEqual((await readTurn(paths, unbound.sequence))?.end?.outcome, { kind: "canceled" });
    assert.equal((await readTurn(paths, answered.sequence))?.end?.outcome.kind, "answered");
    assert.deepEqual((await readTurn(paths, failed.sequence))?.end?.outcome, { kind: "failed", diagnostic: "real failure" });
    assert.deepEqual((await readHeart(paths)).pending.map((tell) => tell.id), ["pending"]);
    assert.deepEqual(await cancelBodyTurns(paths, { bodySequence: body.sequence, at }), { canceled: [], disposition: null }, "retry invents no second terminal");
    holder.release();
    const nextHolder = (await HeldAkumaLeash.try(paths))!;
    try {
      const nextBody = await nextHolder.recordBody(paths, { leashTakenAt: at });
      const nextTurn = await beginTurn(paths, { bodySequence: nextBody.sequence, startedAt: at });
      await assert.rejects(cancelBodyTurns(paths, { bodySequence: body.sequence, at }), /cannot settle/u);
      assert.equal((await readTurn(paths, nextTurn.sequence))?.end, undefined, "old cancellation cannot touch successor work");
    } finally { nextHolder.release(); }
  } finally { holder.release(); value.close(); }
});

test("an answer committing at the stop boundary remains the single terminal winner", async () => {
  const value = await heartFixture("keiyaku-heart-answer-stop-race-");
  const at = "2026-08-08T00:00:00.000Z";
  const { allocated, holder, body } = await bornBody(value.root, "ca1ce104", at);
  const paths = allocated.paths;
  try {
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    const answer = { kind: "answered" as const, answer: "won", session: { sessionId: "native" } };
    const [, canceled] = await Promise.all([
      endTurn(paths, { turnSequence: turn.sequence, outcome: answer, completedAt: at }),
      cancelBodyTurns(paths, { bodySequence: body.sequence, at }),
    ]);
    assert.deepEqual(canceled, { canceled: [], disposition: null });
    assert.deepEqual((await readTurn(paths, turn.sequence))?.end?.outcome, answer);
    assert.equal((await activitySlice(paths)).rows.filter((row) => row.kind === "turn-end").length, 1);
    assert.equal((await readHeart(paths)).latestBody?.end, "put-down");
  } finally { holder.release(); value.close(); }
});

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
