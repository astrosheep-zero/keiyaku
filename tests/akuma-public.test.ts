import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Akuma, AkumaNotBornError } from "../src/akuma/akuma.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { ordinarySelectedCount, ordinarySnapshotBudget, projectTurns, selectHistory, selectSnapshot } from "../src/akuma/projection.js";
import { AkumaArchetypeError, listArchetypeDefinitions, loadArchetype } from "../src/akuma/archetype.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import {
  activitySlice,
  appendActivity,
  beginTurn,
  breakBody,
  finishBodyIfIdle,
  HeldAkumaLeash,
  initializeHeart,
  lifeAt,
  pauseRequested,
  readHeart,
  recordTell,
  requestStop,
  type Soul,
} from "../src/akuma/heart/index.js";
import { akumaRunRoot, allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { settings } from "../src/settings.js";
import { World } from "../src/world.js";

const CLAUDE_EXECUTION = { name: "claude", kind: "claude-agent-sdk" } as const;

async function akumaAt(
  root: string,
  input?: { home?: string; settings?: Awaited<ReturnType<typeof settings>> },
) {
  return Akuma.of(await World.at(root), input);
}

async function timeline(paths: Parameters<typeof activitySlice>[0]) {
  return (await activitySlice(paths)).rows;
}

async function bornHistoryHandle(root: string, suffix: string) {
  const allocated = await allocateAkumaDirectory({
    worldRoot: root, archetype: "claude", draw: () => suffix,
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

test("history completion keeps the start sequence and never remints", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-history-remint-"));
  const born = await bornHistoryHandle(root, "c0000001");
  try {
    const start = await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: {
        type: "tool", phase: "started", id: "bash-1", name: "Bash",
        call: { kind: "run", command: "npm test" },
      },
      at: "2026-08-10T00:00:02.000Z",
    });
    const done = await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: {
        type: "tool", phase: "completed", id: "bash-1", name: "Bash",
        call: { kind: "run", command: "npm test" }, result: { status: "ok" },
      },
      at: "2026-08-10T00:00:03.000Z",
    });
    assert.deepEqual([born.turn.sequence, start, done], [1, 2, 3]);

    const page = await born.handle.history();
    const tools = toolRow(page.rows);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.sequence, 2);
    assert.equal(tools[0] !== undefined && "state" in tools[0] && tools[0].state !== "active", true);
    assert.equal(page.rows.some((row) => row.kind === "tool" && row.sequence === 3), false);

    const sinceStart = await born.handle.history({ since: 2 });
    assert.equal(sinceStart.rows.some((row) => row.kind === "tool"), false);
    assert.equal(sinceStart.rows.some((row) => row.sequence === 3), false);

    const beforeDone = await born.handle.history({ before: done });
    assert.deepEqual(toolRow(beforeDone.rows).map((row) => row.sequence), [2]);
    assert.equal(beforeDone.rows.filter((row) => row.kind === "tool").length, 1);
  } finally {
    born.holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("history limit counts folded semantic rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-history-limit-"));
  const born = await bornHistoryHandle(root, "c0000003");
  try {
    await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: {
        type: "tool", phase: "started", id: "note-tool", name: "Bash",
        call: { kind: "run", command: "echo" },
      },
      at: "2026-08-10T00:00:02.000Z",
    });
    await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: {
        type: "tool", phase: "completed", id: "note-tool", name: "Bash",
        call: { kind: "run", command: "echo" }, result: { status: "ok" },
      },
      at: "2026-08-10T00:00:03.000Z",
    });
    await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: { type: "note", text: "first" },
      at: "2026-08-10T00:00:04.000Z",
    });
    await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: { type: "note", text: "second" },
      at: "2026-08-10T00:00:05.000Z",
    });
    const facts = await timeline(born.allocated.paths);
    assert.ok(facts.length > 3);
    const page = await born.handle.history({ limit: 3 });
    assert.equal(page.rows.length, 3);
    assert.deepEqual(page.rows.map((row) => row.kind), ["tool", "note", "note"]);
    assert.equal(page.rows[0]?.sequence, 2);
    assert.equal(page.omitted > 0, true);
    assert.equal(page.lowestRetained, 1);
    assert.equal(page.highest, facts.at(-1)?.sequence);
  } finally {
    born.holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Heart activity reads do not take public history cursors", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-history-owner-"));
  const born = await bornHistoryHandle(root, "c0000004");
  try {
    await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: { type: "note", text: "later" },
      at: "2026-08-10T00:00:02.000Z",
    });
    const retained = await activitySlice(born.allocated.paths);
    const page = await born.handle.history({ before: 2, limit: 1 });
    assert.deepEqual(retained.rows.map((row) => row.sequence), [1, 2]);
    assert.deepEqual(page.rows.map((row) => row.sequence), [1]);
    assert.equal(page.lowestRetained, retained.lowestRetained);
    assert.equal(page.highest, retained.highest);
  } finally {
    born.holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("forward history reports a pruned interval after its cursor", async () => {
  const history = selectHistory(projectTurns([{
      kind: "activity",
      sequence: 9,
      turnSequence: 1,
      event: { type: "note", text: "retained" },
      at: "2026-08-08T00:00:09.000Z",
    }], { lowestRetained: 1, highest: 9 }), { since: 4, limit: 50 });

  assert.equal(history.historyLost, true);
  assert.deepEqual(history.rows.map((row) => row.sequence), [9]);
});

test("Heart life timestamps select each reachable evidence source", () => {
  const body = {
    sequence: 7,
    leashTakenAt: "2026-08-12T00:00:00.000Z",
    hung: { diagnostic: "stuck", at: "2026-08-12T00:01:00.000Z" },
    endedAt: "2026-08-12T00:02:00.000Z",
  } as const;
  const kill = { sequence: 1, bodySequence: 7, evidence: "killed" as const, at: "2026-08-12T00:03:00.000Z" };
  const createdAt = "2026-08-11T00:00:00.000Z";
  assert.equal(lifeAt("running", body, null, createdAt), body.leashTakenAt);
  assert.equal(lifeAt("hung", body, null, createdAt), body.hung.at);
  assert.equal(lifeAt("killed", body, kill, createdAt), kill.at);
  assert.equal(lifeAt("asleep", body, null, createdAt), body.endedAt);
  assert.equal(lifeAt("stranded", body, null, createdAt), body.endedAt);
  assert.equal(lifeAt("untidy", body, null, createdAt), null);
  assert.equal(lifeAt("asleep", null, null, createdAt), createdAt);
});

test("public fleet rows wire every Heart life to its source timestamp", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-life-at-"));
  const holders: HeldAkumaLeash[] = [];
  try {
    const born = async (suffix: string, createdAt: string) => {
      const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => suffix });
      await initializeHeart(allocated.paths);
      const holder = (await HeldAkumaLeash.try(allocated.paths))!;
      await holder.birth(allocated.paths, {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        cwd: root,
        origin: { kind: "direct" },
        createdAt,
      });
      return { allocated, holder };
    };
    const running = await born("f0000001", "2026-08-12T00:00:00.000Z");
    const runningBody = await running.holder.recordBody(running.allocated.paths, { leashTakenAt: "2026-08-12T00:01:00.000Z" });
    holders.push(running.holder);
    const hung = await born("f0000002", "2026-08-12T00:00:00.000Z");
    const hungBody = await hung.holder.recordBody(hung.allocated.paths, { leashTakenAt: "2026-08-12T00:02:00.000Z" });
    await hung.holder.recordBodyHung(hung.allocated.paths, { sequence: hungBody.sequence, diagnostic: "stuck", at: "2026-08-12T00:03:00.000Z" });
    holders.push(hung.holder);
    const asleep = await born("f0000003", "2026-08-12T00:00:00.000Z");
    const asleepBody = await asleep.holder.recordBody(asleep.allocated.paths, { leashTakenAt: "2026-08-12T00:04:00.000Z" });
    await finishBodyIfIdle(asleep.allocated.paths, { sequence: asleepBody.sequence, at: "2026-08-12T00:05:00.000Z" });
    asleep.holder.release();
    const stranded = await born("f0000004", "2026-08-12T00:00:00.000Z");
    const strandedBody = await stranded.holder.recordBody(stranded.allocated.paths, { leashTakenAt: "2026-08-12T00:06:00.000Z" });
    await breakBody(stranded.allocated.paths, { sequence: strandedBody.sequence, end: "broke-off", at: "2026-08-12T00:07:00.000Z" });
    stranded.holder.release();
    const killed = await born("f0000005", "2026-08-12T00:00:00.000Z");
    const killedBody = await killed.holder.recordBody(killed.allocated.paths, { leashTakenAt: "2026-08-12T00:08:00.000Z" });
    assert.equal((await requestStop(killed.allocated.paths, "2026-08-12T00:09:00.000Z")).kind, "requested");
    await breakBody(killed.allocated.paths, { sequence: killedBody.sequence, end: "put-down", at: "2026-08-12T00:10:00.000Z" });
    await killed.holder.settleStop(killed.allocated.paths);
    killed.holder.release();
    const untidy = await born("f0000006", "2026-08-12T00:00:00.000Z");
    await untidy.holder.recordBody(untidy.allocated.paths, { leashTakenAt: "2026-08-12T00:11:00.000Z" });
    untidy.holder.release();
    const unborn = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0000007" });
    await initializeHeart(unborn.paths);
    const stillborn = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0000008" });
    await initializeHeart(stillborn.paths);
    const stillbornHolder = (await HeldAkumaLeash.try(stillborn.paths))!;
    await stillbornHolder.sealIfUnborn(stillborn.paths, { evidence: "test", at: "2026-08-12T00:12:00.000Z" });

    const rows = (await (await akumaAt(root)).list()).rows;
    const row = (id: string) => rows.find((candidate) => candidate.id === id)!;
    assert.equal(row(running.allocated.id).lifeAt, "2026-08-12T00:01:00.000Z");
    assert.equal(row(hung.allocated.id).lifeAt, "2026-08-12T00:03:00.000Z");
    assert.equal(row(asleep.allocated.id).lifeAt, "2026-08-12T00:05:00.000Z");
    assert.equal(row(stranded.allocated.id).lifeAt, "2026-08-12T00:07:00.000Z");
    assert.equal(row(killed.allocated.id).lifeAt, "2026-08-12T00:09:00.000Z");
    assert.equal(row(untidy.allocated.id).lifeAt, null);
    assert.equal("lifeAt" in row(unborn.id), false);
    assert.equal("lifeAt" in row(stillborn.id), false);
  } finally {
    for (const holder of holders) holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tell refuses an unborn address without leaving durable input", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-tell-unborn-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a10004" });
    await initializeHeart(allocated.paths);
    await assert.rejects((await akumaAt(root)).of({ id: allocated.id }).tell("future input"), AkumaNotBornError);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("interrupt refuses an unborn address without leaving durable input or control", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-unborn-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a10005" });
    await initializeHeart(allocated.paths);
    const holder = (await HeldAkumaLeash.try(allocated.paths))!;
    try {
      await assert.rejects((await akumaAt(root)).of({ id: allocated.id }).interrupt("future input"), AkumaNotBornError);
      assert.deepEqual((await readHeart(allocated.paths)).pending, []);
      assert.equal(await pauseRequested(allocated.paths), false);
    } finally { holder.release(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const provider: ProviderAdapter = {
  admitOptions(options) { return { kind: "admitted", options }; },
  async start() {
    let finishEvents!: () => void;
    const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
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
        kind: "answered" as const, answer: "public answer", historyId: "public-history",
      })),
      async abort() {},
    };
  },
};

