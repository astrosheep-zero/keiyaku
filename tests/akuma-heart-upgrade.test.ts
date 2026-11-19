import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { wakeRecordedTell } from "../src/akuma/body.js";
import { allocateAkumaDirectory, type AkumaPaths } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { Akuma, Akumas, nuke } from "../src/index.js";
import {
  appendActivity,
  cancelBodyTurns,
  HeldAkumaLeash,
  readHeart,
  readTell,
  readTellAction,
  readTurn,
  recordReport,
  recordTellReceipt,
} from "../src/akuma/heart/index.js";
import { HeartNeedsUpgradeError, LEASH_SCHEMA } from "../src/akuma/heart/schema.js";
import { createHeartReader, withHeartTransaction, withReadOnlyHeart } from "../src/akuma/heart/storage.js";
import { encodeSoulRow } from "../src/akuma/heart/soul.js";
import { soulFixture } from "./support/akuma-fixtures.js";
import { waitForCondition } from "./support/process.js";

const at = "2026-10-29T00:00:00.000Z";
const earlier = "2026-10-28T00:00:00.000Z";
const later = "2026-10-29T00:00:01.000Z";
const needsUpgrade = {
  constructor: HeartNeedsUpgradeError,
  message: /found 31: .*Upgrade requires a Heart write/u,
};

