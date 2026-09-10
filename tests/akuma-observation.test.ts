import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { defaultWaitComplete } from "../src/akuma/akuma.js";
import { AkumaHandle } from "../src/akuma/akuma-handle.js";
import {
  HeldAkumaLeash,
  activitySlice,
  appendActivity,
  beginTurn,
  breakBody,
  endTurn,
  initializeHeart,
  recordTell as heartRecordTell,
  recordTellReceipt,
  type Soul,
} from "../src/akuma/heart/index.js";
import { insertActivityFact } from "../src/akuma/heart/rows.js";
import { insertTellFact } from "../src/akuma/heart/tells.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { World } from "../src/world.js";
import { bornStatus } from "../src/akuma/akuma-observe.js";
import { executeWaitAkuma } from "../src/akuma/fleet-execution.js";
import { ordinarySnapshotBudget, projectTurns, selectSnapshot } from "../src/akuma/projection.js";

async function fixture() {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-observation-")));
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

async function recordTell(
  paths: Parameters<typeof heartRecordTell>[0],
  tell: Readonly<{ id: string; body: string; recordedAt: string }>,
) {
  return await heartRecordTell(paths, { kind: "tell", ...tell });
}

test("status frontier preserves the full projection without loading old activity", async (context) => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  let leash: HeldAkumaLeash | null = null;
  try {
    leash = await HeldAkumaLeash.try(paths);
    await leash!.birth(paths, value.soul);
    const body = await leash!.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    const old = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    const db = new DatabaseSync(paths.heart);
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      for (let index = 0; index < 800; index += 1)
        insertActivityFact(db, {
          turnSequence: old.sequence,
          event: { type: "note", text: `old-${index}` },
          at: value.soul.createdAt,
        });
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    await endTurn(paths, {
      turnSequence: old.sequence,
      outcome: { kind: "failed", diagnostic: "old" },
      completedAt: value.soul.createdAt,
    });
    for (const tellId of ["old-told", "latest-told", "pending"])
      await recordTell(paths, { id: tellId, body: tellId, recordedAt: value.soul.createdAt });
    for (const tellId of ["old-told", "latest-told"])
      await recordTellReceipt(paths, {
        evidence: "exact",
        tellId,
        kind: "undelivered",
        receivedAt: value.soul.createdAt,
      });
    const turn = await beginTurn(paths, {
      bodySequence: body.sequence,
      startedAt: value.soul.createdAt,
      call: "current",
    });
    const call = {
      kind: "fileChange",
      changes: [{ op: "update", path: "same.txt", diffstat: { added: 2, removed: 1 } }],
    } as const;
    for (const toolId of ["edit-one", "edit-two", "still-active"]) {
      await appendActivity(paths, {
        turnSequence: turn.sequence,
        at: value.soul.createdAt,
        event: { type: "tool", phase: "started", id: toolId, name: "write", call },
      });
      for (let index = 0; index < 8; index += 1)
        await appendActivity(paths, {
          turnSequence: turn.sequence,
          at: value.soul.createdAt,
          event: { type: "assistant", text: `voice-${index}` },
        });
      if (toolId !== "still-active")
        await appendActivity(paths, {
          turnSequence: turn.sequence,
          at: value.soul.createdAt,
          event: { type: "tool", phase: "completed", id: toolId, name: "write", call, result: { status: "ok" } },
        });
    }
    const prepare = DatabaseSync.prototype.prepare;
    let decodedActivity = 0;
    let queries = 0;
    context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      queries += 1;
      const statement = prepare.call(this, sql);
      if (/SELECT sequence, turn_sequence, event_json/u.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = (...args) => {
          const rows = Reflect.apply(all, statement, args);
          decodedActivity += rows.length;
          return rows;
        };
      }
      return statement;
    });
    for (const closed of [false, true]) {
      if (closed)
        await endTurn(paths, {
          turnSequence: turn.sequence,
          outcome: { kind: "answered", session: { sessionId: "session" }, answer: "" },
          completedAt: value.soul.createdAt,
        });
      const ledger = projectTurns((await activitySlice(paths)).rows);
      for (const aperture of ["monitoring", "receipt"] as const)
        for (const admittedTellId of [undefined, "old-told", "absent"])
          for (const ordinaryBudget of [0, 1, 6, 30]) {
            const input = { aperture, ordinaryBudget, ...(admittedTellId === undefined ? {} : { admittedTellId }) };
            decodedActivity = 0;
            queries = 0;
            const observed = await bornStatus(paths, id, input);
            const expected = selectSnapshot(ledger, { ...input, budget: ordinarySnapshotBudget(ordinaryBudget) });
            assert.deepEqual(observed.status.timeline, expected.snapshot);
            assert.equal(observed.ordinarySelected, expected.ordinaryCount);
            assert.ok(decodedActivity < 40, `read ${decodedActivity} activities for one frontier`);
            assert.ok(queries < 25, `executed ${queries} queries for one status`);
          }
    }
    const next = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    const last = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    await endTurn(paths, {
      turnSequence: last.sequence,
      outcome: { kind: "failed", diagnostic: "frontier" },
      completedAt: value.soul.createdAt,
    });
    await endTurn(paths, {
      turnSequence: next.sequence,
      outcome: { kind: "failed", diagnostic: "latest outcome is not latest start" },
      completedAt: value.soul.createdAt,
    });
    assert.deepEqual(
      (await bornStatus(paths, id, { aperture: "monitoring" })).status.timeline,
      selectSnapshot(projectTurns((await activitySlice(paths)).rows), { aperture: "monitoring" }).snapshot,
    );
  } finally {
    leash?.release();
    value.close();
  }
});

