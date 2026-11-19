import { deferred, temporaryDirectory } from "./support/process.js";
import { abortableDelay } from "../src/akuma/abort.js";
import { recordTell, seedLegacySchema, soulFixture, bornBody, insertLegacyPauseControl } from "./support/akuma-fixtures.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { AkumaOwner, settleAkumaKill } from "../src/akuma/akuma-owner.js";
import { AkumaKillError } from "../src/akuma/akuma-errors.js";
import { executeKillAkuma } from "../src/akuma/akuma-selection-execution.js";
import { projectFailure } from "../src/library/outcome.js";
import type { LiveBodyLaunch } from "../src/akuma/body-launch.js";
import { tellWakeRuntime } from "../src/akuma/body.js";
import { spawnAkumaBody } from "../src/akuma/detached-body.js";
import { noBodyLaunch } from "./support/akuma-fixtures.js";
import {
  HeldAkumaLeash,
  activitySlice,
  appendActivity,
  AkumaBusyError,
  BodyControlledError,
  beginTurn,
  bindTellsToTurn,
  breakBody,
  cancelBodyTurns,
  drainPendingTells,
  endTurn,
  finishBodyIfIdle,
  HeartAbsentError,
  life,
  probeLeash,
  readHeart,
  readForkPoint,
  readLatestTurnForBody,
  readTell,
  readTurnParticipants,
  recordCurrentModel,
  recordSession,
  recordTell as heartRecordTell,
  recordTellDeliveries,
  recordTellReceipt,
  readTurn,
  requestStop,
  type Soul,
} from "../src/akuma/heart/index.js";
import { decodeSoul, decodeSoulRow, encodeSoulRow } from "../src/akuma/heart/soul.js";
import { HeartAuthorityCorruptionError } from "../src/akuma/heart/facts.js";
import { errorCategory, KeiyakuError } from "../src/errors.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

async function fixture() {
  return await soulFixture("keiyaku-akuma-heart-");
}

async function tellFixture(
  value: Awaited<ReturnType<typeof fixture>>,
  input: Readonly<{
    body: string;
    tellId: string;
    recordedAt?: string;
    runtime: Parameters<AkumaOwner["tell"]>[3];
  }>,
) {
  return await new AkumaOwner(value.allocated.id, value.root).tell(
    input.body,
    input.tellId,
    input.recordedAt,
    input.runtime,
  );
}

test("existing non-database Heart paths preserve the SQLite open failure", async () => {
  const value = await fixture();
  try {
    unlinkSync(value.allocated.paths.heart);
    mkdirSync(value.allocated.paths.heart);
    await assert.rejects(readHeart(value.allocated.paths), (error: unknown) => {
      assert.equal(error instanceof HeartAbsentError, false);
      assert.equal(typeof (error as { errcode?: unknown }).errcode, "number");
      return true;
    });
    assert.equal(existsSync(value.allocated.paths.heart), true);
  } finally {
    value.close();
  }
});

test("Tell attribution is durable and part of stable input identity", async () => {
  const value = await fixture();
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  try {
    await leash.birth(value.allocated.paths, value.soul);
    const tell = {
      kind: "tell" as const,
      id: "attributed-tell",
      body: "continue",
      initiator: "Bob",
      recordedAt: value.soul.createdAt,
    };
    await heartRecordTell(value.allocated.paths, tell);
    assert.equal((await readTell(value.allocated.paths, tell.id))?.initiator, "Bob");
    assert.equal((await readHeart(value.allocated.paths)).pending[0]?.initiator, "Bob");
    assert.deepEqual(await heartRecordTell(value.allocated.paths, tell), {
      kind: "recorded",
      tell: await readTell(value.allocated.paths, tell.id),
    });
    await assert.rejects(
      heartRecordTell(value.allocated.paths, { ...tell, initiator: "Alice" }),
      /reused different input/u,
    );
  } finally {
    leash.release();
    value.close();
  }
});

test("birth and seal share the child's leash adjudicator", async () => {
  const value = await fixture();
  try {
    const sealer = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(
      await sealer.sealIfUnborn(value.allocated.paths, { evidence: "call-timeout", at: value.soul.createdAt }),
      "sealed",
    );
    const lateBody = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(await lateBody.birth(value.allocated.paths, value.soul), "sealed");
    lateBody.release();
  } finally {
    value.close();
  }
});

test("control cancellation while waiting for Heart admission leaves no stop or pause", async () => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const leash = (await HeldAkumaLeash.try(paths))!;
  const blocker = new DatabaseSync(paths.heart);
  try {
    await leash.birth(paths, value.soul);
    await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    blocker.exec("BEGIN IMMEDIATE");
    const controller = new AbortController();
    const reason = new Error("caller stopped waiting");
    const handle = new AkumaOwner(value.allocated.id, value.root);
    const results = Promise.allSettled([
      handle.interrupt("not admitted", { runtime: tellWakeRuntime(noBodyLaunch), signal: controller.signal }),
      handle.kill({ signal: controller.signal }),
    ]);
    const timer = setTimeout(() => controller.abort(reason), 20);
    try {
      for (const result of await results) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.equal(result.reason, reason);
      }
    } finally {
      clearTimeout(timer);
    }
    blocker.exec("ROLLBACK");
    const heart = await readHeart(paths);
    assert.equal(heart.stop, null);
    assert.equal(heart.pause, null);
    assert.deepEqual(heart.pending, []);
  } finally {
    blocker.close();
    leash.release();
    value.close();
  }
});

test("cancelled kill admission leaves no stop or successor work", async (context) => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const leash = (await HeldAkumaLeash.try(paths))!;
  const blocker = new DatabaseSync(paths.heart);
  try {
    await leash.birth(paths, value.soul);
    await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    blocker.exec("BEGIN IMMEDIATE");
    const controller = new AbortController();
    const reason = new Error("cancel admission");
    const exec = DatabaseSync.prototype.exec;
    let contended = false;
    const injected = context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      try {
        return exec.call(this, sql);
      } catch (error) {
        if (sql === "BEGIN IMMEDIATE") {
          contended = true;
          controller.abort(reason);
        }
        throw error;
      }
    });
    try {
      await assert.rejects(settleAkumaKill(paths, controller.signal), (error) => error === reason);
      assert.equal(contended, true);
    } finally {
      injected.mock.restore();
    }
    blocker.exec("ROLLBACK");
    assert.equal((await readHeart(paths)).stop, null);
  } finally {
    blocker.close();
    leash.release();
    value.close();
  }
});

test("cancellation after kill admission stops observation without retracting the stop", async (context) => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    const controller = new AbortController();
    const reason = new Error("cancel after admission");
    const exec = DatabaseSync.prototype.exec;
    let committed = false;
    const injected = context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      const result = exec.call(this, sql);
      if (sql === "COMMIT") {
        committed = true;
        controller.abort(reason);
      }
      return result;
    });
    try {
      const id = value.allocated.id;
      await assert.rejects(executeKillAkuma({ path: value.root, ids: [id], signal: controller.signal }), (error) => {
        assert.ok(error instanceof AkumaKillError);
        assert.equal(error.cause, reason);
        const failure = projectFailure(error);
        assert.equal(failure.category, "aborted");
        assert.equal(failure.causeDiagnostic, reason.message);
        assert.deepEqual(failure.kill, [{ id, outcome: "stop-admitted" }]);
        assert.ok(Object.isFrozen(failure.kill) && Object.isFrozen(failure.kill[0]));
        return true;
      });
      assert.equal(committed, true);
    } finally {
      injected.mock.restore();
    }
    assert.notEqual((await readHeart(paths)).stop, null);
  } finally {
    leash.release();
    value.close();
  }
});

test("a non-aborted kill caller has a finite stop confirmation window", async (t) => {
  const value = await fixture();
  const { id, paths } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  t.after(() => { leash.release(); value.close(); });
  await leash.birth(paths, value.soul);
  const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
  const admitted = deferred<void>();
  const exec = DatabaseSync.prototype.exec;
  const injected = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql === "COMMIT") admitted.resolve();
    return result;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = new AkumaOwner(id, value.root).kill({ signal: new AbortController().signal });
  await admitted.promise;
  // The commit precedes the promise continuation that starts the action timer.
  await new Promise<void>((resolve) => setImmediate(resolve));
  injected.mock.restore();
  t.mock.timers.tick(29_900);
  await assert.rejects(waiting, (error) => {
    assert.ok(error instanceof AkumaKillError);
    assert.deepEqual(error.kill, [{ id, outcome: "stop-admitted" }]);
    assert.match(error.message, /admitted stop can still advance/u);
    return true;
  });
  const heart = await readHeart(paths);
  assert.equal(heart.stop?.bodySequence, body.sequence);
  assert.equal(heart.latestBody?.end, undefined);
  assert.equal(heart.latestBody?.hung, undefined);
  assert.equal(heart.latestKill, null);
});

