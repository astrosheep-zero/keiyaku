import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { z } from "zod";
import { akumaOriginSchema } from "../src/akuma/heart/facts.js";
import type { BodyLauncher } from "../src/akuma/body-launch.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import * as root from "../src/index.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { appendActivity, beginTurn, endTurn } from "../src/akuma/heart/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { createdDebtObservationSchema } from "../src/debt/created-observation.js";
import { activityEntrySchema, projectActivityEntry, projectStatusOutcome, projectStatusTimeline } from "../src/akuma/status-projection.js";
import { activeTool, completedTool, answeredOutcome, openAkumaSnapshot, idleAkumaSnapshot } from "./support/kanshi-activity.js";
import { tellResultSchema } from "../src/akuma/call-initial-tell.js";
import { debtSummarySchema } from "../src/debt/board.js";
import { bornBody } from "./support/akuma-fixtures.js";
import { bornWorld, fixtureAdapter, fixtureLauncher, answering, settleFixtureBodies } from "./support/akuma-tell.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip } from "./support/schema-parity.js";

test("Akuma result wire schemas preserve real observations and mutations", async (context) => {
  const directory = temporaryDirectory(context, "akuma-wire-");
  const bodies: Promise<unknown>[] = [];
  const fixture = await bornWorld(directory, "1234abcd");
  const launcher = fixtureLauncher(
    bodies,
    new Map([[fixture.allocated.paths.directory, { adapter: answering("hello"), now: "2026-08-10T00:00:00.000Z" }]]),
  );
  const akumas = akumasWithLauncher(fixture.world, launcher);
  const id = fixture.allocated.id;
  assertWireRoundTrip(root.akumaCatalogueSchema, await akumas.list());
  assertWireRoundTrip(root.akumaObservationSchema, await akumas.status({ akuma: id }));
  const status = await fixture.akuma.status();
  assertWireRoundTrip(root.akumaStatusSchema, status);
  const parsed = root.akumaStatusSchema.parse(status);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.birth));
  assert.ok(Object.isFrozen(parsed.birth.origin));
  assert.ok(Object.isFrozen(parsed.timeline));
  assert.equal(
    root.akumaStatusSchema.safeParse({
      ...status,
      birth: { ...status.birth, origin: { ...status.birth.origin, extra: true } },
    }).success,
    false,
  );
  assert.equal(root.akumaStatusSchema.safeParse({ ...status, cwd: undefined }).success, false);
  assert.deepEqual(akumaOriginSchema.parse({ kind: "direct", extra: true }), { kind: "direct" });
  const json = z.toJSONSchema(root.akumaStatusSchema, { io: "input" });
  const origin = (json.properties as Record<string, any>).birth.properties.origin.anyOf as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    origin.map((arm) => arm.additionalProperties),
    [false, false],
  );
  assertWireRoundTrip(
    root.akumaReportResultSchema,
    await fixture.akuma.report("hello"),
  );
  assertWireRoundTrip(root.akumaHistoryResultSchema, await akumas.history({ akuma: id, id: "turn/999" }));
  assertWireRoundTrip(root.activityHistorySchema, await fixture.akuma.history());
  const completedWait = await akumas.wait({ akuma: [id], timeoutMs: 0 });
  const completedIdle = await fixture.akuma.idle({ timeoutMs: 0 });
  assert.equal(completedWait.reason, "completed");
  assert.equal(completedIdle.reason, "completed");
  assertWireRoundTrip(root.akumaWaitResultSchema, completedWait);
  assertWireRoundTrip(root.akumaIdleResultSchema, completedIdle);
  assertWireRoundTrip(root.akumaTellResultSchema, await akumas.tell({ akuma: id, body: "first" }));
  await settleFixtureBodies(bodies);
  let admitted = false;
  assertWireRoundTrip(
    root.akumaTellResultSchema,
    await akumas.tell({
      wait: true,
      akuma: id,
      body: "answer",
      timeoutMs: 5000,
      observe: {
        admitted: (tell) => {
          admitted = true;
          assertWireRoundTrip(tellResultSchema, tell);
        },
        observe: (observation) => assertWireRoundTrip(root.liveStatusObservationSchema, observation),
      },
    }),
  );
  assert.equal(admitted, true);
  await settleFixtureBodies(bodies);
  assertWireRoundTrip(root.akumaHistoryResultSchema, await akumas.history({ akuma: id }));
  assertWireRoundTrip(root.activityHistorySchema, await fixture.akuma.history());
  assertWireRoundTrip(root.akumaKillResultSchema, await akumas.kill({ akuma: [id] }));
  assertWireRoundTrip(root.killEvidenceSchema, await fixture.akuma.kill());
  const stream = fixture.akuma.stream()[Symbol.asyncIterator]();
  const first = await stream.next();
  assertWireRoundTrip(root.activityHistorySchema, first.value);
  await stream.return?.();
});

