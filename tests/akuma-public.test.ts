import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Akuma, AkumaNotBornError } from "../src/akuma/akuma.js";
import { projectTurns, selectHistory, selectSnapshot } from "../src/akuma/projection.js";
import { AkumaArchetypeError, listArchetypeDefinitions, loadArchetype } from "../src/akuma/archetype.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import {
  activitySlice,
  appendActivity,
  HeldAkumaLeash,
  initializeHeart,
  pauseRequested,
  readHeart,
  recordTell,
} from "../src/akuma/heart/index.js";
import { akumaRunRoot, allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { settings } from "../src/settings.js";
import { World } from "../src/world.js";

const CLAUDE_EXECUTION = { name: "claude", kind: "claude-agent-sdk" } as const;

async function akumaAt(root: string, value?: Awaited<ReturnType<typeof settings>>) {
  return Akuma.of(await World.at(root), value);
}

function timeline(paths: Parameters<typeof activitySlice>[0]) {
  return activitySlice(paths, { limit: 5_000 }).rows;
}

test("forward history reports a pruned interval after its cursor", () => {
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

test("tell refuses an unborn address without leaving durable input", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-tell-unborn-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a10004" });
    initializeHeart(allocated.paths);
    await assert.rejects((await akumaAt(root)).of({ id: allocated.id }).tell("future input"), AkumaNotBornError);
    assert.deepEqual(readHeart(allocated.paths).pending, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("interrupt refuses an unborn address without leaving durable input or control", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-unborn-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a10005" });
    initializeHeart(allocated.paths);
    const holder = HeldAkumaLeash.try(allocated.paths)!;
    try {
      await assert.rejects((await akumaAt(root)).of({ id: allocated.id }).interrupt("future input"), AkumaNotBornError);
      assert.deepEqual(readHeart(allocated.paths).pending, []);
      assert.equal(pauseRequested(allocated.paths), false);
    } finally { holder.release(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const provider: ProviderAdapter = {
  confinement: () => ({ kind: "unconfined" }),
  admitOptions(options) { return { kind: "admitted", options }; },
  async start() {
    return {
      admission: { fence: "public-fixture-turn" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "public-session" } };
          yield { type: "assistant" as const, text: "working" };
        },
      },
      completion: Promise.resolve({ kind: "answered", answer: "public answer", historyId: "public-history" }),
      async abort() {},
    };
  },
};

async function answeredSource(root: string, suffix: string) {
  const world = await World.at(root);
  const allocated = allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => suffix });
  initializeHeart(allocated.paths);
  await driveAkumaBody({
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      description: "Fork source",
      provider: CLAUDE_EXECUTION,
      options: { model: "fixture-model" },
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      cwd: world,
    },
    initialBody: "work",
  }, provider, {
    now: () => "2026-08-08T00:00:00.000Z",
  });
  return allocated;
}

type MutableProvider = { -readonly [Key in keyof ProviderAdapter]: ProviderAdapter[Key] };

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
  assert.deepEqual(snapshot.entries.map((entry) => entry.row.sequence), [7, 8]);
  assert.equal(snapshot.omitted, 2);
  assert.equal(snapshot.entries.some((entry) => entry.row.kind === "tool" && entry.row.state === "active"), true);
  assert.equal(snapshot.entries.some((entry) => entry.row.sequence === 2), false);
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
  assert.deepEqual(idle.entries.map((entry) => entry.row.sequence), [7]);
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

test("open snapshot independently retains pre-tail voice and actionable pins", () => {
  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "activity" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", event: { type: "assistant", text: "voice one" } },
    { kind: "activity" as const, sequence: 3, turnSequence: 1, at: "2026-08-10T00:00:03.000Z", event: { type: "thought", text: "voice two" } },
    { kind: "activity" as const, sequence: 4, turnSequence: 1, at: "2026-08-10T00:00:04.000Z", event: { type: "assistant", text: "voice three" } },
    { kind: "activity" as const, sequence: 5, turnSequence: 1, at: "2026-08-10T00:00:05.000Z", event: { type: "note", text: "hidden note" } },
    { kind: "call" as const, sequence: 6, turnSequence: 1, at: "2026-08-10T00:00:06.000Z", body: "hidden call" },
    { kind: "activity" as const, sequence: 7, turnSequence: 1, at: "2026-08-10T00:00:07.000Z", event: { type: "tool", phase: "started", id: "pinned", name: "Search", call: { kind: "search", query: "pin" } } },
    { kind: "tell" as const, sequence: 8, id: "tell-pinned", body: "pinned input", recordedAt: "2026-08-10T00:00:08.000Z", state: "pending" as const, deliveries: [] },
    { kind: "activity" as const, sequence: 9, turnSequence: 1, at: "2026-08-10T00:00:09.000Z", event: { type: "note", text: "tail note" } },
    { kind: "activity" as const, sequence: 10, turnSequence: 1, at: "2026-08-10T00:00:10.000Z", event: { type: "assistant", text: "tail voice" } },
    { kind: "activity" as const, sequence: 11, turnSequence: 1, at: "2026-08-10T00:00:11.000Z", event: { type: "thought", text: "tail thought" } },
  ]);

  const snapshot = selectSnapshot(ledger, { tail: 3, voice: 3 });
  assert.equal(snapshot.kind, "open");
  if (snapshot.kind !== "open") return;
  const sequences = snapshot.entries.map((entry) => entry.row.sequence);
  assert.deepEqual(sequences, [2, 3, 4, 7, 8, 9, 10, 11]);
  assert.equal(new Set(sequences).size, sequences.length);
  assert.equal(snapshot.omitted, 2);

  const pinnedOnly = selectSnapshot(ledger, { tail: 0, voice: 0 });
  assert.equal(pinnedOnly.kind, "open");
  if (pinnedOnly.kind !== "open") return;
  assert.deepEqual(pinnedOnly.entries.map((entry) => entry.row.sequence), [7, 8]);
  assert.equal(pinnedOnly.omitted, 8);
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
    const leash = HeldAkumaLeash.try(source.paths)!;
    try {
      const handle = (await akumaAt(root)).of({ id: source.id });
      const expected = handle.status();
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
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a10006" });
    initializeHeart(allocated.paths);
    const noPointProvider: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          admission: { fence: "no-point-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "no-point-session" } };
            },
          },
          completion: Promise.resolve({ kind: "answered" as const, answer: "complete without fork" }),
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
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "work",
    }, noPointProvider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });

    const handle = (await akumaAt(root)).of({ id: allocated.id });
    assert.deepEqual(handle.lastAnswer(), { kind: "answer", answer: "complete without fork" });
    assert.deepEqual(handle.history().rows.find((row) => row.kind === "outcome")?.outcome, {
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
    assert.equal(child.status().life, "asleep");
    const childPaths = pathsForAkuId(root, receipt.child);
    const snapshot = readHeart(childPaths);
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
    assert.deepEqual(timeline(childPaths).filter((fact) => fact.kind === "turn-start"), []);
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
      const unborn = allocateAkumaDirectory({ worldRoot: unbornRoot, archetype: "claude", draw: () => "f0a10003" });
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
    const admitted = recordTell(source.paths, {
      id: "resume-unsupported-tell",
      body: "continue",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(admitted.kind, "recorded");
    await driveAkumaBody({ paths: source.paths }, claudeProvider, {
      now: () => "2026-08-08T00:00:02.000Z",
    });
    const status = handle.status();
    assert.equal(status.life, "stranded");
    assert.equal(status.strandedReason, "resume-unsupported");
    assert.equal(status.timeline.entries.some((entry) => entry.kind === "row" && entry.row.kind === "outcome" && entry.row.outcome.kind === "failed"), false);
    const listed = (await (await akumaAt(root)).list()).rows[0]!;
    assert.equal("pending" in listed && listed.pending.includes("resume-unsupported-tell"), true);
    assert.equal(timeline(source.paths).filter((fact) => fact.kind === "turn-start").length, 1);
    assert.equal(timeline(source.paths).find((fact) => fact.kind === "turn-end")?.outcome.kind, "answered");
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
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
    initializeHeart(allocated.paths);
    assert.equal((await world.list()).rows[0]?.life, "unborn");
    assert.equal((await world.list({ archetype: "claude" })).rows[0]?.id, allocated.id);
    assert.deepEqual((await world.list({ archetype: "reviewer" })).rows, []);
    await assert.rejects(world.list({ archetype: "not/a-name" }), /Akuma archetype/);
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
        confinement: { kind: "unconfined" },
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
    assert.equal("history" in listed, false);
    assert.equal("answer" in listed, false);
    assert.equal(listed.archetype, "claude");
    assert.equal(listed.description, "Fixture akuma");
    assert.deepEqual(listed.confinement, { kind: "unconfined" });
    assert.deepEqual(listed.pending, []);
    const status = handle.status();
    assert.equal(status.life, "asleep");
    assert.equal("archetype" in status, false);
    assert.equal("description" in status, false);
    assert.equal("confinement" in status, false);
    assert.equal("pending" in status, false);
    assert.equal(status.timeline.kind, "idle");
    assert.equal(status.timeline.kind === "idle" && status.timeline.outcome?.outcome.kind === "answered", true);
    assert.equal("history" in status, false);
    assert.deepEqual(handle.history().rows.find((row) => row.kind === "outcome")?.outcome, {
      kind: "answered",
      answer: "public answer",
      historyId: "public-history",
      session: { sessionId: "public-session" },
    });
    assert.deepEqual(status.timeline.entries, []);
    assert.deepEqual(await handle.wait((candidate) => candidate.timeline.kind === "idle"
      && candidate.timeline.outcome?.outcome.kind === "answered"), status);
    assert.equal(await handle.kill(), "already-stopped");
    assert.equal(handle.status().life, "asleep");
    assert.equal(handle.status().timeline.kind === "idle"
      && handle.status().timeline.outcome?.outcome.kind === "answered", true);
    assert.equal(await handle.kill(), "already-stopped");
    assert.equal(pauseRequested(allocated.paths), false);
    assert.deepEqual(timeline(allocated.paths).find((fact) => fact.kind === "turn-end")?.outcome, {
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
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0006" });
    initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: { model: "fixture-model" },
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: seat,
      },
      initialBody: "first",
    }, provider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });

    const handle = (await akumaAt(root)).of({ id: allocated.id });
    assert.equal(await handle.kill(), "already-stopped");
    assert.equal(handle.status().life, "asleep");

    rmSync(seat, { recursive: true, force: true });
    const told = await handle.tell("continue");
    assert.equal(typeof told.wake, "object");
    assert.deepEqual(readHeart(allocated.paths).pending.map((tell) => tell.id), [told.admission.tellId]);

    let resumed: Parameters<NonNullable<ProviderAdapter["resume"]>>[0] | undefined;
    const successor: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
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
    const { signal, ...resumedInput } = resumed!;
    assert.equal(signal.aborted, false);
    assert.deepEqual(resumedInput, {
      body: "",
      launchTells: [{ id: told.admission.tellId, text: "continue" }],
      cwd: seat,
      options: { model: "fixture-model" },
      session: { kind: "resume", coordinate: { sessionId: "public-session" } },
    });
    assert.equal(readHeart(allocated.paths).latestBody?.sequence, 2);
    assert.deepEqual(readHeart(allocated.paths).pending, []);
    assert.equal(handle.history().rows.some((row) => row.kind === "tell"
      && row.tellId === told.admission.tellId && row.state === "told"), true);
    assert.equal(handle.status().life, "asleep");
    assert.equal(handle.status().timeline.kind === "idle"
      && handle.status().timeline.outcome?.outcome.kind === "answered", true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt records a tell only after taking an idle leash", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-idle-"));
  const seat = join(root, "seat");
  try {
    mkdirSync(seat);
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0001" });
    initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
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
    assert.equal(pauseRequested(allocated.paths), false);
    assert.deepEqual(readHeart(allocated.paths).pending.map((tell) => tell.id), [receipt.tell.admission.tellId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt waits for a running body to self-abort before recording the tell", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-running-"));
  const seat = join(root, "seat");
  try {
    mkdirSync(seat);
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0002" });
    initializeHeart(allocated.paths);
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
        confinement: { kind: "unconfined" },
        cwd: seat,
      },
      initialBody: "work",
    }, {
      confinement: () => ({ kind: "unconfined" }),
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
    while (readHeart(allocated.paths).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));
    rmSync(seat, { recursive: true, force: true });

    const receipt = await (await akumaAt(root)).of({ id: allocated.id }).interrupt("replace it");
    await body;
    assert.equal(receipt.kind, "interrupted");
    if (receipt.kind !== "interrupted") return;
    assert.equal(receipt.putDown, "self-aborted");
    assert.equal(aborted, true);
    assert.equal(readHeart(allocated.paths).latestBody?.end, "put-down");
    assert.equal(pauseRequested(allocated.paths), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt reports untidy when a free leash has no clean Body settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-unstoppable-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0003" });
    initializeHeart(allocated.paths);
    const holder = HeldAkumaLeash.try(allocated.paths)!;
    holder.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      cwd: root,
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    holder.recordBody(allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
    holder.release();
    assert.deepEqual(await (await akumaAt(root)).of({ id: allocated.id }).interrupt("never recorded"), {
      kind: "unavailable",
      evidence: "untidy",
    });
    assert.equal(pauseRequested(allocated.paths), false);
    assert.deepEqual(readHeart(allocated.paths).pending, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt reports hung when the Body does not release its held leash", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-held-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1d1e0005" });
    initializeHeart(allocated.paths);
    const holder = HeldAkumaLeash.try(allocated.paths)!;
    holder.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      cwd: root,
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    const body = holder.recordBody(allocated.paths, {
      leashTakenAt: "2026-08-08T00:00:00.000Z",
    });
    holder.recordBodyHung(allocated.paths, {
      sequence: body.sequence,
      diagnostic: "provider custody remained live",
      at: "2026-08-08T00:00:01.000Z",
    });
    try {
      const handle = (await akumaAt(root)).of({ id: allocated.id });
      assert.deepEqual(await handle.interrupt("never recorded"), {
        kind: "unavailable",
        evidence: "hung",
      });
      assert.equal(handle.status().life, "hung");
      assert.equal(pauseRequested(allocated.paths), true);
      assert.deepEqual(readHeart(allocated.paths).pending, []);
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
      "access: read",
      "description: Careful reviewer",
      "editor:",
      "  theme: dark",
      "tags: [review, careful]",
      "revision: 3",
      "---",
      "Review the change from first principles.",
      "",
    ].join("\n"));
    const loaded = await loadArchetype({ name: "reviewer", settings: settingsValue });
    const { adapter, ...definition } = loaded;
    assert.equal(typeof adapter.start, "function");
    assert.deepEqual(definition, {
      name: "reviewer",
      path: join(home, "akuma", "reviewer.md"),
      provider: CLAUDE_EXECUTION,
      description: "Careful reviewer",
      options: {
        model: "claude-sonnet-4-5",
        effort: "high",
        access: "read",
        systemPrompt: "Review the change from first principles.\n",
      },
    });
    writeFileSync(join(home, "akuma", "invalid.md"), "---\nprovider: claude\naccess: execute\n---\n");
    await assert.rejects(
      loadArchetype({ name: "invalid", settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.searched[0] === join(home, "akuma", "invalid.md"),
    );
    writeFileSync(join(home, "akuma", "unknown.md"), "---\nprovider: missing\n---\n");
    await assert.rejects(
      loadArchetype({ name: "unknown", settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.reason === "uses unknown provider missing"
        && error.searched[0] === join(home, "akuma", "unknown.md"),
    );
    await assert.rejects(
      loadArchetype({ name: "missing", settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.kind === "akuma-archetype"
        && error.searched[0] === join(home, "akuma", "missing.md"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Archetype catalog lists canonical files in byte order without admitting contents", async () => {
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-archetype-catalog-"));
  try {
    const settingsValue = await settings({ home });
    const world = (await akumaAt(home, settingsValue));
    assert.deepEqual(await world.listArchetypes(), []);

    mkdirSync(join(home, "akuma"));
    writeFileSync(join(home, "akuma", "zeta.md"), "not Archetype Markdown\n");
    writeFileSync(join(home, "akuma", "alpha.md"), "---\nprovider: claude\n---\n");
    writeFileSync(join(home, "akuma", "Upper.md"), "---\nprovider: claude\n---\n");
    writeFileSync(join(home, "akuma", "notes.txt"), "ignored\n");
    mkdirSync(join(home, "akuma", "directory.md"));

    assert.deepEqual(await world.listArchetypes(), ["alpha", "zeta"]);
    await assert.rejects(
      loadArchetype({ name: "zeta", settings: settingsValue }),
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
    assert.deepEqual(await listArchetypeDefinitions({ settings: settingsValue }), [{
      name: "reviewer",
      model: "reviewer-model",
      description: "A complete description that is not truncated by the owner.",
    }]);

    writeFileSync(join(home, "akuma", "broken.md"), "not frontmatter\n");
    await assert.rejects(
      listArchetypeDefinitions({ settings: settingsValue }),
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
      listArchetypeDefinitions({ settings: settingsValue }),
      (error: unknown) => error instanceof AkumaArchetypeError
        && error.searched[0] === join(home, "akuma", "alpha.md")
        && /must begin with YAML frontmatter/u.test(error.reason),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("list distinguishes sealed residue from an unclaimed birth", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-seal-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "abcdef12" });
    initializeHeart(allocated.paths);
    const leash = HeldAkumaLeash.try(allocated.paths)!;
    assert.equal(leash.sealIfUnborn(allocated.paths, {
      evidence: "fixture-abandonment",
      at: "2026-08-08T00:00:00.000Z",
    }), "sealed");
    assert.deepEqual((await (await akumaAt(root)).list()).rows, [{
      id: allocated.id,
      life: "stillborn",
      seal: { evidence: "fixture-abandonment", at: "2026-08-08T00:00:00.000Z" },
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed turn is durable public evidence and never masquerades as provider activity", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-failed-turn-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "fa11ed00" });
    initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "fail",
    }, {
      confinement: () => ({ kind: "unconfined" }),
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
    assert.equal(handle.status().timeline.kind === "idle"
      && handle.status().timeline.outcome?.outcome.kind === "failed", true);
    const settled = await handle.wait();
    assert.equal(settled.life, "stranded");
    assert.equal(settled.timeline.kind === "idle" && settled.timeline.outcome?.outcome.kind === "failed", true);
    assert.equal("pending" in settled, false);
    assert.deepEqual(handle.history().rows.map((row) => row.kind), ["turn", "call", "outcome"]);
    assert.deepEqual(timeline(allocated.paths).filter((fact) => fact.kind === "turn-end").map((turn) => turn.outcome), [
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
    const before = handle.status();
    const heart = new DatabaseSync(source.paths.heart);
    try {
      heart.exec("PRAGMA foreign_keys=ON");
      heart.prepare("DELETE FROM timeline WHERE kind = 'activity'").run();
    } finally { heart.close(); }
    const after = handle.status();
    assert.equal(after.timeline.entries.some((entry) => entry.kind === "row" && ["said", "thought", "note", "tool"].includes(entry.row.kind)), false);
    assert.equal(handle.history().rows.some((row) => ["said", "thought", "note", "tool"].includes(row.kind)), false);

    appendActivity(source.paths, {
      turnSequence: 1,
      event: { type: "activity", event: { provider: "legacy", secret: "raw" } },
      at: "2026-08-08T00:00:01.000Z",
    });
    assert.throws(() => handle.history(), /invalid event shape/u);
    assert.throws(() => handle.status(), /invalid event shape/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kill gives the Body a grace window to abort its owned provider session", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-kill-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "fedcba98" });
    initializeHeart(allocated.paths);
    let aborted = false;
    let settle!: (result: { kind: "failed"; diagnostic: string }) => void;
    const completion = new Promise<{ kind: "failed"; diagnostic: string }>((resolve) => { settle = resolve; });
    const running: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
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
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "keep working",
    };
    const body = driveAkumaBody(launch, running, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    while (readHeart(allocated.paths).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));

    const handle = (await akumaAt(root)).of({ id: allocated.id });
    const waited = handle.wait();
    assert.equal(await handle.kill(), "killed");
    await body;
    assert.notEqual((await waited).life, "running");
    assert.equal(aborted, true);
    assert.equal(readHeart(allocated.paths).latestBody?.end, "put-down");
    assert.equal(handle.status().life, "killed");
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
    assert.throws(() => handle.status(), { name: "AkumaNotBornError" });
    assert.equal(existsSync(join(root, ".keiyaku", "akuma", "run", "claude-1234abcd")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
