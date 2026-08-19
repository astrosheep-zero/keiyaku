import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import {
  HeldAkumaLeash,
  admitRequest,
  activitySlice,
  appendActivity,
  beginTurn,
  breakBody,
  endTurn,
  finishBodyIfIdle,
  heartExists,
  initializeHeart,
  HeartAbsentError,
  life,
  probeLeash,
  pauseRequested,
  readHeart,
  readForkPoint,
  readSoul,
  readNonterminalRequests,
  readRequest,
  recordSession,
  recordTell,
  recordTellDeliveries,
  recordTellReceipt,
  requestPause,
  requestStop,
  reserveRequest,
  serveRequest,
  stopRequested,
  refuseRequest,
  voidRequest,
  type Soul,
} from "../src/akuma/heart/index.js";
import { insertActivityFact, insertKillFact, insertSessionFact, insertStopControl } from "../src/akuma/heart/rows.js";
import { decodeSoul, decodeSoulRow, encodeSoul, encodeSoulRow } from "../src/akuma/heart/soul.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { insertTellFact } from "../src/akuma/heart/tells.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-heart-"));
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
  await initializeHeart(allocated.paths);
  const soul: Soul = {
    id: allocated.id,
    archetype: "claude",
    description: "Claude fixture",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "claude-sonnet-4-5", systemPrompt: "Be precise." },
    cwd: root,
    origin: { kind: "direct" },
    allowed: ALLOWED_ACTIONS,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
  return { root, allocated, soul, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("existing Heart opens adjudicate absence without recreating heart.db", async () => {
  const value = await fixture();
  try {
    unlinkSync(value.allocated.paths.heart);
    assert.equal(await heartExists(value.allocated.paths), false);
    assert.equal(await readSoul(value.allocated.paths), null);
    assert.deepEqual(await readHeart(value.allocated.paths), {
      soul: null,
      latestBody: null,
      latestSession: null,
      pending: [],
      latestKill: null,
      stop: null,
      pause: null,
    });
    assert.equal(await readForkPoint(value.allocated.paths, "missing"), null);
    await assert.rejects(
      appendActivity(value.allocated.paths, {
        turnSequence: 1,
        event: { type: "note", text: "must not recreate" },
        at: "2026-08-08T00:00:00.000Z",
      }),
      HeartAbsentError,
    );
    assert.equal(existsSync(value.allocated.paths.heart), false);
  } finally { value.close(); }
});

test("existing non-database Heart paths preserve the SQLite open failure", async () => {
  const value = await fixture();
  try {
    unlinkSync(value.allocated.paths.heart);
    mkdirSync(value.allocated.paths.heart);
    await assert.rejects(
      readHeart(value.allocated.paths),
      (error: unknown) => {
        assert.equal(error instanceof HeartAbsentError, false);
        assert.equal(typeof (error as { errcode?: unknown }).errcode, "number");
        return true;
      },
    );
    assert.equal(existsSync(value.allocated.paths.heart), true);
  } finally { value.close(); }
});

test("birth and seal share the child's leash adjudicator", async () => {
  const value = await fixture();
  try {
    const sealer = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(await sealer.sealIfUnborn(value.allocated.paths, { evidence: "call-timeout", at: value.soul.createdAt }), "sealed");
    const lateBody = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(await lateBody.birth(value.allocated.paths, value.soul), "sealed");
    lateBody.release();
  } finally { value.close(); }
});

test("a born soul cannot later be sealed", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(await body.birth(value.allocated.paths, value.soul), "born");
    assert.deepEqual((await readHeart(value.allocated.paths)).soul, value.soul);
    assert.equal(await probeLeash(value.allocated.paths), "held");
    body.release();
    const sealer = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(await sealer.sealIfUnborn(value.allocated.paths, { evidence: "late", at: value.soul.createdAt }), "born");
    sealer.release();
  } finally { value.close(); }
});

