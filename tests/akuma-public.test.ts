import { fixtureAdapter } from "./support/akuma-tell.js";
import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import { activityFact, claudeBodyLaunch, turnEndFact } from "./support/akuma-fixtures.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { settlementProbe, waitForCondition, waitForFixtureFile as waitForFile } from "./support/process.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AkumaNotBornError, killAkumaWithRecovery } from "../src/akuma/akuma.js";
import { AkumaComposition as Akuma } from "./support/akuma-composition.js";
import {
  projectTurns,
  selectHistory,
  selectSnapshot,
  activitySnapshotSchema,
  type ActivitySnapshot,
  type ActivityHistory,
  type TurnLedger
} from "../src/akuma/projection.js";
import { AkumaArchetypeError, loadArchetype } from "../src/akuma/archetype.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import {
  activitySlice,
  appendActivity,
  beginTurn,
  breakBody,
  endTurn,
  finishBodyIfIdle,
  HeldAkumaLeash,
  initializeHeart,
  pauseRequested,
  probeLeash,
  readHeart,
  recordTell,
  type Soul,
  type TimelineFact,
} from "../src/akuma/heart/index.js";
import { akumaPaths, akumaRunRoot, allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import { createProviderAttempt, type ProviderAdapter, type ToolCall } from "../src/akuma/provider.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { settings } from "../src/settings.js";
import { Keiyaku } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { World } from "../src/world.js";
import type { AkumaHandle } from "../src/akuma/akuma-handle.js";

const CLAUDE_EXECUTION = { name: "claude", kind: "claude-agent-sdk" } as const;

type DeferredBodyEnd = Readonly<{
  started: string;
  release: string;
  settled: string;
  turnStarted: string;
  turnRelease: string;
  turnSettled: string;
}>;

function configureDeferredBodyEndPlugin(root: string): DeferredBodyEnd {
  const plugins = join(root, "plugins");
  const started = join(root, "body-ended-started");
  const release = join(root, "body-ended-release");
  const settled = join(root, "body-ended-settled");
  const turnStarted = join(root, "turn-outcome-started");
  const turnRelease = join(root, "turn-outcome-release");
  const turnSettled = join(root, "turn-outcome-settled");
  const ledger = join(root, "square-ledger");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, "square-wrapper.mjs"),
    [
      `import square from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), "plugins/square/index.js")).href)};`,
      'import { appendFileSync, existsSync } from "node:fs";',
      "async function waitForRelease(path) {",
      "  if (existsSync(path)) return;",
      "  const deadline = Date.now() + 60000;",
      "  while (!existsSync(path)) {",
      "    if (Date.now() >= deadline) throw new Error(`fixture wait for ${path} expired after 60000ms`);",
      "    await new Promise((resolve) => setImmediate(resolve));",
      "  }",
      "}",
      "export default {",
      '  manifest: { id: "square", apiVersion: 1, writablePaths: [{ name: "square", path: ".square" }] },',
      "  async activate(context) {",
      "    const previousUser = process.env.SQUARE_HOST_LEDGER_USER;",
      "    const previousLocal = process.env.SQUARE_HOST_LEDGER_LOCAL;",
      "    process.env.SQUARE_HOST_LEDGER_USER = context.config.ledgerUser;",
      "    process.env.SQUARE_HOST_LEDGER_LOCAL = context.config.ledgerLocal;",
      "    let actual;",
      "    try { actual = await square.activate(context); } finally {",
      "      if (previousUser === undefined) delete process.env.SQUARE_HOST_LEDGER_USER; else process.env.SQUARE_HOST_LEDGER_USER = previousUser;",
      "      if (previousLocal === undefined) delete process.env.SQUARE_HOST_LEDGER_LOCAL; else process.env.SQUARE_HOST_LEDGER_LOCAL = previousLocal;",
      "    }",
      '    const handler = actual.signals?.["akuma.turn-outcome"];',
      '    if (handler === undefined) throw new Error("Square plugin has no turn-outcome handler");',
      '    return { signals: { ...(actual.signals ?? {}), "akuma.turn-outcome": async (signal) => { appendFileSync(context.config.turnStarted, "turn-outcome\\n"); await waitForRelease(context.config.turnRelease); try { await handler(signal); } finally { appendFileSync(context.config.turnSettled, "turn-outcome\\n"); } } } };',
      "  },",
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(plugins, "deferred.mjs"),
    [
      'import { appendFileSync, existsSync } from "node:fs";',
      "async function waitForRelease(path) {",
      "  if (existsSync(path)) return Promise.resolve();",
      "  const deadline = Date.now() + 60000;",
      "  while (!existsSync(path)) {",
      "    if (Date.now() >= deadline) throw new Error(`fixture wait for ${path} expired after 60000ms`);",
      "    await new Promise((resolve) => setImmediate(resolve));",
      "  }",
      "}",
      "export default {",
      '  manifest: { id: "deferred", apiVersion: 1 },',
      '  activate(context) { return { signals: { "akuma.body-ended": async () => { appendFileSync(context.config.started, "started\\n"); try { await waitForRelease(context.config.release); } finally { appendFileSync(context.config.settled, "settled\\n"); } } } }; },',
      "};",
    ].join("\n"),
  );
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: {
        square: {
          package: "./plugins/square-wrapper.mjs",
          config: {
            turnStarted,
            turnRelease,
            turnSettled,
            ledgerUser: join(ledger, "user"),
            ledgerLocal: join(ledger, "local"),
          },
        },
        deferred: { package: "./plugins/deferred.mjs", config: { started, release, settled } },
      },
    }),
  );
  return { started, release, settled, turnStarted, turnRelease, turnSettled };
}

async function akumaAt(root: string, input?: { home?: string; settings?: Awaited<ReturnType<typeof settings>> }) {
  return Akuma.of(await World.at(root), input);
}

function historyPage(page: Awaited<ReturnType<AkumaHandle["history"]>>): ActivityHistory {
  if ("rows" in page) return page;
  throw new Error(`expected history page, received ${page.kind}`);
}

async function timeline(paths: Parameters<typeof activitySlice>[0]) {
  return (await activitySlice(paths)).rows;
}

async function bornHistoryHandle(root: string, suffix: string) {
  const allocated = await allocateAkumaDirectory({
    worldRoot: root,
    archetype: "claude",
    draw: () => suffix,
  });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  await holder.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: CLAUDE_EXECUTION,
    options: {},
    cwd: root,
    origin: { kind: "direct" },
    allowed: [],
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  const body = await holder.recordBody(allocated.paths, {
    leashTakenAt: "2026-08-10T00:00:00.000Z",
  });
  const turn = await beginTurn(allocated.paths, {
    bodySequence: body.sequence,
    startedAt: "2026-08-10T00:00:01.000Z",
  });
  return { allocated, holder, turn, handle: (await akumaAt(root)).of({ id: allocated.id }) };
}

function toolRow(rows: readonly { kind: string; sequence: number; state?: unknown }[]) {
  return rows.filter((row) => row.kind === "tool");
}

test("malformed public history IDs refuse before Heart reads", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-history-id-");
  const born = await bornHistoryHandle(root, "c0000005");
  born.holder.release();
  unlinkSync(born.allocated.paths.heart);
  await assert.rejects(() => born.handle.history({ id: "history-1" }), /turn\/<positive safe integer>/u);
  await assert.rejects(
    async () =>
      Keiyaku.history({ path: await World.at(root), akuma: born.allocated.id, id: "turn/9007199254740992" }),
    /turn\/<positive safe integer>/u,
  );
});

