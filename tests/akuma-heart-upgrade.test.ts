import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { wakeRecordedTell } from "../src/akuma/body.js";
import { allocateAkumaDirectory, type AkumaPaths } from "../src/akuma/identity.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { Akuma, Akumas, KeiyakuError, nuke } from "../src/index.js";
import {
  appendActivity,
  cancelBodyTurns,
  HeldAkumaLeash,
  activitySlice,
  readHeart,
  readTell,
  readTellAction,
  readTurn,
  recordReport,
  recordSurveillance,
  recordTellReceipt,
} from "../src/akuma/heart/index.js";
import { HeartNeedsUpgradeError, LEASH_SCHEMA } from "../src/akuma/heart/schema.js";
import { withHeartTransaction, withReadOnlyHeart } from "../src/akuma/heart/storage.js";
import { encodeSoulRow } from "../src/akuma/heart/soul.js";
import { cliJson } from "./support/cli-fixtures.js";
import type { WhoamiFacts } from "../src/library/keiyaku-identity.js";
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
async function legacyFixture(version: 29 | 30 | 31 | 32, wal: boolean, prepare?: (database: DatabaseSync) => void) {
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
    if (version >= 31)
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
    if (version >= 31) {
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
    if (version === 32) {
      // The current predecessor shipped this terminal evidence table, and new
      // v32 Hearts no longer created the legacy receipt table.
      database.exec(`
        CREATE TABLE tell_terminal_receipts (
          tell_id TEXT NOT NULL REFERENCES tells(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          received_at TEXT NOT NULL,
          undelivered INTEGER NOT NULL CHECK (undelivered = 0 OR (undelivered = 1 AND kind = 'undelivered')),
          PRIMARY KEY (tell_id, kind)
        ) STRICT;
        DROP TABLE tell_receipts;
      `);
      database.prepare("INSERT INTO tell_terminal_receipts VALUES ('told', 'launch', ?, 0)").run(at);
    }
    database
      .prepare("INSERT INTO control VALUES ('stop', '{\"bodySequence\":2}', ?), ('pause', ?, ?)")
      .run(at, JSON.stringify({ bodySequence: 2, frontierTellId: version >= 31 ? "bound-only" : "pending" }), at);
    database.prepare("INSERT INTO kills VALUES (1, 1, 'killed', ?)").run(at);
    if (version === 30) database.exec("UPDATE turns SET outcome = 'canceled', diagnostic = NULL WHERE sequence = 6");
    prepare?.(database);
    database.exec(`UPDATE sqlite_sequence SET seq = 9000 WHERE name = 'timeline';
      UPDATE activity_retention SET checked_sequence = ${version === 32 ? 9000 : version === 31 ? 16 : 3}; COMMIT`);
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
  // SHM and empty WAL are SQLite coordination, not retained history.
  const files = readdirSync(paths.directory).filter((name) => name !== "heart.db-shm");
  const bytes = new Map(files.map((name) => [name, readFileSync(join(paths.directory, name))]));
  if (bytes.get("heart.db-wal")?.length === 0) bytes.delete("heart.db-wal");
  return bytes;
}

for (const [version, wal] of [[29, false], [29, true], [30, false], [30, true]] as const) {
  test(`v${version} refuses ordinary Akuma access with ${wal ? "retained WAL" : "closed custody"}`, async () => {
    const value = await legacyFixture(version, wal);
    const { paths } = value;
    try {
      const original = custodyBytes(paths);
      if (wal) assert.ok(original.get("heart.db-wal")!.length > 0);
      else assert.deepEqual([...original.keys()].sort(), ["heart.db", "leash.db", "stdio.log"]);
      const owner = new AkumaOwner(value.id, value.root);
      const spawn = async () => assert.fail("old Heart must not spawn a Body");
      const refused = (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(paths.heart));
        assert.match(error.message, new RegExp(`schema version must be 33; found ${version}`, "u"));
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
      assert.deepEqual(custodyBytes(paths), original);
    } finally {
      value.close();
    }
  });
}

function retainedHistory(path: string, predecessorOnly = false) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name").all();
    return {
      version: db.prepare("SELECT version FROM akuma_schema").get()?.version,
      tables: tables.filter(({ name }) => !predecessorOnly || !["akuma_schema", "tell_terminal_receipts", "surveillance"].includes(String(name)))
        .map(({ name, sql }) => ({ name, sql: predecessorOnly && name === "timeline" ? undefined : sql, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map((row) => ({ ...row })) })),
    };
  } finally {
    db.close();
  }
}