test("session admission survives before turn completion", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const fact = await recordSession(value.allocated.paths, {
      provider: "claude",
      options: value.soul.options,
      coordinate: { sessionId: "native-session" },
      cwd: value.root,
      admittedAt: "2026-08-08T00:00:01.000Z",
    });
    body.release();
    assert.equal((await readHeart(value.allocated.paths)).latestSession?.sequence, fact.sequence);
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession?.coordinate, { sessionId: "native-session" });
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession?.options, value.soul.options);
  } finally { value.close(); }
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
  } finally { value.close(); }
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
      id: "tell-1", body: "first", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(admitted.kind, "recorded");
    if (admitted.kind !== "recorded") return;
    const afterActivity = await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "after" },
      at: "2026-08-08T00:00:02.000Z",
    });
    assert.deepEqual([firstActivity, admitted.tell.sequence, afterActivity], [2, 3, 4]);
    assert.deepEqual((await activitySlice(value.allocated.paths)).rows.map((fact) => fact.kind), [
      "turn-start", "activity", "tell", "activity",
    ]);

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
  } finally { value.close(); }
});

test("tell admission refuses an unborn heart without writing its timeline", async () => {
  const value = await fixture();
  try {
    assert.deepEqual(await recordTell(value.allocated.paths, {
      id: "tell-unborn", body: "future input", recordedAt: "2026-08-08T00:00:01.000Z",
    }), { kind: "not-born" });
    assert.deepEqual((await activitySlice(value.allocated.paths)).rows, []);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
  } finally { value.close(); }
});

test("live receipts are terminal only under their exact Heart correlation", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const firstTurn = await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const required = await recordTell(value.allocated.paths, {
      id: "tell-required", body: "wait for receipt", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const unavailable = await recordTell(value.allocated.paths, {
      id: "tell-unavailable", body: "ack is terminal", recordedAt: "2026-08-08T00:00:02.000Z",
    });
    assert.equal(required.kind, "recorded");
    assert.equal(unavailable.kind, "recorded");
    await recordTellDeliveries(value.allocated.paths, [{
      tellId: "tell-required", route: "live", receipt: "required",
      turnSequence: firstTurn.sequence,
      fence: "shared-fence", deliveredAt: "2026-08-08T00:00:03.000Z",
    }, {
      tellId: "tell-unavailable", route: "live", receipt: "unavailable",
      turnSequence: firstTurn.sequence,
      fence: "ack-fence", deliveredAt: "2026-08-08T00:00:03.000Z",
    }]);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending.map((tell) => tell.id), ["tell-required"]);
    await assert.rejects(recordTellReceipt(value.allocated.paths, {
      evidence: "fence", turnSequence: firstTurn.sequence + 1, fence: "shared-fence",
      kind: "accepted", receivedAt: "2026-08-08T00:00:04.000Z",
    }), /no delivery mapping/u);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending.map((tell) => tell.id), ["tell-required"]);
    await recordTellReceipt(value.allocated.paths, {
      evidence: "fence", turnSequence: firstTurn.sequence, fence: "shared-fence",
      kind: "accepted", receivedAt: "2026-08-08T00:00:05.000Z",
    });
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);

    const exact = await recordTell(value.allocated.paths, {
      id: "tell-exact", body: "exact", recordedAt: "2026-08-08T00:00:06.000Z",
    });
    assert.equal(exact.kind, "recorded");
    await recordTellReceipt(value.allocated.paths, {
      evidence: "exact", tellId: "tell-exact", kind: "consumed", receivedAt: "2026-08-08T00:00:07.000Z",
    });
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
    body.release();
  } finally { value.close(); }
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
      id: "tell-pending", body: "pending", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(pending.kind, "recorded");
    const request = await admitRequest(value.allocated.paths, {
      id: "00000000-0000-4000-8000-000000000010",
      action: "akuma.call",
      archetype: "claude",
      body: "child work",
      world: value.root,
      recipe: {
        description: value.soul.description,
        provider: value.soul.provider,
        options: value.soul.options,
        allowed: value.soul.allowed,
      },
      admittedAt: "2026-08-08T00:00:02.000Z",
    });
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
    assert.deepEqual(snapshot.pending.map((tell) => tell.id), ["tell-pending"]);
    assert.equal((await readRequest(value.allocated.paths, request.id))?.state, "admitted");
    assert.equal(life({
      leash: "free",
      body: { ...firstBody, end: "put-down" },
      kill: snapshot.latestKill,
    }), "killed");

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
    assert.equal(life({
      leash: "free",
      body: { ...secondBody, end: "exited" },
      kill: snapshot.latestKill,
    }), "asleep");
    await recordTellDeliveries(value.allocated.paths, [{
      tellId: "tell-pending",
      route: "launch",
      turnSequence: secondTurn.sequence,
      fence: "successor",
      deliveredAt: "2026-08-08T00:00:05.000Z",
    }]);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
    assert.equal((await readRequest(value.allocated.paths, request.id))?.state, "admitted");
    successor.release();
  } finally { value.close(); }
});

