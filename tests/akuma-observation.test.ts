import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Akumas } from "../src/library/akumas.js";
import { akumaObservationSchema } from "../src/akuma/selection-observation.js";
import { World } from "../src/world.js";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { recordTell, soulFixture } from "./support/akuma-fixtures.js";
import { bornStatus, readLiveStatus, waitForObservation } from "../src/akuma/akuma-observe.js";
import { executeWaitAkuma } from "../src/akuma/akuma-wait.js";
import { projectFact } from "../src/akuma/projection.js";
import { summarizeFrontier } from "../src/akuma/projection-read.js";
import {
  HeldAkumaLeash,
  activitySlice,
  appendActivity,
  beginTurn,
  breakBody,
  finishBodyIfIdle,
  endTurn,
  recordCurrentModel,
  recordTellDeliveries,
  recordTellReceipt,
  readStatusFacts,
} from "../src/akuma/heart/index.js";
import { insertTellFact } from "../src/akuma/heart/tells.js";
import { pruneActivityFacts } from "../src/akuma/heart/timeline.js";
import { translatePiEvent, type PiEventState } from "../src/akuma/providers/pi/events.js";
import { ToolObservations } from "../src/akuma/providers/tool-observations.js";
import type { AgentEvent } from "../src/akuma/provider.js";

/** One attempt-local Pi tool book narrating into the collector the caller reads. */
function piState(emitted: AgentEvent[]): PiEventState {
  return { answer: "", assistantSeen: false, tools: new ToolObservations((event) => void emitted.push(event)) };
}

async function fixture() {
  return await soulFixture("keiyaku-akuma-observation-");
}

test("chatty status keeps latest intent, observed activity age, current tools and worktree changes", async () => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const api = Akumas.of(await World.at(value.root));
    const empty = await api.status({ akuma: id });
    assert.equal(empty.lastActivityAt, undefined);
    const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    assert.equal((await api.status({ akuma: id })).lastActivityAt, undefined, "a Turn opening alone is not activity");
    assert.equal((await api.list()).rows?.find(row => row.id === id)?.lastActivityAt, undefined);
    const at = "2026-08-08T00:00:01.000Z";
    const append = (event: Parameters<typeof appendActivity>[1]["event"]) =>
      appendActivity(paths, { turnSequence: turn.sequence, at, event });
    await append({ type: "tool", phase: "started", id: "active", name: "Bash",
      call: { kind: "run", command: "watch current work" } });
    for (let index = 0; index < 32; index += 1) {
      await append({ type: "assistant", text: `intent ${index}` });
      await append({ type: "tool", phase: "completed", id: `tool-${index}`, name: "Bash",
        call: { kind: "run", command: `step ${index}` }, result: { status: "ok" } });
    }
    const inside = Array.from({ length: 6 }, (_, index) => join(value.root, `source-${index}.ts`));
    const outside = Array.from({ length: 3 }, (_, index) => join(tmpdir(), `scratch-${index}.ts`));
    await append({ type: "tool", phase: "completed", id: "changes", name: "Edit",
      call: { kind: "fileChange", changes: [...inside, ...outside].map(path => ({ op: "update", path })) },
      result: { status: "ok" } });
    for (const path of ["recent-one.ts", "recent-two.ts", "recent-three.ts"])
      await append({ type: "tool", phase: "completed", id: path, name: "Read",
        call: { kind: "read", path }, result: { status: "ok" } });
    const view = await api.status({ akuma: id });
    const json = akumaObservationSchema.parse(JSON.parse(JSON.stringify(view)));
    assert.equal(json.lastActivityAt, at);
    assert.deepEqual(json.changes?.map(change => change.path), inside.slice(1));
    assert.equal(json.moreChanges, true);
    assert.equal(json.outsideChanges, outside.length);
    const frontier = (await readStatusFacts(paths)).map(projectFact);
    assert.deepEqual(
      json.recent?.map(row => row.sequence),
      frontier.slice(-3).map(row => row.sequence),
      "status carries exactly the latest Turn's three newest retained rows",
    );
    assert.equal(json.work.summary?.text, "run $ watch current work");
    const settledAt = "2026-08-08T00:00:02.000Z";
    await endTurn(paths, { turnSequence: turn.sequence, completedAt: settledAt,
      outcome: { kind: "answered", answer: "done", session: { sessionId: "status-trunk" } } });
    await finishBodyIfIdle(paths, { sequence: body.sequence, at: settledAt });
    leash.release();
    const asleep = await api.status({ akuma: id });
    assert.equal(asleep.life, "asleep");
    assert.equal(asleep.lastActivityAt, at, "Turn ending does not advance activity");
    const listed = (await api.list({ selection: "settled" })).rows?.find(row => row.id === id);
    assert.equal(listed?.lastActivityAt, asleep.lastActivityAt);
    assert.equal(listed?.lifeAt, settledAt, "Body settlement advances life time independently");
  } finally {
    leash.release();
    value.close();
  }
});

