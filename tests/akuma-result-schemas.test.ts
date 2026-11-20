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
import { activityHistorySchema, activityStreamSnapshotSchema } from "../src/akuma/projection.js";
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
import { tellResultSchema } from "../src/akuma/call-initial-tell.js";
import { bornBody } from "./support/akuma-fixtures.js";
import { bornWorld, fixtureAdapter, fixtureLauncher, answering, settleFixtureBodies } from "./support/akuma-tell.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip, assertWireConformance } from "./support/schema-parity.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

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
  assertWireRoundTrip(activityStreamSnapshotSchema, first.value);
  await stream.return?.();
});

test("standalone public status shares one direct current-work observation and keeps only the latest three rows", async (context) => {
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
    const active = await aku.status();
    assert.deepEqual(active, native, "the standalone face serves the owner's one native observation");
    assertWireRoundTrip(akumaStatusSchema, active);
    assert.deepEqual(active.recent, (await aku.history({ limit: 3 })).rows);
    assert.ok(active.work.summary?.id === activeId && active.work.summary.clipped);
    assert.match(active.work.summary.text, /^run \$ npm test 🙂+…$/u);
    assert.equal(Array.from(active.work.summary.text).length, 300);
    const exact = await root.Akumas.of(world).history({ akuma: aku.id, id: String(activeId) });
    assertWireRoundTrip(akumaHistoryResultSchema, exact);
    assert.ok(exact.kind === "akuma-activity" && exact.row.kind === "tool");
    assert.equal(exact.row.toolId, "native-long-tool");
    const running = await aku.idle({ timeoutMs: 0 });
    assert.equal(running.reason, "deadline");
    assert.equal(running.status.kind, "observed");
    assert.equal(running.status.life, active.life);

    const resource = `/outside/${"nested/".repeat(28)}target.txt`;
    const request = { id: "per_read", action: "external_directory", tool: "read", resources: [resource] };
    const approval = await appendActivity(born.allocated.paths, {
      turnSequence: turn.sequence, at: "2026-10-30T00:00:03.000Z", event: { type: "permission", requests: [request] },
    });
    const pending = await aku.status();
    assert.deepEqual(pending.work.awaiting?.requests, [request]);
    const preview = pending.recent?.at(-1);
    assert.ok(preview?.id === approval);
    assert.match(preview.text, /Awaiting approval:.*external_directory.*read.*…$/u);
    assert.ok(!preview.text.includes(resource));
    const exactApproval = await root.Akumas.of(world).history({ akuma: aku.id, id: String(approval) });
    assert.ok(exactApproval.kind === "akuma-activity" && exactApproval.row.kind === "permission");
    assert.deepEqual(exactApproval.row.requests, [request]);
    const answer = `answer ${"🙂".repeat(600)}`;
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-10-30T00:00:04.000Z", outcome: { kind: "answered", answer, session: { sessionId: "compact-status" } } });
    const idle = await aku.status();
    assertWireRoundTrip(akumaStatusSchema, idle);
    assert.equal(idle.work.kind, "idle");
    assert.equal(idle.work.outcome?.verdict, "answered");
    assert.equal(idle.work.outcome?.historyId, `turn/${turn.sequence}`);
    const waited = await aku.idle({ timeoutMs: 0 });
    assertWireRoundTrip(akumaIdleResultSchema, waited);
    assert.equal(waited.status.kind, "observed");
    assert.equal(waited.status.id, born.allocated.id);
    assert.equal(waited.status.life, idle.life);
    assert.equal(waited.status.outcome?.historyId, `turn/${turn.sequence}`);
    assert.deepEqual(waited.status.outcome, { kind: "answered", historyId: `turn/${turn.sequence}`, answer });
    const stream = aku.stream()[Symbol.asyncIterator]();
    try {
      const window = activityStreamSnapshotSchema.parse((await stream.next()).value);
      assert.ok(window.rows.some(row => row.kind === "tool" && row.toolId === "native-long-tool"));
      assert.ok(window.rows.some(row => row.kind === "outcome" && row.outcome.kind === "answered" && row.outcome.answer === answer));
    } finally { await stream.return?.(); }
  } finally { born.holder.release(); }
});