// This is deliberately the old DDL, including both CHECK constraints, not a
// current Heart relabeled as old or a migration generated from current source.
async function legacyFixture(version: 29 | 30 | 31, wal: boolean, prepare?: (database: DatabaseSync) => void) {
  const owner = await soulFixture("kei-old-heart-");
  const { id, paths } = await allocateAkumaDirectory({
    worldRoot: owner.root,
    akumaName: "claude",
    draw: () => "29abcdef",
  });
  const seed = wal ? join(owner.root, "wal-seed.db") : paths.heart;
  const database = new DatabaseSync(seed);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    let schema = readFileSync("tests/fixtures/heart-v29.sql", "utf8");
    if (version >= 30)
      schema = schema
        .replace("version = 29", `version = ${version}`)
        .replace("VALUES (1, 29)", `VALUES (1, ${version})`)
        .replace("'answered', 'failed', 'invalid-output'", "'answered', 'failed', 'invalid-output', 'canceled'")
        .replace(
          "    OR (outcome IS NULL",
          `    OR (outcome = 'canceled' AND history_id IS NULL AND session_json IS NULL AND answer IS NULL
      AND answer_json IS NULL AND diagnostic IS NULL)
    OR (outcome IS NULL`,
        );
    if (version === 31)
      schema =
        schema.replace("'tell', 'turn-end'", "'tell', 'turn-end', 'report'") +
        `
      DROP TABLE requests;
      CREATE TABLE reports (
        sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
        body_sequence INTEGER NOT NULL REFERENCES bodies(sequence),
        turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
        text TEXT NOT NULL,
        at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX reports_by_turn ON reports(turn_sequence);`;
    database.exec(schema);
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    database.prepare("INSERT INTO soul VALUES (1, ?)").run(...encodeSoulRow({ ...owner.soul, id }));
    database
      .prepare("INSERT INTO bodies VALUES (1, ?, NULL, NULL, 'put-down', ?), (2, ?, NULL, NULL, NULL, NULL)")
      .run(at, at, at);
    database
      .prepare("INSERT INTO sessions VALUES (1, 'claude', ?, ?, ?, ?)")
      .run('{"sessionId":"old-native"}', owner.root, '{"model":"retained","opaque":true}', at);
    database.exec(`INSERT INTO timeline VALUES
      (1, 'turn-start'), (2, 'call'), (3, 'activity'), (4, 'tell'), (5, 'turn-end'),
      (6, 'turn-start'), (7, 'tell'), (8, 'turn-end'), (9, 'turn-start'), (10, 'turn-end'), (11, 'turn-start');`);
    database
      .prepare(
        `INSERT INTO turns (sequence, body_sequence, started_at, initiator, end_sequence, outcome,
      history_id, session_json, answer, answer_json, schema_json, diagnostic, completed_at) VALUES
      (1, 1, ?, 'Alice', 5, 'answered', 'old-answer', '{"sessionId":"old-native"}', '{"ok":true}', '{"ok":true}', '{"type":"object"}', NULL, ?),
      (6, 1, ?, 'Bob', 8, 'failed', NULL, NULL, NULL, NULL, NULL, 'Body put-down with open bound Turns', ?),
      (9, 1, ?, NULL, 10, 'invalid-output', NULL, NULL, 'not JSON', NULL, '{"type":"object"}', 'invalid JSON', ?),
      (11, 2, ?, 'Carol', NULL, NULL, NULL, NULL, NULL, NULL, '{"type":"object"}', NULL, NULL)`,
      )
      .run(at, at, at, at, at, at, at);
    database.prepare("INSERT INTO calls VALUES (2, 1, 'first prompt', ?)").run(at);
    database.prepare("INSERT INTO activity VALUES (3, 1, ?, ?)").run('{"type":"note","text":"retained"}', at);
    database
      .prepare(
        "INSERT INTO tells VALUES ('told', 4, 'delivered', 'Alice', NULL, ?), ('pending', 7, 'keep me', 'Carol', NULL, ?)",
      )
      .run(at, at);
    database.prepare("INSERT INTO tell_bindings VALUES (1, 'told', 1, ?), (2, 'pending', 11, ?)").run(at, at);
    database
      .prepare(
        "INSERT INTO tell_deliveries VALUES (1, 'told', 'launch', 1, 'old-fence', NULL, ?), (2, 'pending', 'live', 11, 'pending-fence', 'required', ?)",
      )
      .run(at, at);
    database.prepare("INSERT INTO tell_receipts VALUES (1, 'fence', NULL, 1, 'old-fence', 'accepted', ?)").run(at);
    database.prepare("INSERT INTO tell_dispositions VALUES (1, ?, NULL)").run(at);
    database.exec("INSERT INTO tell_disposition_members VALUES (1, 'pending')");
    if (version === 31) {
      database.exec(
        `INSERT INTO timeline VALUES (12, 'report'), (13, 'tell'), (14, 'tell'), (15, 'tell'), (16, 'tell');`,
      );
      database.prepare("INSERT INTO reports VALUES (12, 2, 11, 'retained report', ?)").run(at);
      const tell = database.prepare("INSERT INTO tells VALUES (?, ?, ?, NULL, NULL, ?)");
      tell.run("also-mapped", 13, "shares old fence", at);
      tell.run("unavailable", 14, "delivery is enough", at);
      tell.run("undelivered", 15, "terminal without delivery", at);
      tell.run("bound-only", 16, "not submitted", at);
      database.prepare("INSERT INTO tell_bindings VALUES (3, 'bound-only', 11, ?)").run(at);
      database
        .prepare(
          `INSERT INTO tell_deliveries VALUES
        (3, 'also-mapped', 'live', 1, 'old-fence', 'required', ?),
        (4, 'unavailable', 'live', 11, 'no-receipt-channel', 'unavailable', ?),
        (5, 'undelivered', 'live', 1, 'old-fence', 'required', ?)`,
        )
        .run(at, at, at);
      database
        .prepare(
          `INSERT INTO tell_receipts VALUES
        (2, 'exact', 'told', NULL, NULL, 'accepted', ?),
        (3, 'exact', 'also-mapped', NULL, NULL, 'accepted', ?),
        (4, 'exact', 'undelivered', NULL, NULL, 'undelivered', ?),
        (5, 'fence', NULL, 1, 'already-pruned', 'accepted', ?),
        (6, 'fence', NULL, 1, 'old-fence', 'undelivered', ?)`,
        )
        .run(later, earlier, later, at, at);
      database.exec("UPDATE sqlite_sequence SET seq = MAX(seq, 9000)");
    } else {
      database
        .prepare(
          "INSERT INTO requests VALUES (1, 'request-1', ?, 'akuma.call', '{}', ?, 'reserved', 'aku/claude/1234abcd', NULL, NULL, NULL)",
        )
        .run(id, at);
    }
    database
      .prepare("INSERT INTO control VALUES ('stop', '{\"bodySequence\":2}', ?), ('pause', ?, ?)")
      .run(at, JSON.stringify({ bodySequence: 2, frontierTellId: version === 31 ? "bound-only" : "pending" }), at);
    database.prepare("INSERT INTO kills VALUES (1, 1, 'killed', ?)").run(at);
    if (version === 30) database.exec("UPDATE turns SET outcome = 'canceled', diagnostic = NULL WHERE sequence = 6");
    prepare?.(database);
    database.exec(`UPDATE sqlite_sequence SET seq = 9000 WHERE name = 'timeline';
      UPDATE activity_retention SET checked_sequence = ${version === 31 ? 16 : 3}; COMMIT`);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    const leash = new DatabaseSync(paths.leash);
    try {
      leash.exec(LEASH_SCHEMA);
    } finally {
      leash.close();
    }
    writeFileSync(paths.log, "retained execution log\n");
    // Reproduce a left-behind WAL without a live writer shielding it from an
    // accidental checkpoint when the connection under test closes.
    if (wal) for (const suffix of ["", "-wal", "-shm"]) copyFileSync(seed + suffix, paths.heart + suffix);
    return { root: owner.root, id, paths, close: owner.close };
  } finally {
    database.close();
  }
}