test("timeline decoding batches Tell witnesses and rejects missing retained facts", async (context) => {
  const value = await fixture();
  const { paths } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    const db = new DatabaseSync(paths.heart);
    try {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      for (let index = 0; index < 100; index += 1) {
        const tellId = `tell-${index}`;
        insertTellFact(db, { kind: "tell", id: tellId, body: tellId, recordedAt: value.soul.createdAt });
        db.prepare("INSERT INTO tell_bindings(tell_id, turn_sequence, bound_at) VALUES (?, ?, ?)").run(
          tellId,
          turn.sequence,
          value.soul.createdAt,
        );
        db.prepare(
          "INSERT INTO tell_deliveries(tell_id, turn_sequence, route, fence, delivered_at) VALUES (?, ?, 'launch', ?, ?)",
        ).run(tellId, turn.sequence, tellId, value.soul.createdAt);
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    const prepare = DatabaseSync.prototype.prepare;
    let queries = 0;
    context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      queries += 1;
      return prepare.call(this, sql);
    });
    const slice = await activitySlice(paths);
    assert.ok(queries < 15, `N+1 decoding executed ${queries} queries`);
    const tells = slice.rows.filter((row) => row.kind === "tell");
    assert.equal(tells.length, 100);
    assert.ok(
      tells.every(
        (tell) => tell.state === "told" && tell.binding?.turnSequence === turn.sequence && tell.deliveries.length === 1,
      ),
    );
    const corrupt = new DatabaseSync(paths.heart);
    try {
      corrupt.prepare("INSERT INTO timeline(kind) VALUES ('activity')").run();
    } finally {
      corrupt.close();
    }
    await assert.rejects(activitySlice(paths), /missing activity/u);
  } finally {
    leash.release();
    value.close();
  }
});