test("v31 readers preserve retained WAL; a Tell write converts without losing history or high-water marks", async () => {
  const { id, root, paths, close } = await legacyFixture(31, true);
  try {
    const original = custodyBytes(paths);
    assert.ok(original.get("heart.db-wal")!.length > 0);
    const before = retainedHistory(paths.heart, true);
    await assert.rejects(readHeart(paths), needsUpgrade);
    await assert.rejects(new AkumaOwner(id, root).wait({ signal: AbortSignal.timeout(2_000) }), needsUpgrade);
    const identity = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
      environment: { KEIYAKU_ACTOR_ID: id, KEIYAKU_ACTOR_WORLD: root },
    });
    assert.equal(identity.exit, 0, identity.stderr);
    assert.deepEqual(identity.value.self, { kind: "akuma", akumaId: id, world: root });
    assert.ok(typeof identity.value.initiator === "object");
    assert.equal(identity.value.initiator.kind, "unavailable");
    assert.match(identity.value.initiator.diagnostic, /schema version must be 33; found 31/u);
    assert.match(identity.value.profileUnavailable ?? "", /schema version must be 33; found 31/u);
    assert.deepEqual(custodyBytes(paths), original);

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
    assert.deepEqual(custodyBytes(paths), original);
    await recordTellReceipt(paths, { evidence: "exact", tellId: "also-mapped", kind: "follow-up", receivedAt: later });
    assert.deepEqual(
      (await readHeart(paths)).pending.map(({ id }) => id),
      ["pending", "bound-only"],
    );
    assert.deepEqual(retainedHistory(paths.heart, true), { ...before, version: 33 });
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
    });
  } finally {
    close();
  }
});

test("addressed Tell, Ask and Kill reach their first real admission on v31", async () => {
  for (const verb of ["Tell", "Ask", "Kill", "Kill glob"] as const) {
    let frozenDirectory: string | undefined;
    const { root, id, paths, close } = await legacyFixture(31, true, (db) => {
      db.exec("DELETE FROM control WHERE kind = 'stop'");
      if (verb === "Tell") {
        frozenDirectory = join(dirname(db.location()!), "retired-worktree");
        db.prepare("UPDATE soul SET soul_json = json_set(soul_json, '$.cwd', ?)").run(frozenDirectory);
      }
    });
    const holder = await HeldAkumaLeash.try(paths);
    assert.ok(holder);
    const api = Akumas.of(root);
    try {
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
        if (frozenDirectory !== undefined) {
          const original = custodyBytes(paths);
          await assert.rejects(api.tell({ ...input, wait: true }), (error: unknown) => {
            assert.ok(error instanceof KeiyakuError);
            assert.deepEqual(error.frozenWorkdir, { id, cwd: frozenDirectory });
            return true;
          });
          await assert.rejects(readHeart(paths), needsUpgrade);
          assert.deepEqual(custodyBytes(paths), original);
          mkdirSync(frozenDirectory);
        }
        const receipt =
          verb === "Tell"
            ? await api.tell({ ...input, wait: true })
            : await api.ask({ ...input, schema: {}, interrupt: true });
        assert.ok("tellId" in receipt && receipt.tellId);
        assert.ok(
          (await readHeart(paths)).pending.some((tell) => tell.id === receipt.tellId && tell.body === input.body),
        );
      }
      assert.equal(retainedHistory(paths.heart).version, 33);
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
    assert.deepEqual(custodyBytes(paths), original);
    await assert.rejects(readHeart(paths), needsUpgrade);
  } finally {
    close();
  }
});

test("held Reset refuses v31 and requests an exact stop after explicit conversion", async () => {
  const { root, id, paths, close } = await legacyFixture(31, true, (db) => db.exec("DELETE FROM control WHERE kind = 'stop'"));
  const holder = await HeldAkumaLeash.try(paths);
  assert.ok(holder);
  try {
    const before = custodyBytes(paths);
    await assert.rejects(nuke({ world: root, confirm: root }), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof HeartNeedsUpgradeError);
      assert.match(error.message, needsUpgrade.message);
      return true;
    });
    assert.deepEqual(custodyBytes(paths), before);
    await appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "explicit write" }, at });
    assert.equal((await readHeart(paths)).stop, null);
    assert.deepEqual(await nuke({ world: root, confirm: root }), {
      kind: "accepted",
      issues: [{ kind: "reset-owner-stopped", owner: "akuma", diagnostic: `Akuma ${id} could not be stopped: unavailable` }],
    });
    assert.equal(await HeldAkumaLeash.try(paths), null);
    const { latestBody, stop } = await readHeart(paths);
    assert.equal(stop?.bodySequence, 2);
    assert.ok(latestBody?.sequence === 2 && latestBody.end === undefined);
    const turn = await readTurn(paths, 11);
    assert.ok(turn && turn.end === undefined);
  } finally {
    holder.release();
    close();
  }
});

test("contending v31 writes convert once; canceled acquisition changes nothing", async (context) => {
  const { paths, close } = await legacyFixture(31, false);
  const blocker = new DatabaseSync(paths.heart);
  const exec = DatabaseSync.prototype.exec;
  const writers = new Set<DatabaseSync>();
  context.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (this !== blocker && sql === "BEGIN IMMEDIATE") writers.add(this);
    return exec.call(this, sql);
  });
  try {
    const before = retainedHistory(paths.heart);
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
    assert.deepEqual(retainedHistory(paths.heart), before);
    blocker.exec("ROLLBACK");
    const committed = await opening;
    assert.deepEqual(committed.sort(), [9001, 9002]);
    assert.equal(retainedHistory(paths.heart).version, 33);
  } finally {
    blocker.close();
    close();
  }
});

