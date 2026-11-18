import assert from "node:assert/strict";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { wakeRecordedTell } from "../src/akuma/body.js";
import { allocateAkumaDirectory, type AkumaPaths } from "../src/akuma/identity.js";
import { appendActivity, readHeart } from "../src/akuma/heart/index.js";
import { LEASH_SCHEMA } from "../src/akuma/heart/schema.js";
import { withReadOnlyHeart } from "../src/akuma/heart/storage.js";
import { encodeSoulRow } from "../src/akuma/heart/soul.js";
import { soulFixture } from "./support/akuma-fixtures.js";

const at = "2026-10-29T00:00:00.000Z";

// This is deliberately the old DDL, including both CHECK constraints, not a
// current Heart relabeled as old or a migration generated from current source.
async function legacyFixture(version: 29 | 30, wal: boolean) {
  const owner = await soulFixture("kei-old-heart-");
  const { id, paths } = await allocateAkumaDirectory({ worldRoot: owner.root, akumaName: "claude", draw: () => "29abcdef" });
  const seed = wal ? join(owner.root, "wal-seed.db") : paths.heart;
  const database = new DatabaseSync(seed);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    let schema = readFileSync("tests/fixtures/heart-v29.sql", "utf8");
    if (version === 30) schema = schema
      .replace("version = 29", "version = 30")
      .replace("VALUES (1, 29)", "VALUES (1, 30)")
      .replace("'answered', 'failed', 'invalid-output'", "'answered', 'failed', 'invalid-output', 'canceled'")
      .replace("    OR (outcome IS NULL", `    OR (outcome = 'canceled' AND history_id IS NULL AND session_json IS NULL AND answer IS NULL
      AND answer_json IS NULL AND diagnostic IS NULL)
    OR (outcome IS NULL`);
    database.exec(schema);
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    database.prepare("INSERT INTO soul VALUES (1, ?)").run(...encodeSoulRow({ ...owner.soul, id }));
    database.prepare("INSERT INTO bodies VALUES (1, ?, NULL, NULL, 'put-down', ?), (2, ?, NULL, NULL, NULL, NULL)").run(at, at, at);
    database.prepare("INSERT INTO sessions VALUES (1, 'claude', ?, ?, ?, ?)")
      .run('{"sessionId":"old-native"}', owner.root, '{"model":"retained","opaque":true}', at);
    database.exec(`INSERT INTO timeline VALUES
      (1, 'turn-start'), (2, 'call'), (3, 'activity'), (4, 'tell'), (5, 'turn-end'),
      (6, 'turn-start'), (7, 'tell'), (8, 'turn-end'), (9, 'turn-start'), (10, 'turn-end'), (11, 'turn-start');`);
    database.prepare(`INSERT INTO turns (sequence, body_sequence, started_at, initiator, end_sequence, outcome,
      history_id, session_json, answer, answer_json, schema_json, diagnostic, completed_at) VALUES
      (1, 1, ?, 'Alice', 5, 'answered', 'old-answer', '{"sessionId":"old-native"}', '{"ok":true}', '{"ok":true}', '{"type":"object"}', NULL, ?),
      (6, 1, ?, 'Bob', 8, 'failed', NULL, NULL, NULL, NULL, NULL, 'Body put-down with open bound Turns', ?),
      (9, 1, ?, NULL, 10, 'invalid-output', NULL, NULL, 'not JSON', NULL, '{"type":"object"}', 'invalid JSON', ?),
      (11, 2, ?, 'Carol', NULL, NULL, NULL, NULL, NULL, NULL, '{"type":"object"}', NULL, NULL)`)
      .run(at, at, at, at, at, at, at);
    database.prepare("INSERT INTO calls VALUES (2, 1, 'first prompt', ?)").run(at);
    database.prepare("INSERT INTO activity VALUES (3, 1, ?, ?)").run('{"type":"note","text":"retained"}', at);
    database.prepare("INSERT INTO tells VALUES ('told', 4, 'delivered', 'Alice', NULL, ?), ('pending', 7, 'keep me', 'Carol', NULL, ?)").run(at, at);
    database.prepare("INSERT INTO tell_bindings VALUES (1, 'told', 1, ?), (2, 'pending', 11, ?)").run(at, at);
    database.prepare("INSERT INTO tell_deliveries VALUES (1, 'told', 'launch', 1, 'old-fence', NULL, ?), (2, 'pending', 'live', 11, 'pending-fence', 'required', ?)").run(at, at);
    database.prepare("INSERT INTO tell_receipts VALUES (1, 'fence', NULL, 1, 'old-fence', 'accepted', ?)").run(at);
    database.prepare("INSERT INTO tell_dispositions VALUES (1, ?, NULL)").run(at);
    database.exec("INSERT INTO tell_disposition_members VALUES (1, 'pending')");
    database.prepare("INSERT INTO requests VALUES (1, 'request-1', ?, 'akuma.call', '{}', ?, 'reserved', 'aku/claude/1234abcd', NULL, NULL, NULL)").run(id, at);
    database.prepare("INSERT INTO control VALUES ('stop', '{\"bodySequence\":2}', ?), ('pause', '{\"bodySequence\":2,\"frontierTellId\":\"pending\"}', ?)").run(at, at);
    database.prepare("INSERT INTO kills VALUES (1, 1, 'killed', ?)").run(at);
    if (version === 30) database.exec("UPDATE turns SET outcome = 'canceled', diagnostic = NULL WHERE sequence = 6");
    database.exec("UPDATE sqlite_sequence SET seq = 9000 WHERE name = 'timeline'; UPDATE activity_retention SET checked_sequence = 3; COMMIT");
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
  return new Map(readdirSync(paths.directory).sort().map((name) => [name, readFileSync(join(paths.directory, name))]));
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
        assert.match(error.message, new RegExp(`schema version must be 31; found ${version}`, "u"));
        assert.match(error.message, /No converter.*Stop all writers via their owning build before copying the entire custody directory/u);
        assert.match(error.message, /heart\.db, any heart\.db-wal\/heart\.db-shm, leash\.db, stdio\.log/u);
        assert.match(error.message, /original untouched.*only on the copy.*separate World.*previously installed compatible build.*same Akuma identity\/layout.*may upgrade the copy.*leave custody alone/u);
        return true;
      };
      await assert.rejects(readHeart(paths), refused);
      await assert.rejects(owner.history(), refused);
      await assert.rejects(owner.wait({ signal: AbortSignal.timeout(2_000) }), refused);
      await assert.rejects(wakeRecordedTell(paths, "pending", { spawn }), refused);
      await assert.rejects(appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "new" }, at }), refused);
      assert.equal(spawn.mock.callCount(), 0);
      assert.ok(readers.size >= 5);
      assert.ok([...readers].every((reader) => !reader.isOpen), "refusal closes every version reader");
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
      const refusal = new RegExp(`schema version must be 31; found ${version}`, "u");
      await assert.rejects(readHeart(paths), refusal);
      await assert.rejects(appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "new" }, at }), refusal);
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