test("current work selects active commands before narration and preserves pending/outcome coordinates", () => {
  const at = "2026-10-30T00:00:00.000Z";
  for (const command of ["npm test", "square perceive"]) {
    const work = projectCurrentWork([
      { kind: "turn", sequence: 1, bodySequence: 1, at },
      { kind: "tool", sequence: 2, turnSequence: 1, at, name: "bash", toolId: "tool-2", call: { kind: "run", command }, phase: "started" },
      { kind: "said", sequence: 3, turnSequence: 1, at, text: "waiting" },
    ]);
    assert.equal(work.summary?.text, `run $ ${command}`);
    assert.equal(work.summary?.id, 2);
  }
  const captured = projectCurrentWork([
    { kind: "turn", sequence: 1, bodySequence: 1, at },
    { kind: "tool", sequence: 4, turnSequence: 1, at, name: "custom", toolId: "tool-4", call: { kind: "other", input: { json: '{"path":"cut', truncated: true } }, phase: "started" },
  ]);
  assert.deepEqual(captured.summary, { id: 4, text: 'custom {"path":"cut…', clipped: true });
  const pending = { kind: "tell", sequence: 11, at, tellId: "pending", text: "next step", state: "pending", deliveries: [] } as const;
  const work = projectCurrentWork([pending, { kind: "outcome", sequence: 9, turnSequence: 1, at, outcome: { kind: "answered", answer: "exact answer" } }]);
  assert.deepEqual(work.pending, [{ id: 11 }]);
  assert.deepEqual(work.outcome, { historyId: "turn/1", verdict: "answered" });
});

test("typed timeline wire is strict, deeply readonly, exact-optional, and phases results", () => {
  const at = "2026-10-30T00:00:00.000Z";
  const started = {
    kind: "tool", sequence: 2, turnSequence: 1, at, name: "read", toolId: "native-read",
    call: { kind: "read", path: "file" }, phase: "started",
  };
  const completed = {
    ...started, sequence: 3, phase: "completed", result: { status: "ok", output: "bytes" },
  };
  const history = {
    rows: [
      { kind: "turn", sequence: 1, bodySequence: 1, at },
      started,
      completed,
    ],
    omitted: 0,
    hasEarlier: false,
    hasLater: false,
    historyLost: false,
    lowestRetained: 1,
    highest: 3,
  };
  const parsed = activityStreamSnapshotSchema.parse(history);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.rows));
  const row = parsed.rows[1]!;
  assert.ok(Object.isFrozen(row));
  if (row.kind !== "tool") throw new Error("expected tool row");
  assert.ok(Object.isFrozen(row.call));
  assert.equal(activityStreamSnapshotSchema.safeParse({ ...history, extra: true }).success, false);
  assert.equal(
    activityStreamSnapshotSchema.safeParse({ ...history, rows: [...history.rows, { ...started, sequence: 4, result: { status: "ok" } }] }).success,
    false,
    "a started tool never carries a result",
  );
  assert.equal(
    activityStreamSnapshotSchema.safeParse({ ...history, rows: [...history.rows, { ...completed, sequence: 4, result: undefined }] }).success,
    false,
    "a completed tool always carries its result",
  );
  assert.equal(
    activityStreamSnapshotSchema.safeParse({ ...history, rows: [{ ...started, call: { ...started.call, offset: undefined } }] }).success,
    false,
    "absent members stay absent rather than explicit undefined",
  );
  assert.equal(
    activityStreamSnapshotSchema.safeParse({ ...history, rows: [{ ...started, call: { ...started.call, extra: true } }] }).success,
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
  const submitted = await akumas.spawn({ akumaName: "worker", home, cwd: directory, body: "submit" });
  assert.equal(submitted.kind, "spawned");
  assert.equal(submitted.action?.kind, "started");
  assertWireConformance(root.Keiyaku.verbs.spawn.normal, submitted);
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
  assert.equal(root.Keiyaku.verbs.spawn.normal.safeParse(observed).success, false);
  assertWireRoundTrip(forkResultSchema, await akumas.fork({ akuma: observed.akumaId, at: "turn/999" }));
  await settleFixtureBodies(bodies);
  const mutable = claudeProvider as { fork?: ProviderAdapter["fork"] };
  const original = mutable.fork;
  mutable.fork = () => createProviderAttempt(undefined, async () => ({ session: { sessionId: "forked-session" } }));
  try {
    const latest = await akumas.history({ akuma: observed.akumaId, last: true });
    assert.ok(latest.kind === "akuma-answer");
    const forked = await akumas.fork({ akuma: observed.akumaId, at: latest.historyId });
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