test("standalone public status shares compact active and idle observations while native detail stays retained", async (context) => {
  const directory = temporaryDirectory(context, "akuma-standalone-compact-");
  const world = await root.World.at(directory);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const born = await bornBody(directory, "feed0020", "2026-10-30T00:00:00.000Z");
  const aku = root.Akuma.select(world, born.allocated.id);
  const owner = new AkumaOwner(born.allocated.id, world);
  try {
    const turn = await beginTurn(born.allocated.paths, { bodySequence: born.body.sequence, startedAt: "2026-10-30T00:00:01.000Z" });
    const activeId = await appendActivity(born.allocated.paths, {
      turnSequence: turn.sequence, at: "2026-10-30T00:00:02.000Z",
      event: { type: "tool", phase: "started", id: "native-long-tool", name: "bash", call: { kind: "run", command: `npm test ${"🙂".repeat(400)}` } },
    });
    for (let index = 0; index < 12; index += 1)
      await appendActivity(born.allocated.paths, { turnSequence: turn.sequence, at: "2026-10-30T00:00:03.000Z", event: { type: "note", text: `detail ${index} ${"🙂".repeat(400)}` } });
    const native = await owner.status();
    assert.ok(native.timeline.entries.some(entry => entry.kind === "gap"));
    const active = await aku.status();
    assertWireRoundTrip(root.akumaStatusSchema, active);
    assert.deepEqual(active.timeline, projectStatusTimeline(native.timeline));
    assert.ok(active.timeline.entries?.some(entry => entry.id === activeId && entry.text.startsWith("active: ")));
    for (const entry of active.timeline.entries ?? []) {
      assert.deepEqual(Object.keys(entry).sort(), ["id", "text"]);
      assert.equal(Array.from(entry.text).length, 300);
      assert.ok(entry.text.endsWith("…"));
      assert.doesNotMatch(entry.text, /[\uD800-\uDFFF]/u);
    }
    assert.equal(root.akumaStatusSchema.safeParse(native).success, false);
    const answer = `answer ${"🙂".repeat(600)}`;
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-10-30T00:00:04.000Z", outcome: { kind: "answered", answer, session: { sessionId: "compact-status" } } });
    const idle = await aku.status();
    assertWireRoundTrip(root.akumaStatusSchema, idle);
    assert.ok(idle.timeline.kind === "idle" && idle.timeline.outcome?.kind === "answered");
    if (idle.timeline.kind !== "idle" || idle.timeline.outcome?.kind !== "answered") assert.fail("expected idle answer");
    assert.equal(Array.from(idle.timeline.outcome.answer).length, 500);
    assert.ok(idle.timeline.outcome.answer.startsWith("answer 🙂") && idle.timeline.outcome.answer.endsWith("…"));
    const waited = await aku.idle({ timeoutMs: 0 });
    assertWireRoundTrip(root.akumaIdleResultSchema, waited);
    assert.deepEqual(waited.status.timeline, idle.timeline);
    const history = await aku.history();
    assert.ok(history.rows.some(row => row.kind === "outcome" && row.outcome.kind === "answered" && row.outcome.answer === answer));
    const stream = aku.stream()[Symbol.asyncIterator]();
    try {
      const window = root.activityHistorySchema.parse((await stream.next()).value);
      assert.ok(window.rows.some(row => row.kind === "tool" && row.toolId === "native-long-tool"));
    } finally { await stream.return?.(); }
  } finally { born.holder.release(); }
});

