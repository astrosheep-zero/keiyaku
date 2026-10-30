import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { appendActivity, recordReport, cancelBodyTurns, classifyHeartSchema, readHeart, readTurn } from "../src/akuma/heart/index.js";
import { withReadOnlyHeart } from "../src/akuma/heart/storage.js";
import { encodeSoulRow } from "../src/akuma/heart/soul.js";
import { soulFixture } from "./support/akuma-fixtures.js";

const at = "2026-10-29T00:00:00.000Z";

// This is deliberately the old DDL, including both CHECK constraints, not a
// current Heart relabeled as old or a migration generated from current source.
async function legacyFixture(version: 29 | 30 = 29) {
  const owner = await soulFixture("keiyaku-heart-upgrade-");
  const allocated = await allocateAkumaDirectory({ worldRoot: owner.root, archetype: "claude", draw: () => "29abcdef" });
  const database = new DatabaseSync(allocated.paths.heart);
  try {
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
    database.prepare("INSERT INTO soul VALUES (1, ?)").run(...encodeSoulRow({ ...owner.soul, id: allocated.id }));
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
    database.prepare("INSERT INTO requests VALUES (1, 'request-1', ?, 'akuma.call', '{}', ?, 'reserved', 'aku/claude/1234abcd', NULL, NULL, NULL)").run(allocated.id, at);
    database.prepare("INSERT INTO control VALUES ('stop', '{\"bodySequence\":2}', ?), ('pause', '{\"bodySequence\":2,\"frontierTellId\":\"pending\"}', ?)").run(at, at);
    database.prepare("INSERT INTO kills VALUES (1, 1, 'killed', ?)").run(at);
    database.exec("UPDATE activity_retention SET checked_sequence = 3; COMMIT");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
  return { ...owner, paths: allocated.paths };
}

function contents(database: DatabaseSync) {
  // Added empty tables and SQLite's own bookkeeping row order are not historical facts.
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('akuma_schema', 'reports') ORDER BY name").all();
  return tables.map(({ name }) => [name, database.prepare(`SELECT * FROM ${name} ORDER BY ${name === "sqlite_sequence" ? "name" : "rowid"}`).all()]);
}

function raw(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return { version: database.prepare("SELECT version FROM akuma_schema").get()?.version, contents: contents(database),
      schema: database.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all() };
  } finally {
    database.close();
  }
}