test("retention uses a bounded settled buffer while pending tells remain pinned", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const admitted = await recordTell(value.allocated.paths, {
      id: "tell-pinned", body: "keep me", recordedAt: "2026-08-08T00:00:00.000Z",
    });
    assert.equal(admitted.kind, "recorded");
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const heart = new DatabaseSync(value.allocated.paths.heart);
    try {
      heart.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      heart.prepare(`WITH RECURSIVE rows(value) AS (
        VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 5501
      ) INSERT INTO timeline(kind) SELECT 'activity' FROM rows`).run();
      heart.prepare(`INSERT INTO activity(sequence, turn_sequence, event_json, at)
        SELECT sequence, ?, '{"type":"note","text":"buffered"}', '2026-08-08T00:00:01.000Z'
        FROM timeline WHERE kind = 'activity'`).run(turn.sequence);
      heart.exec("COMMIT");
    } catch (error) {
      heart.exec("ROLLBACK");
      throw error;
    } finally { heart.close(); }

    await appendActivity(value.allocated.paths, {
    turnSequence: turn.sequence,
      event: { type: "note", text: "trigger compaction" },
      at: "2026-08-08T00:00:02.000Z",
    });
    let retained = await activitySlice(value.allocated.paths);
    assert.equal(retained.rows.some((fact) => "id" in fact && fact.id === "tell-pinned"), true);
    assert.equal(retained.rows.filter((fact) => fact.kind === "activity").length, 5_000);

    await recordTellReceipt(value.allocated.paths, {
      evidence: "exact", tellId: "tell-pinned", kind: "consumed", receivedAt: "2026-08-08T00:00:03.000Z",
    });
    for (let index = 0; index < 501; index += 1) {
      await appendActivity(value.allocated.paths, {
        turnSequence: turn.sequence,
        event: { type: "note", text: `after-${index}` },
        at: "2026-08-08T00:00:04.000Z",
      });
    }
    retained = await activitySlice(value.allocated.paths);
    assert.equal(retained.rows.some((fact) => "id" in fact && fact.id === "tell-pinned"), false);
    assert.ok(retained.rows.length >= 5_000 && retained.rows.length <= 5_500);
    leash.release();
  } finally { value.close(); }
});