test("history completion keeps the start sequence and never remints", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-history-remint-"));
  const born = await bornHistoryHandle(root, "c0000001");
  try {
    const start = await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: {
        type: "tool",
        phase: "started",
        id: "bash-1",
        name: "Bash",
        call: { kind: "run", command: "npm test" },
      },
      at: "2026-08-10T00:00:02.000Z",
    });
    const done = await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: {
        type: "tool",
        phase: "completed",
        id: "bash-1",
        name: "Bash",
        call: { kind: "run", command: "npm test" },
        result: { status: "ok" },
      },
      at: "2026-08-10T00:00:03.000Z",
    });
    assert.deepEqual([born.turn.sequence, start, done], [1, 2, 3]);

    const page = historyPage(await born.handle.history());
    const tools = toolRow(page.rows);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.sequence, 2);
    assert.equal(tools[0] !== undefined && "state" in tools[0] && tools[0].state !== "active", true);
    assert.equal(
      page.rows.some((row) => row.kind === "tool" && row.sequence === 3),
      false,
    );

    const sinceStart = historyPage(await born.handle.history({ since: 2 }));
    assert.equal(
      sinceStart.rows.some((row) => row.kind === "tool"),
      false,
    );
    assert.equal(
      sinceStart.rows.some((row) => row.sequence === 3),
      false,
    );

    const beforeDone = historyPage(await born.handle.history({ before: done }));
    assert.deepEqual(
      toolRow(beforeDone.rows).map((row) => row.sequence),
      [2],
    );
    assert.equal(beforeDone.rows.filter((row) => row.kind === "tool").length, 1);
  } finally {
    born.holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("forward history reports a pruned interval after its cursor", async () => {
  const history = selectHistory(
    projectTurns([activityFact(9, 1, "2026-08-08T00:00:09.000Z", { type: "note", text: "retained" })], {
      lowestRetained: 1,
      highest: 9,
    }),
    { since: 4, limit: 50 },
  );

  assert.equal(history.historyLost, true);
  assert.deepEqual(
    history.rows.map((row) => row.sequence),
    [9],
  );
});

for (const observation of ["status", "wait", "fleet"] as const) {
  test(`${observation} observes a Body that finishes between Heart read and leash probe`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-observe-end-"));
    const value = await bornHistoryHandle(root, "f0000009");
    const originalTry = HeldAkumaLeash.try;
    const target = value.allocated.paths.leash.replace(/^\/private/u, "");
    let finished = false;
    const mockedTry = t.mock.method(HeldAkumaLeash, "try", async (paths: typeof value.allocated.paths) => {
      if (!finished && paths.leash.replace(/^\/private/u, "") === target) {
        finished = true;
        await endTurn(paths, {
          turnSequence: value.turn.sequence,
          outcome: { kind: "answered", answer: "finished", session: { sessionId: "observation-fixture" } },
          completedAt: "2026-08-12T00:05:00.000Z",
        });
        await finishBodyIfIdle(paths, { sequence: value.turn.bodySequence, at: "2026-08-12T00:05:00.000Z" });
        value.holder.release();
      }
      return await originalTry(paths);
    });
    try {
      const result =
        observation === "fleet"
          ? (await (await akumaAt(root)).list()).rows.find((row) => row.id === value.allocated.id)
          : observation === "wait"
            ? await value.handle.wait(undefined, { timeoutMs: 1_000 })
            : await value.handle.status();
      assert.equal(finished, true);
      assert.equal(result?.life, "asleep");
      if (result !== undefined && "lifeAt" in result) assert.equal(result.lifeAt, "2026-08-12T00:05:00.000Z");
      if (result !== undefined && "timeline" in result) {
        assert.equal(result.timeline.kind, "idle");
        if (result.timeline.kind === "idle") assert.equal(result.timeline.outcome?.outcome.kind, "answered");
      }
    } finally {
      mockedTry.mock.restore();
      value.holder.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a failed Heart refresh releases the observation's free leash claim", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-observe-corrupt-"));
  const value = await bornHistoryHandle(root, "f000000a");
  value.holder.release();
  const originalTry = HeldAkumaLeash.try;
  const mockedTry = t.mock.method(HeldAkumaLeash, "try", async (paths: typeof value.allocated.paths) => {
    const claim = await originalTry(paths);
    if (claim !== null) writeFileSync(paths.heart, "not a database");
    return claim;
  });
  try {
    await assert.rejects(value.handle.status(), /not a database/u);
    mockedTry.mock.restore();
    assert.equal(await probeLeash(value.allocated.paths), "free");
  } finally {
    mockedTry.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});



const provider: ProviderAdapter = fixtureAdapter(async () => {
  const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
  return {
    admission: { fence: "public-fixture-turn" },
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "session" as const, coordinate: { sessionId: "public-session" } };
        yield { type: "assistant" as const, text: "working" };
        finishEvents();
      },
    },
    completion: eventsFinished.then(() => ({
      kind: "answered" as const,
      answer: "public answer",
      historyId: "public-history",
    })),
    async abort() {},
  };
});

test("turn owner folds a rejected completion while the event stream remains open", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-completion-rejection-")));
  const deferred = configureDeferredBodyEndPlugin(root);
  writeFileSync(deferred.release, "release\n");
  const { promise: completion, reject: rejectCompletion } = promiseBarrier<never>();
  const rejecting: ProviderAdapter = fixtureAdapter(async () => {
    queueMicrotask(() => rejectCompletion(new Error("completion rejected")));
    return {
      admission: { fence: "completion-rejection" },
      events: {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(() => {});
        },
      },
      completion,
      async abort() {},
    };
  });
  let driving: ReturnType<typeof driveAkumaBody> | undefined;
  try {
    const world = await World.at(root);
    const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "deadbeef" });
    await initializeHeart(allocated.paths);
    driving = driveAkumaBody(claudeBodyLaunch(allocated, world, "work"), rejecting, {
      now: () => "2026-08-24T00:00:00.000Z",
    });
    void driving.catch(() => undefined);
    await waitForFile(deferred.turnStarted);
    assert.equal(existsSync(deferred.turnSettled), false);
    const rows = (await activitySlice(allocated.paths)).rows;
    const outcome = rows.find((row) => row.kind === "turn-end");
    assert.ok(outcome, JSON.stringify(rows));
    assert.deepEqual(outcome.outcome, { kind: "failed", diagnostic: "completion rejected" });
  } finally {
    writeFileSync(deferred.turnRelease, "release\n");
    await driving;
    await waitForFile(deferred.turnSettled);
    rmSync(root, { recursive: true, force: true });
  }
});

async function answeredSource(root: string, suffix: string, readonly?: Soul["readonly"]) {
  const world = await World.at(root);
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        description: "Fork source",
        provider: CLAUDE_EXECUTION,
        options: { model: "fixture-model", ...(readonly === undefined ? {} : { readonly: true }) },
        ...(readonly === undefined ? {} : { readonly }),
        origin: { kind: "direct" },
        allowed: [],
        cwd: world,
      },
      initialBody: "work",
    },
    provider,
    {
      now: () => "2026-08-08T00:00:00.000Z",
    },
  );
  return allocated;
}

type MutableProvider = {
  -readonly [Key in keyof ProviderAdapter]: ProviderAdapter[Key] | undefined;
};

function snapshot(
  ledger: TurnLedger,
  budget?: Readonly<{ tail: number; voice?: number }>,
  aperture: "monitoring" | "receipt" = "receipt",
): ActivitySnapshot {
  return selectSnapshot(ledger, { aperture, ...(budget === undefined ? {} : { budget }) }).snapshot;
}

