import { deferred, temporaryDirectory } from "./support/process.js";
import { recordTell, soulFixture, bornBody, insertLegacyPauseControl } from "./support/akuma-fixtures.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AkumaOwner, settleAkumaKill } from "../src/akuma/akuma-owner.js";
import { AkumaKillError, AkumaWorkdirMissingError } from "../src/akuma/akuma-errors.js";
import { executeKillAkuma, executeTellAkuma } from "../src/akuma/akuma-selection-execution.js";
import { tellText } from "../src/cli/render/akuma-activity.js";
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
  readHeart,
  readForkPoint,
  readLatestTurnForBody,
  readTell,
  readTellAction,
  recordCurrentModel,
  recordSession,
  recordSurveillance,
  recordTell as heartRecordTell,
  recordTellDeliveries,
  recordTellReceipt,
  readTurn,
  requestStop,
  type Soul,
} from "../src/akuma/heart/index.js";
import { decodeSoul } from "../src/akuma/heart/soul.js";
import { HeartAuthorityCorruptionError } from "../src/akuma/heart/facts.js";
import { withHeartTransaction, withReadOnlyHeart } from "../src/akuma/heart/storage.js";
import { surveillanceAudience } from "../src/akuma/heart/surveillance.js";
import { pruneActivityFacts } from "../src/akuma/heart/timeline.js";
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

test("attributed standing commits with Soul and never comes from frozen caller or a birth replay", async () => {
  const value = await fixture();
  const { id, paths } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await withHeartTransaction(paths, (db) => db.exec(`CREATE TRIGGER refuse_standing BEFORE INSERT ON surveillance
      BEGIN SELECT RAISE(ABORT, 'standing denied'); END`));
    await assert.rejects(leash.birth(paths, value.soul, undefined, "opaque:birth/owner"), /standing denied/u);
    assert.equal((await readHeart(paths)).soul, null);
    assert.deepEqual((await activitySlice(paths)).rows, []);
    await withHeartTransaction(paths, (db) => db.exec("DROP TRIGGER refuse_standing"));
    assert.equal(await leash.birth(paths, value.soul, undefined, "opaque:birth/owner"), "born");
    assert.equal(await leash.birth(paths, value.soul, undefined, "opaque:not-the-birth"), "already-born");
    assert.deepEqual(await withReadOnlyHeart(paths, (db) => surveillanceAudience(db, null)), ["opaque:birth/owner"]);
    assert.deepEqual((await activitySlice(paths)).rows, [
      { kind: "surveillance", sequence: 1, owner: "opaque:birth/owner", off: false, at: value.soul.createdAt },
    ]);
    assert.deepEqual((await readHeart(paths)).soul, { ...value.soul, id });
  } finally {
    leash.release();
    value.close();
  }
});

test("self-withdrawal is idempotent across open Turns and survives compaction without excluding a later binding", async () => {
  const value = await fixture();
  const { id, paths } = value.allocated;
  const owner = "opaque:alpha";
  const other = "opaque:beta";
  const { createdAt: at } = value.soul;
  const leash = (await HeldAkumaLeash.try(paths))!;
  const owners = (turn: number | null) => withReadOnlyHeart(paths, (db) => surveillanceAudience(db, turn));
  const toggle = (off: boolean) => recordSurveillance(paths, id, owner, off);
  try {
    await leash.birth(paths, { ...value.soul, caller: { kind: "external", integration: "square", id: owner } });
    assert.deepEqual(await owners(null), []);
    assert.equal(await toggle(false), "recorded");
    assert.equal(await recordSurveillance(paths, id, other, false), "recorded");
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    const first = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at, initiator: owner });
    const second = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    for (const tellId of ["old", "pending-before-off"]) {
      await recordTell(paths, { id: tellId, body: tellId, initiator: owner, recordedAt: at });
    }
    const bind = (sequence: number, tellId: string) => bindTellsToTurn(paths, {
      turnSequence: sequence, tellIds: [tellId], boundAt: at,
    });
    await bind(second.sequence, "old");
    await recordTellDeliveries(paths, [{ tellId: "old", route: "launch", turnSequence: second.sequence, fence: "old", deliveredAt: at }]);
    await withHeartTransaction(paths, (db) => db.exec("UPDATE sqlite_sequence SET seq=9000 WHERE name='tell_bindings'"));
    assert.deepEqual(await owners(first.sequence), [owner, other]);
    assert.deepEqual(await owners(second.sequence), [owner, other]);
    assert.equal(await toggle(false), "unchanged");
    assert.equal(await toggle(true), "recorded");
    const after = await activitySlice(paths);
    assert.equal(await toggle(true), "unchanged");
    assert.deepEqual(await activitySlice(paths), after);
    await withHeartTransaction(paths, (db) => pruneActivityFacts(db, 2, true));
    await bind(second.sequence, "old");
    assert.deepEqual(await owners(first.sequence), [other]);
    assert.deepEqual(await owners(second.sequence), [other]);
    assert.equal((await readTurn(paths, first.sequence))?.initiator, owner);
    assert.equal((await readTell(paths, "old"))?.initiator, owner);
    await bind(second.sequence, "pending-before-off");
    assert.deepEqual(await owners(first.sequence), [other]);
    assert.deepEqual(await owners(second.sequence), [owner, other]);
    assert.deepEqual(await owners(null), [other]);
  } finally {
    leash.release();
    value.close();
  }
});