test("Body Request facts have one idempotent monotonic authority", async () => {
  const value = await fixture();
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  try {
    await leash.birth(value.allocated.paths, value.soul);
    const input = {
      id: "00000000-0000-4000-8000-000000000001",
      action: "akuma.call" as const,
      archetype: "claude",
      body: "build",
      world: value.root,
      recipe: {
        description: value.soul.description,
        provider: value.soul.provider,
        options: value.soul.options,
        allowed: value.soul.allowed,
      },
      admittedAt: "2026-08-08T00:00:01.000Z",
    };
    assert.equal((await admitRequest(value.allocated.paths, input)).state, "admitted");
    assert.equal((await admitRequest(value.allocated.paths, { ...input, admittedAt: "later" })).admittedAt, input.admittedAt);
    assert.deepEqual((await readNonterminalRequests(value.allocated.paths)).map((request) => request.id), [input.id]);

    const child = await allocateAkumaDirectory({ worldRoot: value.root, archetype: "claude", draw: () => "deadbeef" });
    assert.equal((await reserveRequest(value.allocated.paths, input.id, child.id)).state, "reserved");
    assert.equal((await serveRequest(value.allocated.paths, input.id, child.id)).state, "served");
    assert.equal((await readRequest(value.allocated.paths, input.id))?.state, "served");
    assert.deepEqual(await readNonterminalRequests(value.allocated.paths), []);

    const refused = await admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000002",
      body: "refuse",
    });
    assert.equal((await refuseRequest(value.allocated.paths, refused.id, "unknown Archetype")).state, "refused");
    const voided = await admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000003",
      body: "void",
    });
    assert.equal((await voidRequest(value.allocated.paths, voided.id, "caller gone")).state, "voided");

    assert.deepEqual(await readNonterminalRequests(value.allocated.paths), []);
  } finally {
    leash.release();
    value.close();
  }
});

test("heart schema version 20 and leash schema version 4 hard-refuse old authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-schema-cut-"));
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "30000000" });
  try {
    const heart = new DatabaseSync(allocated.paths.heart);
    heart.exec("CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO akuma_schema VALUES (1, 14)");
    heart.close();
    const leash = new DatabaseSync(allocated.paths.leash);
    leash.exec("CREATE TABLE leash_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO leash_schema VALUES (1, 2)");
    leash.close();
    await assert.rejects(readHeart(allocated.paths), /heart schema version must be 20/u);
    await assert.rejects(HeldAkumaLeash.try(allocated.paths), /leash schema version must be 4/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("answered Turns persist without a provider fork point", async () => {
  const value = await fixture();
  try {
    const claim = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await claim.birth(value.allocated.paths, value.soul);
    const body = await claim.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      startedAt: "2026-08-08T00:00:01.000Z",
    });
    await endTurn(value.allocated.paths, {
      turnSequence: turn.sequence,
      outcome: {
        kind: "answered",
        session: { sessionId: "native-session" },
        answer: "complete answer",
      },
      completedAt: "2026-08-08T00:00:02.000Z",
    });
    claim.release();

    assert.deepEqual((await activitySlice(value.allocated.paths)).rows
      .filter((fact) => fact.kind === "turn-end").map((fact) => fact.outcome), [{
      kind: "answered",
      session: { sessionId: "native-session" },
      answer: "complete answer",
    }]);
  } finally { value.close(); }
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
    assert.deepEqual(await requestPause(value.allocated.paths, "2026-08-08T00:00:02.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    assert.equal(await stopRequested(value.allocated.paths), true);
    assert.equal(await pauseRequested(value.allocated.paths), true);

    const interruptor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await interruptor.clearPause(value.allocated.paths);
    interruptor.release();
    assert.equal(await pauseRequested(value.allocated.paths), false);
    assert.equal(await stopRequested(value.allocated.paths), true);

    assert.deepEqual(await requestPause(value.allocated.paths, "2026-08-08T00:00:04.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    assert.equal(await pauseRequested(value.allocated.paths), true);
  } finally { value.close(); }
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
      id: "tell-1", body: "pending", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const firstTurn = await beginTurn(value.allocated.paths, { bodySequence: body.sequence, startedAt: "2026-08-08T00:00:01.000Z" });
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
    assert.deepEqual(await finishBodyIfIdle(value.allocated.paths, {
      sequence: body.sequence, at: "2026-08-08T00:00:02.000Z",
    }), { kind: "pending", tells: ["tell-1"] });
    const secondTurn = await beginTurn(value.allocated.paths, { bodySequence: body.sequence, startedAt: "2026-08-08T00:00:02.000Z" });
    await endTurn(value.allocated.paths, {
      turnSequence: secondTurn.sequence,
      outcome: { kind: "failed", diagnostic: "later failure" },
      completedAt: "2026-08-08T00:00:03.000Z",
    });
    assert.deepEqual((await activitySlice(value.allocated.paths)).rows
      .filter((fact) => fact.kind === "turn-end").map((turn) => turn.outcome), [
      {
        kind: "answered",
        historyId: "turn-1",
        session: { sessionId: "native-session" },
        answer: "done",
      },
      { kind: "failed", diagnostic: "later failure" },
    ]);
    assert.deepEqual(await readForkPoint(value.allocated.paths, "turn-1"), {
      historyId: "turn-1",
      session: { sessionId: "native-session" },
      provider: "claude",
      cwd: value.root,
      options: value.soul.options,
    });
    assert.equal(await readForkPoint(value.allocated.paths, "missing-turn"), null);
    claim.release();
  } finally { value.close(); }
});

test("fork birth admits the child session in the soul birth transaction", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    assert.equal(await body.birth(value.allocated.paths, value.soul, {
      provider: "claude",
      coordinate: { sessionId: "fork-child" },
      cwd: value.root,
      options: value.soul.options,
      admittedAt: "2026-08-08T00:00:00.000Z",
    }), "born");
    assert.deepEqual((await readHeart(value.allocated.paths)).latestSession, {
      sequence: 1,
      provider: "claude",
      coordinate: { sessionId: "fork-child" },
      cwd: value.root,
      options: value.soul.options,
      admittedAt: "2026-08-08T00:00:00.000Z",
    });
    body.release();
  } finally { value.close(); }
});