async function answeredSource(root: string, suffix: string, readonly?: Soul["readonly"]) {
  const world = await World.at(root);
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  await driveAkumaBody({
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      description: "Fork source",
      provider: CLAUDE_EXECUTION,
      options: { model: "fixture-model", ...(readonly === undefined ? {} : { readonly: true }) },
      ...(readonly === undefined ? {} : { readonly }),
      origin: { kind: "direct" },
      cwd: world,
    },
    initialBody: "work",
  }, provider, {
    now: () => "2026-08-08T00:00:00.000Z",
  });
  return allocated;
}

type MutableProvider = { -readonly [Key in keyof ProviderAdapter]: ProviderAdapter[Key] };

test("public observation classifies a vanished Heart without recreating heart.db", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-public-heart-absent-"));
  try {
    const allocated = await allocateAkumaDirectory({
      worldRoot: root,
      archetype: "claude",
      draw: () => "1234abce",
    });
    await initializeHeart(allocated.paths);
    unlinkSync(allocated.paths.heart);
    const world = await akumaAt(root);
    await assert.rejects(world.of({ id: allocated.id }).status(), AkumaNotBornError);
    assert.deepEqual((await world.list()).rows, [{
      id: allocated.id,
      life: "unborn",
    }]);
    assert.equal(existsSync(allocated.paths.heart), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot selects one current focus while history keeps honest tool lifecycle", () => {
  const facts = [
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "activity" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "tool", phase: "started", id: "old", name: "Bash", call: { kind: "run", command: "old" } } },
    { kind: "turn-end" as const, sequence: 3, turnSequence: 1, completedAt: "2026-08-10T00:00:03.000Z", outcome: { kind: "answered", answer: "old answer", session: { sessionId: "session" } } },
    { kind: "turn-start" as const, sequence: 4, bodySequence: 1, startedAt: "2026-08-10T00:00:04.000Z" },
    { kind: "call" as const, sequence: 5, turnSequence: 4, at: "2026-08-10T00:00:04.000Z", body: "current" },
    { kind: "activity" as const, sequence: 6, turnSequence: 4, at: "2026-08-10T00:00:05.000Z", event: { type: "note", text: "checking" } },
    { kind: "tell" as const, sequence: 7, id: "tell-1", body: "new direction", recordedAt: "2026-08-10T00:00:06.000Z", state: "pending" as const, deliveries: [] },
    { kind: "activity" as const, sequence: 8, turnSequence: 4, at: "2026-08-10T00:00:07.000Z", event: { type: "tool", phase: "started", id: "current", name: "Search", call: { kind: "search", query: "TODO" } } },
  ];
  const ledger = projectTurns(facts);
  const snapshot = selectSnapshot(ledger, { tail: 1 });
  assert.equal(snapshot.kind, "open");
  if (snapshot.kind !== "open") return;
  assert.deepEqual(snapshot.entries.map((entry) => entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence), ["gap:1", 6, 7, 8]);
  assert.equal(snapshot.omitted, 1);
  assert.equal(snapshot.entries.some((entry) => entry.kind === "row" && entry.row.kind === "tool" && entry.row.state === "active"), true);
  assert.equal(snapshot.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 2), false);
  assert.equal(ledger.rows.some((row) => row.kind === "tool" && row.sequence === 2 && row.state === "unsettled"), true);
  assert.equal(ledger.rows.some((row) => row.kind === "tool" && row.sequence === 8 && row.state === "active"), true);
  assert.equal(ledger.turns[0]?.kind, "closed");
  assert.equal(ledger.turns[1]?.kind, "open");
  assert.equal(ledger.openTurn?.rows.some((row) => row.kind === "tool" && row.state === "active"), true);

  const closed = projectTurns([...facts,
    { kind: "activity" as const, sequence: 9, turnSequence: 4, at: "2026-08-10T00:00:08.000Z", event: { type: "assistant", text: "done" } },
    { kind: "turn-end" as const, sequence: 10, turnSequence: 4, completedAt: "2026-08-10T00:00:09.000Z", outcome: { kind: "answered", answer: "done", session: { sessionId: "session" } } },
  ]);
  const idle = selectSnapshot(closed);
  assert.equal(idle.kind, "idle");
  if (idle.kind !== "idle") return;
  assert.equal(idle.outcome?.outcome.kind, "answered");
  assert.deepEqual(idle.entries.map((entry) => entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence), [7]);
  assert.equal(closed.rows.some((row) => row.kind === "said" && row.sequence === 9), false);
  assert.equal(closed.rows.some((row) => row.kind === "tool" && row.sequence === 8 && row.state === "unsettled"), true);
  assert.equal(closed.turns[1]?.kind, "closed");
  if (closed.turns[1]?.kind === "closed") {
    assert.equal(closed.turns[1].rows.some((row) => row.kind === "tool" && row.state === "unsettled"), true);
  }

  const mixedLedger = projectTurns([
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "activity", sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "tool", phase: "started", id: "abandoned", name: "Bash", call: { kind: "run", command: "old" } } },
    { kind: "turn-start", sequence: 3, bodySequence: 2, startedAt: "2026-08-10T00:00:03.000Z" },
    { kind: "turn-end", sequence: 4, turnSequence: 3, completedAt: "2026-08-10T00:00:04.000Z", outcome: { kind: "failed", diagnostic: "latest failed" } },
  ]);
  assert.equal(mixedLedger.turns[0]?.kind, "open");
  assert.equal(mixedLedger.turns[1]?.kind, "closed");
  assert.equal(mixedLedger.openTurn, undefined);
  assert.equal(mixedLedger.rows.some((row) => row.kind === "tool" && row.sequence === 2 && row.state === "active"), true);
  assert.equal(selectSnapshot(mixedLedger).kind, "idle");
});