test("terminal audience does not move to a later Turn, and abnormal Body end only uses its own latest open Turn", async () => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  const at = value.soul.createdAt;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul, undefined, "standing");
    const first = await leash.recordBody(paths, { leashTakenAt: at });
    await beginTurn(paths, { bodySequence: first.sequence, startedAt: at, initiator: "earlier-still-open" });
    const latest = await beginTurn(paths, { bodySequence: first.sequence, startedAt: at, initiator: "latest" });
    const terminal = await endTurn(paths, { turnSequence: latest.sequence, completedAt: at, outcome: { kind: "canceled" } });
    assert.deepEqual(terminal.audience, { kind: "known", owners: ["latest", "standing"] });
    const firstEnd = await breakBody(paths, { sequence: first.sequence, end: "broke-off", at });
    leash.release();
    const successor = (await HeldAkumaLeash.try(paths))!;
    try {
      const second = await successor.recordBody(paths, { leashTakenAt: at });
      await beginTurn(paths, { bodySequence: second.sequence, startedAt: at, initiator: "successor-open" });
      const secondEnd = await breakBody(paths, { sequence: second.sequence, end: "broke-off", at });
      assert.equal(await recordSurveillance(paths, id, "standing", true), "recorded");
      assert.deepEqual(firstEnd, {
        bodySequence: first.sequence, end: "broke-off", at, audience: { kind: "known", owners: ["standing"] },
      });
      assert.deepEqual(secondEnd?.audience, { kind: "known", owners: ["standing", "successor-open"] });
      assert.equal(await breakBody(paths, { sequence: second.sequence, end: "broke-off", at }), undefined);
      assert.deepEqual(terminal.audience, { kind: "known", owners: ["latest", "standing"] }, "withdrawal does not rewrite handed-off evidence");
    } finally {
      successor.release();
    }
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
test("retired frozen directory refuses new Tell without changing an exact previously admitted input", async () => {
  const value = await fixture();
  const { id, paths } = value.allocated;
  const vanishedCwd = join(value.root, "vanished-cwd");
  mkdirSync(vanishedCwd);
  try {
    const born = (await HeldAkumaLeash.try(paths))!;
    await born.birth(paths, { ...value.soul, cwd: vanishedCwd });
    born.release();
    const owner = new AkumaOwner(id, value.root);
    const input = { tellId: "already-admitted", recordedAt: value.soul.createdAt };
    const prior = await owner.admitTell("keep the original", input);
    assert.ok(prior.kind === "recorded");
    rmdirSync(vanishedCwd);
    await assert.rejects(owner.tell("new input", "never-admitted", input.recordedAt, tellWakeRuntime(spawnAkumaBody)), (error: unknown) => {
      assert.ok(error instanceof AkumaWorkdirMissingError);
      assert.deepEqual(projectFailure(error).frozenWorkdir, { id, cwd: vanishedCwd });
      assert.ok(error.message.startsWith(`Cannot wake ${id}: frozen execution directory ${vanishedCwd}`));
      assert.match(error.message, /Spawn a fresh Akuma in a live workdir/u);
      return true;
    });
    const replay = await owner.tell("keep the original", input.tellId, input.recordedAt, {
      spawn: () => assert.fail("known-missing replay must not wake"),
    });
    assert.deepEqual(replay.admission, { tellId: input.tellId });
    assert.deepEqual((await readHeart(paths)).pending, [prior.tell]);
    assert.equal(await readTell(paths, "never-admitted"), null);
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
    assert.ok(diagnostic.startsWith(`Wake of ${value.allocated.id} failed:`));
    assert.match(diagnostic, /re-enter with a live runtime/u);
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

test("frozen directory lost after admission reports the exact Tell and settles it only with custody", async () => {
  for (const settlementFails of [false, true]) {
    const value = await fixture();
    const { id, paths } = value.allocated;
    const cwd = join(value.root, "vanished-at-launch");
    const retiredLeash = `${paths.leash}.fixture`;
    const tellId = "lost-at-launch";
    mkdirSync(cwd);
    try {
      const born = (await HeldAkumaLeash.try(paths))!;
      await born.birth(paths, { ...value.soul, cwd });
      const body = await born.recordBody(paths, { leashTakenAt: value.soul.createdAt });
      assert.equal((await finishBodyIfIdle(paths, { sequence: body.sequence, at: value.soul.createdAt })).kind, "finished");
      born.release();
      const result = await executeTellAkuma({ id, path: value.root, tellId, body: "continue", spawn: async (launch) => {
        assert.equal((await readTell(paths, tellId))?.state, "pending");
        rmdirSync(cwd);
        if (settlementFails) renameSync(paths.leash, retiredLeash);
        return await spawnAkumaBody(launch);
      } });
      if (settlementFails) renameSync(retiredLeash, paths.leash);
      assert.ok("result" in result && result.result === "failed" && result.tellId === tellId);
      const [wake] = result.failures;
      assert.ok(wake.stage === "wake");
      assert.ok(wake.diagnostic.startsWith(`Cannot wake ${id}: frozen execution directory ${cwd}`));
      if (settlementFails) {
        assert.equal(wake.reason, undefined);
        assert.ok(wake.diagnostic.includes(`Could not settle the exact Tell: Akuma Heart database is absent: ${paths.leash}`));
        assert.equal((await readTellAction(paths, tellId)).kind, "pending");
      } else {
        assert.equal(wake.reason, "undelivered");
        const text = tellText(result, "continue", undefined);
        assert.ok(text.includes("! tell delivery failed · undelivered"));
        assert.ok(text.includes(wake.diagnostic));
        assert.deepEqual(await readTellAction(paths, tellId), { kind: "undelivered" });
        const owner = new AkumaOwner(id, value.root);
        assert.equal((await owner.status()).work.kind, "idle");
        assert.equal((await owner.waitReceipt({ timeoutMs: 0 })).reason, "completed");
      }
      assert.equal(await readLatestTurnForBody(paths, body.sequence), null);
    } finally {
      value.close();
    }
  }
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