test("compact activity preserves correlation, head bounds and distinct idle outcomes", () => {
  const command = `npm test ${"🙂".repeat(400)}`;
  const active = projectActivityEntry(activeTool(2, "bash", { kind: "run", command }))!;
  const failed = projectActivityEntry(completedTool(5, "bash", { kind: "run", command }, { status: "error", exitCode: 1 }))!;
  for (const [entry, prefix] of [[active, "active: run $ "], [failed, "error: run $ "]] as const) {
    assert.deepEqual(Object.keys(entry).sort(), ["id", "text"]);
    assert.ok(entry.text.startsWith(`${prefix}npm test 🙂`));
    assert.equal(Array.from(entry.text).length, 300);
    assert.ok(entry.text.endsWith("…"));
    assert.doesNotMatch(entry.text, /[\uD800-\uDFFF]/u);
    assertWireRoundTrip(activityEntrySchema, entry);
  }
  const said = { kind: "said", sequence: 8, turnSequence: 1, at: "2026-10-30T00:00:00.000Z", text: "first\n  indented" } as const;
  const partial = projectActivityEntry({ ...said, truncated: true })!;
  assert.equal(partial.text, `said: ${said.text}…`);
  const native = openAkumaSnapshot([
    { kind: "row", row: activeTool(2, "bash", { kind: "run", command }) },
    { kind: "gap", count: 2 },
    { kind: "row", row: { ...said, kind: "thought", sequence: 6 } },
    { kind: "row", row: said },
  ]);
  const compact = projectStatusTimeline(native);
  assert.deepEqual(compact.entries?.map(entry => entry.id), [2, 8]);
  assert.equal(compact.entries?.[1]?.text, `said: ${said.text}`);
  const answer = `opening ${"🙂".repeat(600)}`;
  const outcome = projectStatusOutcome(answeredOutcome(9, answer));
  assert.equal(outcome.kind, "answered");
  if (outcome.kind !== "answered") assert.fail("expected answer");
  assert.equal(Array.from(outcome.answer).length, 500);
  assert.ok(outcome.answer.startsWith("opening 🙂") && outcome.answer.endsWith("…"));
  assert.doesNotMatch(outcome.answer, /[\uD800-\uDFFF]/u);
  assert.deepEqual(projectStatusOutcome(answeredOutcome(10, "")), { kind: "answered", answer: "" });
  const pending = { kind: "tell", sequence: 11, at: said.at, tellId: "pending", text: "next\n step", state: "pending", deliveries: [] } as const;
  assert.deepEqual(projectStatusTimeline(idleAkumaSnapshot([{ kind: "row", row: pending }], answeredOutcome(9, answer))), {
    kind: "idle", entries: [{ id: 11, text: "pending-tell: next step" }], outcome,
  });
  const diagnostic = "failure ".repeat(100);
  const failure = projectStatusOutcome({ ...answeredOutcome(12, ""), outcome: { kind: "failed", diagnostic } });
  assert.deepEqual(failure, { kind: "failed", diagnostic: `${Array.from(diagnostic).slice(0, 499).join("")}…` });
});