test("snapshot selects one current focus while history keeps honest tool lifecycle", () => {
  const facts: readonly TimelineFact[] = [
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", {
      type: "tool",
      phase: "started",
      id: "old",
      name: "Bash",
      call: { kind: "run", command: "old" },
    }),
    turnEndFact(3, 1, "2026-08-10T00:00:03.000Z", {
      kind: "answered",
      answer: "old answer",
      session: { sessionId: "session" },
    }),
    { kind: "turn-start" as const, sequence: 4, bodySequence: 1, startedAt: "2026-08-10T00:00:04.000Z" },
    { kind: "call" as const, sequence: 5, turnSequence: 4, at: "2026-08-10T00:00:04.000Z", body: "current" },
    activityFact(6, 4, "2026-08-10T00:00:05.000Z", { type: "note", text: "checking" }),
    {
      kind: "tell" as const,
      sequence: 7,
      id: "tell-1",
      body: "new direction",
      recordedAt: "2026-08-10T00:00:06.000Z",
      state: "pending" as const,
      deliveries: [],
    },
    activityFact(8, 4, "2026-08-10T00:00:07.000Z", {
      type: "tool",
      phase: "started",
      id: "current",
      name: "Search",
      call: { kind: "search", query: "TODO" },
    }),
  ];
  const ledger = projectTurns(facts);
  const selected = snapshot(ledger, { tail: 1 });
  assert.ok(selected.kind === "open", "expected selected.kind = \"open\"");
  assert.deepEqual(
    selected.entries.map((entry) => (entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence)),
    [5, 6, 7, 8],
  );
  assert.equal(selected.omitted, 0);
  assert.equal(
    selected.entries.some((entry) => entry.kind === "row" && entry.row.kind === "tool" && entry.row.state === "active"),
    true,
  );
  assert.equal(
    selected.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 2),
    false,
  );
  assert.equal(
    ledger.rows.some((row) => row.kind === "tool" && row.sequence === 2 && row.state === "unsettled"),
    true,
  );
  assert.equal(
    ledger.rows.some((row) => row.kind === "tool" && row.sequence === 8 && row.state === "active"),
    true,
  );
  assert.equal(ledger.turns[0]?.kind, "closed");
  assert.equal(ledger.turns[1]?.kind, "open");
  assert.equal(
    ledger.openTurn?.rows.some((row) => row.kind === "tool" && row.state === "active"),
    true,
  );

  const closed = projectTurns([
    ...facts,
    activityFact(9, 4, "2026-08-10T00:00:08.000Z", { type: "assistant", text: "done" }),
    turnEndFact(10, 4, "2026-08-10T00:00:09.000Z", {
      kind: "answered",
      answer: "done",
      session: { sessionId: "session" },
    }),
  ]);
  const idle = snapshot(closed);
  assert.ok(idle.kind === "idle", "expected idle.kind = \"idle\"");
  assert.equal(idle.outcome?.outcome.kind, "answered");
  assert.deepEqual(
    idle.entries.map((entry) => (entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence)),
    [7],
  );
  assert.equal(
    closed.rows.some((row) => row.kind === "said" && row.sequence === 9),
    false,
  );
  assert.equal(
    closed.rows.some((row) => row.kind === "tool" && row.sequence === 8 && row.state === "unsettled"),
    true,
  );
  assert.equal(closed.turns[1]?.kind, "closed");
  if (closed.turns[1]?.kind === "closed") {
    assert.equal(
      closed.turns[1].rows.some((row) => row.kind === "tool" && row.state === "unsettled"),
      true,
    );
  }

  const mixedLedger = projectTurns([
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", {
      type: "tool",
      phase: "started",
      id: "abandoned",
      name: "Bash",
      call: { kind: "run", command: "old" },
    }),
    { kind: "turn-start", sequence: 3, bodySequence: 2, startedAt: "2026-08-10T00:00:03.000Z" },
    turnEndFact(4, 3, "2026-08-10T00:00:04.000Z", { kind: "failed", diagnostic: "latest failed" }),
  ]);
  assert.equal(mixedLedger.turns[0]?.kind, "open");
  assert.equal(mixedLedger.turns[1]?.kind, "closed");
  assert.equal(mixedLedger.openTurn, undefined);
  assert.equal(
    mixedLedger.rows.some((row) => row.kind === "tool" && row.sequence === 2 && row.state === "active"),
    true,
  );
  assert.equal(snapshot(mixedLedger).kind, "idle");
});

function snapshotSequences(snapshot: ActivitySnapshot): readonly (number | `gap:${number}`)[] {
  return snapshot.entries.map((entry) => (entry.kind === "gap" ? (`gap:${entry.count}` as `gap:${number}`) : entry.row.sequence));
}

test("open snapshots retain one current-Turn opening input outside the ordinary budget", () => {
  const callLedger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "call" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", body: "earlier" },
    turnEndFact(3, 1, "2026-08-10T00:00:03.000Z", {
      kind: "answered",
      answer: "earlier",
      session: { sessionId: "earlier" },
    }),
    { kind: "turn-start" as const, sequence: 4, bodySequence: 1, startedAt: "2026-08-10T00:00:04.000Z" },
    { kind: "call" as const, sequence: 5, turnSequence: 4, at: "2026-08-10T00:00:05.000Z", body: "current" },
    activityFact(6, 4, "2026-08-10T00:00:06.000Z", { type: "assistant", text: "one" }),
    activityFact(7, 4, "2026-08-10T00:00:07.000Z", { type: "thought", text: "two" }),
    activityFact(8, 4, "2026-08-10T00:00:08.000Z", { type: "note", text: "three" }),
    activityFact(9, 4, "2026-08-10T00:00:09.000Z", { type: "assistant", text: "four" }),
    activityFact(10, 4, "2026-08-10T00:00:10.000Z", { type: "thought", text: "five" }),
    activityFact(11, 4, "2026-08-10T00:00:11.000Z", { type: "note", text: "six" }),
  ]);
  const zero = selectSnapshot(callLedger, { aperture: "receipt", budget: { tail: 0, voice: 0 } });
  assert.equal(zero.snapshot.kind, "open");
  if (zero.snapshot.kind === "open") {
    assert.equal(zero.snapshot.openingSequence, 5);
    assert.deepEqual(snapshotSequences(zero.snapshot), [5, 6, "gap:2", 9, "gap:2"]);
    assert.equal(zero.snapshot.omitted, 4);
  }
  assert.equal(zero.ordinaryCount, 0);

  const defaultBudget = selectSnapshot(callLedger, { aperture: "receipt" });
  assert.equal(defaultBudget.snapshot.kind, "open");
  if (defaultBudget.snapshot.kind === "open") {
    assert.equal(defaultBudget.snapshot.openingSequence, 5);
    assert.equal(snapshotSequences(defaultBudget.snapshot).filter((sequence) => sequence === 5).length, 1);
    assert.equal(snapshotSequences(defaultBudget.snapshot).includes(2), false);
  }
  assert.equal(defaultBudget.ordinaryCount, 4);
});

test("open snapshots protect every settled say and file change at zero budget", () => {
  const completedTool = (sequence: number, id: string, call: ToolCall) =>
    activityFact(sequence, 1, `2026-08-10T00:00:${String(sequence).padStart(2, "0")}.000Z`, {
      type: "tool",
      phase: "completed",
      id,
      name: "tool",
      call,
      result: { status: "ok" },
    });
  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "call" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", body: "current" },
    completedTool(3, "ordinary-1", { kind: "run", command: "ordinary-1" }),
    activityFact(4, 1, "2026-08-10T00:00:04.000Z", { type: "assistant", text: "say one" }),
    completedTool(5, "file-1", { kind: "fileChange", changes: [{ op: "update", path: "src/one.ts" }] }),
    completedTool(6, "ordinary-2", { kind: "run", command: "ordinary-2" }),
    activityFact(7, 1, "2026-08-10T00:00:07.000Z", { type: "assistant", text: "say two" }),
    completedTool(8, "file-2", { kind: "fileChange", changes: [{ op: "update", path: "src/two.ts" }] }),
  ]);
  const selected = selectSnapshot(ledger, { aperture: "monitoring", budget: { tail: 0, voice: 0 } });

  assert.equal(selected.snapshot.kind, "open");
  if (selected.snapshot.kind === "open") {
    assert.deepEqual(snapshotSequences(selected.snapshot), [2, "gap:1", 4, 5, "gap:1", 7, 8]);
    assert.equal(selected.snapshot.omitted, 2);
  }
  assert.equal(selected.ordinaryCount, 0);
});