for (const entry of ["read", "write"] as const) test(`v29 upgrades at normal ${entry} open without losing any connected fact`, async () => {
  const value = await legacyFixture();
  try {
    const before = raw(value.paths.heart);
    assert.equal(await classifyHeartSchema(value.paths), "unsupported");
    assert.deepEqual(raw(value.paths.heart), before, "classification does not upgrade");
    if (entry === "read") await readHeart(value.paths);
    else await appendActivity(value.paths, { turnSequence: 11, event: { type: "note", text: "new" }, at });
    assert.equal(raw(value.paths.heart).version, 31);
    if (entry === "read") assert.deepEqual(raw(value.paths.heart).contents, before.contents);
    else {
      // The write adds only its declared activity and sequence, not rewritten history.
      const database = new DatabaseSync(value.paths.heart);
      try {
        database.exec("PRAGMA foreign_keys=ON; DELETE FROM timeline WHERE sequence = 12; UPDATE sqlite_sequence SET seq = 11 WHERE name = 'timeline'");
        assert.deepEqual(contents(database), before.contents);
      } finally { database.close(); }
    }
    assert.equal((await readTurn(value.paths, 6))?.end?.outcome.kind, "failed", "historical diagnostic never infers cancellation");
    assert.deepEqual(await cancelBodyTurns(value.paths, { bodySequence: 2, at }), { canceled: [11], disposition: null });
    assert.deepEqual((await readTurn(value.paths, 11))?.end?.outcome, { kind: "canceled" });
    assert.deepEqual((await readHeart(value.paths)).pending.map((tell) => tell.id), ["pending"]);
    await withReadOnlyHeart(value.paths, (database) => {
      assert.equal(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      assert.throws(() => database.exec("INSERT INTO activity_retention VALUES (2, 0)"), /readonly/u,
        "current-format reads retain a physically read-only connection");
    });
    const database = new DatabaseSync(value.paths.heart);
    try {
      database.exec("PRAGMA foreign_keys=ON; DELETE FROM timeline WHERE sequence = 1");
      assert.equal(database.prepare("SELECT * FROM calls").get(), undefined, "child cascade still targets the rebuilt turns table");
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { database.close(); }
  } finally { value.close(); }
});

test("v30 preserves canceled history and a pruned timeline's high-water when admitting the first report", async () => {
  const value = await legacyFixture(30);
  try {
    const old = new DatabaseSync(value.paths.heart);
    try {
      old.exec("UPDATE turns SET outcome = 'canceled', diagnostic = NULL WHERE sequence = 6");
      old.exec("UPDATE sqlite_sequence SET seq = 9000 WHERE name = 'timeline'");
    } finally { old.close(); }
    const before = raw(value.paths.heart).contents;
    await readHeart(value.paths);
    assert.equal(raw(value.paths.heart).version, 31);
    assert.deepEqual(raw(value.paths.heart).contents, before);
    assert.deepEqual((await readTurn(value.paths, 6))?.end?.outcome, { kind: "canceled" });
    const report = await recordReport(value.paths, { bodySequence: 2, turnSequence: 11, text: "first report", at });
    assert.equal(report.kind, "recorded");
    if (report.kind !== "recorded") assert.fail("report refused");
    assert.equal(report.report.sequence, 9001);
    await withReadOnlyHeart(value.paths, database => {
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM reports").get()?.count, 1);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    });
  } finally { value.close(); }
});

test("concurrent v29 openers wait asynchronously and publish exactly one conversion", async (context) => {
  const value = await legacyFixture();
  const blocker = new DatabaseSync(value.paths.heart);
  const exec = DatabaseSync.prototype.exec;
  let rebuilds = 0;
  context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql.includes("CREATE TABLE turns_upgrade")) rebuilds++;
    return exec.call(this, sql);
  });
  try {
    const before = raw(value.paths.heart).contents;
    blocker.exec("BEGIN IMMEDIATE");
    let settled = false;
    const opening = Promise.all(Array.from({ length: 6 }, () => readHeart(value.paths))).finally(() => { settled = true; });
    await delay(30);
    assert.equal(settled, false);
    blocker.exec("ROLLBACK");
    await opening;
    assert.equal(rebuilds, 1);
    assert.deepEqual(raw(value.paths.heart).contents, before);
  } finally { blocker.close(); value.close(); }
});

test("a broken child relationship rolls back both rebuilt tables and version", async () => {
  const value = await legacyFixture();
  try {
    const corrupt = new DatabaseSync(value.paths.heart);
    corrupt.exec("PRAGMA foreign_keys=OFF; INSERT INTO calls VALUES (99, 999, 'orphan', 'retained corruption')");
    corrupt.close();
    const before = raw(value.paths.heart);
    await assert.rejects(readHeart(value.paths), /broken foreign key relationships/u);
    assert.deepEqual(raw(value.paths.heart), before);
  } finally { value.close(); }
});

test("a failed upgrade commit rolls back and the next ordinary open can retry", async (context) => {
  const value = await legacyFixture();
  const before = raw(value.paths.heart);
  const failure = new Error("upgrade commit denied");
  const exec = DatabaseSync.prototype.exec;
  const injected = context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") throw failure;
    return exec.call(this, sql);
  });
  try {
    await assert.rejects(readHeart(value.paths), (error) => error === failure);
    injected.mock.restore();
    assert.deepEqual(raw(value.paths.heart), before);
    await readHeart(value.paths);
    assert.equal(raw(value.paths.heart).version, 31);
    assert.deepEqual(raw(value.paths.heart).contents, before.contents);
  } finally { injected.mock.restore(); value.close(); }
});