test("reported changes partition by lexical path spelling without canonicalization", async () => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  const outsideRoot = mkdtempSync(join(tmpdir(), "keiyaku-outside-"));
  const aliasRoot = mkdtempSync(join(tmpdir(), "keiyaku-alias-"));
  const alias = join(aliasRoot, "worktree");
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const api = Akumas.of(await World.at(value.root));
    const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    const at = "2026-08-08T00:00:01.000Z";
    const append = (event: Parameters<typeof appendActivity>[1]["event"]) =>
      appendActivity(paths, { turnSequence: turn.sequence, at, event });

    // A symlink spelling the very same directory is still a foreign path: containment
    // reads the reported spelling and never asks the filesystem to canonicalize it.
    await symlink(value.root, alias, "dir");
    await writeFile(join(value.root, "kept.ts"), "kept\n");
    const deleted = join(value.root, "deleted.ts");
    await writeFile(deleted, "gone\n");
    await rm(deleted);
    const escape = join(value.root, "escape");
    await symlink(outsideRoot, escape, "dir");
    const swapCase = (text: string): string =>
      [...text].map((letter) => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase())).join("");
    // Case-folded spellings are foreign too, even where the filesystem would fold them.
    const caseAlias = join(dirname(value.root), swapCase(basename(value.root)), "Case-Alias.ts");

    const inside = [join(value.root, "kept.ts"), join(value.root, "deleted.ts"), join(escape, "leak.ts")];
    const outside = [
      join(alias, "kept.ts"),
      join(alias, "deleted.ts"),
      join(outsideRoot, "scratch.ts"),
      caseAlias,
    ];
    await append({ type: "tool", phase: "completed", id: "changes", name: "Edit",
      call: { kind: "fileChange", changes: [...inside, ...outside].map(path => ({ op: "update", path })) },
      result: { status: "ok" } });

    const json = akumaObservationSchema.parse(JSON.parse(JSON.stringify(await api.status({ akuma: id }))));
    assert.deepEqual(json.changes?.map(change => change.path), inside);
    assert.equal(json.outsideChanges, outside.length);
  } finally {
    leash.release();
    value.close();
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(aliasRoot, { recursive: true, force: true });
  }
});

test("status reports the one current model and follows confirmed native changes", async () => {
  const value = await fixture();
  const { paths } = value.allocated;
  const status = async () => await bornStatus(paths, value.soul.id);
  const modelRows = async (): Promise<number> => {
    const database = new DatabaseSync(paths.heart);
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS count FROM activity WHERE json_extract(event_json, '$.type') = 'model'")
        .get() as { count: number };
      return row.count;
    } finally {
      database.close();
    }
  };
  const claim = (await HeldAkumaLeash.try(paths))!;
  try {
    await claim.birth(paths, value.soul);
    assert.equal(value.soul.options.model, "claude-sonnet-4-5");
    assert.equal((await status()).provider, "claude", "status names the execution adapter");
    assert.equal((await status()).model, "claude-sonnet-4-5", "a fresh birth seeds the one current model");

    const body = await claim.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    assert.equal(await recordCurrentModel(paths, { bodySequence: body.sequence, model: "claude-native" }), "recorded");
    assert.equal((await status()).model, "claude-native", "status follows confirmed native evidence");

    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    for (let index = 0; index < 12; index += 1) {
      await appendActivity(paths, {
        turnSequence: turn.sequence,
        event: { type: "note", text: `filler ${index}` },
        at: "2026-08-08T00:00:01.000Z",
      });
    }
    await endTurn(paths, {
      turnSequence: turn.sequence,
      outcome: { kind: "failed", diagnostic: "fixture turn" },
      completedAt: "2026-08-08T00:00:02.000Z",
    });
    const database = new DatabaseSync(paths.heart);
    try {
      database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      pruneActivityFacts(database, 1, true);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    assert.equal((await status()).model, "claude-native", "compaction cannot reach a model that is not activity");
    assert.equal(await modelRows(), 0, "no model is ever retained as activity");

    assert.equal(await recordCurrentModel(paths, { bodySequence: body.sequence, model: undefined }), "recorded");
    const unknown = await status();
    assert.equal(unknown.model, undefined, "an unnamed replacement reports unknown, never a guess");
    assert.equal(unknown.provider, "claude");
    claim.release();
  } finally {
    value.close();
  }
});