test("reported file changes follow the open or latest closed frontier", () => {
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
    { kind: "activity" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "tool" as const, phase: "started" as const, id: "earlier", name: "Write", call: earlierCall } },
    { kind: "activity" as const, sequence: 3, turnSequence: 1, at: "2026-08-10T00:00:03.000Z", event: { type: "tool" as const, phase: "completed" as const, id: "earlier", name: "Write", call: earlierCall, result: { status: "ok" as const } } },
    { kind: "turn-end" as const, sequence: 4, turnSequence: 1, completedAt: "2026-08-10T00:00:04.000Z", outcome: { kind: "answered" as const, answer: "earlier", session: { sessionId: "earlier" } } },
    { kind: "turn-start" as const, sequence: 5, bodySequence: 1, startedAt: "2026-08-10T00:00:05.000Z" },
    { kind: "activity" as const, sequence: 6, turnSequence: 5, at: "2026-08-10T00:00:06.000Z", event: { type: "tool" as const, phase: "started" as const, id: "frontier", name: "Write", call: frontierCall } },
    { kind: "activity" as const, sequence: 7, turnSequence: 5, at: "2026-08-10T00:00:07.000Z", event: { type: "tool" as const, phase: "completed" as const, id: "frontier", name: "Write", call: frontierCall, result: { status: "ok" as const } } },
    { kind: "activity" as const, sequence: 8, turnSequence: 5, at: "2026-08-10T00:00:08.000Z", event: { type: "tool" as const, phase: "started" as const, id: "failed", name: "Write", call: failedCall } },
    { kind: "activity" as const, sequence: 9, turnSequence: 5, at: "2026-08-10T00:00:09.000Z", event: { type: "tool" as const, phase: "completed" as const, id: "failed", name: "Write", call: failedCall, result: { status: "error" as const } } },
    { kind: "activity" as const, sequence: 10, turnSequence: 5, at: "2026-08-10T00:00:10.000Z", event: { type: "tool" as const, phase: "started" as const, id: "active", name: "Write", call: activeCall } },
    { kind: "activity" as const, sequence: 11, turnSequence: 5, at: "2026-08-10T00:00:11.000Z", event: { type: "tool" as const, phase: "started" as const, id: "run", name: "Bash", call: { kind: "run" as const, command: "touch src/non-file.ts" } } },
    { kind: "activity" as const, sequence: 12, turnSequence: 5, at: "2026-08-10T00:00:12.000Z", event: { type: "tool" as const, phase: "completed" as const, id: "run", name: "Bash", call: { kind: "run" as const, command: "touch src/non-file.ts" }, result: { status: "ok" as const } } },
  ];
  const reported = (snapshot: ReturnType<typeof selectSnapshot>) => snapshot.reportedChanges.map((change) => ({
    sequence: change.sequence,
    at: change.at,
    op: change.op,
    path: change.path,
    ...(change.diffstat === undefined ? {} : { diffstat: change.diffstat }),
  }));
  const openLedger = projectTurns(facts);
  const openFrontier = openLedger.openTurn?.rows.find((row) => row.kind === "tool" && row.call.kind === "fileChange" && row.sequence === 6);
  assert.ok(openFrontier !== undefined && openFrontier.kind === "tool" && openFrontier.call.kind === "fileChange");
  (openFrontier.call.changes[3] as unknown as { op: "unspecified" }).op = "unspecified";

  const open = selectSnapshot(openLedger);
  assert.equal(open.kind, "open");
  assert.deepEqual(reported(open), [
    { sequence: 6, at: "2026-08-10T00:00:06.000Z", op: "add", path: "src/created.ts", diffstat: { added: 4, removed: 0 } },
    { sequence: 6, at: "2026-08-10T00:00:06.000Z", op: "update", path: "src/repeated.ts", diffstat: { added: 2, removed: 1 } },
    { sequence: 6, at: "2026-08-10T00:00:06.000Z", op: "delete", path: "src/removed.ts", diffstat: { added: 0, removed: 3 } },
    { sequence: 6, at: "2026-08-10T00:00:06.000Z", op: "unspecified", path: "src/unknown.ts" },
    { sequence: 6, at: "2026-08-10T00:00:06.000Z", op: "update", path: "src/repeated.ts", diffstat: { added: 1, removed: 0 } },
  ]);
  assert.equal(open.reportedChangesOmitted, 0);

  const closedLedger = projectTurns([...facts, {
    kind: "turn-end" as const,
    sequence: 13,
    turnSequence: 5,
    completedAt: "2026-08-10T00:00:13.000Z",
    outcome: { kind: "answered" as const, answer: "frontier", session: { sessionId: "frontier" } },
  }]);
  const closedFrontier = closedLedger.turns.at(-1);
  assert.ok(closedFrontier?.kind === "closed");
  const closedChange = closedFrontier.rows.find((row) => row.kind === "tool" && row.call.kind === "fileChange" && row.sequence === 6);
  assert.ok(closedChange !== undefined && closedChange.kind === "tool" && closedChange.call.kind === "fileChange");
  (closedChange.call.changes[3] as unknown as { op: "unspecified" }).op = "unspecified";

  const idle = selectSnapshot(closedLedger);
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
      { op: "delete" as const, path: "src/three.ts" },
    ],
  };
  const secondCall = {
    kind: "fileChange" as const,
    changes: [
      { op: "add" as const, path: "src/four.ts" },
      { op: "update" as const, path: "src/five.ts" },
      { op: "delete" as const, path: "src/six.ts" },
      { op: "add" as const, path: "src/seven.ts" },
    ],
  };
  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "activity" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "tool" as const, phase: "started" as const, id: "first", name: "Write", call: firstCall } },
    { kind: "activity" as const, sequence: 3, turnSequence: 1, at: "2026-08-10T00:00:03.000Z", event: { type: "tool" as const, phase: "completed" as const, id: "first", name: "Write", call: firstCall, result: { status: "ok" as const } } },
    { kind: "activity" as const, sequence: 4, turnSequence: 1, at: "2026-08-10T00:00:04.000Z", event: { type: "note" as const, text: "ordinary one" } },
    { kind: "activity" as const, sequence: 5, turnSequence: 1, at: "2026-08-10T00:00:05.000Z", event: { type: "tool" as const, phase: "started" as const, id: "second", name: "Write", call: secondCall } },
    { kind: "activity" as const, sequence: 6, turnSequence: 1, at: "2026-08-10T00:00:06.000Z", event: { type: "tool" as const, phase: "completed" as const, id: "second", name: "Write", call: secondCall, result: { status: "ok" as const } } },
    { kind: "activity" as const, sequence: 7, turnSequence: 1, at: "2026-08-10T00:00:07.000Z", event: { type: "note" as const, text: "ordinary two" } },
    { kind: "activity" as const, sequence: 8, turnSequence: 1, at: "2026-08-10T00:00:08.000Z", event: { type: "note" as const, text: "ordinary three" } },
  ]);
  const snapshot = selectSnapshot(ledger, { tail: 0, voice: 0 });
  assert.equal(snapshot.kind, "open");
  assert.deepEqual(snapshot.reportedChanges.map((change) => change.path), [
    "src/three.ts", "src/four.ts", "src/five.ts", "src/six.ts", "src/seven.ts",
  ]);
  assert.deepEqual(snapshot.reportedChanges.map((change) => change.sequence), [2, 5, 5, 5, 5]);
  assert.equal(snapshot.reportedChangesOmitted, 2);
  assert.equal(snapshot.omitted, 5);
  assert.deepEqual(snapshot.entries, [{ kind: "gap", count: 5 }]);
});