test("open snapshots select the retained launch Tell only without a current-Turn call", () => {
  const facts: readonly TimelineFact[] = [
    {
      kind: "tell",
      sequence: 1,
      id: "opening",
      body: "wake this Turn",
      recordedAt: "2026-08-10T00:00:01.000Z",
      state: "told",
      deliveries: [
        { route: "launch", turnSequence: 4, deliveredAt: "2026-08-10T00:00:02.000Z" },
      ],
    },
    {
      kind: "tell",
      sequence: 2,
      id: "later-launch",
      body: "also at launch",
      recordedAt: "2026-08-10T00:00:02.000Z",
      state: "told",
      deliveries: [
        { route: "launch", turnSequence: 4, deliveredAt: "2026-08-10T00:00:03.000Z" },
      ],
    },
    { kind: "turn-start", sequence: 4, bodySequence: 1, startedAt: "2026-08-10T00:00:04.000Z" },
    activityFact(5, 4, "2026-08-10T00:00:05.000Z", { type: "assistant", text: "working" }),
    {
      kind: "tell",
      sequence: 6,
      id: "other-turn",
      body: "old launch",
      recordedAt: "2026-08-10T00:00:06.000Z",
      state: "told",
      deliveries: [
        { route: "launch", turnSequence: 1, deliveredAt: "2026-08-10T00:00:06.000Z" },
      ],
    },
    {
      kind: "tell",
      sequence: 7,
      id: "live",
      body: "steer current work",
      recordedAt: "2026-08-10T00:00:07.000Z",
      state: "told",
      deliveries: [
        { route: "live", turnSequence: 4, receipt: "required", deliveredAt: "2026-08-10T00:00:07.000Z" },
      ],
    },
    activityFact(8, 4, "2026-08-10T00:00:08.000Z", { type: "note", text: "still working" }),
  ];
  const launch = selectSnapshot(projectTurns(facts), { aperture: "receipt", budget: { tail: 0, voice: 0 } });
  assert.equal(launch.snapshot.kind, "open");
  if (launch.snapshot.kind === "open") {
    assert.equal(launch.snapshot.openingSequence, 1);
    assert.deepEqual(snapshotSequences(launch.snapshot), [1, "gap:1", 5, "gap:2"]);
    assert.equal(launch.snapshot.entries.filter((entry) => entry.kind === "row" && entry.row.sequence === 1).length, 1);
    assert.equal(launch.snapshot.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 6), false);
    assert.equal(launch.snapshot.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 7), false);
    assert.equal(launch.snapshot.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 2), false);
  }

  const callWins = selectSnapshot(
    projectTurns([
      {
        kind: "tell" as const,
        sequence: 1,
        id: "launch",
        body: "launch input",
        recordedAt: "2026-08-10T00:00:01.000Z",
        state: "told" as const,
        deliveries: [{ route: "launch" as const, turnSequence: 2, deliveredAt: "2026-08-10T00:00:01.000Z" }],
      },
      { kind: "turn-start" as const, sequence: 2, bodySequence: 1, startedAt: "2026-08-10T00:00:02.000Z" },
      { kind: "call" as const, sequence: 3, turnSequence: 2, at: "2026-08-10T00:00:03.000Z", body: "call wins" },
    ]),
    { aperture: "receipt", budget: { tail: 0, voice: 0 } },
  ).snapshot;
  assert.equal(callWins.kind, "open");
  if (callWins.kind === "open") assert.equal(callWins.openingSequence, 3);

  const liveOnly = selectSnapshot(
    projectTurns(facts.filter((fact) => fact.kind !== "tell" || fact.id === "other-turn" || fact.id === "live")),
    { aperture: "receipt", budget: { tail: 0, voice: 0 } },
  ).snapshot;
  assert.equal(liveOnly.kind, "open");
  if (liveOnly.kind === "open") assert.equal(liveOnly.openingSequence, undefined);
});

test("opening input composes with existing actionable and receipt pins without a second copy", () => {
  const ledger = projectTurns([
    {
      kind: "tell" as const,
      sequence: 1,
      id: "opening",
      body: "wake this Turn",
      recordedAt: "2026-08-10T00:00:01.000Z",
      state: "told" as const,
      deliveries: [{ route: "launch" as const, turnSequence: 2, deliveredAt: "2026-08-10T00:00:01.000Z" }],
    },
    { kind: "turn-start" as const, sequence: 2, bodySequence: 1, startedAt: "2026-08-10T00:00:02.000Z" },
    activityFact(3, 2, "2026-08-10T00:00:03.000Z", { type: "assistant", text: "one" }),
    activityFact(4, 2, "2026-08-10T00:00:04.000Z", { type: "note", text: "two" }),
    activityFact(5, 2, "2026-08-10T00:00:05.000Z", {
      type: "tool",
      phase: "started",
      id: "active",
      name: "Search",
      call: { kind: "search", query: "TODO" },
    }),
    { kind: "tell" as const, sequence: 6, id: "pending", body: "keep going", recordedAt: "2026-08-10T00:00:06.000Z", state: "pending" as const, deliveries: [] },
    {
      kind: "tell" as const,
      sequence: 7,
      id: "receipt",
      body: "receipt evidence",
      recordedAt: "2026-08-10T00:00:07.000Z",
      state: "told" as const,
      deliveries: [{ route: "live" as const, turnSequence: 2, receipt: "required" as const, deliveredAt: "2026-08-10T00:00:07.000Z" }],
    },
  ]);
  const monitoring = selectSnapshot(ledger, { aperture: "monitoring", budget: { tail: 0, voice: 0 } });
  assert.equal(monitoring.snapshot.kind, "open");
  if (monitoring.snapshot.kind === "open") {
    assert.equal(monitoring.snapshot.openingSequence, 1);
    assert.deepEqual(snapshotSequences(monitoring.snapshot), [1, 3, "gap:1", 5, 6, "gap:1"]);
  }
  assert.equal(monitoring.ordinaryCount, 0);
  const budgeted = selectSnapshot(ledger, { aperture: "monitoring", budget: { tail: 1, voice: 0 } });
  assert.equal(budgeted.snapshot.kind, "open");
  if (budgeted.snapshot.kind === "open")
    assert.deepEqual(snapshotSequences(budgeted.snapshot), [1, 3, "gap:1", 5, 6, 7]);
  assert.equal(budgeted.ordinaryCount, 1);
  const receipt = selectSnapshot(ledger, {
    aperture: "receipt",
    admittedTellId: "receipt",
    budget: { tail: 0, voice: 0 },
  }).snapshot;
  assert.equal(receipt.kind, "open");
  if (receipt.kind === "open") {
    assert.equal(receipt.openingSequence, 1);
    assert.deepEqual(snapshotSequences(receipt), [1, 3, "gap:1", 5, 7]);
    assert.equal(receipt.entries.filter((entry) => entry.kind === "row" && entry.row.sequence === 1).length, 1);
  }
});