test("public timeline wire is strict, deeply readonly, and exact-optional", () => {
  const tool = {
    kind: "tool",
    sequence: 2,
    turnSequence: 1,
    at: "2026-10-30T00:00:00.000Z",
    name: "read",
    toolId: "native-read",
    call: { kind: "read", path: "file" },
    state: "active",
  };
  const snapshot = {
    kind: "open",
    turn: { kind: "turn", sequence: 1, bodySequence: 1, at: "2026-10-30T00:00:00.000Z" },
    entries: [{ kind: "row", row: tool }],
    reportedChanges: [],
    reportedChangesOmitted: 0,
  };
  const parsed = root.activitySnapshotSchema.parse(snapshot);
  assert.equal(parsed.kind, "open");
  if (parsed.kind !== "open") throw new Error("expected open snapshot");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.turn));
  assert.ok(Object.isFrozen(parsed.entries));
  const entry = parsed.entries[0]!;
  assert.ok(Object.isFrozen(entry));
  if (entry.kind !== "row" || entry.row.kind !== "tool") throw new Error("expected tool row");
  assert.ok(Object.isFrozen(entry.row));
  assert.ok(Object.isFrozen(entry.row.call));
  assert.equal(root.activitySnapshotSchema.safeParse({ ...snapshot, openingSequence: undefined }).success, false);
  assert.equal(
    root.activitySnapshotSchema.safeParse({
      ...snapshot,
      entries: [{ kind: "row", row: { ...tool, call: { ...tool.call, offset: undefined } } }],
    }).success,
    false,
  );
  assert.equal(
    root.activitySnapshotSchema.safeParse({
      ...snapshot,
      entries: [{ kind: "row", row: { ...tool, call: { ...tool.call, extra: true } } }],
    }).success,
    false,
  );
});

test("created Debt wire rows freeze and reject explicit undefined without changing native decoding", () => {
  const row = {
    id: "debt/example",
    title: "Example",
    priority: 2,
    disposition: "ready",
  };
  const parsed = createdDebtObservationSchema.parse({ kind: "present", rows: [row] });
  assert.equal(parsed.kind, "present");
  if (parsed.kind !== "present") throw new Error("expected rows");
  const rows = parsed.rows!;
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(rows));
  assert.ok(Object.isFrozen(rows[0]));
  assert.equal(
    createdDebtObservationSchema.safeParse({ kind: "present", rows: [{ ...row, priority: undefined }] }).success,
    false,
  );
  assert.equal(debtSummarySchema.safeParse({ ...row, priority: undefined }).success, false);
});