test("a commit failure rolls back the Heart mutation without replaying it", async (context) => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    const failure = Object.assign(new Error("commit busy"), { errcode: 5 });
    const exec = DatabaseSync.prototype.exec;
    let commits = 0;
    let begins = 0;
    const injected = context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") begins++;
      if (sql === "COMMIT") {
        commits++;
        throw failure;
      }
      return exec.call(this, sql);
    });
    await assert.rejects(
      appendActivity(paths, { turnSequence: turn.sequence, event: { type: "note", text: "rollback" }, at }),
      (error) => error === failure,
    );
    injected.mock.restore();
    assert.equal(begins, 1);
    assert.equal(commits, 1);
    assert.equal((await activitySlice(paths)).rows.filter((fact) => fact.kind === "activity").length, 0);
    await appendActivity(paths, { turnSequence: turn.sequence, event: { type: "note", text: "next call" }, at });
    assert.equal((await activitySlice(paths)).rows.filter((fact) => fact.kind === "activity").length, 1);
  } finally {
    leash.release();
    value.close();
  }
});

test("Pi sessionFile coordinates round trip through Heart custody", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    await recordSession(value.allocated.paths, {
      provider: "pi",
      options: { model: "openai/gpt" },
      coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-native" },
      cwd: value.root,
      admittedAt: "2026-08-08T00:00:01.000Z",
    });
    body.release();
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession?.coordinate, {
      sessionFile: "/sessions/pi.jsonl",
      sessionId: "pi-native",
    });
  } finally {
    value.close();
  }
});

test("tell admission shares activity order and delivery witnesses fold without mutable stages", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const bodyFact = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: bodyFact.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const firstActivity = await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "before" },
      at: "2026-08-08T00:00:00.000Z",
    });
    const admitted = await recordTell(value.allocated.paths, {
      id: "tell-1",
      body: "first",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.ok(admitted.kind === "recorded", "expected admitted.kind = \"recorded\"");
    const afterActivity = await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "after" },
      at: "2026-08-08T00:00:02.000Z",
    });
    assert.deepEqual([firstActivity, admitted.tell.sequence, afterActivity], [2, 3, 4]);
    assert.deepEqual(
      (await activitySlice(value.allocated.paths)).rows.map((fact) => fact.kind),
      ["turn-start", "activity", "tell", "activity"],
    );

    const delivery = {
      tellId: admitted.tell.id,
      route: "launch" as const,
      turnSequence: turn.sequence,
      fence: "launch-fence",
      deliveredAt: "2026-08-08T00:00:03.000Z",
    };
    await recordTellDeliveries(value.allocated.paths, [delivery]);
    await recordTellDeliveries(value.allocated.paths, [delivery]);
    const told = (await activitySlice(value.allocated.paths)).rows[2];
    assert.equal(told !== undefined && "id" in told ? told.state : null, "told");
    assert.equal((await readHeart(value.allocated.paths)).pending.length, 0);
    body.release();
  } finally {
    value.close();
  }
});

test("Turn participants follow binding order across live and launch routes without replacing ownership", async () => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at, initiator: "Alice" });
    assert.deepEqual(await readTurnParticipants(paths, turn.sequence), ["Alice"]);
    assert.deepEqual(await readTurnParticipants(paths, 999), []);
    for (const [id, initiator] of [
      ["live", "Bob"],
      ["anonymous", undefined],
      ["launch", "Carol"],
      ["duplicate", "Alice"],
      ["repeated", "Bob"],
    ] as const) {
      await heartRecordTell(paths, { kind: "tell", id, body: id, recordedAt: at, ...(initiator ? { initiator } : {}) });
      await bindTellsToTurn(paths, { turnSequence: turn.sequence, tellIds: [id], boundAt: at });
    }
    await recordTellDeliveries(paths, [
      { tellId: "live", route: "live", turnSequence: turn.sequence, fence: "live", receipt: "required", deliveredAt: at },
      { tellId: "launch", route: "launch", turnSequence: turn.sequence, fence: "launch", deliveredAt: at },
    ]);
    assert.deepEqual(await readTurnParticipants(paths, turn.sequence), ["Alice", "Bob", "Carol"]);
    assert.equal((await readTurn(paths, turn.sequence))?.initiator, "Alice");
    const ownerless = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    assert.deepEqual(await readTurnParticipants(paths, ownerless.sequence), []);
    await bindTellsToTurn(paths, { turnSequence: ownerless.sequence, tellIds: ["live"], boundAt: at });
    assert.deepEqual(await readTurnParticipants(paths, ownerless.sequence), ["Bob"]);
  } finally {
    leash.release();
    value.close();
  }
});

test("latest admitted Turn attribution is scoped to the exact Body", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const firstBody = await leash.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    const firstTurn = await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: value.soul.createdAt,
      initiator: "Alice",
    });
    assert.equal((await readLatestTurnForBody(value.allocated.paths, firstBody.sequence))?.sequence, firstTurn.sequence);
    assert.equal((await readLatestTurnForBody(value.allocated.paths, firstBody.sequence))?.initiator, "Alice");
    await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal((await readLatestTurnForBody(value.allocated.paths, firstBody.sequence))?.initiator, undefined);

    await breakBody(value.allocated.paths, {
      sequence: firstBody.sequence,
      end: "broke-off",
      at: "2026-08-08T00:00:02.000Z",
    });
    leash.release();
    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    const secondBody = await successor.recordBody(value.allocated.paths, { leashTakenAt: "2026-08-08T00:00:03.000Z" });
    await beginTurn(value.allocated.paths, {
      bodySequence: secondBody.sequence,
      startedAt: "2026-08-08T00:00:03.000Z",
      initiator: "Bob",
    });
    assert.equal((await readLatestTurnForBody(value.allocated.paths, firstBody.sequence))?.initiator, undefined);
    assert.equal((await readLatestTurnForBody(value.allocated.paths, secondBody.sequence))?.initiator, "Bob");
    assert.equal(await readLatestTurnForBody(value.allocated.paths, 999), null);
    successor.release();
  } finally {
    value.close();
  }
});
test("wake names the missing frozen execution directory instead of a bare spawn absence", async () => {
  const value = await fixture();
  const vanishedCwd = join(value.root, "vanished-cwd");
  try {
    const born = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await born.birth(value.allocated.paths, { ...value.soul, cwd: vanishedCwd });
    born.release();
    const result = await tellFixture(value, {
      body: "continue",
      tellId: "tell-missing-cwd",
      runtime: tellWakeRuntime(spawnAkumaBody),
      recordedAt: value.soul.createdAt,
    });
    assert.equal(result.wake.kind, "failed");
    const diagnostic = result.wake.kind === "failed" ? result.wake.diagnostic : "";
    assert.ok(diagnostic.includes(vanishedCwd), diagnostic);
    assert.match(diagnostic, /frozen execution directory/);
    assert.match(diagnostic, /no longer exists/);
    assert.match(diagnostic, /kill this Akuma and spawn a fresh one/);
    assert.doesNotMatch(diagnostic, /spawn .* ENOENT/);
    const heart = await readHeart(value.allocated.paths);
    assert.deepEqual(
      heart.pending.map((tell) => tell.id),
      ["tell-missing-cwd"],
    );
    assert.equal(heart.latestBody, null);
  } finally {
    value.close();
  }
});

test("wake names the missing waking executable instead of a bare spawn absence", async () => {
  const value = await fixture();
  const vanishedExecutable = join(value.root, "vanished-runtime", "keiyaku-body");
  const liveExecPath = process.execPath;
  Object.defineProperty(process, "execPath", { value: vanishedExecutable, configurable: true });
  try {
    const born = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await born.birth(value.allocated.paths, value.soul);
    born.release();
    const result = await tellFixture(value, {
      body: "continue",
      tellId: "tell-missing-executable",
      runtime: tellWakeRuntime(spawnAkumaBody),
      recordedAt: value.soul.createdAt,
    });
    assert.equal(result.wake.kind, "failed");
    const diagnostic = result.wake.kind === "failed" ? result.wake.diagnostic : "";
    assert.ok(diagnostic.includes(vanishedExecutable), diagnostic);
    assert.match(diagnostic, /waking process executable/);
    assert.match(diagnostic, /no longer exists/);
    assert.match(diagnostic, /kill this Akuma and spawn a fresh one/);
    assert.doesNotMatch(diagnostic, /spawn .* ENOENT/);
    const heart = await readHeart(value.allocated.paths);
    assert.deepEqual(
      heart.pending.map((tell) => tell.id),
      ["tell-missing-executable"],
    );
    assert.equal(heart.latestBody, null);
  } finally {
    Object.defineProperty(process, "execPath", { value: liveExecPath, configurable: true });
    value.close();
  }
});