test("Body idle settlement atomically obeys current control", async () => {
  const value = await fixture();
  try {
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await leash.birth(value.allocated.paths, value.soul);
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
    await requestPause(value.allocated.paths, "2026-08-08T00:00:01.000Z");
    assert.deepEqual(await finishBodyIfIdle(value.allocated.paths, {
      sequence: body.sequence,
      at: "2026-08-08T00:00:02.000Z",
    }), { kind: "controlled" });
    assert.equal((await readHeart(value.allocated.paths)).latestBody?.end, "put-down");
    leash.release();
  } finally { value.close(); }
});

test("life is the sole leash and settlement interpretation", async () => {
  const body = { sequence: 1, leashTakenAt: "2026-08-08T00:00:00.000Z" };
  const kill = { sequence: 1, bodySequence: 1, evidence: "killed" as const, at: "life" };
  const project = (input: Partial<Parameters<typeof life>[0]>) => life({
    leash: "free", body, kill: null, ...input,
  });
  assert.equal(project({ leash: "held", kill }), "running");
  assert.equal(project({ leash: "held" }), "running");
  assert.equal(project({ leash: "held", body: {
    ...body,
    hung: { diagnostic: "provider custody remained live", at: "2026-08-08T00:00:02.000Z" },
  } }), "hung");
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
    assert.equal(life({ leash: "held", body: (await readHeart(value.allocated.paths)).latestBody, kill: null }), "hung");
    leash.release();
    assert.equal(life({ leash: "free", body: (await readHeart(value.allocated.paths)).latestBody, kill: null }), "hung");
    const successor = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await assert.rejects(successor.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:03.000Z",
    }), /permanently gated by hung custody/u);
    successor.release();
    await assert.rejects(leash.recordBodyHung(value.allocated.paths, {
      sequence: body.sequence,
      diagnostic: "late fabricated custody",
      at: "2026-08-08T00:00:02.000Z",
    }), /not owned by this leash/u);
  } finally { value.close(); }
});