test("open snapshot independently retains pre-tail voice and actionable pins", () => {
  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "activity" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "assistant", text: "voice one" } },
    { kind: "activity" as const, sequence: 3, turnSequence: 1, at: "2026-08-10T00:00:03.000Z", event: { type: "note", text: "hidden between voices" } },
    { kind: "activity" as const, sequence: 4, turnSequence: 1, at: "2026-08-10T00:00:04.000Z", event: { type: "thought", text: "voice two" } },
    { kind: "call" as const, sequence: 5, turnSequence: 1, at: "2026-08-10T00:00:05.000Z", body: "hidden between voices" },
    { kind: "activity" as const, sequence: 6, turnSequence: 1, at: "2026-08-10T00:00:06.000Z", event: { type: "assistant", text: "voice three" } },
    { kind: "activity" as const, sequence: 7, turnSequence: 1, at: "2026-08-10T00:00:07.000Z", event: { type: "note", text: "hidden before pin" } },
    { kind: "activity" as const, sequence: 8, turnSequence: 1, at: "2026-08-10T00:00:08.000Z", event: { type: "tool", phase: "started", id: "pinned", name: "Search", call: { kind: "search", query: "pin" } } },
    { kind: "tell" as const, sequence: 9, id: "tell-pinned", body: "pinned input", recordedAt: "2026-08-10T00:00:09.000Z", state: "pending" as const, deliveries: [] },
    { kind: "activity" as const, sequence: 10, turnSequence: 1, at: "2026-08-10T00:00:10.000Z", event: { type: "note", text: "tail note" } },
    { kind: "activity" as const, sequence: 11, turnSequence: 1, at: "2026-08-10T00:00:11.000Z", event: { type: "assistant", text: "tail voice" } },
    { kind: "activity" as const, sequence: 12, turnSequence: 1, at: "2026-08-10T00:00:12.000Z", event: { type: "thought", text: "tail thought" } },
  ]);

  const snapshot = selectSnapshot(ledger, { tail: 3, voice: 3 });
  assert.equal(snapshot.kind, "open");
  if (snapshot.kind !== "open") return;
  const positions = snapshot.entries.map((entry) => entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence);
  assert.deepEqual(positions, [2, "gap:1", 4, "gap:1", 6, "gap:1", 8, 9, 10, 11, 12]);
  assert.equal(snapshot.entries.filter((entry) => entry.kind === "row").length, 8);
  assert.equal(snapshot.omitted, 3);

  const pinnedOnly = selectSnapshot(ledger, { tail: 0, voice: 0 });
  assert.equal(pinnedOnly.kind, "open");
  if (pinnedOnly.kind !== "open") return;
  assert.deepEqual(pinnedOnly.entries.map((entry) => entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence), ["gap:6", 8, 9, "gap:3"]);
  assert.equal(pinnedOnly.omitted, 9);
});

test("budgeted snapshot spends newest tail first under the public 3 + 3 proportions", () => {
  assert.deepEqual(ordinarySnapshotBudget(0), { tail: 0, voice: 0 });
  assert.deepEqual(ordinarySnapshotBudget(2), { tail: 2, voice: 0 });
  assert.deepEqual(ordinarySnapshotBudget(4), { tail: 3, voice: 1 });
  assert.deepEqual(ordinarySnapshotBudget(6), { tail: 3, voice: 3 });
  assert.deepEqual(ordinarySnapshotBudget(30), { tail: 3, voice: 3 });

  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "activity" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "assistant", text: "old voice" } },
    { kind: "activity" as const, sequence: 3, turnSequence: 1, at: "2026-08-10T00:00:03.000Z", event: { type: "assistant", text: "kept voice" } },
    { kind: "activity" as const, sequence: 4, turnSequence: 1, at: "2026-08-10T00:00:04.000Z", event: { type: "note", text: "tail note" } },
    { kind: "activity" as const, sequence: 5, turnSequence: 1, at: "2026-08-10T00:00:05.000Z", event: { type: "note", text: "newest note" } },
    { kind: "activity" as const, sequence: 6, turnSequence: 1, at: "2026-08-10T00:00:06.000Z", event: { type: "tool", phase: "started", id: "pin", name: "Search", call: { kind: "search", query: "pin" } } },
    { kind: "tell" as const, sequence: 7, id: "tell-pin", body: "pin", recordedAt: "2026-08-10T00:00:07.000Z", state: "pending" as const, deliveries: [] },
  ]);
  const snapshot = selectSnapshot(ledger, ordinarySnapshotBudget(2));
  assert.equal(snapshot.kind, "open");
  if (snapshot.kind !== "open") return;
  assert.deepEqual(snapshot.entries.map((entry) => entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence), ["gap:2", 4, 5, 6, 7]);
  assert.equal(ordinarySelectedCount(snapshot), 2);
});

