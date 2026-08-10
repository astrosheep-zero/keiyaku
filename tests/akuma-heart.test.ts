import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import {
  HeldAkumaLeash,
  activitySlice,
  admitRequest,
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
  recordDeath,
  recordSession,
  recordTell,
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
  const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "1234abcd" });
  initializeHeart(allocated.paths);
  const soul: Soul = {
    id: allocated.id,
    persona: "claude",
    description: "Claude fixture",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "claude-sonnet-4-5", systemPrompt: "Be precise." },
    cwd: root,
    origin: { kind: "direct" },
    confinement: { kind: "unconfined" },
    contract: "kei/fixture",
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

test("tell admission and death are one serialized fence", () => {
  const value = fixture();
  try {
    const body = HeldAkumaLeash.try(value.allocated.paths)!;
    body.birth(value.allocated.paths, value.soul);
    body.release();
    assert.equal(recordTell(value.allocated.paths, {
      id: "tell-1", body: "first", recordedAt: "2026-08-08T00:00:01.000Z",
    }), "recorded");
    assert.equal(recordDeath(value.allocated.paths, { evidence: "killed", at: "2026-08-08T00:00:02.000Z" }), "recorded");
    assert.equal(recordTell(value.allocated.paths, {
      id: "tell-2", body: "late", recordedAt: "2026-08-08T00:00:03.000Z",
    }), "dead");
    assert.deepEqual(readHeart(value.allocated.paths).pending, []);
  } finally { value.close(); }
});

test("Body Request facts have one idempotent monotonic authority", () => {
  const value = fixture();
  try {
    const input = {
      id: "00000000-0000-4000-8000-000000000001",
      persona: "claude",
      body: "build",
      contract: "kei/fixture",
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

    const child = allocateAkumaDirectory({ worldRoot: value.root, persona: "claude", draw: () => "deadbeef" });
    assert.equal(reserveRequest(value.allocated.paths, input.id, child.id).state, "reserved");
    assert.equal(serveRequest(value.allocated.paths, input.id, child.id).state, "served");
    assert.equal(readRequest(value.allocated.paths, input.id)?.state, "served");
    assert.deepEqual(readNonterminalRequests(value.allocated.paths), []);

    const refused = admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000002",
      body: "refuse",
    });
    assert.equal(refuseRequest(value.allocated.paths, refused.id, "unknown Persona").state, "refused");
    const voided = admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000003",
      body: "void",
    });
    assert.equal(voidRequest(value.allocated.paths, voided.id, "caller gone").state, "voided");

    const deathAdmitted = admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000004",
      body: "death admitted",
    });
    const deathReserved = admitRequest(value.allocated.paths, {
      ...input,
      id: "00000000-0000-4000-8000-000000000005",
      body: "death reserved",
    });
    const reservedChild = allocateAkumaDirectory({ worldRoot: value.root, persona: "claude", draw: () => "feedface" });
    reserveRequest(value.allocated.paths, deathReserved.id, reservedChild.id);
    recordDeath(value.allocated.paths, { evidence: "killed", at: "2026-08-08T00:00:02.000Z" });
    assert.deepEqual(readRequest(value.allocated.paths, deathAdmitted.id), {
      ...deathAdmitted,
      state: "voided",
      evidence: "death:killed",
    });
    assert.deepEqual(readRequest(value.allocated.paths, deathReserved.id), {
      ...deathReserved,
      state: "voided",
      evidence: `death:killed; child=${reservedChild.id}`,
    });
    assert.deepEqual(readNonterminalRequests(value.allocated.paths), []);
  } finally { value.close(); }
});

