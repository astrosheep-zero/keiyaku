import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import { HeldAkumaLeash, admitRequest, initializeHeart, pauseRequested, probeLeash, readHeart, readRequest, readSoul, readTurns, recordTell, requestPause, requestStop, stopRequested, type AkuId, type ProviderOptions } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import type { AgentEvent, ProviderAdapter, TurnResult } from "../src/akuma/provider.js";
import { requestBodyCall } from "../src/akuma/requests.js";

function adapter(input: Readonly<{
  events: readonly AgentEvent[];
  result: TurnResult;
  starts: Array<Readonly<{
    body: string;
    launchTells: readonly Readonly<{ id: string; text: string }>[];
    options: ProviderOptions;
    session: "fresh" | string;
  }>>;
}>): ProviderAdapter {
  const drive = async (
    call: Parameters<ProviderAdapter["start"]>[0]
      | Parameters<NonNullable<ProviderAdapter["resume"]>>[0],
  ) => {
    assert.equal(call.requests, undefined);
    input.starts.push({
      body: call.body,
      launchTells: call.launchTells,
      options: call.options,
      session: call.session.kind === "fresh" ? "fresh" : call.session.coordinate.sessionId,
    });
    return {
      admission: { fence: `fixture-${input.starts.length}` },
      events: {
        async *[Symbol.asyncIterator]() {
          for (const event of input.events) yield event;
        },
      },
      completion: Promise.resolve(input.result),
      async abort() {},
    };
  };
  return {
    confinement: () => ({ kind: "unconfined" }),
    admitOptions(options) { return { kind: "admitted", options }; },
    start: drive,
    resume: drive,
  };
}