test("shared observation returns one final deadline snapshot and propagates caller abort", async () => {
  let reads = 0;
  const deadline = await waitForObservation({
    timeoutMs: 0,
    observe: async (): Promise<"running" | "settled"> => {
      reads += 1;
      return "running";
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
    await finishBodyIfIdle(paths, { sequence: body.sequence, at: value.soul.createdAt });
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
    assert.equal(result.reason, "deadline", "new pending work invalidates the completed probe");
    const item = result.results[0]!;
    assert.equal(item.kind, "observed");
    assert.equal(item.kind === "observed" ? item.life : undefined, "asleep");
    assert.equal(item.kind === "observed" ? item.pending : undefined, true);
    const status = await bornStatus(paths, id);
    assert.equal(status.work.kind, "idle");
    assert.equal(status.work.pending?.[0]?.tellId, "new-pending", "pending input stays independently visible");
  } finally {
    leash.release();
    value.close();
  }
});

test("wait returns stranded failure without consuming pending input", async () => {
  const value = await fixture();
  const { paths, id } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, value.soul);
    const body = await leash.recordBody(paths, { leashTakenAt: value.soul.createdAt });
    await recordTell(paths, { id: "undelivered", body: "OK", recordedAt: value.soul.createdAt });
    const running = await executeWaitAkuma({ path: value.root, ids: [id], completion: "all", timeoutMs: 0 });
    assert.equal(running.reason, "deadline");
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: value.soul.createdAt });
    await endTurn(paths, {
      turnSequence: turn.sequence,
      outcome: { kind: "failed", diagnostic: "session creation: 405" },
      completedAt: value.soul.createdAt,
    });
    await breakBody(paths, { sequence: body.sequence, end: "put-down", at: value.soul.createdAt });
    leash.release();
    const result = await executeWaitAkuma({
      path: value.root, ids: [id], completion: "all", signal: AbortSignal.timeout(2000),
    });
    assert.equal(result.reason, "completed");
    const item = result.results[0]!;
    assert.ok(item.kind === "observed");
    assert.equal(item.life, "stranded");
    assert.equal(item.pending, true, "completion leaves the undelivered Tell pending");
    assert.match(item.outcome?.kind === "failed" ? item.outcome.diagnostic : "", /session creation: 405/u);
    const status = await bornStatus(paths, id);
    assert.equal(status.work.kind, "idle");
    assert.equal(status.work.outcome?.verdict, "failed");
    assert.equal(status.work.pending?.[0]?.tellId, "undelivered");
    assert.equal(status.recent?.at(-1)?.kind, "outcome");
    assert.match(JSON.stringify(status.recent), /session creation: 405/u);
  } finally {
    leash.release();
    value.close();
  }
});