function codecSoul(): Soul {
  return {
    id: "aku/claude/1234abcd" as Soul["id"],
    archetype: "claude",
    description: "Codec fixture",
    provider: {
      name: "codex",
      kind: "codex-app-server",
      executable: "codex",
      config: { flag: true },
      env: { HOME: "/tmp/home" },
    },
    options: { model: "claude-sonnet-4-5", effort: "high", readonly: true, network: "disabled", systemPrompt: "Work." },
    readonly: { enforcement: "native" },
    cwd: "/tmp/work",
    origin: { kind: "request", parent: "aku/parent/1234abcd" as Soul["id"], requestId: "00000000-0000-4000-8000-000000000001" },
    allowed: ["akuma.call", "task.add"],
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

test("soul codec hard-fails invalid known members", () => {
  const corruptions: readonly Readonly<{ name: string; change: (soul: Soul) => unknown }>[] = [
    { name: "missing required field", change: (soul) => { const copy = { ...soul }; delete (copy as Record<string, unknown>).cwd; return copy; } },
    { name: "options readonly false", change: (soul) => ({ ...soul, options: { ...soul.options, readonly: false } }) },
    { name: "readonly option without restraint", change: (soul) => { const copy = { ...soul }; delete (copy as Record<string, unknown>).readonly; return copy; } },
    { name: "restraint without readonly option", change: (soul) => ({ ...soul, options: { ...soul.options, readonly: undefined } }) },
    { name: "none restraint blank diagnostic", change: (soul) => ({ ...soul, readonly: { enforcement: "none", diagnostic: " " } }) },
    { name: "none restraint non-string diagnostic", change: (soul) => ({ ...soul, readonly: { enforcement: "none", diagnostic: 7 } }) },
    { name: "unknown restraint enforcement", change: (soul) => ({ ...soul, readonly: { enforcement: "warn" } }) },
    { name: "unknown provider kind", change: (soul) => ({ ...soul, provider: { ...soul.provider, kind: "grok" } }) },
    { name: "blank provider name", change: (soul) => ({ ...soul, provider: { ...soul.provider, name: " " } }) },
    { name: "provider env non-string value", change: (soul) => ({ ...soul, provider: { ...soul.provider, env: { HOME: 9 } } }) },
    { name: "request origin missing parent", change: (soul) => ({ ...soul, origin: { kind: "request", requestId: "00000000-0000-4000-8000-000000000001" } }) },
    { name: "request origin parent has non-hex suffix", change: (soul) => ({ ...soul, origin: { kind: "request", parent: "aku/parent/nothex", requestId: "00000000-0000-4000-8000-000000000001" } }) },
    { name: "fork origin parent has extra segment", change: (soul) => ({ ...soul, origin: { kind: "fork", parent: "aku/parent/1234abcd/extra", at: "history" } }) },
    { name: "unknown origin kind", change: (soul) => ({ ...soul, origin: { kind: "rebirth" } }) },
    { name: "id is not an Akuma coordinate", change: (soul) => ({ ...soul, id: "garbage" }) },
    { name: "id has a single segment", change: (soul) => ({ ...soul, id: "aku/claude" }) },
    { name: "id suffix is not lower hex8", change: (soul) => ({ ...soul, id: "aku/claude/nothex" }) },
    { name: "id has an extra segment", change: (soul) => ({ ...soul, id: "aku/claude/1234abcd/extra" }) },
    { name: "id archetype is not normalized", change: (soul) => ({ ...soul, id: "aku/Claude/1234abcd" }) },
    { name: "id and archetype disagree", change: (soul) => ({ ...soul, archetype: "worker" }) },
    { name: "blank cwd", change: (soul) => ({ ...soul, cwd: "" }) },
    { name: "blank description", change: (soul) => ({ ...soul, description: " " }) },
    { name: "unknown allowed action", change: (soul) => ({ ...soul, allowed: ["akuma.unknown"] }) },
    { name: "duplicate allowed action", change: (soul) => ({ ...soul, allowed: ["akuma.call", "akuma.call"] }) },
    { name: "non-string allowed action", change: (soul) => ({ ...soul, allowed: [1] }) },
  ];
  for (const { name, change } of corruptions) {
    assert.throws(() => decodeSoul(change(codecSoul())), undefined, name);
    assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify(change(codecSoul())) }), undefined, name);
    assert.throws(() => encodeSoulRow(change(codecSoul()) as Soul), undefined, name);
  }
  assert.throws(() => decodeSoulRow({ soul_json: "not json" }), SyntaxError);
  assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify("garbage") }));
  assert.throws(() => decodeSoulRow({ soul_json: JSON.stringify(42) }));
});

