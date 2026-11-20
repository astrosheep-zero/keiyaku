import assert from "node:assert/strict";
import { rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bornDirectAkuma, heartFixture } from "./support/akuma-fixtures.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { BodySupervisor } from "../src/akuma/body-supervisor.js";
import { observeAdmittedTellAkuma } from "../src/akuma/akuma-selection-execution.js";
import { pendingTellReceipt } from "../src/akuma/call-initial-tell.js";
import { recordTell, beginTurn, bindTellsToTurn, endTurn, finishBodyIfIdle, HeldAkumaLeash, readTell, recordTellDeliveries } from "../src/akuma/heart/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { World } from "../src/world.js";
import { createHeartReader, HeartAbsentError } from "../src/akuma/heart/storage.js";

const AT = "2026-10-01T00:00:00.000Z";

async function born(root: string) {
  return await bornDirectAkuma({ root, akumaName: "worker", draw: "1234abcd", createdAt: AT });
}

test("observer reuses its connection without retaining a transaction and detects replacement and absence", async () => {
  const fixture = await heartFixture("kei-reader-reuse-");
  const { paths } = fixture.allocated;
  const reader = createHeartReader(paths);
  let first: DatabaseSync | undefined;
  try {
    await reader.read((db) => {
      first = db;
    });
    const writer = new DatabaseSync(paths.heart);
    try {
      writer.exec("CREATE TABLE reader_probe(value INTEGER); INSERT INTO reader_probe VALUES (1)");
      await reader.read((db) => {
        assert.equal(db, first);
        assert.equal(db.prepare("SELECT value FROM reader_probe").get()?.value, 1);
      });
      writer.exec("UPDATE reader_probe SET value=2");
      await reader.read((db) => assert.equal(db.prepare("SELECT value FROM reader_probe").get()?.value, 2));
      assert.equal(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy, 0);
    } finally {
      writer.close();
    }
    const old = `${paths.heart}.old`;
    await rename(paths.heart, old);
    await rename(`${paths.heart}-wal`, `${old}-wal`).catch(() => {});
    await rename(`${paths.heart}-shm`, `${old}-shm`).catch(() => {});
    const replacement = new DatabaseSync(paths.heart);
    const source = new DatabaseSync(old, { readOnly: true });
    try {
      const version = source.prepare("SELECT version FROM akuma_schema").get()!.version;
      replacement.exec(
        `CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO akuma_schema VALUES(1, ${version})`,
      );
    } finally {
      source.close();
      replacement.close();
    }
    await reader.read((db) => assert.notEqual(db, first));
    assert.equal(first!.isOpen, false);
    await rm(paths.heart);
    await assert.rejects(
      reader.read(() => assert.fail("absent Heart must not be read")),
      HeartAbsentError,
    );
  } finally {
    reader.clear();
    fixture.close();
  }
});

test("live Ask shares its exact witness and retires the retained Heart reader", async (context) => {
  const root = await World.at(temporaryDirectory(context, "kei-ask-reader-"));
  const { id, paths, leash } = await born(root);
  const { sequence: bodySequence } = await leash.recordBody(paths, { leashTakenAt: AT });
  const { sequence: turnSequence } = await beginTurn(paths, { bodySequence, startedAt: AT });
  await recordTell(paths, { kind: "tell", id: "asked", body: "work", recordedAt: AT });
  await bindTellsToTurn(paths, { turnSequence, tellIds: ["asked"], boundAt: AT });
  const exact = `turn/${turnSequence}`;
  const detailFailure = new Error("frontier unavailable");
  const connections = new Set<DatabaseSync>();
  const notified: string[] = [];
  let refuseDetail = false;
  const prepare = DatabaseSync.prototype.prepare;
  context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.includes("FROM tells WHERE id = ?")) connections.add(this);
    if (refuseDetail && sql.includes("WITH selected(sequence)")) throw detailFailure;
    return prepare.call(this, sql);
  });
  const owner = new AkumaOwner(id, root, async (_id, identities) => {
    notified.push(...identities);
    if (notified.length === 1) await beginTurn(paths, { bodySequence, startedAt: AT });
  });
  try {
    const outcome = { kind: "failed", diagnostic: "test settlement" } as const;
    const result = await owner.tellOutcome("asked", {
      timeoutMs: 3000,
      observe: async ({ status }) => {
        assert.equal(status.work.turn?.sequence, turnSequence, "notification may run after the snapshot, not split it");
        if (status.work.outcome?.state === "running") await endTurn(paths, { turnSequence, outcome, completedAt: AT });
        else assert.deepEqual(status.work.outcome, { turn: exact, at: AT, state: "failed", reason: outcome.diagnostic });
      },
    });
    assert.equal(result.reason, "completed");
    assert.deepEqual(result.outcome, outcome);
    assert.equal(result.completedAt, AT);
    assert.equal(result.end?.turnSequence, turnSequence);
    assert.equal(connections.size, 1);
    assert.equal([...connections][0]!.isOpen, false);
    refuseDetail = true;
    assert.deepEqual((await owner.tellOutcome("asked")).outcome, outcome);
    await assert.rejects(owner.tellOutcome("asked", { observe: () => assert.fail() }), detailFailure);
    assert.deepEqual(notified, [exact, exact, exact]);
  } finally {
    leash.release();
  }
});

