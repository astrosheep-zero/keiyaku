import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import {
  HeldAkumaLeash,
  admitRequest,
  activitySlice,
  appendActivity,
  finishBodyIfIdle,
  initializeHeart,
  life,
  probeLeash,
  pauseRequested,
  readHeart,
  readForkPoint,
  readTurns,
  readNonterminalRequests,
  readRequest,
  recordBody,
  recordSession,
  recordTell,
  recordTellDeliveries,
  recordTellReceipt,
  recordTurn,
  requestPause,
  requestStop,
  reserveRequest,
  serveRequest,
  stopRequested,
  refuseRequest,
  voidRequest,
  type Soul,
} from "../src/akuma/heart/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-heart-"));
  const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
  initializeHeart(allocated.paths);
  const soul: Soul = {
    id: allocated.id,
    archetype: "claude",
    description: "Claude fixture",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "claude-sonnet-4-5", systemPrompt: "Be precise." },
    cwd: root,
    origin: { kind: "direct" },
    confinement: { kind: "unconfined" },
    createdAt: "2026-08-08T00:00:00.000Z",
  };
  return { root, allocated, soul, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("birth and seal share the child's leash adjudicator", () => {
  const value = fixture();
  try {
    const sealer = HeldAkumaLeash.try(value.allocated.paths)!;
    assert.equal(sealer.sealIfUnborn(value.allocated.paths, { evidence: "call-timeout", at: value.soul.createdAt }), "sealed");
    const lateBody = HeldAkumaLeash.try(value.allocated.paths)!;
    assert.equal(lateBody.birth(value.allocated.paths, value.soul), "sealed");
    lateBody.release();
  } finally { value.close(); }
});

test("a born soul cannot later be sealed", () => {
  const value = fixture();
  try {
    const body = HeldAkumaLeash.try(value.allocated.paths)!;
    assert.equal(body.birth(value.allocated.paths, value.soul), "born");
    assert.deepEqual(readHeart(value.allocated.paths).soul, value.soul);
    assert.equal(probeLeash(value.allocated.paths), "held");
    body.release();
    const sealer = HeldAkumaLeash.try(value.allocated.paths)!;
    assert.equal(sealer.sealIfUnborn(value.allocated.paths, { evidence: "late", at: value.soul.createdAt }), "born");
    sealer.release();
  } finally { value.close(); }
});

test("session admission survives before turn completion", () => {
  const value = fixture();
  try {
    const body = HeldAkumaLeash.try(value.allocated.paths)!;
    body.birth(value.allocated.paths, value.soul);
    const fact = recordSession(value.allocated.paths, {
      provider: "claude",
      options: value.soul.options,
      coordinate: { sessionId: "native-session" },
      cwd: value.root,
      admittedAt: "2026-08-08T00:00:01.000Z",
    });
    body.release();
    assert.equal(readHeart(value.allocated.paths).latestSession?.sequence, fact.sequence);
    assert.deepEqual(readHeart(value.allocated.paths).latestSession?.coordinate, { sessionId: "native-session" });
    assert.deepEqual(readHeart(value.allocated.paths).latestSession?.options, value.soul.options);
  } finally { value.close(); }
});

test("tell admission shares activity order and delivery witnesses fold without mutable stages", () => {
  const value = fixture();
  try {
    const body = HeldAkumaLeash.try(value.allocated.paths)!;
    body.birth(value.allocated.paths, value.soul);
    const bodyFact = recordBody(value.allocated.paths, {
      collar: { pid: 1, processGroup: 1, spawnedAt: "tell-witness" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const firstActivity = appendActivity(value.allocated.paths, {
      bodySequence: bodyFact.sequence,
      event: { type: "note", text: "before" },
      at: "2026-08-08T00:00:00.000Z",
    });
    const admitted = recordTell(value.allocated.paths, {
      id: "tell-1", body: "first", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(admitted.kind, "recorded");
    if (admitted.kind !== "recorded") return;
    const afterActivity = appendActivity(value.allocated.paths, {
      bodySequence: bodyFact.sequence,
      event: { type: "note", text: "after" },
      at: "2026-08-08T00:00:02.000Z",
    });
    assert.deepEqual([firstActivity, admitted.tell.sequence, afterActivity], [1, 2, 3]);
    assert.deepEqual(activitySlice(value.allocated.paths).rows.map((fact) => "id" in fact ? "tell" : "activity"), [
      "activity", "tell", "activity",
    ]);

    const delivery = {
      tellId: admitted.tell.id,
      route: "launch" as const,
      bodySequence: bodyFact.sequence,
      fence: "launch-fence",
      deliveredAt: "2026-08-08T00:00:03.000Z",
    };
    recordTellDeliveries(value.allocated.paths, [delivery]);
    recordTellDeliveries(value.allocated.paths, [delivery]);
    const told = activitySlice(value.allocated.paths).rows[1];
    assert.equal(told !== undefined && "id" in told ? told.state : null, "told");
    assert.equal(readHeart(value.allocated.paths).pending.length, 0);
    body.release();
  } finally { value.close(); }
});

test("tell admission refuses an unborn heart without writing its timeline", () => {
  const value = fixture();
  try {
    assert.deepEqual(recordTell(value.allocated.paths, {
      id: "tell-unborn", body: "future input", recordedAt: "2026-08-08T00:00:01.000Z",
    }), { kind: "not-born" });
    assert.deepEqual(activitySlice(value.allocated.paths).rows, []);
    assert.deepEqual(readHeart(value.allocated.paths).pending, []);
  } finally { value.close(); }
});

test("live receipts are terminal only under their exact Heart correlation", () => {
  const value = fixture();
  try {
    const body = HeldAkumaLeash.try(value.allocated.paths)!;
    body.birth(value.allocated.paths, value.soul);
    const firstBody = recordBody(value.allocated.paths, {
      collar: { pid: 1, processGroup: 1, spawnedAt: "receipt-1" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const required = recordTell(value.allocated.paths, {
      id: "tell-required", body: "wait for receipt", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    const unavailable = recordTell(value.allocated.paths, {
      id: "tell-unavailable", body: "ack is terminal", recordedAt: "2026-08-08T00:00:02.000Z",
    });
    assert.equal(required.kind, "recorded");
    assert.equal(unavailable.kind, "recorded");
    recordTellDeliveries(value.allocated.paths, [{
      tellId: "tell-required", route: "live", receipt: "required",
      bodySequence: firstBody.sequence, fence: "shared-fence", deliveredAt: "2026-08-08T00:00:03.000Z",
    }, {
      tellId: "tell-unavailable", route: "live", receipt: "unavailable",
      bodySequence: firstBody.sequence, fence: "ack-fence", deliveredAt: "2026-08-08T00:00:03.000Z",
    }]);
    assert.deepEqual(readHeart(value.allocated.paths).pending.map((tell) => tell.id), ["tell-required"]);
    assert.throws(() => recordTellReceipt(value.allocated.paths, {
      evidence: "fence", bodySequence: firstBody.sequence + 1, fence: "shared-fence",
      kind: "accepted", receivedAt: "2026-08-08T00:00:04.000Z",
    }), /no delivery mapping/u);
    assert.deepEqual(readHeart(value.allocated.paths).pending.map((tell) => tell.id), ["tell-required"]);
    recordTellReceipt(value.allocated.paths, {
      evidence: "fence", bodySequence: firstBody.sequence, fence: "shared-fence",
      kind: "accepted", receivedAt: "2026-08-08T00:00:05.000Z",
    });
    assert.deepEqual(readHeart(value.allocated.paths).pending, []);

    const exact = recordTell(value.allocated.paths, {
      id: "tell-exact", body: "exact", recordedAt: "2026-08-08T00:00:06.000Z",
    });
    assert.equal(exact.kind, "recorded");
    recordTellReceipt(value.allocated.paths, {
      evidence: "exact", tellId: "tell-exact", kind: "consumed", receivedAt: "2026-08-08T00:00:07.000Z",
    });
    assert.deepEqual(readHeart(value.allocated.paths).pending, []);
    body.release();
  } finally { value.close(); }
});

test("kill witnesses one stopped Body without burning pending work", () => {
  const value = fixture();
  try {
    const leash = HeldAkumaLeash.try(value.allocated.paths)!;
    leash.birth(value.allocated.paths, value.soul);
    const firstBody = recordBody(value.allocated.paths, {
      collar: { pid: 1, processGroup: 1, spawnedAt: "kill-1" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const pending = recordTell(value.allocated.paths, {
      id: "tell-pending", body: "pending", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(pending.kind, "recorded");
    const request = admitRequest(value.allocated.paths, {
      id: "00000000-0000-4000-8000-000000000010",
      archetype: "claude",
      body: "child work",
      world: value.root,
      recipe: {
        description: value.soul.description,
        provider: value.soul.provider,
        options: value.soul.options,
        confinement: value.soul.confinement,
      },
      admittedAt: "2026-08-08T00:00:02.000Z",
    });
    assert.deepEqual(requestStop(value.allocated.paths, "2026-08-08T00:00:03.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    assert.deepEqual(leash.settleStop(value.allocated.paths), {
      target: { bodySequence: firstBody.sequence, requestedAt: "2026-08-08T00:00:03.000Z" },
      result: "recorded",
    });
    assert.deepEqual(requestStop(value.allocated.paths, "later"), { kind: "already-killed", body: firstBody });
    let snapshot = readHeart(value.allocated.paths);
    assert.equal(snapshot.latestKill?.bodySequence, firstBody.sequence);
    assert.deepEqual(snapshot.pending.map((tell) => tell.id), ["tell-pending"]);
    assert.equal(readRequest(value.allocated.paths, request.id)?.state, "admitted");
    assert.equal(life("free", { kind: "gone", end: "put-down" }, firstBody, snapshot.latestKill), "killed");

    const secondBody = recordBody(value.allocated.paths, {
      collar: { pid: 2, processGroup: 2, spawnedAt: "kill-2" },
      leashTakenAt: "2026-08-08T00:00:04.000Z",
    });
    snapshot = readHeart(value.allocated.paths);
    assert.equal(life("free", { kind: "gone", end: "exited" }, secondBody, snapshot.latestKill), "asleep");
    recordTellDeliveries(value.allocated.paths, [{
      tellId: "tell-pending",
      route: "launch",
      bodySequence: secondBody.sequence,
      fence: "successor",
      deliveredAt: "2026-08-08T00:00:05.000Z",
    }]);
    assert.deepEqual(readHeart(value.allocated.paths).pending, []);
    assert.equal(readRequest(value.allocated.paths, request.id)?.state, "admitted");
    leash.release();
  } finally { value.close(); }
});

test("retention uses a bounded settled buffer while pending tells remain pinned", () => {
  const value = fixture();
  try {
    const leash = HeldAkumaLeash.try(value.allocated.paths)!;
    leash.birth(value.allocated.paths, value.soul);
    const body = recordBody(value.allocated.paths, {
      collar: { pid: 1, processGroup: 1, spawnedAt: "retention" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const admitted = recordTell(value.allocated.paths, {
      id: "tell-pinned", body: "keep me", recordedAt: "2026-08-08T00:00:00.000Z",
    });
    assert.equal(admitted.kind, "recorded");
    const heart = new DatabaseSync(value.allocated.paths.heart);
    try {
      heart.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      heart.prepare(`WITH RECURSIVE rows(value) AS (
        VALUES(1) UNION ALL SELECT value + 1 FROM rows WHERE value < 5501
      ) INSERT INTO timeline(kind) SELECT 'activity' FROM rows`).run();
      heart.prepare(`INSERT INTO activity(sequence, body_sequence, event_json, at)
        SELECT sequence, ?, '{"type":"note","text":"buffered"}', '2026-08-08T00:00:01.000Z'
        FROM timeline WHERE kind = 'activity'`).run(body.sequence);
      heart.exec("COMMIT");
    } catch (error) {
      heart.exec("ROLLBACK");
      throw error;
    } finally { heart.close(); }

    appendActivity(value.allocated.paths, {
      bodySequence: body.sequence,
      event: { type: "note", text: "trigger compaction" },
      at: "2026-08-08T00:00:02.000Z",
    });
    let retained = activitySlice(value.allocated.paths, { limit: Number.MAX_SAFE_INTEGER });
    assert.equal(retained.rows.some((fact) => "id" in fact && fact.id === "tell-pinned"), true);
    assert.equal(retained.rows.filter((fact) => !("id" in fact)).length, 5_000);

    recordTellReceipt(value.allocated.paths, {
      evidence: "exact", tellId: "tell-pinned", kind: "consumed", receivedAt: "2026-08-08T00:00:03.000Z",
    });
    for (let index = 0; index < 501; index += 1) {
      appendActivity(value.allocated.paths, {
        bodySequence: body.sequence,
        event: { type: "note", text: `after-${index}` },
        at: "2026-08-08T00:00:04.000Z",
      });
    }
    retained = activitySlice(value.allocated.paths, { limit: Number.MAX_SAFE_INTEGER });
    assert.equal(retained.rows.some((fact) => "id" in fact && fact.id === "tell-pinned"), false);
    assert.ok(retained.rows.length >= 5_000 && retained.rows.length <= 5_500);
    leash.release();
  } finally { value.close(); }
});

test("Body Request facts have one idempotent monotonic authority", () => {
  const value = fixture();
  try {
    const input = {
      id: "00000000-0000-4000-8000-000000000001",
      archetype: "claude",
      body: "build",
      world: value.root,
      recipe: {
        description: value.soul.description,
        provider: value.soul.provider,
        options: value.soul.options,
        confinement: value.soul.confinement,
      },
      admittedAt: "2026-08-08T00:00:01.000Z",
    };
    assert.equal(admitRequest(value.allocated.paths, input).state, "admitted");
    assert.equal(admitRequest(value.allocated.paths, { ...input, admittedAt: "later" }).admittedAt, input.admittedAt);
    assert.deepEqual(readNonterminalRequests(value.allocated.paths).map((request) => request.id), [input.id]);

    const child = allocateAkumaDirectory({ worldRoot: value.root, archetype: "claude", draw: () => "deadbeef" });
    assert.equal(reserveRequest(value.allocated.paths, input.id, child.id).state, "reserved");
    assert.equal(serveRequest(value.allocated.paths, input.id, child.id).state, "served");
    assert.equal(readRequest(value.allocated.paths, input.id)?.state, "served");
    assert.deepEqual(readNonterminalRequests(value.allocated.paths), []);

    const refused = admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000002",
      body: "refuse",
    });
    assert.equal(refuseRequest(value.allocated.paths, refused.id, "unknown Archetype").state, "refused");
    const voided = admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000003",
      body: "void",
    });
    assert.equal(voidRequest(value.allocated.paths, voided.id, "caller gone").state, "voided");

    assert.deepEqual(readNonterminalRequests(value.allocated.paths), []);
  } finally { value.close(); }
});

test("heart schema version 9 and leash schema version 4 hard-refuse old authority", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-schema-cut-"));
  const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "30000000" });
  try {
    const heart = new DatabaseSync(allocated.paths.heart);
    heart.exec("CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO akuma_schema VALUES (1, 5)");
    heart.close();
    const leash = new DatabaseSync(allocated.paths.leash);
    leash.exec("CREATE TABLE leash_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO leash_schema VALUES (1, 2)");
    leash.close();
    assert.throws(() => readHeart(allocated.paths), /heart schema version must be 9/u);
    assert.throws(() => HeldAkumaLeash.try(allocated.paths), /leash schema version must be 4/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pause remains distinct from stop and can be cleared only under the leash", () => {
  const value = fixture();
  try {
    const body = HeldAkumaLeash.try(value.allocated.paths)!;
    body.birth(value.allocated.paths, value.soul);
    body.release();
    const firstBody = recordBody(value.allocated.paths, {
      collar: { pid: 1, processGroup: 1, spawnedAt: "pause-stop" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    assert.deepEqual(requestStop(value.allocated.paths, "2026-08-08T00:00:01.000Z"), {
      kind: "requested",
      body: firstBody,
    });
    assert.deepEqual(requestPause(value.allocated.paths, "2026-08-08T00:00:02.000Z"), { kind: "requested" });
    assert.equal(stopRequested(value.allocated.paths), true);
    assert.equal(pauseRequested(value.allocated.paths), true);

    const interruptor = HeldAkumaLeash.try(value.allocated.paths)!;
    interruptor.clearPause(value.allocated.paths);
    interruptor.release();
    assert.equal(pauseRequested(value.allocated.paths), false);
    assert.equal(stopRequested(value.allocated.paths), true);

    assert.deepEqual(requestPause(value.allocated.paths, "2026-08-08T00:00:04.000Z"), { kind: "requested" });
    assert.equal(pauseRequested(value.allocated.paths), true);
  } finally { value.close(); }
});

test("normal body completion refuses while a tell remains pending", () => {
  const value = fixture();
  try {
    const claim = HeldAkumaLeash.try(value.allocated.paths)!;
    claim.birth(value.allocated.paths, value.soul);
    const body = recordBody(value.allocated.paths, {
      collar: { pid: 1, processGroup: 1, spawnedAt: "token" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    recordSession(value.allocated.paths, {
      provider: "claude",
      options: value.soul.options,
      coordinate: { sessionId: "native-session" },
      cwd: value.root,
      admittedAt: "2026-08-08T00:00:00.000Z",
    });
    recordTell(value.allocated.paths, {
      id: "tell-1", body: "pending", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    recordTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      outcome: {
        kind: "answered",
        historyId: "turn-1",
        session: { sessionId: "native-session" },
        answer: "done",
      },
      completedAt: "2026-08-08T00:00:02.000Z",
    });
    assert.deepEqual(finishBodyIfIdle(value.allocated.paths, {
      sequence: body.sequence, at: "2026-08-08T00:00:02.000Z",
    }), { kind: "pending", tells: ["tell-1"] });
    recordTurn(value.allocated.paths, {
      bodySequence: body.sequence,
      outcome: { kind: "failed", diagnostic: "later failure" },
      completedAt: "2026-08-08T00:00:03.000Z",
    });
    assert.deepEqual(readTurns(value.allocated.paths).map((turn) => turn.outcome), [
      {
        kind: "answered",
        historyId: "turn-1",
        session: { sessionId: "native-session" },
        answer: "done",
      },
      { kind: "failed", diagnostic: "later failure" },
    ]);
    assert.deepEqual(readForkPoint(value.allocated.paths, "turn-1"), {
      historyId: "turn-1",
      session: { sessionId: "native-session" },
      provider: "claude",
      cwd: value.root,
      options: value.soul.options,
    });
    assert.equal(readForkPoint(value.allocated.paths, "missing-turn"), null);
    claim.release();
  } finally { value.close(); }
});

test("fork birth admits the child session in the soul birth transaction", () => {
  const value = fixture();
  try {
    const body = HeldAkumaLeash.try(value.allocated.paths)!;
    assert.equal(body.birth(value.allocated.paths, value.soul, {
      provider: "claude",
      coordinate: { sessionId: "fork-child" },
      cwd: value.root,
      options: value.soul.options,
      admittedAt: "2026-08-08T00:00:00.000Z",
    }), "born");
    assert.deepEqual(readHeart(value.allocated.paths).latestSession, {
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

test("life is the sole five-state interpretation", () => {
  const body = { sequence: 1, collar: { pid: 1, processGroup: 1, spawnedAt: "life" }, leashTakenAt: "life" };
  const kill = { sequence: 1, bodySequence: 1, evidence: "killed" as const, at: "life" };
  assert.equal(life("held", { kind: "gone", end: null }, body, kill), "running");
  assert.equal(life("free", { kind: "gone", end: "exited" }, body, null), "asleep");
  assert.equal(life("free", { kind: "gone", end: "broke-off" }, body, null), "stranded");
  assert.equal(life("free", { kind: "alive" }, body, null), "headless");
  assert.equal(life("free", { kind: "unverifiable", diagnostic: "denied" }, body, null), "headless");
  assert.equal(life("free", { kind: "gone", end: "put-down" }, body, kill), "killed");
});
