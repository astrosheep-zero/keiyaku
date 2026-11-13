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
import { activityHistorySchema, activitySnapshotSchema } from "../src/akuma/projection.js";
import { akumaStatusSchema } from "../src/akuma/akuma.js";
import {
  akumaAskResultSchema, akumaCatalogueSchema, akumaKillResultSchema, akumaObservationSchema,
  akumaTellResultSchema, akumaWaitResultSchema,
} from "../src/akuma/selection-observation.js";
import { akumaHistoryResultSchema } from "../src/library/selection.js";
import { akumaIdleResultSchema, akumaReportResultSchema } from "../src/akuma/akuma-instance.js";
import { akumaNameCatalogSchema } from "../src/akuma/archetype.js";
import { forkResultSchema, spawnResultSchema, spawnWaitHeadSchema } from "../src/library/akuma-creation.js";
import { killEvidenceSchema } from "../src/akuma/heart/facts.js";
import { liveStatusObservationSchema } from "../src/akuma/akuma-selection-execution.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { appendActivity, beginTurn, endTurn } from "../src/akuma/heart/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { projectCurrentWork } from "../src/akuma/status-projection.js";
import { activeTool, answeredOutcome, openAkumaSnapshot, idleAkumaSnapshot } from "./support/kanshi-activity.js";
import { tellResultSchema } from "../src/akuma/call-initial-tell.js";
import { bornBody } from "./support/akuma-fixtures.js";
import { bornWorld, fixtureAdapter, fixtureLauncher, answering, settleFixtureBodies } from "./support/akuma-tell.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip, assertWireConformance } from "./support/schema-parity.js";

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
  assertWireRoundTrip(akumaCatalogueSchema, await akumas.list());
  assertWireRoundTrip(akumaObservationSchema, await akumas.status({ akuma: id }));
  const status = await fixture.akuma.status();
  assertWireRoundTrip(akumaStatusSchema, status);
  const parsed = akumaStatusSchema.parse(status);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.birth));
  assert.ok(Object.isFrozen(parsed.birth.origin));
  assert.ok(Object.isFrozen(parsed.work));
  assert.equal(
    akumaStatusSchema.safeParse({
      ...status,
      birth: { ...status.birth, origin: { ...status.birth.origin, extra: true } },
    }).success,
    false,
  );
  assert.equal(akumaStatusSchema.safeParse({ ...status, cwd: undefined }).success, false);
  assert.deepEqual(akumaOriginSchema.parse({ kind: "direct", extra: true }), { kind: "direct" });
  const json = z.toJSONSchema(akumaStatusSchema, { io: "input" });
  const origin = (json.properties as Record<string, any>).birth.properties.origin.anyOf as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(
    origin.map((arm) => arm.additionalProperties),
    [false, false],
  );
  assertWireRoundTrip(
    akumaReportResultSchema,
    await fixture.akuma.report("hello"),
  );
  assertWireRoundTrip(akumaHistoryResultSchema, await akumas.history({ akuma: id, id: "turn/999" }));
  assertWireRoundTrip(activityHistorySchema, await fixture.akuma.history());
  const completedWait = await akumas.wait({ akuma: [id], timeoutMs: 0 });
  const completedIdle = await fixture.akuma.idle({ timeoutMs: 0 });
  assert.equal(completedWait.reason, "completed");
  assert.equal(completedIdle.reason, "completed");
  assertWireRoundTrip(akumaWaitResultSchema, completedWait);
  assertWireRoundTrip(akumaIdleResultSchema, completedIdle);
  assertWireRoundTrip(akumaTellResultSchema, await akumas.tell({ akuma: id, body: "first" }));
  await settleFixtureBodies(bodies);
  let admitted = false;
  assertWireRoundTrip(
    akumaTellResultSchema,
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
        observe: (observation) => assertWireRoundTrip(liveStatusObservationSchema, observation),
      },
    }),
  );
  assert.equal(admitted, true);
  await settleFixtureBodies(bodies);
  assertWireRoundTrip(akumaHistoryResultSchema, await akumas.history({ akuma: id }));
  assertWireRoundTrip(activityHistorySchema, await fixture.akuma.history());
  assertWireRoundTrip(akumaKillResultSchema, await akumas.kill({ akuma: id }));
  assertWireRoundTrip(killEvidenceSchema, await fixture.akuma.kill());
  const stream = fixture.akuma.stream()[Symbol.asyncIterator]();
  const first = await stream.next();
  assertWireRoundTrip(activityHistorySchema, first.value);
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
    assertWireRoundTrip(akumaStatusSchema, active);
    assert.deepEqual(active.work, projectCurrentWork(native.timeline));
    assert.ok(active.work.summary?.id === activeId && active.work.summary.clipped);
    assert.match(active.work.summary.text, /^run \$ npm test/u);
    assert.deepEqual(active.work.activeTools, [{ id: activeId, turnSequence: turn.sequence, toolId: "native-long-tool" }]);
    assert.equal(akumaStatusSchema.safeParse(native).success, false);
    const answer = `answer ${"🙂".repeat(600)}`;
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-10-30T00:00:04.000Z", outcome: { kind: "answered", answer, session: { sessionId: "compact-status" } } });
    const idle = await aku.status();
    assertWireRoundTrip(akumaStatusSchema, idle);
    assert.equal(idle.work.kind, "idle");
    assert.equal(idle.work.outcome?.verdict, "answered");
    assert.equal(idle.work.outcome?.historyId, `turn/${turn.sequence}`);
    assert.equal(idle.work.latestActivity, idle.work.outcome?.activityId);
    const waited = await aku.idle({ timeoutMs: 0 });
    assertWireRoundTrip(akumaIdleResultSchema, waited);
    assert.deepEqual(waited.status.work, idle.work);
    const history = await aku.history();
    assert.ok(history.rows.some(row => row.kind === "outcome" && row.outcome.kind === "answered" && row.outcome.answer === answer));
    const stream = aku.stream()[Symbol.asyncIterator]();
    try {
      const window = activityHistorySchema.parse((await stream.next()).value);
      assert.ok(window.rows.some(row => row.kind === "tool" && row.toolId === "native-long-tool"));
    } finally { await stream.return?.(); }
  } finally { born.holder.release(); }
});