test("opening identity is positive and names exactly one open snapshot entry", () => {
  const open = activitySnapshotSchema.parse({
    kind: "open",
    turn: { kind: "turn", sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T00:00:01.000Z" },
    entries: [
      {
        kind: "row",
        row: { kind: "call", sequence: 1, turnSequence: 1, at: "2026-08-10T00:00:01.000Z", text: "opening" },
      },
    ],
    omitted: 0,
    openingSequence: 1,
    reportedChanges: [],
    reportedChangesOmitted: 0,
  });
  assert.equal(open.kind, "open");
  assert.throws(() =>
    activitySnapshotSchema.parse({
      kind: "open",
      turn: { kind: "turn", sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T00:00:01.000Z" },
      entries: [],
      omitted: 0,
      openingSequence: 1,
      reportedChanges: [],
      reportedChangesOmitted: 0,
    }),
  );
  assert.throws(() =>
    activitySnapshotSchema.parse({
      kind: "open",
      turn: { kind: "turn", sequence: 1, turnSequence: 1, bodySequence: 1, at: "2026-08-10T00:00:01.000Z" },
      entries: [
        {
          kind: "row",
          row: { kind: "call", sequence: 1, turnSequence: 1, at: "2026-08-10T00:00:01.000Z", text: "opening" },
        },
      ],
      omitted: 0,
      openingSequence: 0,
      reportedChanges: [],
      reportedChangesOmitted: 0,
    }),
  );
  assert.throws(() =>
    activitySnapshotSchema.parse({ kind: "unborn", entries: [], omitted: 0, openingSequence: 1, reportedChanges: [], reportedChangesOmitted: 0 }),
  );
  assert.throws(() =>
    activitySnapshotSchema.parse({ kind: "idle", entries: [], omitted: 0, openingSequence: 1, reportedChanges: [], reportedChangesOmitted: 0 }),
  );
});

test("reported file changes follow the open or latest closed frontier and aggregate files", () => {
  const earlierCall = { kind: "fileChange" as const, changes: [{ op: "add" as const, path: "src/earlier.ts" }] };
  const frontierCall = {
    kind: "fileChange" as const,
    changes: [
      { op: "add" as const, path: "src/created.ts", diffstat: { added: 4, removed: 0 } },
      { op: "update" as const, path: "src/repeated.ts", diffstat: { added: 2, removed: 1 } },
      { op: "delete" as const, path: "src/removed.ts", diffstat: { added: 0, removed: 3 } },
      { op: "update" as const, path: "src/unknown.ts" },
      { op: "update" as const, path: "src/repeated.ts", diffstat: { added: 1, removed: 0 } },
    ],
  };
  const failedCall = { kind: "fileChange" as const, changes: [{ op: "add" as const, path: "src/failed.ts" }] };
  const activeCall = { kind: "fileChange" as const, changes: [{ op: "delete" as const, path: "src/active.ts" }] };
  const facts = [
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "earlier",
      name: "Write",
      call: earlierCall,
    }),
    activityFact(3, 1, "2026-08-10T00:00:03.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "earlier",
      name: "Write",
      call: earlierCall,
      result: { status: "ok" as const },
    }),
    turnEndFact(4, 1, "2026-08-10T00:00:04.000Z", {
      kind: "answered" as const,
      answer: "earlier",
      session: { sessionId: "earlier" },
    }),
    { kind: "turn-start" as const, sequence: 5, bodySequence: 1, startedAt: "2026-08-10T00:00:05.000Z" },
    activityFact(6, 5, "2026-08-10T00:00:06.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "frontier",
      name: "Write",
      call: frontierCall,
    }),
    activityFact(7, 5, "2026-08-10T00:00:07.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "frontier",
      name: "Write",
      call: frontierCall,
      result: { status: "ok" as const },
    }),
    activityFact(8, 5, "2026-08-10T00:00:08.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "failed",
      name: "Write",
      call: failedCall,
    }),
    activityFact(9, 5, "2026-08-10T00:00:09.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "failed",
      name: "Write",
      call: failedCall,
      result: { status: "error" as const },
    }),
    activityFact(10, 5, "2026-08-10T00:00:10.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "active",
      name: "Write",
      call: activeCall,
    }),
    activityFact(11, 5, "2026-08-10T00:00:11.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "run",
      name: "Bash",
      call: { kind: "run" as const, command: "touch src/non-file.ts" },
    }),
    activityFact(12, 5, "2026-08-10T00:00:12.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "run",
      name: "Bash",
      call: { kind: "run" as const, command: "touch src/non-file.ts" },
      result: { status: "ok" as const },
    }),
  ];
  const reported = (view: ActivitySnapshot) =>
    view.reportedChanges.map((change) => ({
      sequence: change.sequence,
      at: change.at,
      op: change.op,
      path: change.path,
      ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }),
    }));
  const openLedger = projectTurns(facts);
  const openFrontier = openLedger.openTurn?.rows.find(
    (row) => row.kind === "tool" && row.call.kind === "fileChange" && row.sequence === 6,
  );
  assert.ok(openFrontier !== undefined && openFrontier.kind === "tool" && openFrontier.call.kind === "fileChange");
  (openFrontier.call.changes[3] as unknown as { op: "unspecified" }).op = "unspecified";

  const open = snapshot(openLedger);
  assert.equal(open.kind, "open");
  assert.deepEqual(reported(open), [
    {
      sequence: 6,
      at: "2026-08-10T00:00:06.000Z",
      op: "add",
      path: "src/created.ts",
      diffstat: { added: 4, removed: 0 },
    },
    {
      sequence: 6,
      at: "2026-08-10T00:00:06.000Z",
      op: "delete",
      path: "src/removed.ts",
      diffstat: { added: 0, removed: 3 },
    },
    { sequence: 6, at: "2026-08-10T00:00:06.000Z", op: "unspecified", path: "src/unknown.ts" },
    {
      sequence: 6,
      at: "2026-08-10T00:00:06.000Z",
      op: "update",
      path: "src/repeated.ts",
      diffstat: { added: 3, removed: 1 },
    },
  ]);
  assert.equal(open.reportedChangesOmitted, 0);

  const closedLedger = projectTurns([
    ...facts,
    turnEndFact(13, 5, "2026-08-10T00:00:13.000Z", {
      kind: "answered" as const,
      answer: "frontier",
      session: { sessionId: "frontier" },
    }),
  ]);
  const closedFrontier = closedLedger.turns.at(-1);
  assert.ok(closedFrontier?.kind === "closed");
  const closedChange = closedFrontier.rows.find(
    (row) => row.kind === "tool" && row.call.kind === "fileChange" && row.sequence === 6,
  );
  assert.ok(closedChange !== undefined && closedChange.kind === "tool" && closedChange.call.kind === "fileChange");
  (closedChange.call.changes[3] as unknown as { op: "unspecified" }).op = "unspecified";

  const idle = snapshot(closedLedger);
  assert.equal(idle.kind, "idle");
  assert.deepEqual(reported(idle), reported(open));
  assert.equal(idle.reportedChangesOmitted, 0);
});

test("reported file changes keep the newest five independently of ordinary omissions", () => {
  const firstCall = {
    kind: "fileChange" as const,
    changes: [
      { op: "add" as const, path: "src/one.ts" },
      { op: "update" as const, path: "src/two.ts" },
      { op: "delete" as const, path: "src/three.ts", diffstat: { added: 0, removed: 3 } },
    ],
  };
  const secondCall = {
    kind: "fileChange" as const,
    changes: [
      { op: "add" as const, path: "src/four.ts" },
      { op: "update" as const, path: "src/five.ts" },
      { op: "delete" as const, path: "src/six.ts" },
      { op: "add" as const, path: "src/seven.ts" },
      { op: "update" as const, path: "src/three.ts" },
    ],
  };
  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "first",
      name: "Write",
      call: firstCall,
    }),
    activityFact(3, 1, "2026-08-10T00:00:03.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "first",
      name: "Write",
      call: firstCall,
      result: { status: "ok" as const },
    }),
    activityFact(4, 1, "2026-08-10T00:00:04.000Z", { type: "note" as const, text: "ordinary one" }),
    activityFact(5, 1, "2026-08-10T00:00:05.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "second",
      name: "Write",
      call: secondCall,
    }),
    activityFact(6, 1, "2026-08-10T00:00:06.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "second",
      name: "Write",
      call: secondCall,
      result: { status: "ok" as const },
    }),
    activityFact(7, 1, "2026-08-10T00:00:07.000Z", { type: "note" as const, text: "ordinary two" }),
    activityFact(8, 1, "2026-08-10T00:00:08.000Z", { type: "note" as const, text: "ordinary three" }),
  ]);
  const view = snapshot(ledger, { tail: 0, voice: 0 });
  assert.equal(view.kind, "open");
  assert.deepEqual(
    view.reportedChanges.map((change) => change.path),
    ["src/four.ts", "src/five.ts", "src/six.ts", "src/seven.ts", "src/three.ts"],
  );
  assert.deepEqual(
    view.reportedChanges.map((change) => change.sequence),
    [5, 5, 5, 5, 5],
  );
  assert.equal(view.reportedChanges.at(-1)?.op, "update");
  assert.equal(view.reportedChanges.at(-1)?.diffstat, undefined);
  assert.equal(view.reportedChangesOmitted, 2);
  assert.equal(view.omitted, 3);
  assert.deepEqual(snapshotSequences(view), [2, "gap:1", 5, "gap:2"]);
});

test("outcome folding preserves a truncated final voice equal to the answer", () => {
  const ledger = projectTurns([
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", { type: "assistant", text: "same answer", truncated: true }),
    turnEndFact(3, 1, "2026-08-10T00:00:03.000Z", {
      kind: "answered",
      answer: "same answer",
      session: { sessionId: "session" },
    }),
  ]);

  assert.equal(
    ledger.rows.some((row) => row.kind === "said" && row.text === "same answer" && row.truncated === true),
    true,
  );
  assert.deepEqual(
    selectHistory(ledger, { limit: 50 }).rows.map((row) => row.kind),
    ["turn", "said", "outcome"],
  );
});