test("soul codec ignores additional object members", () => {
  const soul = codecSoul();
  const extended = {
    ...soul,
    retired: { value: true },
    options: { ...soul.options, access: "read" },
    readonly: { ...soul.readonly, explanation: "legacy" },
    provider: { ...soul.provider, process: 42 },
    origin: { ...soul.origin, note: "legacy" },
  };
  assert.deepEqual(decodeSoul(extended), soul);
  assert.deepEqual(decodeSoulRow({ soul_json: JSON.stringify(extended) }), soul);
  assert.deepEqual(JSON.parse(encodeSoul(decodeSoul(extended))), soul);
});

test("soul codec decodes canonically, deep-freezes, and round-trips", () => {
  const encoded = encodeSoulRow(codecSoul());
  assert.deepEqual(decodeSoulRow({ soul_json: encoded[0]! }), codecSoul());
  const decoded = decodeSoulRow({ soul_json: encoded[0]! });
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.options), true);
  assert.equal(Object.isFrozen(decoded.provider), true);
  assert.equal(Object.isFrozen(decoded.provider.config), true);
  assert.equal(Object.isFrozen(decoded.provider.env), true);
  assert.equal(Object.isFrozen(decoded.readonly), true);
  assert.equal(Object.isFrozen(decoded.origin), true);
  assert.equal(Object.isFrozen(decoded.provider.config!.flag), true);

  const none: Soul = {
    ...codecSoul(),
    readonly: { enforcement: "none", diagnostic: "ACP cannot remove task-surface mutation capabilities" },
  };
  assert.deepEqual(decodeSoul(JSON.parse(encodeSoul(none))), none);

  const reordered = JSON.parse(JSON.stringify(codecSoul())) as Record<string, unknown>;
  const keys = Object.keys(reordered);
  for (const key of keys.reverse()) {
    const value = reordered[key];
    delete reordered[key];
    (reordered as Record<string, unknown>)[key] = value;
  }
  assert.deepEqual(encodeSoulRow(codecSoul()), encodeSoulRow(reordered as unknown as Soul), "canonical serialization ignores input key order");
  assert.deepEqual(Object.keys(JSON.parse(encoded[0]!)), [
    "id", "archetype", "description", "provider", "options", "readonly", "cwd", "origin", "allowed", "createdAt",
  ]);

  const preFeature = JSON.parse(encoded[0]!) as Record<string, unknown>;
  delete preFeature.allowed;
  assert.deepEqual(decodeSoul(preFeature).allowed, ALLOWED_ACTIONS);
  assert.deepEqual(JSON.parse(encodeSoul(decodeSoul(preFeature))).allowed, ALLOWED_ACTIONS);

  assert.throws(() => encodeSoulRow({ ...codecSoul(), options: { readonly: true }, readonly: undefined }), undefined, "encode validates the consistency rule");
  assert.equal(encodeSoulRow(codecSoul())[0] === encodeSoulRow(codecSoul())[0], true, "canonical encoding is deterministic");
});

function afterSnapshotQuery(after: () => void): () => void {
  const proto = DatabaseSync.prototype;
  const originalPrepare = proto.prepare;
  let fired = false;
  proto.prepare = function(this: DatabaseSync, ...args: Parameters<typeof originalPrepare>) {
    const statement = originalPrepare.apply(this, args);
    const get = statement.get;
    const all = statement.all;
    const fire = () => {
      if (fired) return;
      fired = true;
      after();
    };
    statement.get = function(this: typeof statement, ...args: Parameters<typeof statement.get>) {
      const result = get.apply(this, args);
      fire();
      return result;
    };
    statement.all = function(this: typeof statement, ...args: Parameters<typeof statement.all>) {
      const result = all.apply(this, args);
      fire();
      return result;
    };
    return statement;
  };
  return () => { proto.prepare = originalPrepare; };
}