test("schema version 5 hard-refuses old heart and leash authority", () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-schema-cut-"));
  const allocated = allocateAkumaDirectory({ worldRoot: root, persona: "claude", draw: () => "30000000" });
  try {
    const heart = new DatabaseSync(allocated.paths.heart);
    heart.exec("CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO akuma_schema VALUES (1, 2)");
    heart.close();
    const leash = new DatabaseSync(allocated.paths.leash);
    leash.exec("CREATE TABLE leash_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO leash_schema VALUES (1, 2)");
    leash.close();
    assert.throws(() => readHeart(allocated.paths), /heart schema version must be 5/u);
    assert.throws(() => HeldAkumaLeash.try(allocated.paths), /leash schema version must be 4/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("activity retains exactly the newest 5000 facts", () => {
  const value = fixture();
  try {
    const body = recordBody(value.allocated.paths, {
      collar: { pid: 1, processGroup: 1, spawnedAt: "retention" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    const heart = new DatabaseSync(value.allocated.paths.heart);
    const insert = heart.prepare("INSERT INTO activity(body_sequence, event_json, at) VALUES (?, ?, ?)");
    heart.exec("BEGIN");
    for (let index = 1; index <= 5_000; index += 1) {
      insert.run(body.sequence, JSON.stringify({ type: "note", text: `note-${index}` }), "2026-08-08T00:00:00.000Z");
    }
    heart.exec("COMMIT");
    heart.close();

    assert.equal(appendActivity(value.allocated.paths, {
      bodySequence: body.sequence,
      event: { type: "note", text: "newest" },
      at: "2026-08-08T00:00:01.000Z",
    }), 5_001);
    const retained = activitySlice(value.allocated.paths, { limit: 5_000 });
    assert.equal(retained.rows.length, 5_000);
    assert.equal(retained.lowestRetained, 2);
    assert.equal(retained.highest, 5_001);
    assert.equal(retained.rows[0]?.sequence, 2);
    assert.equal(retained.rows.at(-1)?.sequence, 5_001);
  } finally { value.close(); }
});

test("activity before and since cursors are exclusive and preserve ascending order", () => {
  const value = fixture();
  try {
    const body = recordBody(value.allocated.paths, {
      collar: { pid: 1, processGroup: 1, spawnedAt: "pagination" },
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    for (let index = 1; index <= 5; index += 1) {
      appendActivity(value.allocated.paths, {
        bodySequence: body.sequence,
        event: { type: "note", text: `note-${index}` },
        at: `2026-08-08T00:00:0${index}.000Z`,
      });
    }
    assert.deepEqual(activitySlice(value.allocated.paths, { before: 4, limit: 2 }).rows.map((row) => row.sequence), [2, 3]);
    assert.deepEqual(activitySlice(value.allocated.paths, { since: 2, limit: 2 }).rows.map((row) => row.sequence), [3, 4]);
    assert.deepEqual(activitySlice(value.allocated.paths, { limit: 2 }).rows.map((row) => row.sequence), [4, 5]);
  } finally { value.close(); }
});

test("pause is death-fenced and remains distinct from terminal stop", () => {
  const value = fixture();
  try {
    const body = HeldAkumaLeash.try(value.allocated.paths)!;
    body.birth(value.allocated.paths, value.soul);
    body.release();
    assert.equal(requestStop(value.allocated.paths, "2026-08-08T00:00:01.000Z"), "requested");
    assert.equal(requestPause(value.allocated.paths, "2026-08-08T00:00:02.000Z"), "requested");
    assert.equal(stopRequested(value.allocated.paths), true);
    assert.equal(pauseRequested(value.allocated.paths), true);

    const interruptor = HeldAkumaLeash.try(value.allocated.paths)!;
    interruptor.clearPause(value.allocated.paths);
    interruptor.release();
    assert.equal(pauseRequested(value.allocated.paths), false);
    assert.equal(stopRequested(value.allocated.paths), true);

    recordDeath(value.allocated.paths, { evidence: "killed", at: "2026-08-08T00:00:03.000Z" });
    assert.equal(requestPause(value.allocated.paths, "2026-08-08T00:00:04.000Z"), "dead");
    assert.equal(pauseRequested(value.allocated.paths), false);
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
  const death = { evidence: "killed" as const, at: "2026-08-08T00:00:00.000Z" };
  assert.equal(life("held", { kind: "gone", end: null }, null), "running");
  assert.equal(life("free", { kind: "gone", end: "exited" }, null), "asleep");
  assert.equal(life("free", { kind: "gone", end: "broke-off" }, null), "stranded");
  assert.equal(life("free", { kind: "alive" }, null), "headless");
  assert.equal(life("free", { kind: "unverifiable", diagnostic: "denied" }, null), "headless");
  assert.equal(life("held", { kind: "alive" }, death), "dead");
});
