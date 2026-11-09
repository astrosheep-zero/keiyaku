import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { z } from "zod";
import { akumaOriginSchema } from "../src/akuma/heart/facts.js";
import type { BodyLauncher } from "../src/akuma/body-launch.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import type { Akuma, Akumas, listArchetypeDefinitions } from "../src/index.js";
import * as root from "../src/index.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { beginTurn } from "../src/akuma/heart/index.js";
import { createdDebtObservationSchema } from "../src/debt/created-observation.js";
import { debtRowSchema } from "../src/debt/board.js";
import { bornBody } from "./support/akuma-fixtures.js";
import { bornWorld, fixtureAdapter, fixtureLauncher, answering, settleFixtureBodies } from "./support/akuma-tell.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip, type Assert, type Exact, type Wire } from "./support/schema-parity.js";

type Result<T extends (...args: never[]) => unknown> = Wire<Awaited<ReturnType<T>>>;
export type List = Assert<Exact<z.output<typeof root.akumaListSchema>, Result<Akumas["list"]>>>;
export type Spawn = Assert<Exact<z.output<typeof root.spawnResultSchema>, Result<Akumas["spawn"]>>>;
export type Fork = Assert<Exact<z.output<typeof root.forkResultSchema>, Result<Akumas["fork"]>>>;
export type Status = Assert<Exact<z.output<typeof root.akumaObservationSchema>, Result<Akumas["status"]>>>;
export type Tell = Assert<Exact<z.output<typeof root.akumaTellResultSchema>, Result<Akumas["tell"]>>>;
export type Ask = Assert<Exact<z.output<typeof root.akumaAskResultSchema>, Result<Akumas["ask"]>>>;
export type Wait = Assert<Exact<z.output<typeof root.akumaWaitResultSchema>, Result<Akumas["wait"]>>>;
export type Kill = Assert<Exact<z.output<typeof root.akumaKillResultSchema>, Result<Akumas["kill"]>>>;
export type History = Assert<Exact<z.output<typeof root.akumaHistoryResultSchema>, Result<Akumas["history"]>>>;
export type HandleStatus = Assert<Exact<z.output<typeof root.akumaStatusSchema>, Result<Akuma["status"]>>>;
export type HandleTell = Assert<Exact<z.output<typeof root.akumaTellResultSchema>, Result<Akuma["tell"]>>>;
export type HandleAsk = Assert<Exact<z.output<typeof root.akumaAskResultSchema>, Result<Akuma["ask"]>>>;
export type HandleIdle = Assert<Exact<z.output<typeof root.akumaIdleResultSchema>, Result<Akuma["idle"]>>>;
export type HandleHistory = Assert<Exact<z.output<typeof root.activityHistorySchema>, Result<Akuma["history"]>>>;
export type HandleKill = Assert<Exact<z.output<typeof root.killEvidenceSchema>, Result<Akuma["kill"]>>>;
export type HandleReport = Assert<Exact<z.output<typeof root.akumaReportResultSchema>, Result<Akuma["report"]>>>;
export type Stream = Assert<Exact<z.output<typeof root.activityHistorySchema>, Wire<root.AkumaStreamSnapshot>>>;
export type Catalogue = Assert<
  Exact<z.output<typeof root.archetypeCatalogSchema>, Result<typeof listArchetypeDefinitions>>
>;
export type ListRow = Assert<
  Exact<z.output<typeof root.akumaListRowSchema>, Wire<import("../src/akuma/akuma.js").AkumaListRow>>
>;
export type UnbornRow = Assert<
  Exact<z.output<typeof root.unbornAkumaListRowSchema>, Wire<import("../src/akuma/akuma.js").UnbornAkumaListRow>>
>;
export type Dispatch = Assert<
  Exact<z.output<typeof root.dispatchSchema>, Wire<import("../src/dispatch/index.js").Dispatch>>
>;
export type DispatchFailure = Assert<
  Exact<z.output<typeof root.dispatchFailureSchema>, Wire<import("../src/dispatch/index.js").DispatchFailure>>
>;
export type LiveObservation = Assert<
  Exact<
    z.output<typeof root.liveStatusObservationSchema>,
    Wire<import("../src/akuma/akuma-observe.js").LiveStatusObservation>
  >
>;
export type SpawnHead = Assert<Exact<z.output<typeof root.spawnWaitHeadSchema>, Wire<root.SpawnWaitHead>>>;
export type TellReceipt = Assert<Exact<z.output<typeof root.tellResultSchema>, Wire<root.TellResult>>>;
export type ObservationStage = Assert<
  Exact<z.output<typeof root.akumaObservationStageSchema>, Wire<root.AkumaObservationStage>>