test("wake names both missing pieces when the executable and frozen directory are gone", async () => {
  const value = await fixture();
  const vanishedCwd = join(value.root, "vanished-cwd");
  const vanishedExecutable = join(value.root, "vanished-runtime", "keiyaku-body");
  const liveExecPath = process.execPath;
  Object.defineProperty(process, "execPath", { value: vanishedExecutable, configurable: true });
  try {
    const born = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await born.birth(value.allocated.paths, { ...value.soul, cwd: vanishedCwd });
    born.release();
    const result = await tellFixture(value, {
      body: "continue",
      tellId: "tell-missing-both",
      runtime: tellWakeRuntime(spawnAkumaBody),
      recordedAt: value.soul.createdAt,
    });
    assert.equal(result.wake.kind, "failed");
    const diagnostic = result.wake.kind === "failed" ? result.wake.diagnostic : "";
    assert.ok(diagnostic.includes(vanishedCwd), diagnostic);
    assert.ok(diagnostic.includes(vanishedExecutable), diagnostic);
    assert.match(diagnostic, /frozen execution directory/);
    assert.match(diagnostic, /waking process executable/);
    assert.match(diagnostic, /kill this Akuma and spawn a fresh one/);
    assert.doesNotMatch(diagnostic, /spawn .* ENOENT/);
    const heart = await readHeart(value.allocated.paths);
    assert.deepEqual(
      heart.pending.map((tell) => tell.id),
      ["tell-missing-both"],
    );
    assert.equal(heart.latestBody, null);
  } finally {
    Object.defineProperty(process, "execPath", { value: liveExecPath, configurable: true });
    value.close();
  }
});

test("a held foreign Body cannot confirm submission without an exact delivery", async (t) => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const leash = (await HeldAkumaLeash.try(paths))!;
  t.after(() => { leash.release(); value.close(); });
  await leash.birth(paths, value.soul);
  const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
  const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
  const waiting = deferred<void>();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = tellFixture(value, {
    body: "continue", tellId: "tell-held", recordedAt: value.soul.createdAt,
    runtime: {
      async spawn() { assert.fail("must not launch into held custody"); },
      async schedule(ms, signal) { waiting.resolve(); await abortableDelay(ms, signal); },
    },
  });
  await waiting.promise;
  await bindTellsToTurn(paths, { turnSequence: turn.sequence, tellIds: ["tell-held"], boundAt: value.soul.createdAt });
  t.mock.timers.tick(29_900);
  const result = await pending;
  assert.equal(result.wake.kind, "confirmation-stopped");
  if (result.wake.kind !== "confirmation-stopped") assert.fail("expected a typed stop");
  assert.equal(result.wake.reason, "deadline");
  assert.match(result.wake.diagnostic, /admitted input can still advance/u);
  assert.equal((await readTell(paths, "tell-held"))?.state, "pending");
  assert.equal((await readTurn(paths, turn.sequence))?.end, undefined);
  assert.equal((await readHeart(paths)).latestBody?.hung, undefined);
});

test("an exact historical undelivered witness is a negative action result", async () => {
  const value = await fixture();
  const { paths } = value.allocated;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    await heartRecordTell(paths, { kind: "tell", id: "old", body: "old input", recordedAt: at });
    await recordTellReceipt(paths, { evidence: "exact", tellId: "old", kind: "undelivered", receivedAt: at });
    const receipt = await tellFixture(value, {
      body: "old input", tellId: "old", recordedAt: at,
      runtime: { async spawn() { assert.fail("a terminal historical Tell is not replayed"); } },
    });
    assert.deepEqual(receipt.wake, {
      kind: "failed", reason: "undelivered", diagnostic: "Heart recorded this Tell as undelivered",
    });
    assert.equal((await readTell(paths, "old"))?.state, "told");
  } finally {
    leash.release();
    value.close();
  }
});

test("action deadline releases even a launch handle that arrives after the invocation", async (t) => {
  const value = await fixture();
  t.after(value.close);
  const { paths } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  await leash.birth(paths, value.soul);
  leash.release();
  const started = deferred<void>();
  const handle = deferred<LiveBodyLaunch>();
  const released = deferred<void>();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const confirming = tellFixture(value, {
    body: "pending", tellId: "slow-prepare", runtime: {
      async spawn() { started.resolve(); return await handle.promise; },
    },
  });
  await started.promise;
  t.mock.timers.tick(29_900);
  const result = await confirming;
  assert.equal(result.wake.kind, "confirmation-stopped");
  assert.equal((await readTell(paths, "slow-prepare"))?.state, "pending");
  assert.equal((await readHeart(paths)).latestBody, null);
  handle.resolve({ completed: new Promise(() => {}), async cancel() { assert.fail("no execution cancellation"); }, release: released.resolve });
  await released.promise;
});

test("an unrelated Body cannot hide actual launch failure", async () => {
  const value = await fixture();
  let winnerSequence: number | undefined;
  try {
    const born = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await born.birth(value.allocated.paths, value.soul);
    born.release();
    const result = await tellFixture(value, {
      body: "continue",
      tellId: "tell-successor-race",
      recordedAt: value.soul.createdAt,
      runtime: {
        async spawn(): Promise<LiveBodyLaunch> {
          const winner = (await HeldAkumaLeash.try(value.allocated.paths))!;
          const body = await winner.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
          winnerSequence = body.sequence;
          winner.release();
          return {
            completed: Promise.resolve({ diagnostic: "fixture launch failed" }),
            async cancel() {},
            release() {},
          };
        },
      },
    });
    assert.deepEqual(result.wake, { kind: "failed", diagnostic: "fixture launch failed" });
    assert.equal((await readHeart(value.allocated.paths)).latestBody?.sequence, winnerSequence);
  } finally {
    value.close();
  }
});

test("terminal Tell evidence is admitted once for each exact Tell and kind", async () => {
  const value = await fixture();
  const { paths } = value.allocated;
  const at = "2026-08-08T00:00:03.000Z";
  const receivedAt = "2026-08-08T00:00:05.000Z";
  const duplicateAt = "2026-08-08T00:00:07.000Z";
  const holder = (await HeldAkumaLeash.try(paths))!;
  const ids = ["required-1", "required-2", "unavailable", "exact"];
  const pending = async () => (await readHeart(paths)).pending.map((tell) => tell.id);
  try {
    await holder.birth(paths, value.soul);
    const body = await holder.recordBody(paths, { leashTakenAt: at });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    for (const id of ids) assert.equal((await recordTell(paths, { id, body: id, recordedAt: at })).kind, "recorded");
    await bindTellsToTurn(paths, { turnSequence: turn.sequence, tellIds: ids, boundAt: at });
    assert.deepEqual(await pending(), ids, "binding alone does not settle input");
    const fenceReceipt = { evidence: "fence" as const, turnSequence: turn.sequence, fence: "shared", kind: "accepted", receivedAt };
    await assert.rejects(recordTellReceipt(paths, fenceReceipt), /no delivery mapping/u);
    const delivery = { route: "live" as const, turnSequence: turn.sequence, deliveredAt: at };
    const required = { ...delivery, tellId: "required-1", receipt: "required" as const, fence: "shared" };
    await recordTellDeliveries(paths, [
      required,
      { ...required, tellId: "required-2" },
      { ...delivery, tellId: "unavailable", receipt: "unavailable", fence: "other" },
    ]);
    assert.deepEqual(await pending(), ["required-1", "required-2", "exact"]);
    await assert.rejects(
      recordTellDeliveries(paths, [
        { ...delivery, route: "launch", tellId: "exact", fence: "launch" },
        { ...required, receipt: "unavailable" },
      ]),
      /conflicting evidence/u,
    );
    assert.deepEqual((await readTell(paths, "exact"))?.deliveries, [], "a rejected batch records no partial delivery");
    await assert.rejects(recordTellReceipt(paths, { ...fenceReceipt, turnSequence: turn.sequence + 1 }), /no delivery mapping/u);
    assert.deepEqual(await pending(), ["required-1", "required-2", "exact"]);
    await recordTellReceipt(paths, fenceReceipt);
    await recordTellReceipt(paths, { ...fenceReceipt, receivedAt: duplicateAt });
    assert.deepEqual(await pending(), ["exact"], "the fence settles only its mapped Tells");

    const exactReceipt = { evidence: "exact" as const, tellId: "exact", kind: "consumed", receivedAt };
    await assert.rejects(recordTellReceipt(paths, { ...exactReceipt, tellId: "missing" }), /unknown tell missing/u);
    await recordTellReceipt(paths, exactReceipt);
    await recordTellReceipt(paths, { ...exactReceipt, receivedAt: duplicateAt });
    await recordTellReceipt(paths, { ...exactReceipt, tellId: "required-1", kind: "accepted", receivedAt: duplicateAt });
    assert.deepEqual(await pending(), []);
    const database = new DatabaseSync(paths.heart, { readOnly: true });
    try {
      const witnesses = database.prepare("SELECT * FROM tell_terminal_receipts ORDER BY tell_id, kind").all();
      assert.deepEqual(witnesses.map(({ tell_id, kind, received_at }) => [tell_id, kind, received_at]), [
        ["exact", "consumed", receivedAt],
        ["required-1", "accepted", receivedAt],
        ["required-2", "accepted", receivedAt],
        ["unavailable", "unavailable", at],
      ]);
    } finally {
      database.close();
    }
  } finally {
    holder.release();
    value.close();
  }
});