test("body births, admits native session, records the turn, and exits only when idle", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-body-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
    initializeHeart(allocated.paths);
    const launch: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { model: "claude-sonnet-4-5", effort: "high", systemPrompt: "Build carefully." },
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "build it",
    };
    const starts: Array<Readonly<{
      body: string;
      launchTells: readonly Readonly<{ id: string; text: string }>[];
      options: ProviderOptions;
      session: "fresh" | string;
    }>> = [];
    await driveAkumaBody(launch, adapter({
      starts,
      events: [
        { type: "session", coordinate: { sessionId: "native-1" } },
        { type: "assistant", text: "working" },
      ],
      result: { kind: "answered", answer: "done", historyId: "history-1" },
    }), {
      collar: { pid: 999_999, processGroup: 999_999, spawnedAt: "fixture" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });

    const first = readHeart(allocated.paths);
    assert.equal(probeLeash(allocated.paths), "free");
    assert.equal(first.soul?.id, allocated.id);
    assert.equal(first.latestSession?.coordinate.sessionId, "native-1");
    assert.deepEqual(first.latestSession?.options, {
      model: "claude-sonnet-4-5", effort: "high", systemPrompt: "Build carefully.",
    });
    assert.deepEqual(readTurns(allocated.paths)[0]?.outcome, {
      kind: "answered",
      answer: "done",
      historyId: "history-1",
      session: { sessionId: "native-1" },
    });
    assert.equal(first.latestBody?.end, "exited");
    assert.deepEqual(starts, [{
      body: "build it",
      launchTells: [],
      options: { model: "claude-sonnet-4-5", effort: "high", systemPrompt: "Build carefully." },
      session: "fresh",
    }]);

    recordTell(allocated.paths, {
      id: "tell-1",
      body: "adjust it",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await driveAkumaBody({ paths: allocated.paths }, adapter({
      starts,
      events: [{ type: "action", note: "Started" }],
      result: { kind: "answered", answer: "adjusted", historyId: "history-2" },
    }), {
      collar: { pid: 999_998, processGroup: 999_998, spawnedAt: "fixture-2" },
      now: () => "2026-08-08T00:00:02.000Z",
      async putDownOwnTree() {},
    });

    const second = readHeart(allocated.paths);
    assert.deepEqual(starts, [
      {
        body: "build it",
        launchTells: [],
        options: { model: "claude-sonnet-4-5", effort: "high", systemPrompt: "Build carefully." },
        session: "fresh",
      },
      {
        body: "",
        launchTells: [{ id: "tell-1", text: "adjust it" }],
        options: { model: "claude-sonnet-4-5", effort: "high", systemPrompt: "Build carefully." },
        session: "native-1",
      },
    ]);
    assert.deepEqual(readTurns(allocated.paths)[1]?.outcome, {
      kind: "answered",
      answer: "adjusted",
      historyId: "history-2",
      session: { sessionId: "native-1" },
    });
    assert.deepEqual(second.pending, []);
    assert.equal(second.latestBody?.end, "exited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live receipt persistence waits for its Body-scoped delivery mapping", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-live-tell-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1a2b3c4d" });
    initializeHeart(allocated.paths);
    let releaseEvents!: () => void;
    const eventsReleased = new Promise<void>((resolve) => { releaseEvents = resolve; });
    let releaseReceipt!: () => void;
    const receiptReleased = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    let tellObserved!: () => void;
    const observed = new Promise<void>((resolve) => { tellObserved = resolve; });
    const live: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          admission: { fence: "initial-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "live-session" } };
              await eventsReleased;
            },
          },
          receipts: {
            async *[Symbol.asyncIterator]() {
              await receiptReleased;
              yield { evidence: "fence" as const, fence: "live-fence", kind: "accepted" };
            },
          },
          completion: Promise.resolve({ kind: "answered", answer: "done", historyId: "live-history" }),
          async tell() {
            releaseReceipt();
            tellObserved();
            return { fence: "live-fence" };
          },
          async abort() {},
        };
      },
    };
    const body = driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "work",
    }, live, {
      collar: { pid: 999_978, processGroup: 999_978, spawnedAt: "live-tell" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    while (readHeart(allocated.paths).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));
    recordTell(allocated.paths, {
      id: "tell-live", body: "steer", recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await observed;
    releaseEvents();
    await body;
    assert.deepEqual(readHeart(allocated.paths).pending, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt persistence failure aborts the Session and terminates the Body", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-receipt-failure-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1a2b3c4e" });
    initializeHeart(allocated.paths);
    let aborted = false;
    let releaseEvents!: () => void;
    const eventsReleased = new Promise<void>((resolve) => { releaseEvents = resolve; });
    const body = driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "work",
    }, {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          admission: { fence: "launch" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "receipt-failure-session" } };
              await eventsReleased;
            },
          },
          receipts: {
            async *[Symbol.asyncIterator]() {
              yield { evidence: "fence" as const, fence: "unknown", kind: "accepted" };
            },
          },
          completion: new Promise<TurnResult>(() => {}),
          async abort() { aborted = true; releaseEvents(); },
        };
      },
    }, {
      collar: { pid: 999_977, processGroup: 999_977, spawnedAt: "receipt-failure" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });

    await body;
    assert.equal(aborted, true);
    assert.equal(readHeart(allocated.paths).latestBody?.end, "broke-off");
    assert.deepEqual(readTurns(allocated.paths).at(-1)?.outcome, {
      kind: "failed",
      diagnostic: "tell receipt has no delivery mapping",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared drive drains Body Requests before recording its terminal turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-body-requests-"));
  const priorHome = process.env.HOME;
  const home = join(root, "home");
  mkdirSync(join(home, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(home, ".keiyaku", "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  process.env.HOME = home;
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
    initializeHeart(allocated.paths);
    const recoveredRequestId = "00000000-0000-4000-8000-000000000020";
    admitRequest(allocated.paths, {
      id: recoveredRequestId,
      archetype: "worker",
      body: "crashed nested work",
      world: root,
      recipe: {
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { systemPrompt: "Work.\n" },
        confinement: { kind: "unconfined" },
      },
      admittedAt: "2026-08-09T00:00:00.000Z",
    });
    const staleTransport = join(allocated.paths.directory, "requests", "1", `${recoveredRequestId}.request.json`);
    mkdirSync(join(allocated.paths.directory, "requests", "1"), { recursive: true });
    writeFileSync(staleTransport, "stale");
    let requestDirectory: string | undefined;
    let childId: AkuId | undefined;
    const provider: ProviderAdapter = {
      confinement: () => ({ kind: "declared", writableRoots: [root] }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start(input) {
        assert.ok(input.requests);
        assert.equal(existsSync(staleTransport), false);
        assert.equal(input.requests.dir, join(allocated.paths.directory, "requests", "1"));
        requestDirectory = input.requests.dir;
        childId = await requestBodyCall({
          directory: input.requests.dir,
          id: "00000000-0000-4000-8000-000000000021",
          world: root,
          archetype: "worker",
          body: "nested work",
          recipe: {
            provider: { name: "claude", kind: "claude-agent-sdk" },
            options: { systemPrompt: "Work.\n" },
            confinement: { kind: "unconfined" },
          },
        });
        return {
          admission: { fence: "body-request-parent-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "parent-session" } };
            },
          },
          completion: Promise.resolve({ kind: "answered", answer: "parent done", historyId: "parent-turn" }),
          async abort() {},
        };
      },
    };
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "parent",
        provider: { name: "codex-app-server", kind: "codex-app-server" },
        options: { access: "write" },
        origin: { kind: "direct" },
        confinement: { kind: "declared", writableRoots: [root] },
        cwd: root,
      },
      initialBody: "parent work",
    }, provider, {
      collar: { pid: 999_997, processGroup: 999_997, spawnedAt: "body-request-parent" },
      now: () => "2026-08-09T00:00:00.000Z",
      async putDownOwnTree() {},
      async spawnChild(launch) {
        const child = HeldAkumaLeash.try(launch.paths)!;
        child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-09T00:00:01.000Z" });
        child.release();
        return { pid: 999_996, processGroup: 999_996, spawnedAt: "body-request-child" };
      },
    });

    assert.ok(childId);
    assert.equal(readRequest(allocated.paths, recoveredRequestId)?.state, "voided");
    assert.deepEqual(readSoul(pathsForAkuId(root, childId))?.origin, {
      kind: "request",
      parentId: allocated.id,
      requestId: "00000000-0000-4000-8000-000000000021",
    });
    assert.equal(readRequest(allocated.paths, "00000000-0000-4000-8000-000000000021")?.state, "served");
    assert.equal(readTurns(allocated.paths).at(-1)?.outcome.kind, "answered");
    assert.equal(requestDirectory === undefined ? true : existsSync(requestDirectory), false);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fork-born body sleeps without a turn and its first tell resumes the child session", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-body-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a1b0d1" });
    initializeHeart(allocated.paths);
    const starts: Array<Readonly<{
      body: string;
      launchTells: readonly Readonly<{ id: string; text: string }>[];
      options: ProviderOptions;
      session: "fresh" | string;
    }>> = [];
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { model: "soul-model" },
        origin: { kind: "fork", parent: "aku/claude/1234abcd" as typeof allocated.id, at: "history-1" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      birthSession: {
        provider: "claude",
        coordinate: { sessionId: "native-child" },
        cwd: join(root, "session-seat"),
        options: { model: "fork-recipe" },
        admittedAt: "2026-08-08T00:00:00.000Z",
      },
    }, adapter({
      starts,
      events: [],
      result: { kind: "failed", diagnostic: "must not start" },
    }), {
      collar: { pid: 999_980, processGroup: 999_980, spawnedAt: "fork-birth" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    assert.deepEqual(starts, []);
    assert.deepEqual(readTurns(allocated.paths), []);
    assert.equal(readHeart(allocated.paths).latestBody?.end, "exited");

    recordTell(allocated.paths, { id: "tell-fork", body: "continue", recordedAt: "2026-08-08T00:00:01.000Z" });
    await driveAkumaBody({ paths: allocated.paths }, adapter({
      starts,
      events: [],
      result: { kind: "answered", answer: "continued", historyId: "history-2" },
    }), {
      collar: { pid: 999_981, processGroup: 999_981, spawnedAt: "fork-wake" },
      now: () => "2026-08-08T00:00:02.000Z",
      async putDownOwnTree() {},
    });
    assert.deepEqual(starts, [{
      body: "",
      launchTells: [{ id: "tell-fork", text: "continue" }],
      options: { model: "fork-recipe" },
      session: "native-child",
    }]);
    assert.deepEqual(readTurns(allocated.paths)[0]?.outcome, {
      kind: "answered",
      answer: "continued",
      historyId: "history-2",
      session: { sessionId: "native-child" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the soul retains the summon cwd before native session admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-seat-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "87654321" });
    initializeHeart(allocated.paths);
    const launch: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: join(root, "custom-seat"),
      },
      initialBody: "start",
    };
    await driveAkumaBody(launch, adapter({
      starts: [],
      events: [],
      result: { kind: "failed", diagnostic: "failed before session" },
    }), {
      collar: { pid: 999_995, processGroup: 999_995, spawnedAt: "seat-fixture" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    assert.equal(readHeart(allocated.paths).soul?.cwd, join(root, "custom-seat"));
    assert.deepEqual(readTurns(allocated.paths)[0]?.outcome, {
      kind: "failed", diagnostic: "failed before session",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an answer without an admitted or resumed session is retained as a failed turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-sessionless-answer-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "decafbad" });
    initializeHeart(allocated.paths);
    await driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "start",
    }, adapter({
      starts: [],
      events: [],
      result: { kind: "answered", answer: "unforkable", historyId: "missing-session" },
    }), {
      collar: { pid: 999_991, processGroup: 999_991, spawnedAt: "sessionless-answer" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    assert.deepEqual(readTurns(allocated.paths)[0]?.outcome, {
      kind: "failed",
      diagnostic: "Provider answered without a resumable session",
    });
    assert.equal(readHeart(allocated.paths).latestBody?.end, "broke-off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successor settles an abandoned Body-scoped stop before creating its Body", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-orphan-stop-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "a1b2c3d4" });
    initializeHeart(allocated.paths);
    const base: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "first",
    };
    await driveAkumaBody(base, adapter({
      starts: [],
      events: [{ type: "session", coordinate: { sessionId: "orphan-session" } }],
      result: { kind: "answered", answer: "first", historyId: "orphan-history-1" },
    }), {
      collar: { pid: 999_994, processGroup: 999_994, spawnedAt: "orphan-1" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    const stopped = requestStop(allocated.paths, "2026-08-08T00:00:01.000Z");
    assert.equal(stopped.kind, "requested");
    assert.equal(requestPause(allocated.paths, "2026-08-08T00:00:01.000Z"), "requested");
    assert.equal(stopRequested(allocated.paths), true);
    assert.equal(pauseRequested(allocated.paths), true);
    recordTell(allocated.paths, {
      id: "orphan-tell",
      body: "continue",
      recordedAt: "2026-08-08T00:00:02.000Z",
    });
    const wake: BodyLaunch = { paths: base.paths };
    await driveAkumaBody(wake, adapter({
      starts: [], events: [], result: { kind: "answered", answer: "continued", historyId: "orphan-history-2" },
    }), {
      collar: { pid: 999_993, processGroup: 999_993, spawnedAt: "orphan-2" },
      now: () => "2026-08-08T00:00:03.000Z",
      async putDownOwnTree() {},
    });
    assert.equal(stopRequested(allocated.paths), false);
    assert.equal(pauseRequested(allocated.paths), false);
    const snapshot = readHeart(allocated.paths);
    assert.equal(snapshot.latestKill?.bodySequence, stopped.body.sequence);
    assert.equal(snapshot.latestBody?.sequence, stopped.body.sequence + 1);
    assert.notEqual(snapshot.latestKill?.bodySequence, snapshot.latestBody?.sequence);
    assert.deepEqual(readTurns(allocated.paths).at(-1)?.outcome, {
      kind: "answered",
      answer: "continued",
      historyId: "orphan-history-2",
      session: { sessionId: "orphan-session" },
    });
    assert.equal(snapshot.latestBody?.end, "exited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause aborts the current drive and records the body as put down", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-pause-"));
  try {
    const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "c0ffee00" });
    initializeHeart(allocated.paths);
    let aborted = false;
    let settle!: (result: TurnResult) => void;
    const completion = new Promise<TurnResult>((resolve) => { settle = resolve; });
    const running: ProviderAdapter = {
      confinement: () => ({ kind: "unconfined" }),
      admitOptions(options) { return { kind: "admitted", options }; },
      async start() {
        return {
          admission: { fence: "pause-fixture-turn" },
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
            settle({ kind: "failed", diagnostic: "paused" });
          },
        };
      },
    };
    const body = driveAkumaBody({
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        confinement: { kind: "unconfined" },
        cwd: root,
      },
      initialBody: "work",
    }, running, {
      collar: { pid: 999_989, processGroup: 999_989, spawnedAt: "pause-fixture" },
      now: () => "2026-08-08T00:00:00.000Z",
      async putDownOwnTree() {},
    });
    while (readHeart(allocated.paths).latestBody === null) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(requestPause(allocated.paths, "2026-08-08T00:00:01.000Z"), "requested");
    await body;
    assert.equal(aborted, true);
    assert.equal(readHeart(allocated.paths).latestBody?.end, "put-down");
    assert.equal(pauseRequested(allocated.paths), true);
    assert.equal(probeLeash(allocated.paths), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a body aborts and buries its process tree when the heart disappears during a drive", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-heart-gone-"));
  const allocated = allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "bad0cafe" });
  initializeHeart(allocated.paths);
  let aborted = false;
  let buried = false;
  const failing: ProviderAdapter = {
    confinement: () => ({ kind: "unconfined" }),
    admitOptions(options) { return { kind: "admitted", options }; },
    async start() {
      return {
        admission: { fence: "heart-gone-fixture-turn" },
        events: {
          async *[Symbol.asyncIterator]() {
            rmSync(allocated.paths.directory, { recursive: true, force: true });
            yield { type: "action", note: "Working" } as const;
          },
        },
        completion: Promise.resolve({ kind: "failed", diagnostic: "heart gone" }),
        async abort() { aborted = true; },
      };
    },
  };
  await driveAkumaBody({
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
      cwd: root,
    },
    initialBody: "start",
  }, failing, {
    collar: { pid: 999_992, processGroup: 999_992, spawnedAt: "heart-gone" },
    now: () => "2026-08-08T00:00:00.000Z",
    async putDownOwnTree() { buried = true; },
  });
  assert.equal(aborted, true);
  assert.equal(buried, true);
  rmSync(root, { recursive: true, force: true });
});