test("a failed v31 upgrade commit rolls back the normalized evidence and version", async (context) => {
  const { paths, close } = await legacyFixture(31, true);
  const original = retainedHistory(paths.heart);
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
    assert.deepEqual(retainedHistory(paths.heart), original);
    assert.equal(await write(), 9001);
    assert.equal(retainedHistory(paths.heart).version, 33);
  } finally {
    injection.mock.restore();
    close();
  }
});

test("a v31 writer exiting before commit publishes neither its mutation nor the conversion", async () => {
  const { paths, close } = await legacyFixture(31, true);
  try {
    const original = retainedHistory(paths.heart);
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
        if (sql === "COMMIT" && this.prepare("SELECT version FROM akuma_schema").get().version === 33 &&
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
    assert.deepEqual(retainedHistory(paths.heart), original);
    await assert.rejects(readHeart(paths), needsUpgrade);
  } finally {
    close();
  }
});

test("a broken retained v31 relationship aborts conversion without publishing v33", async () => {
  const { paths, close } = await legacyFixture(31, false);
  try {
    const corrupt = new DatabaseSync(paths.heart);
    try {
      corrupt.exec("PRAGMA foreign_keys=OFF; INSERT INTO calls VALUES (99, 999, 'orphan', 'retained corruption')");
    } finally {
      corrupt.close();
    }
    const before = retainedHistory(paths.heart);
    await assert.rejects(
      appendActivity(paths, { turnSequence: 11, event: { type: "note", text: "new" }, at }),
      /broken foreign key relationships/u,
    );
    assert.deepEqual(retainedHistory(paths.heart), before);
  } finally {
    close();
  }
});

test("v32 read, refusal and no-op preserve WAL; a real admission upgrades the same referenced timeline", async (t) => {
  const { paths, id, close } = await legacyFixture(32, true);
  const fresh = await soulFixture("kei-v33-fresh-");
  try {
    const original = custodyBytes(paths);
    const before = retainedHistory(paths.heart);
    assert.ok(original.get("heart.db-wal")!.length > 0);
    const v32 = { constructor: HeartNeedsUpgradeError, message: /found 32: .*Upgrade requires a Heart write/u };
    await assert.rejects(activitySlice(paths), v32);
    await assert.rejects(recordTellReceipt(paths, {
      evidence: "fence", turnSequence: 1, fence: "unknown", kind: "accepted", receivedAt: at,
    }), /no delivery mapping/u);
    assert.equal(await recordSurveillance(paths, id, "Alice", true), "unchanged");
    assert.deepEqual(custodyBytes(paths), original);
    await assert.rejects(readHeart(paths), v32);
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(later) });
    assert.equal(await recordSurveillance(paths, id, "opaque:surveillant", false), "recorded");
    const after = retainedHistory(paths.heart);
    assert.equal(after.version, 33);
    assert.deepEqual(after.tables.find(({ name }) => name === "surveillance")?.rows, [
      { sequence: 9001, owner: "opaque:surveillant", binding_frontier: null, at: later },
    ]);
    for (const table of before.tables) {
      const actual = after.tables.find(({ name }) => name === table.name)!;
      if (table.name === "akuma_schema") continue;
      if (table.name === "sqlite_sequence") {
        assert.deepEqual(actual.rows, table.rows.map((row) => row.name === "timeline" ? { ...row, seq: 9001 } : row));
      } else if (table.name === "timeline") {
        assert.deepEqual(actual.rows, [...table.rows, { sequence: 9001, kind: "surveillance" }]);
      } else {
        assert.deepEqual(actual, table);
      }
    }
    const format = (db: DatabaseSync) => db.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE name IN ('timeline', 'surveillance', 'surveillance_by_owner') ORDER BY name`)
      .all().map(({ sql }) => String(sql).replace(/\s+/gu, ""));
    assert.deepEqual(await withReadOnlyHeart(paths, format), await withReadOnlyHeart(fresh.allocated.paths, format));
    await withHeartTransaction(paths, (db) => {
      assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.throws(() => db.exec("INSERT INTO timeline(kind) VALUES ('unknown')"), /CHECK constraint/u);
      assert.throws(() => db.prepare("INSERT INTO surveillance VALUES (99999, 'orphan', NULL, ?)").run(at), /FOREIGN KEY constraint/u);
    });
  } finally {
    fresh.close();
    close();
  }
});

test("current Heart keeps a physically read-only connection during observation", async () => {
  const value = await soulFixture("kei-current-heart-");
  try {
    await withReadOnlyHeart(value.allocated.paths, (database) => {
      assert.throws(() => database.exec("CREATE TABLE forbidden (x INTEGER)"), /readonly/u);
    });
  } finally {
    value.close();
  }
});