>;
export type AliasBinding = Assert<
  Exact<
    z.output<typeof import("../src/alias/index.js").aliasBindingSchema>,
    Wire<import("../src/alias/index.js").AliasBinding>
  >
>;
// Akuma.birth, Akuma.select, and Akumas.of return handles, not wire results.
// Thrown errors are not results.

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
  assertWireRoundTrip(root.akumaListSchema, await akumas.list());
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
    await fixture.akuma.report("hello", { bodySequence: 1, turnSequence: 1 }),
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
    root.akumaAskResultSchema,
    await akumas.ask({
      akuma: id,
      body: "answer",
      timeoutMs: 5000,
      observe: {
        admitted: (tell) => {
          admitted = true;
          assertWireRoundTrip(root.tellResultSchema, tell);
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

test("public timeline wire is strict, deeply readonly, and exact-optional", () => {
  const tool = {
    kind: "tool",
    sequence: 2,
    turnSequence: 1,
    at: "2026-10-30T00:00:00.000Z",
    name: "read",
    call: { kind: "read", path: "file" },
    state: "active",
  };
  const snapshot = {
    kind: "open",
    turn: { kind: "turn", sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-10-30T00:00:00.000Z" },
    entries: [{ kind: "row", row: tool }],
    omitted: 0,
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
    state: "open",
    priority: 2,
    disposition: "ready",
    updatedAt: "2026-10-30T00:00:00.000Z",
    bodyPresent: false,
    children: { live: 1, total: 2 },
  };
  const parsed = createdDebtObservationSchema.parse({ kind: "present", rows: [row] });
  assert.equal(parsed.kind, "present");
  if (parsed.kind !== "present") throw new Error("expected rows");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.rows));
  assert.ok(Object.isFrozen(parsed.rows[0]));
  assert.ok(Object.isFrozen(parsed.rows[0]?.children));
  assert.equal(
    createdDebtObservationSchema.safeParse({ kind: "present", rows: [{ ...row, children: undefined }] }).success,
    false,
  );
  assert.equal(debtRowSchema.safeParse({ ...row, children: undefined }).success, true);
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
    const ask = await api.ask({ akuma: born.allocated.id, body: "queued", timeoutMs: 0 });
    assert.equal(ask.observation.reason, "deadline");
    assertWireRoundTrip(root.akumaAskResultSchema, ask);
    const report = await akuma.report("working", { bodySequence: born.body.sequence, turnSequence: turn.sequence });
    assert.equal(report.kind, "recorded");
    assertWireRoundTrip(root.akumaReportResultSchema, report);
    const refused = await akuma.report("stale", { bodySequence: born.body.sequence + 1, turnSequence: turn.sequence });
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
    new Map([[fixture.allocated.paths.directory, { adapter: answering("answer"), now: "2026-08-10T00:00:00.000Z" }]]),
  );
  const ask = await akumasWithLauncher(fixture.world, launcher).ask({
    akuma: fixture.allocated.id,
    body: "question",
    timeoutMs: 5000,
  });
  assert.equal(ask.observation.reason, "answered");
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
  const adapter = fixtureAdapter(async () => {
    const finished = deferred<void>();
    return {
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
      resource: { abort: async () => {} },
    };
  });
  const launcher: BodyLauncher = (launch) =>
    fixtureLauncher(bodies, new Map([[launch.paths.directory, { adapter, now: "2026-08-10T00:00:00.000Z" }]]))(launch);
  const akumas = akumasWithLauncher(fixture.world, launcher);
  const spawned = await akumas.spawn({ akumaName: "worker", home, cwd: directory });
  assert.equal(spawned.observation.kind, "born");
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
        assertWireRoundTrip(root.tellResultSchema, tell);
        assertWireRoundTrip(root.spawnWaitHeadSchema, head);
      },
      observe: (observation) => assertWireRoundTrip(root.liveStatusObservationSchema, observation),
    },
  });
  assert.equal(admitted, true);
  assert.equal(observed.observation.kind, "observed");
  assertWireRoundTrip(root.spawnResultSchema, observed);
  assertWireRoundTrip(root.forkResultSchema, await akumas.fork({ akuma: observed.akuma, at: "turn/999" }));
  await settleFixtureBodies(bodies);
  const mutable = claudeProvider as { fork?: ProviderAdapter["fork"] };
  const original = mutable.fork;
  mutable.fork = () => createProviderAttempt(undefined, async () => ({ session: { sessionId: "forked-session" } }));
  try {
    const history = await akumas.history({ akuma: observed.akuma });
    assert.equal(history.kind, "history");
    if (history.kind !== "history") throw new Error("missing history");
    const outcome = history.history.rows.find((row) => row.kind === "outcome");
    assert.ok(outcome);
    const forked = await akumas.fork({ akuma: observed.akuma, at: outcome.outcome.historyId });
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