test("public status exposes frozen provider selection without private recipe or invented model", async () => {
  const { Akuma } = await import("../src/index.js");
  const value = await fixture();
  const { paths, id } = value.allocated;
  const leash = (await HeldAkumaLeash.try(paths))!;
  try {
    await leash.birth(paths, {
      ...value.soul,
      provider: { ...value.soul.provider, env: { SECRET: "private-token" }, config: { private: "private-config" } },
      options: { systemPrompt: "private-prompt" },
    });
    const status = await Akuma.select(value.root, id).status();
    assert.equal(status.provider, "claude");
    assert.equal(Object.hasOwn(status, "model"), false);
    const json = JSON.stringify(status);
    for (const secret of ["private-token", "private-config", "private-prompt"])
      assert.equal(json.includes(secret), false);
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
    const observed = await readLiveStatus(value.root, id);
    const rows = (await readStatusFacts(paths)).map(projectFact);
    assert.equal(observed.status.provider, "claude");
    assert.equal(observed.status.model, "claude-sonnet-4-5");
    assert.deepEqual(observed.rows, rows, "the callback companion is the complete projection of that frontier");
    assert.deepEqual(
      observed.status.recent,
      rows.slice(-3),
      "status keeps only the latest Turn's three newest rows, projected from the same facts",
    );
    assert.equal(observed.status.work.kind, "open");
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
    const emitted: AgentEvent[] = [];
    const state = piState(emitted);
    const emit = (event: AgentEvent): void => void emitted.push(event);
    let ticks = 0;
    const observe = async (event: AgentSessionEvent): Promise<void> => {
      translatePiEvent(event, state, emit);
      for (const translated of emitted.splice(0))
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
    const frontier = summarizeFrontier((await activitySlice(paths)).rows.map(projectFact), value.root);
    assert.equal(frontier.work.kind, "open");
    const reported = (frontier.changes ?? []).map((change) => ({
      path: change.path,
      ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }),
    }));
    assert.deepEqual(reported, [
      { path: "src/created.ts" },
      { path: "src/overwritten.ts" },
      // A write then an edit on one path stay one summary; the write's unknown
      // diffstat leaves the aggregated group without fabricated numbers.
      { path: "src/mixed.ts" },
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
    const emitted: AgentEvent[] = [];
    const state = piState(emitted);
    const at = (tick: number) => new Date(Date.parse(value.soul.createdAt) + tick * 1_000).toISOString();
    const args = { alpha: 1, nested: { ok: true } };
    const emit = (event: AgentEvent): void => void emitted.push(event);
    translatePiEvent({ type: "tool_execution_start", toolCallId: "future-1", toolName: "future_tool", args }, state, emit);
    translatePiEvent(
      {
        type: "tool_execution_end",
        toolCallId: "future-1",
        toolName: "future_tool",
        isError: false,
        result: { content: [{ type: "text", text: "secret output" }] },
      },
      state,
      emit,
    );
    for (const [index, event] of emitted.entries()) {
      await appendActivity(paths, { turnSequence: turn.sequence, at: at(index + 1), event });
    }

    const calls = (await activitySlice(paths)).rows.map(projectFact).flatMap(row => row.kind === "tool" ? [row.call] : []);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ({
      kind: "other", input: { json: JSON.stringify(args) },
    })));
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

    const facts = await readStatusFacts(paths);
    assert.deepEqual(
      facts.filter((fact) => fact.kind === "tell").map((fact) => fact.id),
      [opening.tell.id, live.tell.id],
    );
    const status = await bornStatus(paths, id);
    assert.equal(status.work.kind, "open");
    assert.deepEqual(status.recent?.map(row => row.sequence), [opening.tell.sequence, frontier.sequence, live.tell.sequence]);
    assert.equal(status.recent?.some(row => row.kind === "tell" && row.tellId === unrelated.tell.id), false);
    assert.equal(status.work.summary?.id, live.tell.sequence);
  } finally {
    leash.release();
    value.close();
  }
});

test("status preserves pending input before any Turn without inventing recent work", async () => {
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
      const observed = await bornStatus(paths, id);
      assert.equal(observed.work.kind, "idle");
      assert.equal(observed.work.turn, undefined);
      assert.equal(observed.recent, undefined);
      assert.deepEqual(observed.work.pending, phase === "pending"
        ? [{ id: (await readStatusFacts(paths)).find(fact => fact.kind === "tell")!.sequence, tellId: "only-tell" }]
        : undefined);
    }
  } finally {
    leash.release();
    value.close();
  }
});
