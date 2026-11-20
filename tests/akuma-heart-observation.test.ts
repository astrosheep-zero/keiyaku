import assert from "node:assert/strict";
import { rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bornDirectAkuma, heartFixture } from "./support/akuma-fixtures.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { BodySupervisor } from "../src/akuma/body-supervisor.js";
import { observeAdmittedTellAkuma } from "../src/akuma/akuma-selection-execution.js";
import { pendingTellReceipt } from "../src/akuma/call-initial-tell.js";
import { recordTell, beginTurn, bindTellsToTurn, endTurn, breakBody, readHeart, readTell } from "../src/akuma/heart/index.js";
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

test("malformed and future Heart versions fail distinctly instead of becoming absence", async () => {
  const fixture = await heartFixture("kei-heart-format-");
  const { paths } = fixture.allocated;
  try {
    const database = new DatabaseSync(paths.heart);
    try {
      database.exec("DROP TABLE akuma_schema; CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version)");
      database.exec("INSERT INTO akuma_schema VALUES (1, '29')");
      await assert.rejects(readHeart(paths), { category: "authority-corruption" });
      database.exec("UPDATE akuma_schema SET version = 2147483648");
      await assert.rejects(readHeart(paths), /heart schema version must be 32; found 2147483648/u);
    } finally {
      database.close();
    }
  } finally {
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
      observe: async ({ status, rows }) => {
        assert.equal(status.work.turn?.sequence, turnSequence, "notification may run after the snapshot, not split it");
        if (rows.every((row) => row.kind !== "outcome")) await endTurn(paths, { turnSequence, outcome, completedAt: AT });
      },
    });
    assert.deepEqual(result, { reason: "completed", outcome, completedAt: AT });
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

test("ask stops on an abandoned bound Turn without inventing an answer", async (context) => {
  const root = await World.at(temporaryDirectory(context, "kei-ask-stopped-"));
  const parent = await born(root);
  const body = await parent.leash.recordBody(parent.paths, { leashTakenAt: AT });
  await recordTell(parent.paths, { kind: "tell", id: "asked", body: "work", recordedAt: AT });
  const turn = await beginTurn(parent.paths, { bodySequence: body.sequence, startedAt: AT });
  await bindTellsToTurn(parent.paths, { turnSequence: turn.sequence, tellIds: ["asked"], boundAt: AT });
  await breakBody(parent.paths, { sequence: body.sequence, end: "put-down", at: AT });
  parent.leash.release();
  const result = await new AkumaOwner(parent.id, root).tellOutcome("asked", { signal: AbortSignal.timeout(2000) });
  assert.equal(result.reason, "completed");
  assert.equal(result.outcome, null);
  assert.equal((await readTell(parent.paths, "asked"))?.state, "pending");
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

test("ask cancellation interrupts contended Heart admission", async (context) => {
  const root = await World.at(temporaryDirectory(context, "kei-ask-cancel-"));
  const parent = await born(root);
  await recordTell(parent.paths, { kind: "tell", id: "blocked", body: "work", recordedAt: AT });
  const blocker = new DatabaseSync(parent.paths.heart);
  blocker.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  blocker.prepare("SELECT version FROM akuma_schema").get();
  const controller = new AbortController();
  const reason = new Error("cancel ask read");
  const timer = setTimeout(() => controller.abort(reason), 20);
  try {
    await assert.rejects(
      new AkumaOwner(parent.id, root).tellOutcome("blocked", { signal: controller.signal }),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
    blocker.close();
    parent.leash.release();
  }
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
