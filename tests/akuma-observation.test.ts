import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
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
import { translatePiEvent, type PiEventState } from "../src/akuma/providers/pi/events.js";

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

test("reported changes retain native Pi writes and aggregate a write-then-edit path", async () => {
  const value = await fixture();
  const { paths } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    const state: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
    let ticks = 0;
    const observe = async (event: AgentSessionEvent): Promise<void> => {
      for (const translated of translatePiEvent(event, state))
        await appendActivity(paths, {
          turnSequence: turn.sequence,
          at: new Date(Date.parse(value.soul.createdAt) + (ticks += 1) * 1_000).toISOString(),
          event: translated,
        });
    };
    const write = async (id: string, path: string): Promise<void> => {
      await observe({ type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path, content: "x\n" } });
      await observe({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: "write",
        isError: false,
        result: { content: [{ type: "text", text: `Successfully wrote to ${path}` }] },
      });
    };
    await write("write-create", "src/created.ts");
    await write("write-overwrite", "src/overwritten.ts");
    await observe({
      type: "tool_execution_start",
      toolCallId: "write-failed",
      toolName: "write",
      args: { path: "src/failed.ts", content: "x\n" },
    });
    await observe({
      type: "tool_execution_end",
      toolCallId: "write-failed",
      toolName: "write",
      isError: true,
      result: { content: [{ type: "text", text: "EPERM: operation not permitted" }] },
    });
    await write("write-then-edit", "src/mixed.ts");
    await observe({
      type: "tool_execution_start",
      toolCallId: "edit-mixed",
      toolName: "edit",
      args: { path: "src/mixed.ts", edits: [{ oldText: "x", newText: "y" }] },
    });
    await observe({
      type: "tool_execution_end",
      toolCallId: "edit-mixed",
      toolName: "edit",
      isError: false,
      result: { details: { patch: "@@ -1 +1,2 @@\n-x\n+y\n+z" } },
    });
    const snapshot = selectSnapshot(projectTurns((await activitySlice(paths)).rows), { aperture: "monitoring" }).snapshot;
    assert.equal(snapshot.kind, "open");
    const reported = snapshot.reportedChanges.map((change) => ({
      op: change.op,
      path: change.path,
      ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }),
    }));
    assert.deepEqual(reported, [
      { op: "update", path: "src/created.ts" },
      { op: "update", path: "src/overwritten.ts" },
      // A write then an edit on one path stay one summary; the write's unknown
      // diffstat leaves the aggregated group without fabricated numbers.
      { op: "update", path: "src/mixed.ts" },
    ]);
    assert.equal(reported.some((change) => change.path === "src/failed.ts"), false);
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
