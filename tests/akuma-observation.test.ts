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
  recordTellDeliveries,
  recordTellReceipt,
  readStatusFacts,
  type Soul,
} from "../src/akuma/heart/index.js";
import { insertActivityFact } from "../src/akuma/heart/rows.js";
import { insertTellFact } from "../src/akuma/heart/tells.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { World } from "../src/world.js";
import { bornStatus, readLiveStatus, waitForObservation } from "../src/akuma/akuma-observe.js";
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

test("shared observation returns one final deadline snapshot and propagates caller abort", async () => {
  let reads = 0;
  const deadline = await waitForObservation({
    timeoutMs: 0,
    observe: async () => {
      reads += 1;
      return "running" as const;
    },
    complete: (status) => status === "settled",
  });
  assert.deepEqual(deadline, { reason: "deadline", value: "running" });
  assert.equal(reads, 1);

  const completed = await waitForObservation({
    timeoutMs: 0,
    observe: async () => "settled" as const,
    complete: (status) => status === "settled",
  });
  assert.deepEqual(completed, { reason: "completed", value: "settled" });

  const controller = new AbortController();
  const reason = new Error("caller cancelled observation");
  controller.abort(reason);
  await assert.rejects(
    waitForObservation({
      signal: controller.signal,
      observe: async () => "running" as const,
      complete: () => false,
    }),
    (error: unknown) => error === reason,
  );
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

test("a live status observation pairs its bounded status with the same complete projected frontier", async () => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt, call: "live frontier" });
    const input = { aperture: "monitoring" as const, ordinaryBudget: 0 };
    const observed = await readLiveStatus(value.root, id, input);
    const facts = await readStatusFacts(paths, input);
    const ledger = projectTurns(facts);
    assert.deepEqual(observed.status.timeline, selectSnapshot(ledger, input).snapshot, "status keeps its bounded public shape");
    assert.deepEqual(observed.rows, ledger.rows, "the callback companion is the complete projection of that frontier");
    assert.equal("rows" in observed.status, false, "the public status itself carries no companion field");
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
      await observe({
        type: "tool_execution_start",
        toolCallId: id,
        toolName: "write",
        args: { path, content: "x\n" },
      });
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
    const snapshot = selectSnapshot(projectTurns((await activitySlice(paths)).rows), {
      aperture: "monitoring",
    }).snapshot;
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
    assert.equal(
      reported.some((change) => change.path === "src/failed.ts"),
      false,
    );
  } finally {
    leash.release();
    value.close();
  }
});

test("a retained unknown tool call keeps its bounded argument preview through projection", async () => {
  const value = await fixture();
  const { paths } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    const state: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
    const at = (tick: number) => new Date(Date.parse(value.soul.createdAt) + tick * 1_000).toISOString();
    const args = { alpha: 1, nested: { ok: true } };
    const started = translatePiEvent(
      { type: "tool_execution_start", toolCallId: "future-1", toolName: "future_tool", args },
      state,
    );
    const completed = translatePiEvent(
      {
        type: "tool_execution_end",
        toolCallId: "future-1",
        toolName: "future_tool",
        isError: false,
        result: { content: [{ type: "text", text: "secret output" }] },
      },
      state,
    );
    await appendActivity(paths, { turnSequence: turn.sequence, at: at(1), event: started[0]! });
    await appendActivity(paths, { turnSequence: turn.sequence, at: at(2), event: completed[0]! });

    const snapshot = selectSnapshot(projectTurns((await activitySlice(paths)).rows), { aperture: "monitoring" })
      .snapshot;
    const calls = snapshot.entries.flatMap((entry) =>
      entry.kind === "row" && entry.row.kind === "tool" ? [entry.row.call] : [],
    );
    assert.deepEqual(calls, [
      {
        kind: "other",
        display: "future_tool",
        input: { json: JSON.stringify(args), truncated: false },
      },
    ]);
    assert.doesNotMatch(JSON.stringify(calls), /secret output/u, "a tool result body never enters the preview");
  } finally {
    leash.release();
    value.close();
  }
});

test("status reads retain delivered frontier Tells without a global told substitution", async () => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  const at = "2026-08-08T00:00:00.000Z";
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: at });
    const earlier = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at, call: "earlier work" });
    await endTurn(paths, {
      turnSequence: earlier.sequence,
      outcome: { kind: "failed", diagnostic: "earlier finished" },
      completedAt: at,
    });
    const opening = await recordTell(paths, { id: "opening", body: "wake frontier", recordedAt: at });
    assert.ok(opening.kind === "recorded");
    const frontier = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    await recordTellDeliveries(paths, [
      {
        tellId: opening.tell.id,
        route: "launch",
        turnSequence: frontier.sequence,
        fence: "opening-launch",
        deliveredAt: at,
      },
    ]);
    const live = await recordTell(paths, { id: "live", body: "steer frontier", recordedAt: at });
    assert.ok(live.kind === "recorded");
    await recordTellDeliveries(paths, [
      {
        tellId: live.tell.id,
        route: "live",
        receipt: "unavailable",
        turnSequence: frontier.sequence,
        fence: "frontier-live",
        deliveredAt: at,
      },
    ]);
    const unrelated = await recordTell(paths, { id: "unrelated", body: "old work", recordedAt: at });
    assert.ok(unrelated.kind === "recorded");
    await recordTellDeliveries(paths, [
      {
        tellId: unrelated.tell.id,
        route: "launch",
        turnSequence: earlier.sequence,
        fence: "earlier-launch",
        deliveredAt: at,
      },
    ]);

    const facts = await readStatusFacts(paths, { aperture: "monitoring" });
    assert.deepEqual(
      facts.filter((fact) => fact.kind === "tell").map((fact) => fact.id),
      [opening.tell.id, live.tell.id],
    );
    const zero = await bornStatus(paths, id, { aperture: "monitoring", ordinaryBudget: 0 });
    assert.equal(zero.status.timeline.kind, "open");
    if (zero.status.timeline.kind === "open") {
      assert.equal(zero.status.timeline.openingSequence, opening.tell.sequence);
      assert.deepEqual(
        zero.status.timeline.entries.map((entry) => (entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence)),
        [opening.tell.sequence, "gap:1"],
      );
    }
    assert.equal(zero.ordinarySelected, 0);

    const budgeted = await bornStatus(paths, id, { aperture: "monitoring", ordinaryBudget: 1 });
    assert.equal(budgeted.status.timeline.kind, "open");
    if (budgeted.status.timeline.kind === "open") {
      assert.deepEqual(
        budgeted.status.timeline.entries.map((entry) => (entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence)),
        [opening.tell.sequence, live.tell.sequence],
      );
      assert.equal(
        budgeted.status.timeline.entries.some(
          (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.tellId === unrelated.tell.id,
        ),
        false,
      );
    }
    assert.equal(budgeted.ordinarySelected, 1);
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
      for (const aperture of ["monitoring", "receipt"] as const) {
        for (const admittedTellId of [undefined, "only-tell", "absent"]) {
          const input = { aperture, ...(admittedTellId === undefined ? {} : { admittedTellId }) };
          const observed = await bornStatus(paths, id, input);
          assert.deepEqual(observed.status.timeline, selectSnapshot(projectTurns(await readStatusFacts(paths, input)), input).snapshot);
          assert.equal(
            observed.status.timeline.kind,
            (phase === "pending" && (aperture === "monitoring" || admittedTellId !== "absent")) ||
              (phase === "told" && admittedTellId === "only-tell")
              ? "idle"
              : "unborn",
          );
        }
      }
    }
  } finally {
    leash.release();
    value.close();
  }
});