test("current work selects active commands before narration and preserves pending/outcome coordinates", () => {
  for (const command of ["npm test", "square perceive"]) {
    const work = projectCurrentWork(openAkumaSnapshot([
      { kind: "row", row: activeTool(2, "bash", { kind: "run", command }) },
      { kind: "row", row: { kind: "said", sequence: 3, turnSequence: 1, at: "2026-10-30T00:00:00.000Z", text: "waiting" } },
    ]));
    assert.equal(work.summary?.text, `run $ ${command}`);
    assert.equal(work.summary?.id, 2);
  }
  const captured = projectCurrentWork(openAkumaSnapshot([
    { kind: "row", row: activeTool(4, "custom", { kind: "other", input: { json: '{"path":"cut', truncated: true } }) },
  ]));
  assert.deepEqual(captured.summary, { id: 4, text: 'custom {"path":"cut…', clipped: true });
  const pending = { kind: "tell", sequence: 11, at: "2026-10-30T00:00:00.000Z", tellId: "pending", text: "next step", state: "pending", deliveries: [] } as const;
  const work = projectCurrentWork(idleAkumaSnapshot([{ kind: "row", row: pending }], answeredOutcome(9, "exact answer")));
  assert.deepEqual(work.pending, [{ id: 11, tellId: "pending" }]);
  assert.deepEqual(work.outcome, { historyId: "turn/1", activityId: 9, verdict: "answered" });
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
  const parsed = activitySnapshotSchema.parse(snapshot);
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
  assert.equal(activitySnapshotSchema.safeParse({ ...snapshot, openingSequence: undefined }).success, false);
  assert.equal(
    activitySnapshotSchema.safeParse({
      ...snapshot,
      entries: [{ kind: "row", row: { ...tool, call: { ...tool.call, offset: undefined } } }],
    }).success,
    false,
  );
  assert.equal(
    activitySnapshotSchema.safeParse({
      ...snapshot,
      entries: [{ kind: "row", row: { ...tool, call: { ...tool.call, extra: true } } }],
    }).success,
    false,
  );
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
    assertWireRoundTrip(akumaIdleResultSchema, idle);
    const wait = await api.wait({ akuma: [born.allocated.id], timeoutMs: 0 });
    assert.equal(wait.reason, "deadline");
    assertWireRoundTrip(akumaWaitResultSchema, wait);
    const ask = await api.tell({ akuma: born.allocated.id, body: "queued", wait: true, timeoutMs: 0 });
    assert.equal(ask.input?.kind, "deadline");
    assertWireRoundTrip(akumaTellResultSchema, ask);
    const report = await akuma.report("working");
    assert.equal(report.kind, "recorded");
    assertWireRoundTrip(akumaReportResultSchema, report);
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-10-30T00:00:00.000Z", outcome: { kind: "canceled" } });
    const refused = await akuma.report("closed");
    assert.equal(refused.kind, "refused");
    assertWireRoundTrip(akumaReportResultSchema, refused);
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
  assertWireRoundTrip(akumaAskResultSchema, ask);
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
  assertWireRoundTrip(spawnResultSchema, spawned);
  assertWireConformance(root.Keiyaku.verbs.spawn.normal, spawned);
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
        assertWireRoundTrip(spawnWaitHeadSchema, head);
      },
      observe: (observation) => assertWireRoundTrip(liveStatusObservationSchema, observation),
    },
  });
  assert.equal(admitted, true);
  assert.equal(observed.input?.kind, "answered");
  assertWireRoundTrip(spawnResultSchema, observed);
  assertWireConformance(root.Keiyaku.verbs.spawn.normal, observed);
  assertWireRoundTrip(forkResultSchema, await akumas.fork({ akuma: observed.akumaId, at: "turn/999" }));
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
    assertWireRoundTrip(forkResultSchema, forked);
    assertWireConformance(root.Keiyaku.verbs.fork.normal, forked);
    await settleFixtureBodies(bodies);
  } finally {
    if (original === undefined) delete mutable.fork;
    else mutable.fork = original;
  }
});

test("archetype catalogue wire preserves populated and empty pages", async (context) => {
  const home = temporaryDirectory(context, "akuma-catalog-wire-");
  assertWireRoundTrip(akumaNameCatalogSchema, await root.Akumas.akumaNames({ home }));
  mkdirSync(join(home, "akumas"), { recursive: true });
  writeFileSync(join(home, "akumas", "worker.md"), "---\nprovider: claude\ndescription: Worker\n---\nWork.\n");
  assertWireRoundTrip(akumaNameCatalogSchema, await root.Akumas.akumaNames({ home }));
});