test("kill witnesses one stopped Body without burning pending work", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const firstBody = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const pending = await recordTell(value.allocated.paths, {
      id: "tell-pending",
      body: "pending",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(pending.kind, "recorded");
    assert.deepEqual(await requestStop(value.allocated.paths, "2026-08-08T00:00:03.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    await breakBody(value.allocated.paths, {
      sequence: firstBody.sequence,
      end: "put-down",
      at: "2026-08-08T00:00:03.500Z",
    });
    assert.deepEqual(await leash.settleStop(value.allocated.paths), {
      target: { bodySequence: firstBody.sequence, requestedAt: "2026-08-08T00:00:03.000Z" },
      result: "recorded",
    });
    assert.equal((await requestStop(value.allocated.paths, "later")).kind, "already-killed");
    let snapshot = await readHeart(value.allocated.paths);
    assert.equal(snapshot.latestKill?.bodySequence, firstBody.sequence);
    assert.deepEqual(
      snapshot.pending.map((tell) => tell.id),
      ["tell-pending"],
    );
    assert.equal(
      life({
        leash: "free",
        body: { ...firstBody, end: "put-down" },
        kill: snapshot.latestKill,
      }),
      "killed",
    );

    leash.release();
    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    const secondBody = await successor.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:04.000Z",
    });
    const secondTurn = await beginTurn(value.allocated.paths, {
      bodySequence: secondBody.sequence,
      startedAt: "2026-08-08T00:00:04.000Z",
    });
    snapshot = await readHeart(value.allocated.paths);
    assert.equal(
      life({
        leash: "free",
        body: { ...secondBody, end: "exited" },
        kill: snapshot.latestKill,
      }),
      "asleep",
    );
    await recordTellDeliveries(value.allocated.paths, [
      {
        tellId: "tell-pending",
        route: "launch",
        turnSequence: secondTurn.sequence,
        fence: "successor",
        deliveredAt: "2026-08-08T00:00:05.000Z",
      },
    ]);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
    successor.release();
  } finally {
    value.close();
  }
});

test("kill admission witnesses a stranded settled Body instead of requesting a stop", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "broke-off",
      at: "2026-08-08T00:00:01.000Z",
    });
    leash.release();

    assert.deepEqual(await requestStop(value.allocated.paths, "2026-08-08T00:00:02.000Z"), {
      kind: "witnessed",
      body: { ...body, end: "broke-off", endedAt: "2026-08-08T00:00:01.000Z" },
    });
    const snapshot = await readHeart(value.allocated.paths);
    assert.deepEqual(snapshot.latestKill, {
      sequence: snapshot.latestKill!.sequence,
      bodySequence: body.sequence,
      evidence: "killed",
      at: "2026-08-08T00:00:02.000Z",
    });
    assert.equal(snapshot.stop, null);
    assert.equal((await readHeart(value.allocated.paths)).stop, null);
    assert.equal(
      life({ leash: "free", body: snapshot.latestBody, kill: snapshot.latestKill }),
      "killed",
    );
    assert.equal(
      (await requestStop(value.allocated.paths, "2026-08-08T00:00:03.000Z")).kind,
      "already-killed",
    );
  } finally {
    value.close();
  }
});

test("kill admission of a put-down stranded Body consumes its stop control", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    assert.deepEqual(await requestStop(value.allocated.paths, "2026-08-08T00:00:01.000Z"), {
      kind: "requested",
      body,
    });
    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "put-down",
      at: "2026-08-08T00:00:02.000Z",
    });
    leash.release();

    // The first kill caller vanished before settling; a later kill witnesses
    // the already settled Body and consumes the lingering stop control.
    assert.equal((await requestStop(value.allocated.paths, "2026-08-08T00:00:03.000Z")).kind, "witnessed");
    assert.equal((await readHeart(value.allocated.paths)).stop, null);
    assert.equal(
      (await readHeart(value.allocated.paths)).latestKill?.bodySequence,
      body.sequence,
    );
  } finally {
    value.close();
  }
});

test("ended but hung custody is never a successful kill", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-kill-ended-hung-");
  const { allocated, body, holder } = await bornBody(root, "b0000910", "2026-08-08T00:00:00.000Z");
  try {
    await holder.recordBodyHung(allocated.paths, { sequence: body.sequence, diagnostic: "foreign custody", at: body.leashTakenAt });
    await breakBody(allocated.paths, { sequence: body.sequence, end: "broke-off", at: body.leashTakenAt });
    const result = await settleAkumaKill(allocated.paths, new AbortController().signal);
    assert.deepEqual(result, { evidence: "hung" });
    assert.equal((await readHeart(allocated.paths)).latestKill, null);
  } finally {
    holder.release();
  }
});

test("kill of a normally exited Body stays already stopped without a witness", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    await finishBodyIfIdle(value.allocated.paths, { sequence: body.sequence, at: "2026-08-08T00:00:01.000Z" });
    leash.release();

    assert.equal((await requestStop(value.allocated.paths, "2026-08-08T00:00:02.000Z")).kind, "already-stopped");
    assert.equal((await readHeart(value.allocated.paths)).latestKill, null);
    assert.equal(
      life({
        leash: "free",
        body: (await readHeart(value.allocated.paths)).latestBody,
        kill: null,
      }),
      "asleep",
    );
  } finally {
    value.close();
  }
});

test("kill witnesses a stranded Body and leaves its pending Tell for an ordinary wake", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    await breakBody(value.allocated.paths, { sequence: body.sequence, end: "put-down", at: value.soul.createdAt });
    await recordTell(value.allocated.paths, {
      id: "tell-recover-on-kill",
      body: "continue",
      recordedAt: value.soul.createdAt,
    });
    leash.release();
    assert.deepEqual(await settleAkumaKill(value.allocated.paths), { evidence: "killed" });
    const settled = await readHeart(value.allocated.paths);
    assert.equal(settled.latestKill?.bodySequence, body.sequence);
    assert.deepEqual(
      settled.pending.map((tell) => tell.id),
      ["tell-recover-on-kill"],
      "kill never settles or discards admitted input",
    );
    assert.equal(await probeLeash(value.allocated.paths), "free");

    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    const successorBody = await successor.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: successorBody.sequence,
      startedAt: value.soul.createdAt,
    });
    const [queued] = drainPendingTells((await readHeart(value.allocated.paths)).pending);
    assert.equal(queued?.id, "tell-recover-on-kill");
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      tellIds: [queued!.id],
      boundAt: value.soul.createdAt,
    });
    await recordTellDeliveries(value.allocated.paths, [
      {
        tellId: queued!.id,
        route: "launch",
        turnSequence: turn.sequence,
        fence: "successor",
        deliveredAt: value.soul.createdAt,
      },
    ]);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
    successor.release();
  } finally {
    value.close();
  }
});

test("heart schema version 32 and leash schema version 4 hard-refuse unknown authority", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-schema-cut-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, akumaName: "claude", draw: () => "30000000" });
  seedLegacySchema(allocated.paths.heart, "akuma_schema", 14);
  seedLegacySchema(allocated.paths.leash, "leash_schema", 2);
  await assert.rejects(readHeart(allocated.paths), /heart schema version must be 32/u);
  await assert.rejects(HeldAkumaLeash.try(allocated.paths), /leash schema version must be 4/u);
});