function writeHeart(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL");
  return database;
}

function claimLeashSeat(path: string): DatabaseSync | null {
  const uri = pathToFileURL(path);
  uri.searchParams.set("mode", "rw");
  const database = new DatabaseSync(uri.href, { timeout: 0 });
  try {
    database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    return database;
  } catch {
    database.close();
    return null;
  }
}

test("activitySlice returns one retained-bound and row epoch", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const turn = await beginTurn(value.allocated.paths, {
      bodySequence: firstBody.sequence,
      startedAt: "2026-08-08T00:00:00.000Z",
    });
    const first = await appendActivity(value.allocated.paths, {
      turnSequence: turn.sequence,
      event: { type: "note", text: "before-commit" },
      at: "2026-08-08T00:00:01.000Z",
    });
    const writer = writeHeart(value.allocated.paths.heart);
    let committed: number | undefined;
    const restore = afterSnapshotQuery(() => {
      if (committed !== undefined) return;
      writer.exec("BEGIN IMMEDIATE");
      committed = insertActivityFact(writer, {
        turnSequence: turn.sequence,
        event: { type: "note", text: "after-commit" },
        at: "2026-08-08T00:00:02.000Z",
      });
      writer.exec("COMMIT");
    });
    try {
      const slice = await activitySlice(value.allocated.paths);
      const sequences = slice.rows.map((row) => row.sequence);
      const pre = slice.highest === first && !sequences.includes(committed!);
      const post = slice.highest === committed && sequences.includes(committed!);
      assert.equal(pre || post, true);
      assert.equal(slice.lowestRetained === 1, true);
    } finally {
      restore();
      writer.close();
    }
    body.release();
  } finally { value.close(); }
});

test("readHeart returns one related Heart-fact epoch", async () => {
  const value = await fixture();
  try {
    const body = (await HeldAkumaLeash.try(value.allocated.paths))!;
    await body.birth(value.allocated.paths, value.soul);
    const firstBody = await body.recordBody(value.allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    body.release();
    const writer = writeHeart(value.allocated.paths.heart);
    let wrote = false;
    let claimed = false;
    const restore = afterSnapshotQuery(() => {
      if (wrote) return;
      wrote = true;
      const leash = claimLeashSeat(value.allocated.paths.leash);
      claimed = leash !== null;
      writer.exec("BEGIN IMMEDIATE");
      insertSessionFact(writer, {
        provider: "claude",
        options: value.soul.options,
        coordinate: { sessionId: "concurrent-session" },
        cwd: value.root,
        admittedAt: "2026-08-08T00:00:01.000Z",
      });
      insertTellFact(writer, {
        id: "tell-concurrent", body: "concurrent", recordedAt: "2026-08-08T00:00:02.000Z",
      });
      insertKillFact(writer, firstBody.sequence, "2026-08-08T00:00:03.000Z");
      insertStopControl(writer, firstBody.sequence, "2026-08-08T00:00:04.000Z");
      writer.exec("COMMIT");
      if (leash !== null) {
        leash.exec("ROLLBACK");
        leash.close();
      }
    });
    try {
      const snapshot = await readHeart(value.allocated.paths);
      const pre = snapshot.latestSession === null
        && snapshot.pending.length === 0
        && snapshot.latestKill === null
        && snapshot.stop === null;
      const post = snapshot.latestSession?.coordinate.sessionId === "concurrent-session"
        && snapshot.pending.map((tell) => tell.id).join() === "tell-concurrent"
        && snapshot.latestKill?.bodySequence === firstBody.sequence
        && snapshot.stop?.bodySequence === firstBody.sequence;
      assert.equal(wrote, true);
      assert.equal(claimed, true);
      assert.equal(pre || post, true);
      assert.deepEqual(snapshot.soul, value.soul);
      assert.equal(snapshot.latestBody?.sequence, firstBody.sequence);
    } finally {
      restore();
      writer.close();
    }
  } finally { value.close(); }
});