test("wait timeout returns the same running status carrier", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-wait-timeout-");
  const source = await answeredSource(root, "de1ad100");
  const leash = (await HeldAkumaLeash.try(source.paths))!;
  try {
    const handle = (await akumaAt(root)).of({ id: source.id });
    const expected = await handle.status();
    assert.equal(expected.life, "running");
    assert.deepEqual(await handle.wait(undefined, { timeoutMs: 0 }), expected);
  } finally {
    leash.release();
  }
});

test("an answered Turn without a fork point remains visible and keeps its answer", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-no-fork-point-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a10006" });
  await initializeHeart(allocated.paths);
  const noPointProvider: ProviderAdapter = fixtureAdapter(async () => {
    const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
    return {
      admission: { fence: "no-point-turn" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "no-point-session" } };
          finishEvents();
        },
      },
      completion: eventsFinished.then(() => ({
        kind: "answered" as const,
        answer: "complete without fork",
      })),
      async abort() {},
    };
  });
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        description: "No fork point",
        provider: CLAUDE_EXECUTION,
        options: { model: "fixture-model" },
        origin: { kind: "direct" },
        allowed: [],
        cwd: root,
      },
      initialBody: "work",
    },
    noPointProvider,
    {
      now: () => "2026-08-08T00:00:00.000Z",
    },
  );

  const handle = (await akumaAt(root)).of({ id: allocated.id });
  assert.deepEqual(await handle.lastAnswer(), { kind: "answer", answer: "complete without fork" });
  assert.deepEqual(historyPage(await handle.history()).rows.find((row) => row.kind === "outcome")?.outcome, {
    kind: "answered",
    historyId: "turn/1",
    answer: "complete without fork",
  });
  const exact = await handle.history({ id: "turn/1" });
  if (!("kind" in exact) || exact.kind !== "exact") throw new Error("expected exact history");
  assert.deepEqual(await handle.fork({ at: "missing-point" }), { kind: "unknown-history", at: "missing-point" });
});

test("fork preserves the exact admitted readonly restraint byte-for-byte", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-restraint-"));
  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  const deferred = configureDeferredBodyEndPlugin(root);
  let sourcePromise: Promise<Awaited<ReturnType<typeof answeredSource>>> | undefined;
  let forkPromise: Promise<Awaited<ReturnType<AkumaHandle["fork"]>>> | undefined;
  try {
    let sourceSettled = false;
    sourcePromise = answeredSource(root, "f0a10007", { enforcement: "native" }).then((source) => {
      sourceSettled = true;
      return source;
    });
    await waitForFile(deferred.turnStarted);
    await Promise.resolve();
    assert.equal(sourceSettled, false);
    writeFileSync(deferred.turnRelease, "release\n");
    await waitForFile(deferred.started);
    await Promise.resolve();
    assert.equal(sourceSettled, false);
    assert.equal(
      await probeLeash(akumaPaths({ runRoot: akumaRunRoot(root), archetype: "claude", suffix: "f0a10007" })),
      "free",
    );
    writeFileSync(deferred.release, "release\n");
    const source = await sourcePromise;
    await waitForFile(deferred.settled);
    await waitForFile(deferred.turnSettled);
    assert.equal(existsSync(join(root, ".square", "KEIYAKU.square")), true);
    mutable.fork = () =>
      createProviderAttempt(undefined, async () => ({ session: { sessionId: "fork-restraint-child" } }));
    const world = await akumaAt(root);
    unlinkSync(deferred.started);
    unlinkSync(deferred.release);
    unlinkSync(deferred.settled);
    unlinkSync(deferred.turnStarted);
    unlinkSync(deferred.turnRelease);
    forkPromise = world.of({ id: source.id }).fork({ at: "turn/1" });
    await waitForFile(deferred.started);
    const childRows = (await world.list()).rows.filter((row) => row.id !== source.id);
    assert.equal(childRows.length, 1);
    assert.equal(await probeLeash(pathsForAkuId(root, childRows[0]!.id)), "free");
    writeFileSync(deferred.release, "release\n");
    const receipt = await forkPromise;
    await waitForFile(deferred.settled);
    assert.ok(receipt.kind === "forked", JSON.stringify(receipt));
    const child = world.of({ id: receipt.child });
    assert.deepEqual((await readHeart(pathsForAkuId(root, receipt.child))).soul?.readonly, { enforcement: "native" });
    assert.equal((await child.status()).readonly?.enforcement, "native");
  } finally {
    mutable.fork = originalFork;
    writeFileSync(deferred.release, "release\n");
    writeFileSync(deferred.turnRelease, "release\n");
    await sourcePromise?.catch(() => undefined);
    await forkPromise?.catch(() => undefined);
    if (existsSync(deferred.started)) await waitForFile(deferred.settled).catch(() => undefined);
    if (existsSync(deferred.turnStarted)) await waitForFile(deferred.turnSettled).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
});

test("fork preserves categorical, exact-history, native, local, and not-born failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-results-"));
  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    const source = await answeredSource(root, "f0a10002");
    const handle = (await akumaAt(root)).of({ id: source.id });

    delete mutable.fork;
    assert.deepEqual(await handle.fork({ at: "missing" }), { kind: "provider-cannot-fork", provider: "claude" });

    let nativeCalls = 0;
    mutable.fork = () =>
      createProviderAttempt(undefined, async () => {
        nativeCalls += 1;
        throw new Error("native refused");
      });
    assert.deepEqual(await handle.fork({ at: "missing" }), { kind: "unknown-history", at: "missing" });
    assert.equal(nativeCalls, 0);
    assert.deepEqual(await handle.fork({ at: "turn/1" }), { kind: "fork-failed", diagnostic: "native refused" });

    mutable.fork = () =>
      createProviderAttempt(undefined, async () => {
        const runRoot = akumaRunRoot(root);
        rmSync(runRoot, { recursive: true, force: true });
        writeFileSync(runRoot, "blocked");
        return { session: { sessionId: "orphan-upstream-session" } };
      });
    const partial = await handle.fork({ at: "turn/1" });
    assert.equal(partial.kind, "upstream-forked");
    if (partial.kind === "upstream-forked") {
      assert.deepEqual(partial.childSession, { sessionId: "orphan-upstream-session" });
      assert.match(partial.diagnostic, /exist|directory|not a directory/i);
    }

    const unbornRoot = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-unborn-"));
    try {
      const unborn = await allocateAkumaDirectory({
        worldRoot: unbornRoot,
        archetype: "claude",
        draw: () => "f0a10003",
      });
      await assert.rejects(
        (await akumaAt(unbornRoot)).of({ id: unborn.id }).fork({ at: "anything" }),
        AkumaNotBornError,
      );
    } finally {
      rmSync(unbornRoot, { recursive: true, force: true });
    }
  } finally {
    mutable.fork = originalFork;
    rmSync(root, { recursive: true, force: true });
  }
});