test("a newer running tool does not displace a complete 3 + 3 ordinary selection", () => {
  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "activity" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "assistant", text: "hidden voice" } },
    { kind: "activity" as const, sequence: 3, turnSequence: 1, at: "2026-08-10T00:00:03.000Z", event: { type: "note", text: "hidden note" } },
    { kind: "activity" as const, sequence: 4, turnSequence: 1, at: "2026-08-10T00:00:04.000Z", event: { type: "assistant", text: "voice one" } },
    { kind: "activity" as const, sequence: 5, turnSequence: 1, at: "2026-08-10T00:00:05.000Z", event: { type: "thought", text: "voice two" } },
    { kind: "activity" as const, sequence: 6, turnSequence: 1, at: "2026-08-10T00:00:06.000Z", event: { type: "assistant", text: "voice three" } },
    { kind: "activity" as const, sequence: 7, turnSequence: 1, at: "2026-08-10T00:00:07.000Z", event: { type: "note", text: "tail one" } },
    { kind: "activity" as const, sequence: 8, turnSequence: 1, at: "2026-08-10T00:00:08.000Z", event: { type: "note", text: "tail two" } },
    { kind: "activity" as const, sequence: 9, turnSequence: 1, at: "2026-08-10T00:00:09.000Z", event: { type: "note", text: "tail three" } },
    { kind: "activity" as const, sequence: 10, turnSequence: 1, at: "2026-08-10T00:00:10.000Z", event: { type: "tool", phase: "started", id: "running", name: "Bash", call: { kind: "run", command: "npm test" } } },
    { kind: "tell" as const, sequence: 11, id: "pending", body: "continue", recordedAt: "2026-08-10T00:00:11.000Z", state: "pending" as const, deliveries: [] },
  ]);
  const snapshot = selectSnapshot(ledger, { tail: 3, voice: 3 });
  assert.equal(snapshot.kind, "open");
  if (snapshot.kind !== "open") return;
  assert.deepEqual(snapshot.entries.map((entry) => entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence), [
    "gap:2", 4, 5, 6, 7, 8, 9, 10, 11,
  ]);
  assert.equal(ordinarySelectedCount(snapshot), 6);
  assert.equal(snapshot.entries.some((entry) => entry.kind === "row" && entry.row.kind === "tool" && entry.row.state === "active"), true);
});

test("outcome folding preserves a truncated final voice equal to the answer", () => {
  const ledger = projectTurns([
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "activity", sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "assistant", text: "same answer", truncated: true } },
    { kind: "turn-end", sequence: 3, turnSequence: 1, completedAt: "2026-08-10T00:00:03.000Z", outcome: { kind: "answered", answer: "same answer", session: { sessionId: "session" } } },
  ]);

  assert.equal(ledger.rows.some((row) => row.kind === "said"
    && row.text === "same answer" && row.truncated === true), true);
  assert.deepEqual(selectHistory(ledger, { limit: 50 }).rows.map((row) => row.kind), ["turn", "said", "outcome"]);
});

test("wait timeout returns the same running status carrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-wait-timeout-"));
  try {
    const source = await answeredSource(root, "de1ad100");
    const leash = (await HeldAkumaLeash.try(source.paths))!;
    try {
      const handle = (await akumaAt(root)).of({ id: source.id });
      const expected = (await handle.status());
      assert.equal(expected.life, "running");
      assert.deepEqual(await handle.wait(undefined, { timeoutMs: 0 }), expected);
    } finally {
      leash.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait refuses invalid public timeoutMs values", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-wait-invalid-timeout-"));
  try {
    const source = await answeredSource(root, "de1ad101");
    const handle = (await akumaAt(root)).of({ id: source.id });
    for (const timeoutMs of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      await assert.rejects(
        handle.wait(undefined, { timeoutMs }),
        /Akuma wait timeoutMs must be a nonnegative finite millisecond duration/u,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an answered Turn without a fork point remains visible and keeps its answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-no-fork-point-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a10006" });
    await initializeHeart(allocated.paths);
    const noPointProvider: ProviderAdapter = {
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        let finishEvents!: () => void;
        const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
        return {
          admission: { fence: "no-point-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "no-point-session" } };
              finishEvents();
            },
          },
          completion: eventsFinished.then(() => ({
            kind: "answered" as const, answer: "complete without fork",
          })),
          async abort() {},
        };
      },
    };
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        description: "No fork point",
        provider: CLAUDE_EXECUTION,
        options: { model: "fixture-model" },
        origin: { kind: "direct" },
        cwd: root,
      },
      initialBody: "work",
    }, noPointProvider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });

    const handle = (await akumaAt(root)).of({ id: allocated.id });
    assert.deepEqual((await handle.lastAnswer()), { kind: "answer", answer: "complete without fork" });
    assert.deepEqual((await handle.history()).rows.find((row) => row.kind === "outcome")?.outcome, {
      kind: "answered",
      session: { sessionId: "no-point-session" },
      answer: "complete without fork",
    });
    assert.deepEqual(await handle.fork({ at: "missing-point" }), { kind: "unknown-history", at: "missing-point" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fork publishes a sleeping child with lineage and its native birth session", async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-keiyaku-akuma-fork-"));
  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    const source = await answeredSource(root, "f0a10001");
    const world = (await akumaAt(root));
    const worldRoot = await World.at(root);
    assert.equal(await world.of({ id: source.id }).kill(), "already-stopped");
    let nativeInput: Parameters<NonNullable<ProviderAdapter["fork"]>>[0] | undefined;
    mutable.fork = async (input) => {
      nativeInput = input;
      return { session: { sessionId: "fork-child-session" } };
    };

    const receipt = await world.of({ id: source.id }).fork({ at: "public-history" });
    assert.equal(receipt.kind, "forked", JSON.stringify(receipt));
    if (receipt.kind !== "forked") return;
    assert.deepEqual(nativeInput, {
      session: { sessionId: "public-session" },
      at: "public-history",
      cwd: worldRoot,
    });
    assert.match(receipt.child, /^aku\/claude\/[0-9a-f]{8}$/u);
    const child = world.of({ id: receipt.child });
    assert.equal((await child.status()).life, "asleep");
    const childPaths = pathsForAkuId(root, receipt.child);
    const snapshot = await readHeart(childPaths);
    assert.deepEqual(snapshot.soul?.origin, { kind: "fork", parent: source.id, at: "public-history" });
    assert.equal(snapshot.soul?.description, "Fork source");
    assert.deepEqual(snapshot.latestSession, {
      sequence: 1,
      provider: "claude",
      coordinate: { sessionId: "fork-child-session" },
      cwd: worldRoot,
      options: { model: "fixture-model" },
      admittedAt: snapshot.latestSession?.admittedAt,
    });
    assert.deepEqual((await timeline(childPaths)).filter((fact) => fact.kind === "turn-start"), []);
  } finally {
    mutable.fork = originalFork;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork preserves the exact admitted readonly restraint byte-for-byte", async () => {
  const root = mkdtempSync(join(process.cwd(), ".tmp-keiyaku-akuma-fork-restraint-"));
  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    const source = await answeredSource(root, "f0a10007", { enforcement: "native" });
    mutable.fork = async () => ({ session: { sessionId: "fork-restraint-child" } });
    const world = (await akumaAt(root));
    const receipt = await world.of({ id: source.id }).fork({ at: "public-history" });
    assert.equal(receipt.kind, "forked", JSON.stringify(receipt));
    if (receipt.kind !== "forked") return;
    const child = world.of({ id: receipt.child });
    assert.deepEqual((await readHeart(pathsForAkuId(root, receipt.child))).soul?.readonly, { enforcement: "native" });
    assert.equal((await child.status()).readonly?.enforcement, "native");
  } finally {
    mutable.fork = originalFork;
    rmSync(root, { recursive: true, force: true });
  }
});