function custodyBytes(paths: AkumaPaths) {
  return new Map(
    readdirSync(paths.directory)
      .sort()
      .map((name) => [name, readFileSync(join(paths.directory, name))]),
  );
}

function oldHistory(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    const tables = database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
    return { tables, rows: tables.map(({ name }) => database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()) };
  } finally {
    database.close();
  }
}

for (const version of [29, 30] as const) {
  test(`v${version} refuses ordinary Akuma access without changing closed custody`, async (context) => {
    const value = await legacyFixture(version, false);
    const { paths } = value;
    try {
      const original = custodyBytes(paths);
      assert.deepEqual([...original.keys()], ["heart.db", "leash.db", "stdio.log"]);
      const readers = new Set<DatabaseSync>();
      const prepare = DatabaseSync.prototype.prepare;
      context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        if (sql.includes("FROM akuma_schema")) readers.add(this);
        return prepare.call(this, sql);
      });
      const owner = new AkumaOwner(value.id, value.root);
      const spawn = context.mock.fn(async () => assert.fail("old Heart must not spawn a Body"));
      const refused = (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(paths.heart));
        assert.match(error.message, new RegExp(`schema version must be 32; found ${version}`, "u"));
        assert.match(
          error.message,
          /No converter.*Stop all writers via their owning build before copying the entire custody directory/u,
        );
        assert.match(error.message, /heart\.db, any heart\.db-wal\/heart\.db-shm, leash\.db, stdio\.log/u);
        assert.match(
          error.message,
          /original untouched.*only on the copy.*separate World.*previously installed compatible build.*same Akuma identity\/layout.*may upgrade the copy.*leave custody alone/u,
        );
        return true;
      };
      await assert.rejects(readHeart(paths), refused);
      await assert.rejects(owner.history(), refused);
      await assert.rejects(owner.wait({ signal: AbortSignal.timeout(2_000) }), refused);
      await assert.rejects(wakeRecordedTell(paths, "pending", { spawn }, AbortSignal.timeout(2_000), true), refused);
      await assert.rejects(
        appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "new" }, at }),
        refused,
      );
      assert.equal(spawn.mock.callCount(), 0);
      assert.ok(readers.size >= 5);
      assert.ok(
        [...readers].every((reader) => !reader.isOpen),
        "refusal closes every version reader",
      );
      const after = custodyBytes(paths);
      for (const [name, bytes] of original) assert.deepEqual(after.get(name), bytes, name);
      for (const [name, bytes] of after) {
        if (!original.has(name))
          assert.ok(name === "heart.db-shm" || (name === "heart.db-wal" && bytes.length === 0), name);
      }
    } finally {
      value.close();
    }
  });

  test(`v${version} refuses using the retained WAL without checkpointing it`, async () => {
    const { paths, close } = await legacyFixture(version, true);
    try {
      const original = custodyBytes(paths);
      assert.ok(original.get("heart.db-wal")!.length > 0);
      const history = oldHistory(paths.heart);
      const refusal = new RegExp(`schema version must be 32; found ${version}`, "u");
      await assert.rejects(readHeart(paths), refusal);
      await assert.rejects(
        appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "new" }, at }),
        refusal,
      );
      const after = custodyBytes(paths);
      assert.deepEqual([...after.keys()], [...original.keys()]);
      // SHM lock/cache bookkeeping is not retained execution evidence.
      after.delete("heart.db-shm");
      original.delete("heart.db-shm");
      assert.deepEqual(after, original);
      assert.deepEqual(oldHistory(paths.heart), history);
    } finally {
      close();
    }
  });
}