test("schema Tell admission refuses a running Body and binds once with frozen schema JSON", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const schemaJson = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}';
    await assert.rejects(
      heartRecordTell(value.allocated.paths, {
        kind: "tell",
        id: "schema-busy",
        body: "return structured",
        recordedAt: "2026-08-08T00:00:01.000Z",
        schemaJson,
      }),
      AkumaBusyError,
    );
    assert.equal((await readHeart(value.allocated.paths)).pending.length, 0);

    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "put-down",
      at: "2026-08-08T00:00:02.000Z",
    });
    const admitted = await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "schema-idle",
      body: "return structured",
      recordedAt: "2026-08-08T00:00:03.000Z",
      schemaJson,
    });
    assert.ok(admitted.kind === "recorded", "expected admitted.kind = \"recorded\"");
    const following = await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "plain-join",
      body: "also",
      recordedAt: "2026-08-08T00:00:04.000Z",
    });
    const laterSchema = await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "schema-later",
      body: "next turn",
      recordedAt: "2026-08-08T00:00:05.000Z",
      schemaJson,
    });
    assert.equal(following.kind, "recorded");
    assert.equal(laterSchema.kind, "recorded");
    const pending = (await readHeart(value.allocated.paths)).pending;
    assert.deepEqual(
      drainPendingTells(pending).map((tell) => tell.id),
      ["schema-idle"],
      "a schema Tell takes its own Turn and absorbs no ordinary input",
    );
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:06.000Z",
      schemaJson,
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      tellIds: ["schema-idle", "plain-join"],
      boundAt: "2026-08-08T00:00:06.000Z",
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      tellIds: ["schema-idle"],
      boundAt: "2026-08-08T00:00:07.000Z",
    });
    assert.deepEqual(
      drainPendingTells((await readHeart(value.allocated.paths)).pending).map((tell) => tell.id),
      ["schema-idle"],
      "binding never widens a schema Tell's dedicated Turn",
    );
    const rebindingTurn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:08.000Z",
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: rebindingTurn.sequence,
      tellIds: ["schema-idle"],
      boundAt: "2026-08-08T00:00:08.000Z",
    });
    const started = await readTurn(value.allocated.paths, turn.sequence);
    assert.equal(started?.schemaJson, schemaJson);
    await endTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      outcome: {
        kind: "invalid-output",
        diagnostic: "Unexpected token",
        answer: "not-json",
      },
      completedAt: "2026-08-08T00:00:09.000Z",
    });
    const ended = await readTurn(value.allocated.paths, turn.sequence);
    assert.equal(ended?.end?.outcome.kind, "invalid-output");
    if (ended?.end?.outcome.kind === "invalid-output") {
      assert.equal(ended.end.outcome.answer, "not-json");
    }
    await recordTellReceipt(value.allocated.paths, {
      evidence: "exact",
      tellId: "schema-idle",
      kind: "consumed",
      receivedAt: "2026-08-08T00:00:10.000Z",
    });
    assert.deepEqual(
      drainPendingTells((await readHeart(value.allocated.paths)).pending).map((tell) => tell.id),
      ["plain-join"],
      "ordinary drain stops before the next schema Tell",
    );
    leash.release();
  } finally {
    value.close();
  }
});

test("a binding-before-delivery crash remains recoverable without predecessor terminality", async () => {
  const value = await fixture();
  try {
    const predecessor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await predecessor.birth(value.allocated.paths, value.soul);
    const firstBody = await predecessor.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "crash-window",
      body: "resume after crash",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const firstTurn = await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: "2026-08-08T00:00:02.000Z",
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: firstTurn.sequence,
      tellIds: ["crash-window"],
      boundAt: "2026-08-08T00:00:02.000Z",
    });
    predecessor.release();

    const pending = (await readHeart(value.allocated.paths)).pending;
    assert.deepEqual(
      drainPendingTells(pending).map((tell) => tell.id),
      ["crash-window"],
    );
    assert.deepEqual(drainPendingTells(pending, [firstTurn.sequence]), []);

    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    const secondBody = await successor.recordBody(value.allocated.paths, { leashTakenAt: "2026-08-08T00:00:03.000Z" });
    const secondTurn = await beginTurn(value.allocated.paths, {
      bodySequence: secondBody.sequence,
      startedAt: "2026-08-08T00:00:03.000Z",
    });
    await bindTellsToTurn(value.allocated.paths, {
      turnSequence: secondTurn.sequence,
      tellIds: ["crash-window"],
      boundAt: "2026-08-08T00:00:03.000Z",
    });
    const recovered = await readTell(value.allocated.paths, "crash-window");
    assert.equal(recovered?.state, "pending");
    assert.equal(recovered?.binding?.turnSequence, secondTurn.sequence);
    assert.equal((await readTurn(value.allocated.paths, firstTurn.sequence))?.end, undefined);
    assert.equal((await readHeart(value.allocated.paths)).latestBody?.sequence, secondBody.sequence);
    successor.release();
  } finally {
    value.close();
  }
});

test("interrupt admission joins one stable frontier and stale completion preserves newer control", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-barrier-join-");
  const { allocated, holder, body } = await bornBody(root, "baba1001", "2026-08-08T00:00:00.000Z");
  try {
    const [first, second] = await Promise.all([
      heartRecordTell(allocated.paths, {
        kind: "tell",
        id: "interrupt-one",
        body: "first",
        recordedAt: "2026-08-08T00:00:01.000Z",
      }, { interrupt: true }),
      heartRecordTell(allocated.paths, {
        kind: "tell",
        id: "interrupt-two",
        body: "second",
        recordedAt: "2026-08-08T00:00:02.000Z",
      }, { interrupt: true }),
    ]);
    assert.equal(first.kind, "recorded");
    assert.equal(second.kind, "recorded");
    if (first.kind !== "recorded" || second.kind !== "recorded") throw new Error("concurrent interrupts were not admitted");
    const firstBarrier = first.barrier;
    assert.ok(firstBarrier);
    assert.equal(second.barrier?.frontierTellId, firstBarrier.frontierTellId);
    const duplicate = await heartRecordTell(allocated.paths, {
      kind: "tell",
      id: first.tell.id,
      body: first.tell.body,
      recordedAt: "2026-08-08T00:00:03.000Z",
    }, { interrupt: true });
    assert.equal(duplicate.kind, "recorded");
    if (duplicate.kind !== "recorded") throw new Error("duplicate interrupt identity was refused");
    assert.equal(duplicate.tell.sequence, first.tell.sequence);
    assert.equal(duplicate.tell.recordedAt, first.tell.recordedAt);
    assert.equal(duplicate.barrier?.frontierTellId, firstBarrier.frontierTellId);

    const admittedHeart = await readHeart(allocated.paths);
    assert.equal(admittedHeart.pause?.bodySequence, body.sequence);
    assert.equal(admittedHeart.pause?.frontierTellId, firstBarrier.frontierTellId);
    assert.deepEqual(
      admittedHeart.pending.map((tell) => tell.id).sort(),
      [first.tell.id, second.tell.id].sort(),
    );
    await assert.rejects(
      heartRecordTell(allocated.paths, {
        kind: "tell",
        id: first.tell.id,
        body: "changed payload",
        recordedAt: first.tell.recordedAt,
      }, { interrupt: true }),
      /reused different input/u,
    );

    await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: "2026-08-08T00:00:05.000Z" });
    holder.release();
    const successorLeash = await HeldAkumaLeash.try(allocated.paths);
    assert.ok(successorLeash);
    const settled = await successorLeash.completeInterruptBarrier(allocated.paths, firstBarrier);
    assert.equal(settled.kind, "completed");
    assert.equal((await readHeart(allocated.paths)).pause, null);
    const successor = await successorLeash.recordBody(allocated.paths, { leashTakenAt: "2026-08-08T00:00:06.000Z" });
    const newer = await heartRecordTell(allocated.paths, {
      kind: "tell",
      id: "interrupt-three",
      body: "third",
      recordedAt: "2026-08-08T00:00:07.000Z",
    }, { interrupt: true });
    assert.equal(newer.kind, "recorded");
    if (newer.kind !== "recorded") throw new Error("successor interrupt was not admitted");
    const newerBarrier = newer.barrier;
    assert.ok(newerBarrier);
    assert.equal(newerBarrier.bodySequence, successor.sequence);
    const stale = await successorLeash.completeInterruptBarrier(allocated.paths, firstBarrier);
    assert.equal(stale.kind, "completed");
    assert.deepEqual((await readHeart(allocated.paths)).pause, newerBarrier);
    assert.equal((await successorLeash.completeInterruptBarrier(allocated.paths, newerBarrier)).kind, "unavailable");
    successorLeash.release();
  } finally {
    holder.release();
  }
});

test("recordBody refuses a start admitted across an unsettled interrupt barrier", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-body-race-");
  const { allocated, holder, body } = await bornBody(root, "baba1002", "2026-08-08T00:00:00.000Z");
  holder.release();
  const candidate = await HeldAkumaLeash.try(allocated.paths);
  assert.ok(candidate);
  try {
    assert.equal((await candidate.completeInterruptBarrier(allocated.paths)).kind, "clear");
    const admitted = await heartRecordTell(allocated.paths, {
      kind: "tell",
      id: "race-interrupt",
      body: "protected",
      recordedAt: "2026-08-08T00:00:01.000Z",
    }, { interrupt: true });
    assert.equal(admitted.kind, "recorded");
    await assert.rejects(
      candidate.recordBody(allocated.paths, { leashTakenAt: "2026-08-08T00:00:02.000Z" }),
      BodyControlledError,
    );
    const heart = await readHeart(allocated.paths);
    assert.equal(heart.latestBody?.sequence, body.sequence);
    assert.equal(heart.pause?.frontierTellId, "race-interrupt");
    assert.deepEqual(heart.pending.map((tell) => tell.id), ["race-interrupt"]);
  } finally {
    candidate.release();
  }
});

test("legacy pause clears only after explicit non-hung settlement without inventing a Tell", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-legacy-pause-");
  const { allocated, holder, body } = await bornBody(root, "baba1003", "2026-08-08T00:00:00.000Z");
  try {
    await insertLegacyPauseControl(allocated.paths, body.sequence, "2026-08-08T00:00:01.000Z");
    const pause = (await readHeart(allocated.paths)).pause;
    assert.ok(pause);
    assert.equal(pause.frontierTellId, undefined);
    assert.equal((await holder.completeInterruptBarrier(allocated.paths)).kind, "unavailable");
    assert.equal((await readHeart(allocated.paths)).pause?.bodySequence, body.sequence);
    await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: "2026-08-08T00:00:02.000Z" });
    assert.equal((await holder.completeInterruptBarrier(allocated.paths)).kind, "completed");
    assert.equal((await readHeart(allocated.paths)).pause, null);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
  } finally {
    holder.release();
  }
});