test("public Akuma handles separate compact list rows from full status and wait", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-public-");
  const world = await akumaAt(root);
  assert.deepEqual((await world.list()).rows, []);
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
  await initializeHeart(allocated.paths);
  assert.equal((await world.list()).rows[0]?.life, "unborn");
  assert.equal((await world.list({ archetype: "claude" })).rows[0]?.id, allocated.id);
  assert.deepEqual((await world.list({ archetype: "reviewer" })).rows, []);
  await assert.rejects(world.list({ archetype: "not/a-name" }), /Akuma name/);
  await assert.rejects(world.list({ unknown: true } as never), /unknown field: unknown/);

  const launch: BodyLaunch = {
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      description: "Fixture akuma",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      allowed: [],
      cwd: root,
    },
    initialBody: "work",
  };
  await driveAkumaBody(launch, provider, {
    now: () => "2026-08-08T00:00:00.000Z",
  });

  const handle = world.of({ id: allocated.id });
  const listed = (await world.list()).rows[0]!;
  assert.equal(listed.life, "asleep");
  assert.equal("lifeAt" in listed && listed.lifeAt, "2026-08-08T00:00:00.000Z");
  assert.equal("history" in listed, false);
  assert.equal("answer" in listed, false);
  assert.equal(listed.archetype, "claude");
  assert.equal(listed.description, "Fixture akuma");
  assert.deepEqual(listed.pending, []);
  const status = await handle.status();
  assert.equal(status.life, "asleep");
  assert.equal("archetype" in status, false);
  assert.equal("description" in status, false);
  assert.equal("pending" in status, false);
  assert.equal(status.timeline.kind, "idle");
  assert.equal(status.timeline.kind === "idle" && status.timeline.outcome?.outcome.kind === "answered", true);
  assert.equal(status.timeline.kind === "idle" && status.timeline.outcome?.outcome.historyId, "turn/1");
  assert.equal("history" in status, false);
  assert.deepEqual(historyPage(await handle.history()).rows.find((row) => row.kind === "outcome")?.outcome, {
    kind: "answered",
    answer: "public answer",
    historyId: "turn/1",
  });
  const exact = await handle.history({ id: "turn/1" });
  if (!("kind" in exact) || exact.kind !== "exact") throw new Error("expected exact history");
  assert.deepEqual(exact.outcome.outcome, { kind: "answered", answer: "public answer", historyId: "turn/1" });
  assert.equal(status.timeline.entries.length, 0);
  assert.deepEqual(
    await handle.wait(
      (candidate) => candidate.timeline.kind === "idle" && candidate.timeline.outcome?.outcome.kind === "answered",
    ),
    status,
  );
  assert.equal(await handle.kill(), "already-stopped");
  assert.equal((await handle.status()).life, "asleep");
  const finalStatus = await handle.status();
  assert.equal(
    finalStatus.timeline.kind === "idle" && finalStatus.timeline.outcome?.outcome.kind === "answered",
    true,
  );
  assert.equal(await handle.kill(), "already-stopped");
  assert.equal(await pauseRequested(allocated.paths), false);
  assert.deepEqual((await timeline(allocated.paths)).find((fact) => fact.kind === "turn-end")?.outcome, {
    kind: "answered",
    answer: "public answer",
    historyId: "public-history",
    session: { sessionId: "public-session" },
  });
});

test("kill returns before its successor recovery settles", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-recovery-fire-and-forget-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0010" });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  await holder.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: CLAUDE_EXECUTION,
    options: {},
    origin: { kind: "direct" },
    allowed: [],
    cwd: root,
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  const body = await holder.recordBody(allocated.paths, { leashTakenAt: "2026-08-10T00:00:00.000Z" });
  await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: "2026-08-10T00:00:01.000Z" });
  await recordTell(allocated.paths, {
    kind: "tell",
    id: "kill-recovery-pending",
    body: "continue",
    recordedAt: "2026-08-10T00:00:02.000Z",
  });
  holder.release();

  let recoveryReleased!: () => void;
  let recoverySettled = false;
  const recovery = new Promise<void>((resolve) => {
    recoveryReleased = () => {
      recoverySettled = true;
      resolve();
    };
  });
  assert.equal(await killAkumaWithRecovery(allocated.paths, async () => await recovery), "killed");
  assert.equal(recoverySettled, false);
  recoveryReleased();
  await recovery;
});

test("failed kill recovery leaves its pending Tell unchanged", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-recovery-failure-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0011" });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  await holder.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: CLAUDE_EXECUTION,
    options: {},
    origin: { kind: "direct" },
    allowed: [],
    cwd: root,
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  const body = await holder.recordBody(allocated.paths, { leashTakenAt: "2026-08-10T00:00:00.000Z" });
  await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: "2026-08-10T00:00:01.000Z" });
  await recordTell(allocated.paths, {
    kind: "tell",
    id: "kill-recovery-failure",
    body: "continue",
    recordedAt: "2026-08-10T00:00:02.000Z",
  });
  holder.release();
  assert.equal(
    await killAkumaWithRecovery(allocated.paths, async () => {
      throw new Error("spawn denied");
    }),
    "killed",
  );
  assert.deepEqual(
    (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
    ["kill-recovery-failure"],
  );
});

test("kill settles a stranded dead Body and later observation presents the killed life", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-stranded-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0012" });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  await holder.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: CLAUDE_EXECUTION,
    options: {},
    origin: { kind: "direct" },
    allowed: [],
    cwd: root,
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  const body = await holder.recordBody(allocated.paths, { leashTakenAt: "2026-08-10T00:00:00.000Z" });
  await breakBody(allocated.paths, { sequence: body.sequence, end: "broke-off", at: "2026-08-10T00:00:01.000Z" });
  holder.release();

  const world = await akumaAt(root);
  const handle = world.of({ id: allocated.id });
  assert.equal((await handle.status()).life, "stranded");
  assert.equal(await handle.kill(), "killed");
  const status = await handle.status();
  assert.equal(status.life, "killed");
  assert.equal("strandedReason" in status, false);
  const listed = (await world.list()).rows.find((row) => row.id === allocated.id);
  assert.equal(listed !== undefined && "life" in listed && listed.life, "killed");
  assert.equal(await handle.kill(), "already-killed");
});

test("interrupt records a tell only after taking an idle leash", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-idle-");
  const seat = join(root, "seat");
  mkdirSync(seat);
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0001" });
  await initializeHeart(allocated.paths);
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        allowed: [],
        cwd: seat,
      },
      initialBody: "first",
    },
    provider,
    {
      now: () => "2026-08-08T00:00:00.000Z",
    },
  );
  rmSync(seat, { recursive: true, force: true });

  const handle = (await akumaAt(root)).of({ id: allocated.id });
  const receipt = await handle.interrupt("next");
  assert.equal(receipt.kind, "interrupted");
  if (receipt.kind !== "interrupted" || "kind" in receipt.tell) return;
  assert.equal(receipt.putDown, "was-idle");
  assert.equal(typeof receipt.tell.wake, "object");
  assert.equal(await pauseRequested(allocated.paths), false);
  assert.deepEqual(
    (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
    [receipt.tell.admission.tellId],
  );
  if (receipt.tell.wake.kind === "pursuing") {
    await handle.kill();
    await handle.wait();
  }
});

test("interrupt waits for leash release after a durable Body end beyond the default retry window", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-ended-held-"));
  let releaseHolder: (() => void) | undefined;
  let operation: ReturnType<AkumaHandle["interrupt"]> | undefined;
  let restoreTry: (() => void) | undefined;
  try {
    const value = await bornHistoryHandle(root, "1d1e0009");
    releaseHolder = value.holder.release.bind(value.holder);
    await breakBody(value.allocated.paths, {
      sequence: value.turn.bodySequence,
      end: "put-down",
      at: "2026-08-08T00:00:02.000Z",
    });
    const runtime = {
      async spawn(paths: typeof value.allocated.paths): Promise<OwnedProcess> {
        return {
          pid: 0,
          exited: Promise.resolve({ code: 0, signal: null, log: { path: paths.log, from: 0, to: 0 } }),
          async terminate() {},
          release() {},
        };
      },
    };
    let failedTries = 0;
    let acquireRetryObserved = false;
    const targetLeash = value.allocated.paths.leash.replace(/^\/private/u, "");
    const { promise: retryObserved, resolve: witnessRetry } = promiseBarrier<void>();
    const originalTry = HeldAkumaLeash.try;
    const mockedTry = t.mock.method(HeldAkumaLeash, "try", async (paths: typeof value.allocated.paths) => {
      const leash = await originalTry(paths);
      if (paths.leash.replace(/^\/private/u, "") === targetLeash && leash === null) {
        failedTries += 1;
        if (failedTries === 3) acquireRetryObserved = true;
        if (failedTries === 13) witnessRetry();
      }
      return leash;
    });
    restoreTry = () => mockedTry.mock.restore();
    operation = value.handle.interrupt("after end", { runtime });
    const first = await Promise.race([
      retryObserved.then(() => "retry" as const),
      operation.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
    ]);
    assert.equal(first, "retry", `failed leash tries: ${failedTries}`);
    assert.equal(acquireRetryObserved, true);
    releaseHolder?.();
    releaseHolder = undefined;
    const receipt = await operation;
    assert.equal(receipt.kind, "interrupted");
    if (receipt.kind === "interrupted") assert.equal(receipt.putDown, "was-idle");
  } finally {
    restoreTry?.();
    releaseHolder?.();
    await operation?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt caller cancellation stops waiting without manufacturing control evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-cancelled-"));
  let releaseHolder: (() => void) | undefined;
  try {
    const value = await bornHistoryHandle(root, "1d1e000a");
    releaseHolder = value.holder.release.bind(value.holder);
    const controller = new AbortController();
    const operation = value.handle.interrupt("cancelled", { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("caller stopped waiting")), 20);
    await assert.rejects(operation, /caller stopped waiting/u);
    assert.equal(await pauseRequested(value.allocated.paths), true);
    assert.deepEqual((await readHeart(value.allocated.paths)).pending, []);
    releaseHolder?.();
    releaseHolder = undefined;
  } finally {
    releaseHolder?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt reports untidy when a free leash has no clean Body settlement", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-unstoppable-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0003" });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  await holder.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: CLAUDE_EXECUTION,
    options: {},
    origin: { kind: "direct" },
    allowed: [],
    cwd: root,
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  await holder.recordBody(allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
  holder.release();
  assert.deepEqual(await (await akumaAt(root)).of({ id: allocated.id }).interrupt("never recorded"), {
    kind: "unavailable",
    evidence: "untidy",
  });
  assert.equal(await pauseRequested(allocated.paths), false);
  assert.deepEqual((await readHeart(allocated.paths)).pending, []);
});