test("bounded Tell keeps its exact terminal when the free-leash recheck hits expiry", async (t) => {
  const root = await World.at(temporaryDirectory(t, "kei-tell-expiry-recheck-"));
  const { id, paths, leash } = await born(root);
  const tellId = "before-expiry";
  const answer = "exact answer\n";
  let receipt: ReturnType<typeof pendingTellReceipt>;
  let sequence: number;
  try {
    const admitted = await recordTell(paths, { kind: "tell", id: tellId, body: "work", recordedAt: AT });
    assert.ok(admitted.kind === "recorded");
    receipt = pendingTellReceipt(admitted.tell);
    const body = await leash.recordBody(paths, { leashTakenAt: AT });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: AT });
    sequence = turn.sequence;
    await bindTellsToTurn(paths, { turnSequence: sequence, tellIds: [tellId], boundAt: AT });
    await recordTellDeliveries(paths, [{ tellId, turnSequence: sequence, route: "launch", fence: "exact", deliveredAt: AT }]);
    await endTurn(paths, { turnSequence: sequence, outcome: { kind: "answered", answer, session: { sessionId: "exact" } }, completedAt: AT });
    assert.equal((await finishBodyIfIdle(paths, { sequence: body.sequence, at: AT })).kind, "finished");
  } finally { leash.release(); }

  let expired = false;
  let readsAfterExpiry = 0;
  const duration = 10_000;
  const now = performance.now.bind(performance);
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, ...args: Parameters<typeof prepare>) {
    if (expired) readsAfterExpiry++;
    return prepare.apply(this, args);
  });
  t.mock.method(performance, "now", () => now() + (expired ? duration : 0));
  const acquire = HeldAkumaLeash.try;
  t.mock.method(HeldAkumaLeash, "try", async (selected: typeof paths) => {
    const claim = await acquire.call(HeldAkumaLeash, selected);
    if (selected.heart === paths.heart) {
      assert.ok(claim, "read reaches the real free-leash recheck");
      expired = true;
    }
    return claim;
  });
  const { observation, end } = await observeAdmittedTellAkuma({ path: root, id, receipt, closeAtBound: true, timeoutMs: duration });
  assert.ok(expired);
  assert.equal(readsAfterExpiry, 0);
  assert.equal(end?.turnSequence, sequence);
  assert.deepEqual(observation, { kind: "answered", answer, completedAt: AT });
});

test("ask preserves the launch gap, then returns an explicit failed wake without waiting forever", async (context) => {
  const root = await World.at(temporaryDirectory(context, "kei-ask-wake-failed-"));
  const parent = await born(root);
  const admitted = await recordTell(parent.paths, { kind: "tell", id: "asked", body: "work", recordedAt: AT });
  parent.leash.release();
  assert.equal(admitted.kind, "recorded");
  const receipt = pendingTellReceipt(admitted.tell);
  const { promise: wake, resolve } = deferred<typeof receipt>();
  let rounds = 0;
  const result = await observeAdmittedTellAkuma({
    path: root, id: parent.id, receipt, wake,
    signal: AbortSignal.timeout(2000),
    onObserve: { observe: () => {
      if (++rounds === 2) resolve({ ...receipt, wake: { kind: "failed", diagnostic: "spawn failed" } });
    } },
  });
  assert.ok(rounds >= 3);
  assert.deepEqual(result.observation, { kind: "unanswered" });
  assert.deepEqual(result.receipt.wake, { kind: "failed", diagnostic: "spawn failed" });
  assert.equal((await readTell(parent.paths, "asked"))?.state, "pending");
});

test("unchanged Body observations do not wake the Turn, but a new Tell does", async (context) => {
  const parent = await born(temporaryDirectory(context, "kei-control-changes-"));
  const body = await parent.leash.recordBody(parent.paths, { leashTakenAt: AT });
  const supervisor = await BodySupervisor.open(parent.paths, body.sequence, parent.leash);
  try {
    const previous = supervisor.current();
    let woke = false;
    const next = supervisor.next(previous).then((snapshot) => {
      woke = true;
      return snapshot;
    });
    await supervisor.refresh();
    await supervisor.refresh();
    assert.equal(supervisor.current(), previous);
    assert.equal(woke, false);
    await recordTell(parent.paths, { kind: "tell", id: "new-tell", body: "work", recordedAt: AT });
    await supervisor.refresh();
    assert.equal((await next).pending[0]?.id, "new-tell");
  } finally {
    await supervisor.close();
    parent.leash.release();
  }
});