function retained31Source(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = database
      .prepare(
        `SELECT name, type, sql, rootpage FROM sqlite_schema
      WHERE tbl_name NOT IN ('akuma_schema', 'tell_terminal_receipts') ORDER BY name`,
      )
      .all();
    return {
      version: database.prepare("SELECT version FROM akuma_schema").get()?.version,
      schema,
      rows: schema
        .filter(({ type }) => type === "table")
        .map(({ name }) =>
          database.prepare(`SELECT * FROM ${name} ORDER BY ${name === "sqlite_sequence" ? "name" : "rowid"}`).all(),
        ),
    };
  } finally {
    database.close();
  }
}

test("v31 readers preserve retained WAL; a Tell write converts without losing history or high-water marks", async () => {
  const { id, root, paths, close } = await legacyFixture(31, true);
  const observer = createHeartReader(paths);
  try {
    const original = custodyBytes(paths);
    assert.ok(original.get("heart.db-wal")!.length > 0);
    const before = retained31Source(paths.heart);
    assert.equal(before.version, 31);
    await assert.rejects(readHeart(paths), needsUpgrade);
    await assert.rejects(
      observer.read(() => assert.fail("old Heart must not enter the read")),
      needsUpgrade,
    );
    await assert.rejects(new AkumaOwner(id, root).wait({ signal: AbortSignal.timeout(2_000) }), needsUpgrade);
    const after = custodyBytes(paths);
    // SQLite may update coordination bookkeeping but not the database or retained WAL.
    original.delete("heart.db-shm");
    after.delete("heart.db-shm");
    assert.deepEqual(after, original);
    assert.deepEqual(retained31Source(paths.heart), before);

    await recordTellReceipt(paths, { evidence: "exact", tellId: "also-mapped", kind: "accepted", receivedAt: later });
    await assert.rejects(
      recordTellReceipt(paths, {
        evidence: "fence",
        turnSequence: 1,
        fence: "unknown",
        kind: "accepted",
        receivedAt: later,
      }),
      /no delivery mapping/u,
    );
    const refused = custodyBytes(paths);
    refused.delete("heart.db-shm");
    assert.deepEqual(refused, original, "idempotent and failed receipts must not publish conversion");
    await recordTellReceipt(paths, { evidence: "exact", tellId: "also-mapped", kind: "follow-up", receivedAt: later });
    assert.deepEqual(
      (await readHeart(paths)).pending.map(({ id }) => id),
      ["pending", "bound-only"],
    );
    assert.deepEqual(retained31Source(paths.heart), { ...before, version: 32 });
    await withReadOnlyHeart(paths, (db) => {
      const rows = db.prepare("SELECT * FROM tell_terminal_receipts ORDER BY tell_id, kind").all();
      assert.deepEqual(
        rows.map(({ tell_id, kind, received_at, undelivered }) => [tell_id, kind, received_at, undelivered]),
        [
          ["also-mapped", "accepted", earlier, 0],
          ["also-mapped", "follow-up", later, 0],
          ["also-mapped", "undelivered", at, 0],
          ["told", "accepted", at, 0],
          ["told", "launch", at, 0],
          ["told", "undelivered", at, 0],
          ["unavailable", "unavailable", at, 0],
          ["undelivered", "accepted", at, 0],
          ["undelivered", "undelivered", at, 1],
        ],
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    });
    assert.deepEqual(await readTellAction(paths, "also-mapped"), { kind: "live", turnSequence: 1 });
    assert.deepEqual(await readTellAction(paths, "undelivered"), { kind: "undelivered" });
    const negative = { evidence: "exact", tellId: "also-mapped", kind: "undelivered" } as const;
    await recordTellReceipt(paths, { ...negative, receivedAt: later });
    await recordTellReceipt(paths, { ...negative, receivedAt: earlier });
    assert.deepEqual(await readTellAction(paths, "also-mapped"), { kind: "undelivered" });
    assert.deepEqual(await readTellAction(paths, "pending"), { kind: "live", turnSequence: 11 });
    assert.equal((await readTell(paths, "pending"))?.state, "pending", "submission is not the stronger receipt");
    assert.equal((await readTurn(paths, 1))?.end?.outcome.kind, "answered");
    const report = await recordReport(paths, { text: "after normalization", at });
    assert.equal(report.kind === "recorded" && report.report.sequence, 9001);
    await recordTellReceipt(paths, {
      evidence: "fence",
      turnSequence: 11,
      fence: "pending-fence",
      kind: "undelivered",
      receivedAt: later,
    });
    assert.equal((await readTell(paths, "pending"))?.state, "told");
    assert.deepEqual(await readTellAction(paths, "pending"), { kind: "live", turnSequence: 11 });
    await withReadOnlyHeart(paths, (db) => {
      const promoted = db
        .prepare(
          `SELECT received_at, undelivered FROM tell_terminal_receipts
        WHERE tell_id = 'also-mapped' AND kind = 'undelivered'`,
        )
        .get();
      assert.equal(promoted?.received_at, at);
      assert.equal(promoted?.undelivered, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tell_receipts").get()?.count, 6);
      assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tell_receipts'").get()?.seq, 9000);
    });
  } finally {
    close();
  }
});

test("addressed Tell, Ask and Kill reach their first real admission on v31", async () => {
  for (const verb of ["Tell", "Ask", "Kill", "Kill glob"] as const) {
    const { root, id, paths, close } = await legacyFixture(31, true, (db) => {
      db.exec("DELETE FROM control WHERE kind = 'stop'");
    });
    const holder = await HeldAkumaLeash.try(paths);
    assert.ok(holder);
    const api = Akumas.of(root);
    try {
      await assert.rejects(api.status({ akuma: id }), /Upgrade requires a Heart write/u);
      if (verb === "Kill" || verb === "Kill glob") {
        const controller = new AbortController();
        const killing = api.kill({ akuma: verb === "Kill" ? id : "aku/claude/29*", signal: controller.signal });
        // Keep the Body under its leash until the addressed call actually records stop.
        const settled = Promise.allSettled([killing]);
        try {
          await waitForCondition(
            "addressed stop admission",
            async () =>
              (
                await readHeart(paths).catch((error: unknown) => {
                  if (error instanceof HeartNeedsUpgradeError) return null;
                  throw error;
                })
              )?.stop?.bodySequence === 2,
          );
          await cancelBodyTurns(paths, { bodySequence: 2, at: later });
          holder.release();
          assert.deepEqual(await killing, { results: [{ id, outcome: "killed" }] });
        } finally {
          controller.abort();
          await settled;
        }
      } else {
        const alias = parseAkumaAlias("@legacy");
        if (verb === "Ask") await moveAlias({ world: root, alias, akumaId: id });
        const input = { akuma: verb === "Ask" ? alias : id, body: `first ${verb}`, timeoutMs: 0 };
        const receipt =
          verb === "Tell"
            ? await api.tell({ ...input, wait: true })
            : await api.ask({ ...input, schema: {}, interrupt: true });
        assert.ok("tellId" in receipt && receipt.tellId);
        assert.ok(
          (await readHeart(paths)).pending.some((tell) => tell.id === receipt.tellId && tell.body === input.body),
        );
      }
      assert.equal(retained31Source(paths.heart).version, 32);
    } finally {
      holder.release();
      close();
    }
  }
});

test("a refused report does not convert a settled v31 Heart or change its retained WAL", async () => {
  const { id, root, paths, close } = await legacyFixture(31, true, (db) => {
    db.exec(`INSERT INTO timeline VALUES (17, 'turn-end');
      UPDATE turns SET outcome = 'canceled', end_sequence = 17, completed_at = '${later}' WHERE sequence = 11;
      UPDATE bodies SET end = 'put-down', ended_at = '${later}' WHERE sequence = 2;
      DELETE FROM control`);
  });
  try {
    const original = custodyBytes(paths);
    assert.ok(original.get("heart.db-wal")!.length > 0);
    assert.deepEqual(await Akuma.select(root, id).report("no executing Turn"), {
      kind: "refused",
      reason: "not-executing",
    });
    const after = custodyBytes(paths);
    original.delete("heart.db-shm");
    after.delete("heart.db-shm");
    assert.deepEqual(after, original);
    await assert.rejects(readHeart(paths), needsUpgrade);
  } finally {
    close();
  }
});

test("Reset cannot delete held v31 custody or convert it to inspect its Body", async () => {
  const { root, id, paths, close } = await legacyFixture(31, false);
  const holder = await HeldAkumaLeash.try(paths);
  assert.ok(holder);
  const writer = new DatabaseSync(paths.heart);
  try {
    assert.equal(writer.prepare("SELECT version FROM akuma_schema").get()?.version, 31);
    writer.exec("DELETE FROM control WHERE kind = 'stop'");
    const inode = statSync(paths.heart, { bigint: true }).ino;
    const before = custodyBytes(paths);
    await assert.rejects(nuke({ world: root, confirm: root }), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof HeartNeedsUpgradeError);
      assert.match(error.message, needsUpgrade.message);
      return true;
    });
    const after = custodyBytes(paths);
    before.delete("heart.db-shm");
    after.delete("heart.db-shm");
    assert.deepEqual(after, before);
    assert.equal(statSync(paths.heart, { bigint: true }).ino, inode);
    assert.equal(await HeldAkumaLeash.try(paths), null);
    assert.equal(writer.prepare("SELECT version FROM akuma_schema").get()?.version, 31);

    await appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "explicit write" }, at });
    assert.deepEqual(await nuke({ world: root, confirm: root }), {
      kind: "accepted",
      issues: [
        { kind: "reset-owner-stopped", owner: "akuma", diagnostic: `Akuma ${id} could not be stopped: unavailable` },
      ],
    });
    assert.equal(statSync(paths.heart, { bigint: true }).ino, inode);
    assert.deepEqual(readFileSync(paths.leash), before.get("leash.db"));
    assert.deepEqual(readFileSync(paths.log), before.get("stdio.log"));
    assert.equal(await HeldAkumaLeash.try(paths), null);
    const retained = await readHeart(paths);
    assert.equal(retained.latestBody?.sequence, 2);
    assert.equal(retained.latestBody?.end, undefined);
    assert.equal(retained.stop?.bodySequence, 2);
    assert.equal((await readTurn(paths, 11))?.end, undefined);
  } finally {
    writer.close();
    holder.release();
    close();
  }
});