test("interrupt reports hung when the Body does not release its held leash", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-held-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0005" });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  await holder.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: CLAUDE_EXECUTION,
    options: {},
    origin: { kind: "direct" },
    allowed: [],
    cwd: root,
    createdAt: "2026-08-08T00:00:00.000Z",
  });
  const body = await holder.recordBody(allocated.paths, {
    leashTakenAt: "2026-08-08T00:00:00.000Z",
  });
  await holder.recordBodyHung(allocated.paths, {
    sequence: body.sequence,
    diagnostic: "provider custody remained live",
    at: "2026-08-08T00:00:01.000Z",
  });
  await breakBody(allocated.paths, {
    sequence: body.sequence,
    end: "broke-off",
    at: "2026-08-08T00:00:02.000Z",
  });
  try {
    const handle = (await akumaAt(root)).of({ id: allocated.id });
    assert.deepEqual(await handle.interrupt("never recorded"), {
      kind: "unavailable",
      evidence: "hung",
    });
    assert.equal((await handle.status()).life, "hung");
    assert.equal(await pauseRequested(allocated.paths), true);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    holder.release();
    assert.deepEqual(await handle.interrupt("still never recorded"), {
      kind: "unavailable",
      evidence: "hung",
    });
    assert.equal((await handle.status()).life, "hung");
    assert.equal(await pauseRequested(allocated.paths), false);
  } finally {
    holder.release();
  }
});

test("kill returns unavailable when an unsettled Body keeps the leash", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-kill-held-"));
  const value = await bornHistoryHandle(root, "1d1e0008");
  try {
    const started = performance.now();
    assert.equal(await value.handle.kill(), "unavailable");
    assert.ok(performance.now() - started < 3_000);
  } finally {
    value.holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Project Archetype definitions shadow Home while Home remains the fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-project-archetypes-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-project-archetypes-home-"));
  try {
    mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
    mkdirSync(join(home, "akuma"));
    writeFileSync(join(root, ".keiyaku", "akuma", "project-only.md"), "---\nprovider: claude\n---\nProject only.\n");
    writeFileSync(join(home, "akuma", "home-only.md"), "---\nprovider: claude\n---\nHome only.\n");
    writeFileSync(
      join(root, ".keiyaku", "akuma", "shared.md"),
      "---\nprovider: claude\ndescription: Project\n---\nProject body.\n",
    );
    writeFileSync(join(home, "akuma", "shared.md"), "---\nprovider: claude\ndescription: Home\n---\nHome body.\n");

    const settingsValue = await settings({ root, home });
    const world = await akumaAt(root, { home, settings: settingsValue });
    assert.deepEqual(await world.listArchetypes(), ["home-only", "project-only", "shared"]);

    const catalog = await Keiyaku.ls({ query: { kind: "archetypes" }, path: await World.at(root), home });
    assert.deepEqual(catalog, {
      kind: "archetypes",
      rows: [{ name: "home-only" }, { name: "project-only" }, { name: "shared", description: "Project" }],
    });

    const parsed = parseArgv(["-C", root, "ls", "aku/"]);
    if (!("command" in parsed)) throw new Error("expected parsed ls command");
    const cli = await invoke(parsed, {
      environment: { KEIYAKU_HOME: home },
    });
    assert.deepEqual(cli, { kind: "catalog", catalog });

    const shared = await loadArchetype({ name: "shared", project: root, home, settings: settingsValue });
    assert.equal(shared.path, join(root, ".keiyaku", "akuma", "shared.md"));
    assert.equal(shared.description, "Project");
    const fallback = await loadArchetype({ name: "home-only", project: root, home, settings: settingsValue });
    assert.equal(fallback.path, join(home, "akuma", "home-only.md"));

    await assert.rejects(
      loadArchetype({ name: "missing", project: root, home, settings: settingsValue }),
      (error: unknown) =>
        error instanceof AkumaArchetypeError &&
        error.searched.join("\n") ===
          [join(root, ".keiyaku", "akuma", "missing.md"), join(home, "akuma", "missing.md")].join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("list silently skips identities whose compact row cannot be read", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-list-schema-cut-");
  const heartCut = await allocateAkumaDirectory({
    worldRoot: root,
    archetype: "claude",
    draw: () => "c1000001",
  });
  const heart = new DatabaseSync(heartCut.paths.heart);
  heart.exec(
    [
      "CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);",
      "INSERT INTO akuma_schema VALUES (1, 13)",
    ].join(""),
  );
  heart.close();
  const noise = join(akumaRunRoot(root), "NOISE-notid");
  mkdirSync(noise);
  const visible = await allocateAkumaDirectory({
    worldRoot: root,
    archetype: "claude",
    draw: () => "c1000003",
  });

  const world = await akumaAt(root);
  assert.deepEqual((await world.list()).rows, [{ id: visible.id, life: "unborn" }]);
  assert.equal(existsSync(noise), true);

  rmSync(heartCut.paths.directory, { recursive: true, force: true });
  const leashCut = await allocateAkumaDirectory({
    worldRoot: root,
    archetype: "claude",
    draw: () => "c1000002",
  });
  await initializeHeart(leashCut.paths);
  unlinkSync(leashCut.paths.leash);
  const leash = new DatabaseSync(leashCut.paths.leash);
  leash.exec(
    [
      "CREATE TABLE leash_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);",
      "INSERT INTO leash_schema VALUES (1, 2)",
    ].join(""),
  );
  leash.close();
  assert.deepEqual((await world.list()).rows, [{ id: visible.id, life: "unborn" }]);
});

test("kill gives the Body a grace window to abort its owned provider session", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "fedcba98" });
  await initializeHeart(allocated.paths);
  let aborted = false;
  const { promise: completion, resolve: settle } = promiseBarrier<{ kind: "failed"; diagnostic: string }>();
  const running: ProviderAdapter = fixtureAdapter(async () => ({
    admission: { fence: "kill-fixture-turn" },
    events: {
      async *[Symbol.asyncIterator]() {
        while (!aborted) {
          yield { type: "note" as const, text: "Working" };
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    },
    completion,
    async abort() {
      aborted = true;
      settle({ kind: "failed", diagnostic: "stopped" });
    },
  }));
  const launch: BodyLaunch = {
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      allowed: [],
      cwd: root,
    },
    initialBody: "keep working",
  };
  const body = driveAkumaBody(launch, running, {
    now: () => "2026-08-08T00:00:00.000Z",
  });
  await waitForCondition(
    "the first Body recorded in Heart",
    async () => (await readHeart(allocated.paths)).latestBody !== null,
    { terminalState: settlementProbe(body, () => "the driving Body pump settled without a recorded Body") },
  );

  const handle = (await akumaAt(root)).of({ id: allocated.id });
  const waited = handle.wait();
  assert.equal(await handle.kill(), "killed");
  await body;
  assert.notEqual((await waited).life, "running");
  assert.equal(aborted, true);
  assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
  assert.equal((await handle.status()).life, "killed");
});