test("default single and fleet waits probe life without repeatedly rendering activity", async (context) => {
  for (const fleet of [false, true]) {
    const value = await fixture();
    const { paths, id } = value.allocated;
    const leash = (await HeldAkumaLeash.try(paths))!;
    try {
      await leash.birth(paths, value.soul);
      const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
      const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
      await appendActivity(paths, {
        turnSequence: turn.sequence,
        event: { type: "note", text: "still working" },
        at: value.soul.createdAt,
      });
      const prepare = DatabaseSync.prototype.prepare;
      let observations = 0;
      let activityReadsBeforeSettlement = 0;
      let settling: Promise<void> | undefined;
      const mock = context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        if (/FROM bodies ORDER BY sequence DESC LIMIT 1/u.test(sql) && ++observations === 3) {
          settling = Promise.resolve().then(async () => {
            await endTurn(paths, {
              turnSequence: turn.sequence,
              outcome: { kind: "failed", diagnostic: "finished" },
              completedAt: value.soul.createdAt,
            });
            await breakBody(paths, { sequence: body.sequence, end: "put-down", at: value.soul.createdAt });
            leash.release();
          });
        }
        if (/SELECT sequence, turn_sequence, event_json/u.test(sql) && settling === undefined)
          activityReadsBeforeSettlement += 1;
        return prepare.call(this, sql);
      });
      try {
        const status = fleet
          ? (await executeWaitAkuma({ path: value.root, ids: [id], completion: "all", timeoutMs: 2_000 }))
              .observations[0]!.status
          : await new AkumaHandle(id, value.root).wait(undefined, { timeoutMs: 2_000 });
        await settling;
        assert.equal(activityReadsBeforeSettlement, 0);
        assert.ok(observations >= 3);
        assert.equal(status.life, "stranded");
      } finally {
        mock.mock.restore();
      }
    } finally {
      leash.release();
      value.close();
    }
  }
});

test("wait rechecks its final status when a completed probe acquires a new pending Tell", async (context) => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    await breakBody(paths, { sequence: body.sequence, end: "put-down", at: value.soul.createdAt });
    leash.release();
    const prepare = DatabaseSync.prototype.prepare;
    let probes = 0;
    context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("SELECT 1 FROM tells WHERE")) {
        const get = statement.get.bind(statement);
        statement.get = (...args) => {
          const result = Reflect.apply(get, statement, args);
          probes += 1;
          if (probes === 2) {
            const writer = new DatabaseSync(paths.heart);
            try {
              insertTellFact(writer, {
                kind: "tell",
                id: "new-pending",
                body: "new work",
                recordedAt: value.soul.createdAt,
              });
            } finally {
              writer.close();
            }
          }
          return result;
        };
      }
      return statement;
    });
    const result = await executeWaitAkuma({ path: value.root, ids: [id], completion: "all", timeoutMs: 250 });
    assert.ok(probes > 4, "returned without another probe after the final status invalidated completion");
    assert.equal(defaultWaitComplete(result.observations[0]!.status), false);
    assert.ok(
      result.observations[0]!.status.timeline.entries.some(
        (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.tellId === "new-pending",
      ),
    );
  } finally {
    leash.release();
    value.close();
  }
});

test("status preserves unborn and Tell-only apertures without a Turn", async () => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    for (const phase of ["empty", "pending", "told"] as const) {
      if (phase === "pending")
        await recordTell(paths, { id: "only-tell", body: "hello", recordedAt: value.soul.createdAt });
      if (phase === "told")
        await recordTellReceipt(paths, {
          evidence: "exact",
          tellId: "only-tell",
          kind: "undelivered",
          receivedAt: value.soul.createdAt,
        });
      const ledger = projectTurns((await activitySlice(paths)).rows);
      for (const aperture of ["monitoring", "receipt"] as const) {
        for (const admittedTellId of [undefined, "only-tell", "absent"]) {
          const input = { aperture, ...(admittedTellId === undefined ? {} : { admittedTellId }) };
          const observed = await bornStatus(paths, id, input);
          assert.deepEqual(observed.status.timeline, selectSnapshot(ledger, input).snapshot);
          assert.equal(observed.status.timeline.kind, phase === "empty" ? "unborn" : "idle");
        }
      }
    }
  } finally {
    leash.release();
    value.close();
  }
});