test("contending v31 writes convert once; canceled acquisition changes nothing", async (context) => {
  const { paths, close } = await legacyFixture(31, false);
  const blocker = new DatabaseSync(paths.heart);
  const exec = DatabaseSync.prototype.exec;
  const writers = new Set<DatabaseSync>();
  let conversions = 0;
  context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (this !== blocker && sql === "BEGIN IMMEDIATE") writers.add(this);
    if (sql.includes("CREATE TABLE tell_terminal_receipts")) conversions++;
    return exec.call(this, sql);
  });
  try {
    const before = retained31Source(paths.heart);
    blocker.exec("BEGIN IMMEDIATE");
    const controller = new AbortController();
    const reason = new Error("open canceled before acquiring writer custody");
    const write = (text: string) => appendActivity(paths, { turnSequence: 11, event: { type: "note", text }, at });
    const canceled = withHeartTransaction(
      paths,
      () => assert.fail("canceled writer entered its mutation"),
      controller.signal,
    );
    const refused = assert.rejects(canceled, (error) => error === reason);
    const opening = Promise.all([write("first contending writer"), write("second contending writer")]);
    try {
      await waitForCondition("the writers to contend under the blocker", () => writers.size === 3);
      await assert.rejects(readHeart(paths), needsUpgrade);
    } finally {
      controller.abort(reason);
    }
    await refused;
    assert.equal(conversions, 0);
    assert.deepEqual(retained31Source(paths.heart), before);
    blocker.exec("ROLLBACK");
    const committed = await opening;
    assert.equal(conversions, 1);
    assert.deepEqual(committed.sort(), [9001, 9002]);
    assert.equal(retained31Source(paths.heart).version, 32);
  } finally {
    blocker.close();
    close();
  }
});