test("malformed pause frontier is Heart corruption, not legacy state", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-malformed-pause-");
  const { allocated, holder, body } = await bornBody(root, "baba1004", "2026-08-08T00:00:00.000Z");
  const database = new DatabaseSync(allocated.paths.heart);
  try {
    database
      .prepare("INSERT INTO control(kind, value_json, at) VALUES ('pause', ?, ?)")
      .run(JSON.stringify({ bodySequence: body.sequence, frontierTellId: "missing-interrupt-tell" }), "2026-08-08T00:00:01.000Z");
    await assert.rejects(readHeart(allocated.paths), (error: unknown) => {
      assert.ok(error instanceof HeartAuthorityCorruptionError && error instanceof KeiyakuError);
      assert.equal(error.name, "HeartAuthorityCorruptionError");
      assert.equal(errorCategory(error), "authority-corruption");
      return true;
    });
  } finally {
    database.close();
    holder.release();
  }
});

test("pause remains distinct from stop and can be cleared only under the leash", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    body.release();
    assert.deepEqual(await requestStop(value.allocated.paths, "2026-08-08T00:00:01.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    await insertLegacyPauseControl(value.allocated.paths, firstBody.sequence, "2026-08-08T00:00:02.000Z");
    assert.notEqual((await readHeart(value.allocated.paths)).stop, null);
    assert.notEqual((await readHeart(value.allocated.paths)).pause, null);

    const interruptor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal((await interruptor.completeInterruptBarrier(value.allocated.paths)).kind, "unavailable");
    assert.notEqual((await readHeart(value.allocated.paths)).pause, null);
    await breakBody(value.allocated.paths, { sequence: firstBody.sequence, end: "put-down", at: "2026-08-08T00:00:03.000Z" });
    assert.equal((await interruptor.completeInterruptBarrier(value.allocated.paths)).kind, "completed");
    interruptor.release();
    assert.equal((await readHeart(value.allocated.paths)).pause, null);
    assert.notEqual((await readHeart(value.allocated.paths)).stop, null);

    await insertLegacyPauseControl(value.allocated.paths, firstBody.sequence, "2026-08-08T00:00:04.000Z");
    const nextInterruptor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal((await nextInterruptor.completeInterruptBarrier(value.allocated.paths)).kind, "completed");
    nextInterruptor.release();
    assert.equal((await readHeart(value.allocated.paths)).pause, null);
  } finally {
    value.close();
  }
});

test("a fresh interrupt Tell joins but does not rewrite a legacy pause", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    await insertLegacyPauseControl(value.allocated.paths, body.sequence, "2026-08-08T00:00:01.000Z");
    assert.notEqual((await readHeart(value.allocated.paths)).pause, null);

    const admitted = await heartRecordTell(value.allocated.paths, {
      kind: "tell",
      id: "interrupt-tell",
      body: "take this interrupt",
      recordedAt: "2026-08-08T00:00:02.000Z",
    }, { interrupt: true });
    assert.equal(admitted.kind, "recorded");
    if (admitted.kind !== "recorded") return;
    assert.equal(admitted.tell.id, "interrupt-tell");
    assert.equal(admitted.tell.body, "take this interrupt");
    assert.equal(admitted.tell.recordedAt, "2026-08-08T00:00:02.000Z");
    assert.equal(admitted.tell.state, "pending");
    assert.deepEqual(admitted.tell.deliveries, []);
    const snapshot = await readHeart(value.allocated.paths);
    assert.equal(snapshot.pause?.bodySequence, body.sequence);
    assert.equal(snapshot.pause?.frontierTellId, undefined);
    assert.deepEqual(snapshot.pending, [admitted.tell]);
    leash.release();
  } finally {
    value.close();
  }
});

test("interrupt admission refuses unborn work without recording a Tell", async () => {
  const value = await fixture();
  try {
    assert.deepEqual(
      await heartRecordTell(value.allocated.paths, {
        kind: "tell",
        id: "unborn-tell",
        body: "never admitted",
        recordedAt: "2026-08-08T00:00:01.000Z",
      }, { interrupt: true }),
      { kind: "not-born" },
    );
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
  } finally {
    value.close();
  }
});

test("normal body completion refuses while a tell remains pending", async () => {
  const value = await fixture();
  try {
    const claim = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await claim.birth(value.allocated.paths, value.soul);
    const body = await claim.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    await recordSession(value.allocated.paths, {
      provider: "claude",
      options: value.soul.options,
      coordinate: { sessionId: "native-session" },
      cwd: value.root,
      admittedAt: "2026-08-08T00:00:00.000Z",
    });
    await recordTell(value.allocated.paths, {
      id: "tell-1",
      body: "pending",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const firstTurn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:01.000Z",
    });
    await endTurn(value.allocated.paths, {
      turnSequence: firstTurn.sequence,
      outcome: {
        kind: "answered",
        historyId: "turn-1",
        session: { sessionId: "native-session" },
        answer: "done",
      },
      completedAt: "2026-08-08T00:00:02.000Z",
    });
    assert.deepEqual(
      await finishBodyIfIdle(value.allocated.paths, {
        sequence: body.sequence,
        at: "2026-08-08T00:00:02.000Z",
      }),
      { kind: "pending", tells: ["tell-1"] },
    );
    const secondTurn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:02.000Z",
    });
    await endTurn(value.allocated.paths, {
      turnSequence: secondTurn.sequence,
      outcome: { kind: "failed", diagnostic: "later failure" },
      completedAt: "2026-08-08T00:00:03.000Z",
    });
    assert.deepEqual(
      (await activitySlice(value.allocated.paths)).rows
        .filter((fact) => fact.kind === "turn-end")
        .map((turn) => turn.outcome),
      [
        {
          kind: "answered",
          historyId: "turn-1",
          session: { sessionId: "native-session" },
          answer: "done",
        },
        { kind: "failed", diagnostic: "later failure" },
      ],
    );
    assert.deepEqual(await readForkPoint(value.allocated.paths, `turn/${firstTurn.sequence}`), {
      historyId: "turn-1",
      session: { sessionId: "native-session" },
      provider: "claude",
      cwd: value.root,
      options: value.soul.options,
    });
    assert.equal(await readForkPoint(value.allocated.paths, "missing-turn"), null);
    claim.release();
  } finally {
    value.close();
  }
});

test("the current runtime model is one Soul member, moved only by the exact running Body", async () => {
  const value = await fixture();
  try {
    const claim = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await claim.birth(value.allocated.paths, value.soul);
    const body = await claim.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    const stored = async (): Promise<Soul> => (await readHeart(value.allocated.paths)).soul!;

    assert.equal((await stored()).options.model, "claude-sonnet-4-5", "birth seeds the one current model");
    assert.equal(
      await recordCurrentModel(value.allocated.paths, { bodySequence: body.sequence, model: "claude-sonnet-4-5" }),
      "unchanged",
    );
    assert.equal(
      await recordCurrentModel(value.allocated.paths, { bodySequence: body.sequence, model: "claude-native" }),
      "recorded",
    );

    const moved = await stored();
    assert.equal(moved.options.model, "claude-native");
    assert.deepEqual(
      { ...moved, options: { ...moved.options, model: "claude-sonnet-4-5" } },
      value.soul,
      "every other Soul member is untouched",
    );

    assert.equal(
      await recordCurrentModel(value.allocated.paths, { bodySequence: body.sequence, model: undefined }),
      "recorded",
    );
    assert.equal((await stored()).options.model, undefined, "an unnamed replacement clears the selection");

    assert.equal(
      await recordCurrentModel(value.allocated.paths, { bodySequence: body.sequence + 1, model: "claude-late" }),
      "not-current-body",
      "a superseded Body cannot move the model",
    );
    assert.equal((await stored()).options.model, undefined);

    await recordCurrentModel(value.allocated.paths, { bodySequence: body.sequence, model: "claude-native" });
    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "broke-off",
      at: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(
      await recordCurrentModel(value.allocated.paths, { bodySequence: body.sequence, model: "claude-after" }),
      "not-current-body",
      "evidence from a settled Body is refused, never applied",
    );
    assert.equal((await stored()).options.model, "claude-native");
    claim.release();
  } finally {
    value.close();
  }
});