test("recorded and refused reports retain their wire evidence", async (context) => {
  const directory = temporaryDirectory(context, "akuma-report-wire-");
  const world = await root.World.at(directory);
  writeFileSync(join(directory, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const born = await bornBody(directory, "feed0001", "2026-10-30T00:00:00.000Z");
  try {
    const turn = await beginTurn(born.allocated.paths, {
      bodySequence: born.body.sequence,
      startedAt: "2026-10-30T00:00:00.000Z",
    });
    const akuma = root.Akuma.select(world, born.allocated.id);
    const api = akumasWithLauncher(world, async () => {
      throw new Error("held Body must not launch");
    });
    const idle = await akuma.idle({ timeoutMs: 0 });
    assert.equal(idle.reason, "deadline");
    assertWireRoundTrip(root.akumaIdleResultSchema, idle);
    const wait = await api.wait({ akuma: [born.allocated.id], timeoutMs: 0 });
    assert.equal(wait.reason, "deadline");
    assertWireRoundTrip(root.akumaWaitResultSchema, wait);
    const ask = await api.tell({ akuma: born.allocated.id, body: "queued", wait: true, timeoutMs: 0 });
    assert.equal(ask.input?.kind, "deadline");
    assertWireRoundTrip(root.akumaTellResultSchema, ask);
    const report = await akuma.report("working");
    assert.equal(report.kind, "recorded");
    assertWireRoundTrip(root.akumaReportResultSchema, report);
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-10-30T00:00:00.000Z", outcome: { kind: "canceled" } });
    const refused = await akuma.report("closed");
    assert.equal(refused.kind, "refused");
    assertWireRoundTrip(root.akumaReportResultSchema, refused);
  } finally {
    born.holder.release();
  }
});

test("a fresh direct ask returns an answered wire result", async (context) => {
  const directory = temporaryDirectory(context, "akuma-ask-answer-wire-");
  const fixture = await bornWorld(directory, "abcd1234");
  const bodies: Promise<unknown>[] = [];
  const launcher = fixtureLauncher(
    bodies,
    new Map([[fixture.allocated.paths.directory, { adapter: answering('{"ok":true}'), now: "2026-08-10T00:00:00.000Z" }]]),
  );
  const ask = await akumasWithLauncher(fixture.world, launcher).ask({
    akuma: fixture.allocated.id,
    body: "question",
    schema: { type: "object" },
    timeoutMs: 5000,
  });
  assert.equal(ask.kind, "answered");
  assertWireRoundTrip(root.akumaAskResultSchema, ask);
  await settleFixtureBodies(bodies);
});

test("spawn and fork results describe real creation and refusal", async (context) => {
  const directory = temporaryDirectory(context, "akuma-spawn-wire-");
  const fixture = await bornWorld(directory, "87654321");
  const home = join(directory, "home");
  mkdirSync(join(home, "akumas"), { recursive: true });
  writeFileSync(join(home, "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  const bodies: Promise<unknown>[] = [];
  const adapter = fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
    const finished = deferred<void>();
    custody.own({ closed: finished.promise, forceDispose: async () => {} });
    return {
      admission: { fence: "source-turn" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "source-session" } };
          finished.resolve();
        },
      },
      completion: finished.promise.then(() => ({
        kind: "answered" as const,
        answer: "done",
        historyId: "native-history",
      })),
    };
  }));
  const launcher: BodyLauncher = (launch) =>
    fixtureLauncher(bodies, new Map([[launch.paths.directory, { adapter, now: "2026-08-10T00:00:00.000Z" }]]))(launch);
  const akumas = akumasWithLauncher(fixture.world, launcher);
  const spawned = await akumas.spawn({ akumaName: "worker", home, cwd: directory });
  assert.equal(spawned.kind, "spawned");
  assert.equal(spawned.input, undefined);
  assertWireRoundTrip(root.spawnResultSchema, spawned);
  let admitted = false;
  const observed = await akumas.spawn({
    akumaName: "worker",
    home,
    cwd: directory,
    body: "answer",
    mode: "wait",
    timeoutMs: 5000,
    observe: {
      admitted: (tell, _id, head) => {
        admitted = true;
        assertWireRoundTrip(tellResultSchema, tell);
        assertWireRoundTrip(root.spawnWaitHeadSchema, head);
      },
      observe: (observation) => assertWireRoundTrip(root.liveStatusObservationSchema, observation),
    },
  });
  assert.equal(admitted, true);
  assert.equal(observed.input?.kind, "answered");
  assertWireRoundTrip(root.spawnResultSchema, observed);
  assertWireRoundTrip(root.forkResultSchema, await akumas.fork({ akuma: observed.akumaId, at: "turn/999" }));
  await settleFixtureBodies(bodies);
  const mutable = claudeProvider as { fork?: ProviderAdapter["fork"] };
  const original = mutable.fork;
  mutable.fork = () => createProviderAttempt(undefined, async () => ({ session: { sessionId: "forked-session" } }));
  try {
    const history = await akumas.history({ akuma: observed.akumaId });
    assert.equal(history.kind, "akuma");
    if (history.kind !== "akuma") throw new Error("missing history");
    const outcome = history.events.find((row) => row.kind === "outcome");
    assert.ok(outcome);
    const forked = await akumas.fork({ akuma: observed.akumaId, at: `turn/${outcome.turnSequence}` });
    assert.equal(forked.kind, "forked");
    assertWireRoundTrip(root.forkResultSchema, forked);
    await settleFixtureBodies(bodies);
  } finally {
    if (original === undefined) delete mutable.fork;
    else mutable.fork = original;
  }
});

test("archetype catalogue wire preserves populated and empty pages", async (context) => {
  const home = temporaryDirectory(context, "akuma-catalog-wire-");
  assertWireRoundTrip(root.archetypeCatalogSchema, await root.listArchetypeDefinitions({ home }));
  mkdirSync(join(home, "akumas"), { recursive: true });
  writeFileSync(join(home, "akumas", "worker.md"), "---\nprovider: claude\ndescription: Worker\n---\nWork.\n");
  assertWireRoundTrip(root.archetypeCatalogSchema, await root.listArchetypeDefinitions({ home }));
});