test("a failed v31 upgrade commit rolls back the normalized evidence and version", async (context) => {
  const { paths, close } = await legacyFixture(31, false);
  const original = oldHistory(paths.heart);
  const exec = DatabaseSync.prototype.exec;
  const failure = new Error("upgrade commit denied");
  const injection = context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") throw failure;
    return exec.call(this, sql);
  });
  try {
    const write = () => appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "new" }, at });
    await assert.rejects(write(), (error) => error === failure);
    injection.mock.restore();
    assert.deepEqual(oldHistory(paths.heart), original);
    assert.equal(await write(), 9001);
    assert.equal(retained31Source(paths.heart).version, 32);
  } finally {
    injection.mock.restore();
    close();
  }
});

test("a v31 writer exiting before commit publishes neither its mutation nor the conversion", async () => {
  const { paths, close } = await legacyFixture(31, true);
  try {
    const original = oldHistory(paths.heart);
    const heart = new URL("../src/akuma/heart/index.js", import.meta.url);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
      import { DatabaseSync } from "node:sqlite";
      import { appendActivity } from ${JSON.stringify(heart.href)};
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function (sql) {
        if (sql === "COMMIT" && this.prepare("SELECT version FROM akuma_schema").get().version === 32 &&
            this.prepare("SELECT 1 FROM activity WHERE sequence = 9001").get()) process.exit(73);
        return exec.call(this, sql);
      };
      await appendActivity(${JSON.stringify(paths)}, {
        turnSequence: 11, event: { type: "note", text: "interrupted writer" }, at: ${JSON.stringify(at)},
      });
    `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 73, child.stderr);
    assert.deepEqual(oldHistory(paths.heart), original);
    await assert.rejects(readHeart(paths), needsUpgrade);
  } finally {
    close();
  }
});

test("a broken retained v31 relationship aborts conversion without publishing v32", async () => {
  const { paths, close } = await legacyFixture(31, false);
  try {
    const corrupt = new DatabaseSync(paths.heart);
    try {
      corrupt.exec("PRAGMA foreign_keys=OFF; INSERT INTO calls VALUES (99, 999, 'orphan', 'retained corruption')");
    } finally {
      corrupt.close();
    }
    const before = retained31Source(paths.heart);
    await assert.rejects(
      appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "new" }, at }),
      /broken foreign key relationships/u,
    );
    assert.deepEqual(retained31Source(paths.heart), before);
    const unchanged = new DatabaseSync(paths.heart, { readOnly: true });
    try {
      assert.equal(
        unchanged.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'tell_terminal_receipts'").get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    close();
  }
});

test("current Heart keeps a physically read-only connection during observation", async () => {
  const value = await soulFixture("kei-current-heart-");
  try {
    await withReadOnlyHeart(value.allocated.paths, (database) => {
      assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      assert.throws(() => database.exec("CREATE TABLE forbidden (x INTEGER)"), /readonly/u);
    });
  } finally {
    value.close();
  }
});