test("a model update preserves unrelated raw Soul members instead of re-encoding them", async () => {
  const value = await fixture();
  try {
    const claim = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await claim.birth(value.allocated.paths, value.soul);
    const body = await claim.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    // A Soul with members this build does not model. Decoding and re-encoding
    // would discard them; the narrow update must preserve them unchanged.
    const raw = {
      id: value.soul.id,
      akumaName: "claude",
      description: "Claude fixture",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: { model: "claude-sonnet-4-5", systemPrompt: "Be precise.", legacyKnob: true },
      cwd: value.root,
      origin: { kind: "direct" },
      createdAt: value.soul.createdAt,
      legacyMember: [1, 2],
    };
    const database = new DatabaseSync(value.allocated.paths.heart);
    try {
      database.prepare("UPDATE soul SET soul_json = ? WHERE singleton = 1").run(JSON.stringify(raw));
    } finally {
      database.close();
    }

    assert.equal(
      await recordCurrentModel(value.allocated.paths, { bodySequence: body.sequence, model: "claude-native" }),
      "recorded",
    );
    const after = new DatabaseSync(value.allocated.paths.heart);
    try {
      const row = after.prepare("SELECT soul_json FROM soul WHERE singleton = 1").get() as { soul_json: string };
      assert.deepEqual(JSON.parse(row.soul_json), {
        ...raw,
        options: { ...raw.options, model: "claude-native" },
      });
    } finally {
      after.close();
    }
    claim.release();
  } finally {
    value.close();
  }
});

test("a session keeps no model copy and an obsolete one never regains authority", async () => {
  const value = await fixture();
  try {
    const claim = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await claim.birth(value.allocated.paths, value.soul);
    const body = await claim.recordBody(value.allocated.paths, { leashTakenAt: value.soul.createdAt });
    await recordSession(value.allocated.paths, {
      provider: "claude",
      options: value.soul.options,
      coordinate: { sessionId: "native-session" },
      cwd: value.root,
      admittedAt: value.soul.createdAt,
    });
    const database = new DatabaseSync(value.allocated.paths.heart);
    try {
      const row = database.prepare("SELECT options_json FROM sessions ORDER BY sequence DESC LIMIT 1").get() as {
        options_json: string;
      };
      assert.deepEqual(JSON.parse(row.options_json), { systemPrompt: "Be precise." }, "a new session stores no model");
      // A row written before the model became one Soul member.
      database
        .prepare("UPDATE sessions SET options_json = ? WHERE sequence = (SELECT MAX(sequence) FROM sessions)")
        .run(JSON.stringify({ model: "claude-obsolete", systemPrompt: "Be precise." }));
    } finally {
      database.close();
    }
    assert.equal((await readHeart(value.allocated.paths)).latestSession?.options.model, undefined);

    await recordCurrentModel(value.allocated.paths, { bodySequence: body.sequence, model: "claude-native" });
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: value.soul.createdAt,
    });
    await endTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      outcome: {
        kind: "answered",
        historyId: "turn-1",
        session: { sessionId: "native-session" },
        answer: "done",
      },
      completedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.deepEqual(await readForkPoint(value.allocated.paths, `turn/${turn.sequence}`), {
      historyId: "turn-1",
      session: { sessionId: "native-session" },
      provider: "claude",
      cwd: value.root,
      options: { systemPrompt: "Be precise.", model: "claude-native" },
    });
    claim.release();
  } finally {
    value.close();
  }
});

test("fork birth admits the child session in the soul birth transaction", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(
      await body.birth(value.allocated.paths, value.soul, {
        provider: "claude",
        coordinate: { sessionId: "fork-child" },
        cwd: value.root,
        options: value.soul.options,
        admittedAt: "2026-08-08T00:00:00.000Z",
      }),
      "born",
    );
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession, {
      sequence: 1,
      provider: "claude",
      coordinate: { sessionId: "fork-child" },
      cwd: value.root,
      // A session admits a coordinate, never a model: the Soul owns the one
      // current model and composes it freshly into every Turn.
      options: { systemPrompt: "Be precise." },
      admittedAt: "2026-08-08T00:00:00.000Z",
    });
    body.release();
  } finally {
    value.close();
  }
});

test("Body idle settlement atomically checks queued work and current control", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
    await recordTell(value.allocated.paths, { id: "racing-idle", body: "run next", recordedAt: value.soul.createdAt });
    assert.deepEqual(
      await finishBodyIfIdle(value.allocated.paths, {
        sequence: body.sequence,
        at: "2026-08-08T00:00:01.000Z",
      }),
      { kind: "pending", tells: ["racing-idle"] },
    );
    await insertLegacyPauseControl(value.allocated.paths, body.sequence, "2026-08-08T00:00:01.000Z");
    assert.deepEqual(
      await finishBodyIfIdle(value.allocated.paths, {
        sequence: body.sequence,
        at: "2026-08-08T00:00:02.000Z",
      }),
      { kind: "controlled" },
    );
    assert.equal((await readHeart(value.allocated.paths)).latestBody?.end, undefined,
      "control judgment alone is not provider closure proof");
    await cancelBodyTurns(value.allocated.paths, { bodySequence: body.sequence, at: "2026-08-08T00:00:02.000Z" });
    assert.equal((await readHeart(value.allocated.paths)).latestBody?.end, "put-down");
    leash.release();
  } finally {
    value.close();
  }
});

test("life is the sole leash and settlement interpretation", async () => {
  const body = { sequence: 1, leashTakenAt: "2026-08-08T00:00:00.000Z" };
  const kill = { sequence: 1, bodySequence: 1, evidence: "killed" as const, at: "life" };
  const project = (input: Partial<Parameters<typeof life>[0]>) =>
    life({
      leash: "free",
      body,
      kill: null,
      ...input,
    });
  assert.equal(project({ leash: "held", kill }), "running");
  assert.equal(project({ leash: "held" }), "running");
  assert.equal(
    project({
      leash: "held",
      body: {
        ...body,
        hung: { diagnostic: "provider custody remained live", at: "2026-08-08T00:00:02.000Z" },
      },
    }),
    "hung",
  );
  assert.equal(project({}), "untidy");
  assert.equal(project({ body: { ...body, end: "exited" } }), "asleep");
  assert.equal(project({ body: { ...body, end: "broke-off" } }), "stranded");
  assert.equal(project({ body: { ...body, end: "put-down" }, kill }), "killed");
});

test("Body hung custody evidence round trips through Heart", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
    await leash.recordBodyHung(value.allocated.paths, {
      sequence: body.sequence,
      diagnostic: "provider custody remained live",
      at: "2026-08-08T00:00:01.000Z",
    });
    assert.deepEqual((await readHeart(value.allocated.paths)).latestBody?.hung, {
      diagnostic: "provider custody remained live",
      at: "2026-08-08T00:00:01.000Z",
    });
    await breakBody(value.allocated.paths, {
      sequence: body.sequence,
      end: "broke-off",
      at: "2026-08-08T00:00:02.000Z",
    });
    assert.equal(
      life({ leash: "held", body: (await readHeart(value.allocated.paths)).latestBody, kill: null }),
      "hung",
    );
    leash.release();
    assert.equal(
      life({ leash: "free", body: (await readHeart(value.allocated.paths)).latestBody, kill: null }),
      "hung",
    );
    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await assert.rejects(
      successor.recordBody(value.allocated.paths, {
        leashTakenAt: "2026-08-08T00:00:03.000Z",
      }),
      /permanently gated by hung custody/u,
    );
    successor.release();
    await assert.rejects(
      leash.recordBodyHung(value.allocated.paths, {
        sequence: body.sequence,
        diagnostic: "late fabricated custody",
        at: "2026-08-08T00:00:02.000Z",
      }),
      /not owned by this leash/u,
    );
  } finally {
    value.close();
  }
});