test("fork preserves categorical, exact-history, native, local, and not-born failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-results-"));
  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    const source = await answeredSource(root, "f0a10002");
    const handle = (await akumaAt(root)).of({ id: source.id });

    mutable.fork = undefined;
    assert.deepEqual(await handle.fork({ at: "missing" }), { kind: "provider-cannot-fork", provider: "claude" });

    let nativeCalls = 0;
    mutable.fork = async () => {
      nativeCalls += 1;
      throw new Error("native refused");
    };
    assert.deepEqual(await handle.fork({ at: "missing" }), { kind: "unknown-history", at: "missing" });
    assert.equal(nativeCalls, 0);
    assert.deepEqual(await handle.fork({ at: "public-history" }), { kind: "fork-failed", diagnostic: "native refused" });

    mutable.fork = async () => {
      const runRoot = akumaRunRoot(root);
      rmSync(runRoot, { recursive: true, force: true });
      writeFileSync(runRoot, "blocked");
      return { session: { sessionId: "orphan-upstream-session" } };
    };
    const partial = await handle.fork({ at: "public-history" });
    assert.equal(partial.kind, "upstream-forked");
    if (partial.kind === "upstream-forked") {
      assert.deepEqual(partial.childSession, { sessionId: "orphan-upstream-session" });
      assert.match(partial.diagnostic, /exist|directory|not a directory/i);
    }

    const unbornRoot = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-unborn-"));
    try {
      const unborn = await allocateAkumaDirectory({ worldRoot: unbornRoot, archetype: "claude", draw: () => "f0a10003" });
      await assert.rejects(
        (await akumaAt(unbornRoot)).of({ id: unborn.id }).fork({ at: "anything" }),
        AkumaNotBornError,
      );
    } finally { rmSync(unbornRoot, { recursive: true, force: true }); }
  } finally {
    mutable.fork = originalFork;
    rmSync(root, { recursive: true, force: true });
  }
});

test("status names a durable session that the adapter cannot resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-resume-unsupported-"));
  const mutable = claudeProvider as MutableProvider;
  const originalResume = mutable.resume;
  try {
    const source = await answeredSource(root, "f0a10003");
    mutable.resume = undefined;
    const handle = (await akumaAt(root)).of({ id: source.id });
    const admitted = await recordTell(source.paths, {
      id: "resume-unsupported-tell",
      body: "continue",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(admitted.kind, "recorded");
    await driveAkumaBody({ paths: source.paths }, claudeProvider, {
      now: () => "2026-08-08T00:00:02.000Z",
    });
    const status = (await handle.status());
    assert.equal(status.life, "stranded");
    assert.equal(status.strandedReason, "resume-unsupported");
    assert.equal(status.timeline.entries.some((entry) => entry.kind === "row" && entry.row.kind === "outcome" && entry.row.outcome.kind === "failed"), false);
    const listed = (await (await akumaAt(root)).list()).rows[0]!;
    assert.equal("pending" in listed && listed.pending.includes("resume-unsupported-tell"), true);
    assert.equal((await timeline(source.paths)).filter((fact) => fact.kind === "turn-start").length, 1);
    assert.equal((await timeline(source.paths)).find((fact) => fact.kind === "turn-end")?.outcome.kind, "answered");
  } finally {
    mutable.resume = originalResume;
    rmSync(root, { recursive: true, force: true });
  }
});