function codecSoul(): Soul {
  return {
    id: "aku/claude/1234abcd" as Soul["id"],
    akumaName: "claude",
    description: "Codec fixture",
    provider: {
      name: "codex",
      kind: "codex-app-server",
      executable: "codex",
      config: { flag: true },
      env: { HOME: "/tmp/home" },
    },
    options: { model: "claude-sonnet-4-5", effort: "high", network: "disabled", systemPrompt: "Work." },
    cwd: "/tmp/work",
    origin: {
      kind: "fork",
      parent: "aku/parent/1234abcd" as Soul["id"],
      at: "turn/1",
    },
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

test("soul codec hard-fails invalid known members", () => {
  // prettier-ignore
  const corruptions: readonly Readonly<{ name: string; change: (soul: Soul) => unknown }>[] = [
    { name: "missing required field", change: (soul) => { const copy = { ...soul }; delete (copy as Record<string, unknown>).cwd; return copy; } },
    { name: "unknown systemPromptMode", change: (soul) => ({ ...soul, options: { ...soul.options, systemPromptMode: "merge" } }) },
    { name: "systemPromptMode without systemPrompt", change: (soul) => {
      const options = { ...soul.options, systemPromptMode: "append" };
      delete (options as { systemPrompt?: string }).systemPrompt;
      return { ...soul, options };
    } },
    { name: "unknown provider kind", change: (soul) => ({ ...soul, provider: { ...soul.provider, kind: "grok" } }) },
    { name: "blank provider name", change: (soul) => ({ ...soul, provider: { ...soul.provider, name: " " } }) },
    { name: "provider env non-string value", change: (soul) => ({ ...soul, provider: { ...soul.provider, env: { HOME: 9 } } }) },
    { name: "fork origin parent has extra segment", change: (soul) => ({ ...soul, origin: { kind: "fork", parent: "aku/parent/1234abcd/extra", at: "history" } }) },
    { name: "unknown origin kind", change: (soul) => ({ ...soul, origin: { kind: "rebirth" } }) },
    { name: "id is not an Akuma coordinate", change: (soul) => ({ ...soul, id: "garbage" }) },
    { name: "id has a single segment", change: (soul) => ({ ...soul, id: "aku/claude" }) },
    { name: "id suffix is not lower hex8", change: (soul) => ({ ...soul, id: "aku/claude/nothex" }) },
    { name: "id has an extra segment", change: (soul) => ({ ...soul, id: "aku/claude/1234abcd/extra" }) },
    { name: "id akumaName is not normalized", change: (soul) => ({ ...soul, id: "aku/Claude/1234abcd" }) },
    { name: "id and akumaName disagree", change: (soul) => ({ ...soul, akumaName: "worker" }) },
    { name: "blank cwd", change: (soul) => ({ ...soul, cwd: "" }) },
    { name: "blank description", change: (soul) => ({ ...soul, description: " " }) },
  ];
  for (const { name, change } of corruptions) {
    assert.throws(() => decodeSoul(change(codecSoul())), undefined as never, name);
    assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify(change(codecSoul())) }), HeartAuthorityCorruptionError, name);
    assert.throws(() => encodeSoulRow(change(codecSoul()) as Soul), undefined as never, name);
  }
  assert.throws(() => decodeSoulRow({ soul_json: "not json" }), (error: unknown) => {
    assert.ok(error instanceof HeartAuthorityCorruptionError);
    assert.equal(error.category, "authority-corruption");
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
  assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify("garbage") }));
  assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify(42) }));
});



test("Soul caller attribution shares admission validation and preserves legal absence", async (context) => {
  const { decodeAkumaCaller, projectAkumaBirth } = await import("../src/akuma/caller.js");
  const unknown = decodeSoul(codecSoul());
  assert.equal("caller" in unknown, false);
  assert.deepEqual(projectAkumaBirth(unknown).caller, { kind: "unknown" });
  assert.equal(JSON.stringify(unknown).includes('"caller"'), false);
  // Attribution stores a canonical coordinate, so an absent World is admitted without a lookup.
  const absentWorld = join(temporaryDirectory(context, "keiyaku-akuma-caller-"), "nonexistent-world");
  assert.equal(existsSync(absentWorld), false);
  for (const caller of [
    { kind: "akuma", world: absentWorld, akumaId: "aku/delegator/1234abcd" },
    { kind: "external", integration: "slack", id: "channel:thread" },
  ]) {
    const admitted = decodeAkumaCaller(caller);
    assert.deepEqual(decodeSoul({ ...codecSoul(), caller }).caller, admitted);
    assert.deepEqual(projectAkumaBirth(decodeSoul({ ...codecSoul(), caller })).caller, admitted);
  }
  for (const caller of [
    null, { kind: "unknown" },
    { kind: "akuma", world: "relative", akumaId: "aku/parent/1234abcd" },
    { kind: "akuma", world: "/world/../elsewhere", akumaId: "aku/parent/1234abcd" },
    { kind: "akuma", world: absentWorld, akumaId: "aku/Parent/1234abcd" },
    { kind: "external", integration: "Upper", id: "id" },
    { kind: "external", integration: "slack", id: " " },
    { kind: "external", integration: "slack", id: "a\u0000b" },
    { kind: "external", integration: "slack", id: "x".repeat(513) },
  ]) {
    assert.throws(() => decodeAkumaCaller(caller), /Invalid Akuma caller/u);
    assert.throws(() => decodeSoul({ ...codecSoul(), caller }), /Invalid Akuma caller/u);
  }
});






function seedClosedHistoryActivity(paths: Parameters<typeof readHeart>[0], turnSequence: number, count: number): void {
  const database = new DatabaseSync(paths.heart);
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const latest = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM timeline").get() as {
      value: number;
    };
    database
      .prepare(
        `WITH RECURSIVE rows(value) AS (
      VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < ?
    ) INSERT INTO timeline(kind) SELECT 'activity' FROM rows`,
      )
      .run(count);
    database
      .prepare(
        `INSERT INTO activity(sequence, turn_sequence, event_json, at)
      SELECT sequence, ?, '{"type":"note","text":"old history"}', '2026-08-08T00:00:10.000Z'
      FROM timeline WHERE sequence > ?`,
      )
      .run(turnSequence, latest.value);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

test("pruning preserves historical Tell references and their terminal evidence", async () => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  const database = new DatabaseSync(paths.heart);
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    for (const id of ["delivered", "undelivered", "unreferenced"]) {
      await recordTell(paths, { id, body: id, recordedAt: at });
    }
    database.prepare("INSERT INTO tell_dispositions (body_sequence, decided_at, resolved_at) VALUES (?, ?, ?)")
      .run(body.sequence, at, at);
    database.prepare("INSERT INTO tell_disposition_members (body_sequence, tell_id) VALUES (?, 'delivered'), (?, 'undelivered')")
      .run(body.sequence, body.sequence);
    const originalDecision = database.prepare("SELECT * FROM tell_dispositions").all();
    const originalMembers = database.prepare("SELECT * FROM tell_disposition_members ORDER BY tell_id").all();
    await recordTellReceipt(paths, { kind: "undelivered", evidence: "exact", tellId: "undelivered", receivedAt: at });
    for (const tellId of ["delivered", "unreferenced"]) {
      const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
      await recordTellDeliveries(paths, [{
        tellId,
        route: "live",
        receipt: "required",
        turnSequence: turn.sequence,
        fence: tellId,
        deliveredAt: at,
      }]);
      await recordTellReceipt(paths, {
        kind: "confirmed",
        evidence: "fence",
        turnSequence: turn.sequence,
        fence: tellId,
        receivedAt: at,
      });
      await endTurn(paths, {
        turnSequence: turn.sequence,
        outcome: { kind: "answered", answer: "done", session: { sessionId: "historical" } },
        completedAt: at,
      });
    }
    const active = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    seedClosedHistoryActivity(paths, active.sequence, 5501);
    await appendActivity(paths, { turnSequence: active.sequence, event: { type: "note", text: "prune" }, at });

    assert.equal(await readTell(paths, "unreferenced"), null);
    assert.equal(database.prepare("SELECT 1 FROM tell_terminal_receipts WHERE tell_id = 'unreferenced'").get(), undefined);
    assert.equal((await readTell(paths, "delivered"))?.state, "told");
    assert.equal((await readTell(paths, "undelivered"))?.state, "told");
    assert.deepEqual((await readHeart(paths)).pending, []);
    assert.deepEqual(database.prepare("SELECT * FROM tell_dispositions").all(), originalDecision);
    assert.deepEqual(database.prepare("SELECT * FROM tell_disposition_members ORDER BY tell_id").all(), originalMembers);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
    leash.release();
    value.close();
  }
});

test("protected backlog does not repeat unchanged sweeps and releasing a Tell triggers reclamation", async (t) => {
  const value = await fixture();
  const paths = value.allocated.paths;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    const database = new DatabaseSync(paths.heart);
    try {
      database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      const insert = database.prepare("INSERT INTO timeline(kind) VALUES ('tell')");
      const tell = database.prepare("INSERT INTO tells(id, sequence, body, recorded_at) VALUES (?, ?, 'pending', ?)");
      for (let index = 0; index < 5501; index += 1) tell.run(`pending-${index}`, insert.run().lastInsertRowid, at);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    const prepare = DatabaseSync.prototype.prepare;
    let sweeps = 0;
    let fullCounts = 0;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql.includes("DELETE FROM timeline")) sweeps += 1;
      if (/COUNT\(\*\).*FROM timeline/i.test(sql)) fullCounts += 1;
      return prepare.call(this, sql);
    });
    // Each append reopens Heart, so the assertion also proves the maintenance
    // cursor survives connection lifetimes rather than being an in-memory cache.
    for (let index = 0; index < 20; index += 1)
      await appendActivity(paths, {
        turnSequence: turn.sequence,
        event: { type: "note", text: `update-${index}` },
        at,
      });
    assert.equal(sweeps, 1, "protected-only sweeps are not repeated for every append");
    assert.equal(fullCounts, 0, "the append path must not count the full retained timeline");
    await recordTellReceipt(paths, { evidence: "exact", tellId: "pending-0", kind: "consumed", receivedAt: at });
    assert.equal(sweeps, 2, "releasing protection creates a reclamation opportunity without 500 new events");
    assert.equal(await readTell(paths, "pending-0"), null);
    assert.equal((await readTell(paths, "pending-1"))?.state, "pending");
    const retained = await readHeart(paths);
    assert.equal(retained.pending.length, 5500);
  } finally {
    leash.release();
    value.close();
  }
});