test("public Akuma handles separate compact list rows from full status and wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-public-"));
  try {
    const world = (await akumaAt(root));
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
    const status = (await handle.status());
    assert.equal(status.life, "asleep");
    assert.equal("archetype" in status, false);
    assert.equal("description" in status, false);
    assert.equal("pending" in status, false);
    assert.equal(status.timeline.kind, "idle");
    assert.equal(status.timeline.kind === "idle" && status.timeline.outcome?.outcome.kind === "answered", true);
    assert.equal("history" in status, false);
    assert.deepEqual((await handle.history()).rows.find((row) => row.kind === "outcome")?.outcome, {
      kind: "answered",
      answer: "public answer",
      historyId: "public-history",
      session: { sessionId: "public-session" },
    });
    assert.deepEqual(status.timeline.entries, []);
    assert.deepEqual(await handle.wait((candidate) => candidate.timeline.kind === "idle"
      && candidate.timeline.outcome?.outcome.kind === "answered"), status);
    assert.equal(await handle.kill(), "already-stopped");
    assert.equal((await handle.status()).life, "asleep");
    assert.equal((await handle.status()).timeline.kind === "idle"
      && (await handle.status()).timeline.outcome?.outcome.kind === "answered", true);
    assert.equal(await handle.kill(), "already-stopped");
    assert.equal(await pauseRequested(allocated.paths), false);
    assert.deepEqual((await timeline(allocated.paths)).find((fact) => fact.kind === "turn-end")?.outcome, {
      kind: "answered",
      answer: "public answer",
      historyId: "public-history",
      session: { sessionId: "public-session" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tell after an already stopped Body wakes the same Akuma through its retained session", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-kill-resume-"));
  const seat = join(root, "seat");
  try {
    mkdirSync(seat);
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0006" });
    await initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: { model: "fixture-model" },
        origin: { kind: "direct" },
        cwd: seat,
      },
      initialBody: "first",
    }, provider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });

    const handle = (await akumaAt(root)).of({ id: allocated.id });
    assert.equal(await handle.kill(), "already-stopped");
    assert.equal((await handle.status()).life, "asleep");

    rmSync(seat, { recursive: true, force: true });
    const told = await handle.tell("continue");
    assert.equal(typeof told.wake, "object");
    assert.deepEqual((await readHeart(allocated.paths)).pending.map((tell) => tell.id), [told.admission.tellId]);

    let resumed: Parameters<NonNullable<ProviderAdapter["resume"]>>[0] | undefined;
    const successor: ProviderAdapter = {
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() { throw new Error("retained Akuma must resume"); },
      async resume(input) {
        resumed = input;
        return {
          admission: { fence: "kill-resume-successor" },
          events: { async *[Symbol.asyncIterator]() {} },
          completion: Promise.resolve({ kind: "answered", answer: "continued", historyId: "continued-history" }),
          async abort() {},
        };
      },
    };
    await driveAkumaBody({ paths: allocated.paths }, successor, {
      now: () => "2026-08-08T00:00:02.000Z",
    });

    assert.notEqual(resumed, undefined);
    const { requests, signal, ...resumedInput } = resumed!;
    assert.equal(signal.aborted, false);
    assert.equal(requests.dir, join(allocated.paths.directory, "requests", "2"));
    assert.deepEqual(resumedInput, {
      body: "",
      launchTells: [{ id: told.admission.tellId, text: "continue" }],
      cwd: seat,
      options: { model: "fixture-model" },
      session: { kind: "resume", coordinate: { sessionId: "public-session" } },
    });
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 2);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    assert.equal((await handle.history()).rows.some((row) => row.kind === "tell"
      && row.tellId === told.admission.tellId && row.state === "told"), true);
    assert.equal((await handle.status()).life, "asleep");
    assert.equal((await handle.status()).timeline.kind === "idle"
      && (await handle.status()).timeline.outcome?.outcome.kind === "answered", true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt records a tell only after taking an idle leash", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-idle-"));
  const seat = join(root, "seat");
  try {
    mkdirSync(seat);
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0001" });
    await initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        cwd: seat,
      },
      initialBody: "first",
    }, provider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    rmSync(seat, { recursive: true, force: true });

    const receipt = await (await akumaAt(root)).of({ id: allocated.id }).interrupt("next");
    assert.equal(receipt.kind, "interrupted");
    if (receipt.kind !== "interrupted" || "kind" in receipt.tell) return;
    assert.equal(receipt.putDown, "was-idle");
    assert.equal(typeof receipt.tell.wake, "object");
    assert.equal(await pauseRequested(allocated.paths), false);
    assert.deepEqual((await readHeart(allocated.paths)).pending.map((tell) => tell.id), [receipt.tell.admission.tellId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt waits for a running body to self-abort before recording the tell", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-running-"));
  const seat = join(root, "seat");
  try {
    mkdirSync(seat);
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0002" });
    await initializeHeart(allocated.paths);
    let aborted = false;
    let settle!: (result: { kind: "failed"; diagnostic: string }) => void;
    const completion = new Promise<{ kind: "failed"; diagnostic: string }>((resolve) => { settle = resolve; });
    const body = driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        cwd: seat,
      },
      initialBody: "work",
    }, {
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              while (!aborted) {
                yield { type: "action" as const, note: "Working" };
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            },
          },
          completion,
          async abort() {
            aborted = true;
            settle({ kind: "failed", diagnostic: "interrupted" });
          },
        };
      },
    }, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    while ((await readHeart(allocated.paths)).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));
    rmSync(seat, { recursive: true, force: true });

    const receipt = await (await akumaAt(root)).of({ id: allocated.id }).interrupt("replace it");
    await body;
    assert.equal(receipt.kind, "interrupted");
    if (receipt.kind !== "interrupted") return;
    assert.equal(receipt.putDown, "self-aborted");
    assert.equal(aborted, true);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.equal(await pauseRequested(allocated.paths), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt reports untidy when a free leash has no clean Body settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-unstoppable-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0003" });
    await initializeHeart(allocated.paths);
    const holder = (await HeldAkumaLeash.try(allocated.paths))!;
    await holder.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt reports hung when the Body does not release its held leash", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-held-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0005" });
    await initializeHeart(allocated.paths);
    const holder = (await HeldAkumaLeash.try(allocated.paths))!;
    await holder.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Archetype Markdown is strict call-time input with a durable option shape", async () => {
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-archetype-"));
  try {
    mkdirSync(join(home, "akuma"));
    const settingsValue = await settings({ home });
    writeFileSync(join(home, "akuma", "reviewer.md"), [
      "---",
      "provider: claude",
      "model: claude-sonnet-4-5",
      "effort: high",
      "readonly: true",
      "description: Careful reviewer",
      "editor:",
      "  theme: dark",
      "tags: [review, careful]",
      "revision: 3",
      "---",
      "Review the change from first principles.",
      "",
    ].join("\n"));
    const loaded = await loadArchetype({ name: "reviewer", home, settings: settingsValue });
    const { adapter, ...definition } = loaded;
    assert.equal(typeof adapter.start, "function");
    assert.deepEqual(definition, {
      name: "reviewer",
      path: join(home, "akuma", "reviewer.md"),
      provider: CLAUDE_EXECUTION,
      description: "Careful reviewer",
      allowed: ALLOWED_ACTIONS,
      options: {
        model: "claude-sonnet-4-5",
        effort: "high",
        readonly: true,
        systemPrompt: "Review the change from first principles.\n",
        systemPromptMode: "append",
      },
      readonly: { enforcement: "native" },
    });
    writeFileSync(join(home, "akuma", "invalid.md"), "---\nprovider: claude\nreadonly: false\n---\n");
    await assert.rejects(
      loadArchetype({ name: "invalid", home, settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.searched[0] === join(home, "akuma", "invalid.md")
        && !error.message.includes("searched")
        && !/archetype/iu.test(error.message),
    );
    writeFileSync(join(home, "akuma", "stale-access.md"), "---\nprovider: claude\naccess: read\n---\n");
    await assert.rejects(
      loadArchetype({ name: "stale-access", home, settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.reason.includes("access is not supported"),
    );
    writeFileSync(join(home, "akuma", "wordy-readonly.md"), "---\nprovider: claude\nreadonly: yes\n---\n");
    await assert.rejects(
      loadArchetype({ name: "wordy-readonly", home, settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.reason.includes("readonly must be true"),
    );
    writeFileSync(join(home, "akuma", "grok-review.md"), "---\nprovider: grok-build\nreadonly: true\n---\n");
    const grok = await loadArchetype({ name: "grok-review", home, settings: settingsValue });
    assert.deepEqual(grok.readonly, {
      enforcement: "none",
      diagnostic: "Grok Build cannot remove task-surface mutation capabilities",
    });
    assert.deepEqual(grok.options, { readonly: true });
    writeFileSync(join(home, "akuma", "unknown.md"), "---\nprovider: missing\n---\n");
    await assert.rejects(
      loadArchetype({ name: "unknown", home, settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.reason === "uses unknown provider missing"
        && error.searched[0] === join(home, "akuma", "unknown.md"),
    );
    await assert.rejects(
      loadArchetype({ name: "missing", home, settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.kind === "akuma-archetype"
        && error.searched[0] === join(home, "akuma", "missing.md")
        && error.message === "`missing` was not found\nuse `keiyaku ls aku/` to list available Akuma",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Archetype catalog lists canonical files in byte order without admitting contents", async () => {
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-archetype-catalog-"));
  try {
    const settingsValue = await settings({ home });
    const world = (await akumaAt(home, { home, settings: settingsValue }));
    assert.deepEqual(await world.listArchetypes(), []);

    mkdirSync(join(home, "akuma"));
    writeFileSync(join(home, "akuma", "zeta.md"), "not Archetype Markdown\n");
    writeFileSync(join(home, "akuma", "alpha.md"), "---\nprovider: claude\n---\n");
    writeFileSync(join(home, "akuma", "Upper.md"), "---\nprovider: claude\n---\n");
    writeFileSync(join(home, "akuma", "notes.txt"), "ignored\n");
    mkdirSync(join(home, "akuma", "directory.md"));

    assert.deepEqual(await world.listArchetypes(), ["alpha", "zeta"]);
    await assert.rejects(
      loadArchetype({ name: "zeta", home, settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError && error.kind === "akuma-archetype",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Archetype definition catalog decodes metadata without provider admission", async () => {
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-definition-catalog-"));
  try {
    mkdirSync(join(home, "akuma"));
    const settingsValue = await settings({ home });
    writeFileSync(join(home, "akuma", "reviewer.md"), [
      "---",
      "provider: provider-that-does-not-exist",
      "model: reviewer-model",
      "description: A complete description that is not truncated by the owner.",
      "---",
      "prompt",
      "",
    ].join("\n"));
    assert.deepEqual(await listArchetypeDefinitions({ home }), [{
      name: "reviewer",
      model: "reviewer-model",
      description: "A complete description that is not truncated by the owner.",
    }]);

    writeFileSync(join(home, "akuma", "broken.md"), "not frontmatter\n");
    await assert.rejects(
      listArchetypeDefinitions({ home }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.searched[0] === join(home, "akuma", "broken.md")
        && /must begin with YAML frontmatter/u.test(error.reason),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Archetype definition catalog reports the first invalid definition in byte order", async () => {
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-definition-catalog-first-invalid-"));
  try {
    mkdirSync(join(home, "akuma"));
    const settingsValue = await settings({ home });
    // alpha is first in byte order but slower to read, so a completion race would report bravo.
    writeFileSync(join(home, "akuma", "alpha.md"), "not frontmatter\n".repeat(100_000));
    writeFileSync(join(home, "akuma", "bravo.md"), "not frontmatter\n");
    await assert.rejects(
      listArchetypeDefinitions({ home }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.searched[0] === join(home, "akuma", "alpha.md")
        && /must begin with YAML frontmatter/u.test(error.reason),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Akuma home is independent of injected Settings provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-home-root-"));
  const homeA = mkdtempSync(join(tmpdir(), "keiyaku-akuma-home-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "keiyaku-akuma-home-b-"));
  try {
    mkdirSync(join(homeA, "akuma"));
    mkdirSync(join(homeB, "akuma"));
    writeFileSync(join(homeA, "settings.json"), JSON.stringify({
      providers: { local: { kind: "claude-agent-sdk", executable: "from-a" } },
    }));
    writeFileSync(join(homeA, "akuma", "decoy.md"), "---\nprovider: claude\n---\nFrom A.\n");
    writeFileSync(join(homeB, "akuma", "worker.md"), "---\nprovider: local\n---\nFrom B.\n");
    const settingsFromA = await settings({ home: homeA });
    const world = await akumaAt(root, { home: homeB, settings: settingsFromA });
    assert.deepEqual(await world.listArchetypes(), ["worker"]);
    const loaded = await loadArchetype({ name: "worker", home: homeB, settings: settingsFromA });
    assert.equal(loaded.path, join(homeB, "akuma", "worker.md"));
    assert.deepEqual(loaded.provider, {
      name: "local",
      kind: "claude-agent-sdk",
      executable: "from-a",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(homeA, { recursive: true, force: true });
    rmSync(homeB, { recursive: true, force: true });
  }
});

test("list keeps every ordinary birth window visible without creating files", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-list-birth-windows-"));
  try {
    const directoryOnly = await allocateAkumaDirectory({
      worldRoot: root, archetype: "claude", draw: () => "b1000001",
    });
    const before = readdirSync(directoryOnly.paths.directory);
    const heartOnly = await allocateAkumaDirectory({
      worldRoot: root, archetype: "claude", draw: () => "b1000002",
    });
    await initializeHeart(heartOnly.paths);
    unlinkSync(heartOnly.paths.leash);
    const both = await allocateAkumaDirectory({
      worldRoot: root, archetype: "reviewer", draw: () => "b1000003",
    });
    await initializeHeart(both.paths);
    const sealed = await allocateAkumaDirectory({
      worldRoot: root, archetype: "claude", draw: () => "b1000004",
    });
    await initializeHeart(sealed.paths);
    const holder = (await HeldAkumaLeash.try(sealed.paths))!;
    assert.equal(await holder.sealIfUnborn(sealed.paths, {
      evidence: "call-timeout",
      at: "2026-08-08T00:00:00.000Z",
    }), "sealed");
    mkdirSync(join(akumaRunRoot(root), "not-an-identity"));

    const world = await akumaAt(root);
    assert.deepEqual((await world.list()).rows, [
      { id: directoryOnly.id, life: "unborn" },
      { id: heartOnly.id, life: "unborn" },
      { id: sealed.id, life: "stillborn", seal: {
        evidence: "call-timeout", at: "2026-08-08T00:00:00.000Z",
      } },
      { id: both.id, life: "unborn" },
    ]);
    assert.deepEqual((await world.list({ archetype: "claude" })).rows.map((row) => row.id), [
      directoryOnly.id, heartOnly.id, sealed.id,
    ]);
    assert.deepEqual((await world.list({ archetype: "reviewer" })).rows, [
      { id: both.id, life: "unborn" },
    ]);
    assert.deepEqual(readdirSync(directoryOnly.paths.directory), before);
    assert.equal(existsSync(directoryOnly.paths.heart), false);
    assert.equal(existsSync(directoryOnly.paths.leash), false);
    assert.equal(existsSync(heartOnly.paths.leash), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("list silently skips identities whose compact row cannot be read", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-list-schema-cut-"));
  try {
    const heartCut = await allocateAkumaDirectory({
      worldRoot: root, archetype: "claude", draw: () => "c1000001",
    });
    const heart = new DatabaseSync(heartCut.paths.heart);
    heart.exec([
      "CREATE TABLE akuma_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);",
      "INSERT INTO akuma_schema VALUES (1, 13)",
    ].join(""));
    heart.close();
    const noise = join(akumaRunRoot(root), "NOISE-notid");
    mkdirSync(noise);
    const visible = await allocateAkumaDirectory({
      worldRoot: root, archetype: "claude", draw: () => "c1000003",
    });

    const world = await akumaAt(root);
    assert.deepEqual((await world.list()).rows, [{ id: visible.id, life: "unborn" }]);
    assert.equal(existsSync(noise), true);

    rmSync(heartCut.paths.directory, { recursive: true, force: true });
    const leashCut = await allocateAkumaDirectory({
      worldRoot: root, archetype: "claude", draw: () => "c1000002",
    });
    await initializeHeart(leashCut.paths);
    unlinkSync(leashCut.paths.leash);
    const leash = new DatabaseSync(leashCut.paths.leash);
    leash.exec([
      "CREATE TABLE leash_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);",
      "INSERT INTO leash_schema VALUES (1, 2)",
    ].join(""));
    leash.close();
    assert.deepEqual((await world.list()).rows, [{ id: visible.id, life: "unborn" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed turn is durable public evidence and never masquerades as provider activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-failed-turn-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "fa11ed00" });
    await initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        cwd: root,
      },
      initialBody: "fail",
    }, {
      async start() {
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          completion: Promise.resolve({ kind: "failed", diagnostic: "native failed" }),
          async abort() {},
        };
      },
    }, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    const handle = (await akumaAt(root)).of({ id: allocated.id });
    assert.equal((await handle.status()).timeline.kind === "idle"
      && (await handle.status()).timeline.outcome?.outcome.kind === "failed", true);
    const settled = await handle.wait();
    assert.equal(settled.life, "stranded");
    assert.equal(settled.timeline.kind === "idle" && settled.timeline.outcome?.outcome.kind === "failed", true);
    assert.equal("pending" in settled, false);
    assert.deepEqual((await handle.history()).rows.map((row) => row.kind), ["turn", "call", "outcome"]);
    assert.deepEqual((await timeline(allocated.paths)).filter((fact) => fact.kind === "turn-end").map((turn) => turn.outcome), [
      { kind: "failed", diagnostic: "native failed" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activity is persistent narration and old raw events fail the public hard cut", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-activity-law-"));
  try {
    const source = await answeredSource(root, "ac710001");
    const handle = (await akumaAt(root)).of({ id: source.id });
    const before = (await handle.status());
    const heart = new DatabaseSync(source.paths.heart);
    try {
      heart.exec("PRAGMA foreign_keys=ON");
      heart.prepare("DELETE FROM timeline WHERE kind = 'activity'").run();
    } finally { heart.close(); }
    const after = (await handle.status());
    assert.equal(after.timeline.entries.some((entry) => entry.kind === "row" && ["said", "thought", "note", "tool"].includes(entry.row.kind)), false);
    assert.equal((await handle.history()).rows.some((row) => ["said", "thought", "note", "tool"].includes(row.kind)), false);

    await appendActivity(source.paths, {
      turnSequence: 1,
      event: { type: "activity", event: { provider: "legacy", secret: "raw" } },
      at: "2026-08-08T00:00:01.000Z",
    });
    await assert.rejects(handle.history(), /invalid event shape/u);
    await assert.rejects(handle.status(), /invalid event shape/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kill gives the Body a grace window to abort its owned provider session", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-kill-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "fedcba98" });
    await initializeHeart(allocated.paths);
    let aborted = false;
    let settle!: (result: { kind: "failed"; diagnostic: string }) => void;
    const completion = new Promise<{ kind: "failed"; diagnostic: string }>((resolve) => { settle = resolve; });
    const running: ProviderAdapter = {
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
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
        };
      },
    };
    const launch: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        cwd: root,
      },
      initialBody: "keep working",
    };
    const body = driveAkumaBody(launch, running, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    while ((await readHeart(allocated.paths)).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));

    const handle = (await akumaAt(root)).of({ id: allocated.id });
    const waited = handle.wait();
    assert.equal(await handle.kill(), "killed");
    await body;
    assert.notEqual((await waited).life, "running");
    assert.equal(aborted, true);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.equal((await handle.status()).life, "killed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Akuma projects the already resolved WorldRoot without a second discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-relative-"));
  try {
    const coordinate = relative(process.cwd(), root);
    const world = await World.at(coordinate);
    assert.equal((await Akuma.of(world).list()).searched[0], resolve(world, ".keiyaku", "akuma", "run"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status reports a missing coordinate as not born without creating heart residue", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-not-born-"));
  try {
    const handle = (await akumaAt(root)).of({ id: "aku/claude/1234abcd" });
    await assert.rejects(handle.status(), { name: "AkumaNotBornError" });
    assert.equal(existsSync(join(root, ".keiyaku", "akuma", "run", "claude-1234abcd")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
