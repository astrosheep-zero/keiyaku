import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONTROL_RESPONSE_MS, handoffPendingTells } from "../src/akuma/body.js";
import { driveAkumaBody as runAkumaBody, type BodyLaunch, type TellWakeRuntime } from "../src/akuma/body.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import {
  HeldAkumaLeash,
  activitySlice,
  admitRequest,
  initializeHeart,
  pauseRequested,
  probeLeash,
  readHeart,
  readRequest,
  readSoul,
  recordSession,
  recordTell,
  requestPause,
  requestStop,
  reserveRequest,
  stopRequested,
  type AkuId,
} from "../src/akuma/heart/index.js";
import type { ProviderOptions } from "../src/akuma/provider-recipe.js";
import { allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import {
  createProviderAttempt,
  type AgentEvent,
  type ProviderAdapter,
  type ProviderAttempt,
  type Session,
  type TurnResult,
} from "../src/akuma/provider.js";
import { akumaCallRequestCommands, requestForwardedAkumaCall as requestBodyCall } from "../src/akuma/call-request.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { World } from "../src/world.js";

test("generic handoff with no pending Tell does not spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-empty-handoff-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "acp", draw: () => "1a2b3c48" });
    await initializeHeart(allocated.paths);
    let spawned = 0;
    await handoffPendingTells(allocated.paths, async () => {
      spawned += 1;
      throw new Error("must not spawn");
    });
    assert.equal(spawned, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function outcomes(paths: Parameters<typeof activitySlice>[0]) {
  return (await activitySlice(paths)).rows.filter((fact) => fact.kind === "turn-end").map((fact) => fact.outcome);
}

function sessionResource(session: Session) {
  let settleClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });
  void session.completion.then(settleClosed, settleClosed);
  return {
    closed,
    abort: async () => {
      await session.abort();
      settleClosed();
    },
    forceDispose: async () => {
      await session.forceDispose?.();
      settleClosed();
    },
  };
}

function sessionAttempt(establish: () => Promise<Session>) {
  return createProviderAttempt(undefined, async (custody) => {
    const session = await establish();
    custody.own(sessionResource(session));
    return session;
  });
}

function attemptForSession(value: Promise<Session> | ProviderAttempt<Session>): ProviderAttempt<Session> {
  if ("result" in value) return value;
  return createProviderAttempt(undefined, async (custody) => {
    const session = await value;
    custody.own(sessionResource(session));
    return session;
  });
}

function bodyAdapter(adapter: ProviderAdapter): ProviderAdapter {
  return {
    ...adapter,
    start: (input) => attemptForSession(adapter.start(input) as Promise<Session> | ProviderAttempt<Session>),
    ...(adapter.resume === undefined
      ? {}
      : {
          resume: (input: Parameters<NonNullable<ProviderAdapter["resume"]>>[0]) =>
            attemptForSession(adapter.resume!(input) as Promise<Session> | ProviderAttempt<Session>),
        }),
  };
}

async function driveAkumaBody(...input: Parameters<typeof runAkumaBody>): Promise<void> {
  if (input[1] === undefined) await runAkumaBody(...input);
  else await runAkumaBody(input[0], bodyAdapter(input[1]), input[2]);
}

function adapter(
  input: Readonly<{
    events: readonly AgentEvent[];
    result: TurnResult;
    starts: Array<
      Readonly<{
        body: string;
        launchTells: readonly Readonly<{ id: string; text: string }>[];
        options: ProviderOptions;
        session: "fresh" | string;
      }>
    >;
  }>,
): ProviderAdapter {
  const drive = async (
    call: Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0],
  ) => {
    let finishEvents!: () => void;
    const eventsFinished = new Promise<void>((resolve) => {
      finishEvents = resolve;
    });
    assert.ok(call.requests);
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
          finishEvents();
        },
      },
      completion: eventsFinished.then(() => input.result),
      async abort() {},
      async forceDispose() {},
    };
  };
  return {
    admitOptions(options) {
      return { kind: "admitted", options };
    },
    start: (input) => sessionAttempt(async () => await drive(input)),
    resume: (input) => sessionAttempt(async () => await drive(input)),
  };
}

test("body births, admits native session, records the turn, and exits only when idle", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-body-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1234abcd" });
    await initializeHeart(allocated.paths);
    const launch: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: { model: "claude-sonnet-4-5", effort: "high", systemPrompt: "Build carefully." },
        origin: { kind: "direct" },
        cwd: root,
      },
      initialBody: "build it",
    };
    const starts: Array<
      Readonly<{
        body: string;
        launchTells: readonly Readonly<{ id: string; text: string }>[];
        options: ProviderOptions;
        session: "fresh" | string;
      }>
    > = [];
    await driveAkumaBody(
      launch,
      adapter({
        starts,
        events: [
          { type: "session", coordinate: { sessionId: "native-1" } },
          { type: "assistant", text: "working" },
        ],
        result: { kind: "answered", answer: "done", historyId: "history-1" },
      }),
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );

    const first = await readHeart(allocated.paths);
    assert.equal(await probeLeash(allocated.paths), "free");
    assert.equal(first.soul?.id, allocated.id);
    assert.equal(first.latestSession?.coordinate.sessionId, "native-1");
    assert.deepEqual(first.latestSession?.options, {
      model: "claude-sonnet-4-5",
      effort: "high",
      systemPrompt: "Build carefully.",
    });
    assert.deepEqual((await outcomes(allocated.paths))[0], {
      kind: "answered",
      answer: "done",
      historyId: "history-1",
      session: { sessionId: "native-1" },
    });
    assert.equal(first.latestBody?.end, "exited");
    assert.deepEqual(starts, [
      {
        body: "build it",
        launchTells: [],
        options: { model: "claude-sonnet-4-5", effort: "high", systemPrompt: "Build carefully." },
        session: "fresh",
      },
    ]);

    await recordTell(allocated.paths, {
      id: "tell-1",
      body: "adjust it",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await driveAkumaBody(
      { paths: allocated.paths },
      adapter({
        starts,
        events: [{ type: "action", note: "Started" }],
        result: { kind: "answered", answer: "adjusted", historyId: "history-2" },
      }),
      {
        now: () => "2026-08-08T00:00:02.000Z",
      },
    );

    const second = await readHeart(allocated.paths);
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
    assert.deepEqual((await outcomes(allocated.paths))[1], {
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
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1a2b3c4d" });
    await initializeHeart(allocated.paths);
    let releaseEvents!: () => void;
    const eventsReleased = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    let releaseReceipt!: () => void;
    const receiptReleased = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    let tellObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      tellObserved = resolve;
    });
    const live: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
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
          completion: eventsReleased.then(() => ({
            kind: "answered" as const,
            answer: "done",
            historyId: "live-history",
          })),
          async tell() {
            releaseReceipt();
            tellObserved();
            return { kind: "accepted" as const, fence: "live-fence" };
          },
          async abort() {},
        };
      },
    };
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      live,
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    while ((await readHeart(allocated.paths)).latestBody === null)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await recordTell(allocated.paths, {
      id: "tell-live",
      body: "steer",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await observed;
    releaseEvents();
    await body;
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a receipt-free live acknowledgement settles the tell in the current Body", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-live-ack-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "codex", draw: () => "1a2b3c40" });
    await initializeHeart(allocated.paths);
    let releaseEvents!: () => void;
    const eventsReleased = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    let tellObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      tellObserved = resolve;
    });
    const live: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      start() {
        return sessionAttempt(async () => ({
          admission: { fence: "initial-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "live-session" } };
              await eventsReleased;
            },
          },
          completion: eventsReleased.then(() => ({
            kind: "answered" as const,
            answer: "done",
            historyId: "live-history",
          })),
          async tell() {
            tellObserved();
            return { kind: "accepted" as const, fence: "turn-1:tell-live" };
          },
          async abort() {},
          async forceDispose() {},
        }));
      },
    };
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "codex",
          provider: { name: "codex", kind: "codex-app-server" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      live,
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    while ((await readHeart(allocated.paths)).latestBody === null)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await recordTell(allocated.paths, {
      id: "tell-live",
      body: "steer",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await observed;
    while ((await readHeart(allocated.paths)).pending.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    releaseEvents();
    await body;
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Session without live tell hands off while narration remains open", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-tell-handoff-"));
  try {
    const allocated = await allocateAkumaDirectory({
      worldRoot: root,
      archetype: "acp",
      draw: () => "1a2b3c42",
    });
    await initializeHeart(allocated.paths);
    let aborts = 0;
    const incumbent: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      async start() {
        return {
          admission: { fence: "incumbent" },
          events: {
            async *[Symbol.asyncIterator]() {
              await new Promise(() => undefined);
            },
          },
          completion: new Promise<TurnResult>(() => undefined),
          async abort() {
            aborts += 1;
            assert.equal(await probeLeash(allocated.paths), "held");
            assert.deepEqual(
              (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
              ["tell-handoff"],
            );
          },
        };
      },
    };
    let automaticLaunches = 0;
    let released = 0;
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "acp",
          provider: { name: "acp", kind: "acp" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      incumbent,
      {
        now: () => "2026-08-08T00:00:00.000Z",
        async spawnBody(launch) {
          automaticLaunches += 1;
          assert.deepEqual(launch, { paths: allocated.paths, refuseIfHeld: true });
          return {
            pid: 1,
            exited: new Promise<never>(() => undefined),
            async terminate() {},
            release() {
              released += 1;
            },
          } satisfies OwnedProcess;
        },
      },
    );
    while ((await readHeart(allocated.paths)).latestBody === null) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await recordTell(allocated.paths, {
      id: "tell-handoff",
      body: "continue promptly",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await Promise.race([
      body,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Body did not hand off pending Tell")), 1_000),
      ),
    ]);

    assert.equal(aborts, 1);
    assert.equal(await probeLeash(allocated.paths), "free");
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.deepEqual(await outcomes(allocated.paths), []);
    assert.deepEqual(
      (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
      ["tell-handoff"],
    );
    assert.equal(automaticLaunches, 1);
    assert.equal(released, 1);

    const launches: Array<readonly Readonly<{ id: string; text: string }>[]> = [];
    const successorStart = async (input: Parameters<ProviderAdapter["start"]>[0]) => {
      launches.push(input.launchTells);
      return {
        admission: { fence: "successor" },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "successor-session" } };
          },
        },
        completion: Promise.resolve({ kind: "answered" as const, answer: "continued" }),
        async abort() {},
      };
    };
    await driveAkumaBody(
      { paths: allocated.paths },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
        start: successorStart,
        resume: successorStart,
      },
      { now: () => "2026-08-08T00:00:02.000Z" },
    );

    assert.deepEqual(launches, [[{ id: "tell-handoff", text: "continue promptly" }]]);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    assert.equal((await outcomes(allocated.paths)).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed release recovery spawn leaves its Tell pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-release-spawn-failure-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "acp", draw: () => "1a2b3c45" });
    await initializeHeart(allocated.paths);
    let spawnAttempts = 0;
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "acp",
          provider: { name: "acp", kind: "acp" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
        async start() {
          return {
            admission: { fence: "release-spawn-failure" },
            events: {
              async *[Symbol.asyncIterator]() {
                await new Promise<void>(() => undefined);
              },
            },
            completion: new Promise<TurnResult>(() => undefined),
            async abort() {},
          };
        },
      },
      {
        now: () => "2026-08-08T00:00:00.000Z",
        async spawnBody() {
          spawnAttempts += 1;
          throw new Error("spawn denied");
        },
      },
    );
    while ((await readHeart(allocated.paths)).latestBody === null) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await recordTell(allocated.paths, {
      id: "release-spawn-failure",
      body: "continue",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await Promise.race([
      body,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Body did not release after spawn failure")), 1_000),
      ),
    ]);
    assert.equal(spawnAttempts, 1);
    assert.equal(await probeLeash(allocated.paths), "free");
    assert.deepEqual(
      (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
      ["release-spawn-failure"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Tell after Session terminality stays pending without replacing the answered turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-terminal-tell-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "codex", draw: () => "1a2b3c41" });
    await initializeHeart(allocated.paths);
    let closeEvents!: () => void;
    const eventsClosed = new Promise<void>((resolve) => {
      closeEvents = resolve;
    });
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let sessionSeen!: () => void;
    const sessionObserved = new Promise<void>((resolve) => {
      sessionSeen = resolve;
    });
    const launches: Array<readonly Readonly<{ id: string; text: string }>[]> = [];
    let turn = 0;
    const drive = async (
      input: Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0],
    ) => {
      turn += 1;
      const currentTurn = turn;
      launches.push(input.launchTells);
      if (currentTurn === 1) bodyStarted();
      return {
        admission: { fence: `terminal-turn-${currentTurn}` },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "terminal-session" } };
            if (currentTurn === 1) {
              sessionSeen();
              await eventsClosed;
            }
          },
        },
        completion: (currentTurn === 1 ? eventsClosed : Promise.resolve()).then(() => ({
          kind: "answered" as const,
          answer: currentTurn === 1 ? "done" : "continued",
          historyId: `terminal-history-${currentTurn}`,
        })),
        async tell() {
          return { kind: "turn-ended" as const };
        },
        async abort() {},
      };
    };
    const provider: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      start: drive,
      resume: drive,
    };
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "codex",
          provider: { name: "codex", kind: "codex-app-server" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      provider,
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    await started;
    await sessionObserved;
    await recordTell(allocated.paths, {
      id: "tell-after-terminal",
      body: "next turn",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    closeEvents();
    await body;

    assert.deepEqual((await outcomes(allocated.paths))[0], {
      kind: "answered",
      answer: "done",
      historyId: "terminal-history-1",
      session: { sessionId: "terminal-session" },
    });
    assert.deepEqual(launches, [[], [{ id: "tell-after-terminal", text: "next turn" }]]);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "exited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt persistence failure aborts the Session and terminates the Body", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-receipt-failure-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1a2b3c4e" });
    await initializeHeart(allocated.paths);
    let aborted = false;
    let releaseEvents!: () => void;
    const eventsReleased = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
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
            async abort() {
              aborted = true;
              releaseEvents();
            },
          };
        },
      },
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );

    await body;
    assert.equal(aborted, true);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "broke-off");
    assert.deepEqual((await outcomes(allocated.paths)).at(-1), {
      kind: "failed",
      diagnostic: "tell receipt has no delivery mapping",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("request-pump failure aborts the Session and closes request transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-request-pump-failure-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1a2b3c4e" });
    await initializeHeart(allocated.paths);
    let aborted = false;
    let directory!: string;
    let releaseEvents!: () => void;
    const eventsReleased = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
        async start(input) {
          directory = input.requests!.dir;
          return {
            admission: { fence: "launch" },
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: "session" as const, coordinate: { sessionId: "request-pump-failure-session" } };
                await eventsReleased;
              },
            },
            completion: new Promise<TurnResult>(() => {}),
            async abort() {
              aborted = true;
              releaseEvents();
            },
          };
        },
      },
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );

    while (directory === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(directory, "request transport is unavailable");
    await body;

    assert.equal(aborted, true);
    assert.equal(existsSync(directory), false);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "broke-off");
    assert.deepEqual((await outcomes(allocated.paths)).at(-1), {
      kind: "failed",
      diagnostic: "ENOTDIR: not a directory, scandir '" + directory + "'",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("request-pump failure aborts pending ProviderAdapter.start and closes transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-request-pump-setup-failure-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "1a2b3c4e" });
    await initializeHeart(allocated.paths);
    let directory!: string;
    let setupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    let setupAborted!: () => void;
    const setupAbortObserved = new Promise<void>((resolve) => {
      setupAborted = resolve;
    });
    let setupAbortReason: unknown;
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
        async start(input) {
          directory = input.requests!.dir;
          setupStarted();
          await new Promise<never>((_resolve, reject) => {
            input.signal.addEventListener(
              "abort",
              () => {
                setupAbortReason = input.signal.reason;
                setupAborted();
                reject(input.signal.reason);
              },
              { once: true },
            );
          });
          throw new Error("unreachable setup continuation");
        },
      },
      { now: () => "2026-08-08T00:00:00.000Z" },
    );

    await started;
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(directory, "request transport is unavailable");
    await setupAbortObserved;
    await body;

    assert.equal(
      setupAbortReason instanceof Error ? setupAbortReason.message : String(setupAbortReason),
      "ENOTDIR: not a directory, scandir '" + directory + "'",
    );
    assert.equal(existsSync(directory), false);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "broke-off");
    assert.deepEqual((await outcomes(allocated.paths)).at(-1), {
      kind: "failed",
      diagnostic: "ENOTDIR: not a directory, scandir '" + directory + "'",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a drive drains Body Requests before recording its terminal turn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiyaku-akuma-body-requests-")));
  const world = await World.prove(root);
  const priorHome = process.env.HOME;
  const home = join(root, "home");
  mkdirSync(join(home, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(home, ".keiyaku", "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  process.env.HOME = home;
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
    await initializeHeart(allocated.paths);
    const seed = {
      id: allocated.id,
      archetype: "parent",
      provider: { name: "codex-app-server", kind: "codex-app-server" } as const,
      options: {},
      origin: { kind: "direct" } as const,
      allowed: ALLOWED_ACTIONS,
      cwd: root,
    };
    const birth = (await HeldAkumaLeash.try(allocated.paths))!;
    await birth.birth(allocated.paths, { ...seed, createdAt: "2026-08-09T00:00:00.000Z" });
    birth.release();
    const recoveredRequestId = "00000000-0000-4000-8000-000000000020";
    await admitRequest(allocated.paths, {
      id: recoveredRequestId,
      action: "akuma.call",
      payloadJson: JSON.stringify({ malformed: "reserved recovery must ignore this payload" }),
      admittedAt: "2026-08-09T00:00:00.000Z",
      permitted: true,
    });
    const staleTransport = join(allocated.paths.directory, "requests", "1", `${recoveredRequestId}.request.json`);
    mkdirSync(join(allocated.paths.directory, "requests", "1"), { recursive: true });
    writeFileSync(staleTransport, "stale");
    let requestDirectory: string | undefined;
    let childId: AkuId | undefined;
    const provider: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      async start(input) {
        let finishEvents!: () => void;
        const eventsFinished = new Promise<void>((resolve) => {
          finishEvents = resolve;
        });
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
            allowed: ALLOWED_ACTIONS,
          },
        });
        return {
          admission: { fence: "body-request-parent-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "parent-session" } };
              finishEvents();
            },
          },
          completion: eventsFinished.then(() => ({
            kind: "answered" as const,
            answer: "parent done",
            historyId: "parent-turn",
          })),
          async abort() {},
        };
      },
    };
    await driveAkumaBody(
      {
        paths: allocated.paths,
        seed,
        initialBody: "parent work",
      },
      provider,
      {
        now: () => "2026-08-09T00:00:00.000Z",
        upstream: { launchWorld: () => world },
        commands: akumaCallRequestCommands(),
        async spawnChild(launch) {
          const child = (await HeldAkumaLeash.try(launch.paths))!;
          await child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-09T00:00:01.000Z" });
          child.release();
        },
      },
    );

    assert.ok(childId);
    assert.equal((await readRequest(allocated.paths, recoveredRequestId))?.state, "voided");
    assert.deepEqual((await readSoul(pathsForAkuId(root, childId)))?.origin, {
      kind: "request",
      parent: allocated.id,
      requestId: "00000000-0000-4000-8000-000000000021",
    });
    assert.equal((await readRequest(allocated.paths, "00000000-0000-4000-8000-000000000021"))?.state, "served");
    assert.equal((await outcomes(allocated.paths)).at(-1)?.kind, "answered");
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
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "f0a1b0d1" });
    await initializeHeart(allocated.paths);
    const starts: Array<
      Readonly<{
        body: string;
        launchTells: readonly Readonly<{ id: string; text: string }>[];
        options: ProviderOptions;
        session: "fresh" | string;
      }>
    > = [];
    await driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: { model: "soul-model" },
          origin: { kind: "fork", parent: "aku/claude/1234abcd" as typeof allocated.id, at: "history-1" },
          cwd: root,
        },
        birthSession: {
          provider: "claude",
          coordinate: { sessionId: "native-child" },
          cwd: join(root, "session-seat"),
          options: { model: "fork-recipe" },
          admittedAt: "2026-08-08T00:00:00.000Z",
        },
      },
      adapter({
        starts,
        events: [],
        result: { kind: "failed", diagnostic: "must not start" },
      }),
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    assert.deepEqual(starts, []);
    assert.deepEqual(await outcomes(allocated.paths), []);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "exited");

    await recordTell(allocated.paths, { id: "tell-fork", body: "continue", recordedAt: "2026-08-08T00:00:01.000Z" });
    await driveAkumaBody(
      { paths: allocated.paths },
      adapter({
        starts,
        events: [],
        result: { kind: "answered", answer: "continued", historyId: "history-2" },
      }),
      {
        now: () => "2026-08-08T00:00:02.000Z",
      },
    );
    assert.deepEqual(starts, [
      {
        body: "",
        launchTells: [{ id: "tell-fork", text: "continue" }],
        options: { model: "fork-recipe" },
        session: "native-child",
      },
    ]);
    assert.deepEqual((await outcomes(allocated.paths))[0], {
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
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "87654321" });
    await initializeHeart(allocated.paths);
    const launch: BodyLaunch = {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        cwd: join(root, "custom-seat"),
      },
      initialBody: "start",
    };
    await driveAkumaBody(
      launch,
      adapter({
        starts: [],
        events: [],
        result: { kind: "failed", diagnostic: "failed before session" },
      }),
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    assert.equal((await readHeart(allocated.paths)).soul?.cwd, join(root, "custom-seat"));
    assert.deepEqual((await outcomes(allocated.paths))[0], {
      kind: "failed",
      diagnostic: "failed before session",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an answer without an admitted or resumed session is retained as a failed turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-sessionless-answer-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "decafbad" });
    await initializeHeart(allocated.paths);
    await driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "start",
      },
      adapter({
        starts: [],
        events: [],
        result: { kind: "answered", answer: "unforkable", historyId: "missing-session" },
      }),
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    assert.deepEqual((await outcomes(allocated.paths))[0], {
      kind: "failed",
      diagnostic: "Provider answered without a resumable session",
    });
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "broke-off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successor admits through the leash without reconstructing custody of an untidy predecessor", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-orphan-stop-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "a1b2c3d4" });
    await initializeHeart(allocated.paths);
    const soul = {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" as const },
      options: {},
      origin: { kind: "direct" as const },
      cwd: root,
      createdAt: "2026-08-08T00:00:00.000Z",
    };
    const predecessorLeash = (await HeldAkumaLeash.try(allocated.paths))!;
    await predecessorLeash.birth(allocated.paths, soul);
    const predecessor = await predecessorLeash.recordBody(allocated.paths, { leashTakenAt: soul.createdAt });
    await recordSession(allocated.paths, {
      provider: "claude",
      coordinate: { sessionId: "orphan-session" },
      cwd: root,
      options: {},
      admittedAt: soul.createdAt,
    });
    predecessorLeash.release();

    const stopped = await requestStop(allocated.paths, "2026-08-08T00:00:01.000Z");
    assert.equal(stopped.kind, "requested");
    assert.equal(await stopRequested(allocated.paths), true);
    await recordTell(allocated.paths, {
      id: "orphan-tell",
      body: "continue",
      recordedAt: "2026-08-08T00:00:02.000Z",
    });
    const wake: BodyLaunch = { paths: allocated.paths };
    await driveAkumaBody(
      wake,
      adapter({
        starts: [],
        events: [],
        result: { kind: "answered", answer: "continued", historyId: "orphan-history-2" },
      }),
      {
        now: () => "2026-08-08T00:00:03.000Z",
      },
    );
    assert.equal(await stopRequested(allocated.paths), false);
    const snapshot = await readHeart(allocated.paths);
    assert.equal(snapshot.latestKill, null);
    assert.equal(snapshot.latestBody?.sequence, predecessor.sequence + 1);
    assert.deepEqual((await outcomes(allocated.paths)).at(-1), {
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

test("pause aborts stalled provider setup and records clean Body settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-setup-pause-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "c0ffed00" });
    await initializeHeart(allocated.paths);
    let setupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
        async start(input) {
          setupStarted();
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
          });
          throw new Error("unreachable setup continuation");
        },
      },
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    await started;
    const current = (await readHeart(allocated.paths)).latestBody!;
    const requestedAt = performance.now();
    await requestPause(allocated.paths, "2026-08-08T00:00:01.000Z");
    await Promise.race([
      body,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Body did not abort stalled setup")), 500)),
    ]);
    assert.ok(performance.now() - requestedAt < CONTROL_RESPONSE_MS);
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, current.sequence);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.deepEqual(await outcomes(allocated.paths), []);
    assert.equal(await probeLeash(allocated.paths), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause interrupts pre-drive reserved-request recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-request-settlement-pause-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "c0ffed01" });
    await initializeHeart(allocated.paths);
    const soul = {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" } as const,
      options: {},
      origin: { kind: "direct" } as const,
      allowed: ALLOWED_ACTIONS,
      cwd: root,
      createdAt: "2026-08-08T00:00:00.000Z",
    };
    const birth = (await HeldAkumaLeash.try(allocated.paths))!;
    await birth.birth(allocated.paths, soul);
    birth.release();
    const requestId = "00000000-0000-4000-8000-000000000099";
    await admitRequest(allocated.paths, {
      id: requestId,
      action: "akuma.call",
      payloadJson: JSON.stringify({ malformed: "settlement remains payload blind" }),
      admittedAt: "2026-08-08T00:00:01.000Z",
      permitted: true,
    });
    const child = await allocateAkumaDirectory({ worldRoot: root, archetype: "worker", draw: () => "c0ffed02" });
    await initializeHeart(child.paths);
    await reserveRequest(allocated.paths, requestId, child.id);
    const childLeash = (await HeldAkumaLeash.try(child.paths))!;
    try {
      const body = driveAkumaBody({ paths: allocated.paths }, undefined, {
        now: () => new Date().toISOString(),
      });
      const current = await Promise.race([
        (async () => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const observed = (await readHeart(allocated.paths)).latestBody;
            if (observed !== null) return observed;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          throw new Error("Body did not record request-settlement custody");
        })(),
        body.then(
          () => {
            throw new Error("Body ended before request-settlement custody");
          },
          (error) => {
            throw new Error(
              `Body failed before request-settlement custody: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        ),
      ]);
      const requestedAt = performance.now();
      await requestPause(allocated.paths, new Date().toISOString());
      await Promise.race([
        body,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Body did not interrupt request settlement")), 500),
        ),
      ]);
      assert.ok(performance.now() - requestedAt < CONTROL_RESPONSE_MS);
      assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, current.sequence);
      assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
      assert.equal(await probeLeash(allocated.paths), "free");
    } finally {
      childLeash.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pause aborts the current drive and records the body as put down", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-pause-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "c0ffee00" });
    await initializeHeart(allocated.paths);
    let aborted = false;
    let forced = false;
    let settle!: (result: TurnResult) => void;
    const completion = new Promise<TurnResult>((resolve) => {
      settle = resolve;
    });
    const running: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
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
            throw new Error("graceful disposal failed");
          },
          async forceDispose() {
            forced = true;
            aborted = true;
            settle({ kind: "failed", diagnostic: "paused" });
          },
        };
      },
    };
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      running,
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    while ((await readHeart(allocated.paths)).latestBody === null)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const current = (await readHeart(allocated.paths)).latestBody!;
    assert.deepEqual(await requestPause(allocated.paths, "2026-08-08T00:00:01.000Z"), {
      kind: "requested",
      body: current,
    });
    await body;
    assert.equal(aborted, true);
    assert.equal(forced, true);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.equal(await pauseRequested(allocated.paths), true);
    assert.equal(await probeLeash(allocated.paths), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forced disposal failure records hung and broke-off before the Body returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-hung-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "c0ffee06" });
    await initializeHeart(allocated.paths);
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
        async start() {
          return {
            admission: { fence: "hung-fixture-turn" },
            events: {
              async *[Symbol.asyncIterator]() {
                await new Promise<void>(() => {});
              },
            },
            completion: new Promise<TurnResult>(() => {}),
            async abort() {
              throw new Error("graceful disposal failed");
            },
            async forceDispose() {
              throw new Error("forced disposal failed");
            },
          };
        },
      },
      { now: () => "2026-08-08T00:00:00.000Z" },
    );
    while ((await readHeart(allocated.paths)).latestBody === null)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await requestPause(allocated.paths, "2026-08-08T00:00:01.000Z");
    await body;
    const heart = await readHeart(allocated.paths);
    assert.deepEqual(heart.latestBody?.hung, {
      diagnostic: "forced disposal failed",
      at: "2026-08-08T00:00:00.000Z",
    });
    assert.equal(heart.latestBody?.end, "broke-off");
    assert.equal(await probeLeash(allocated.paths), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider closure failure enters Body supervision before session completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-closed-failure-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "c0ffee07" });
    await initializeHeart(allocated.paths);
    let rejectClosed!: (error: Error) => void;
    const closed = new Promise<void>((_resolve, reject) => {
      rejectClosed = reject;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
        start() {
          markStarted();
          return {
            result: Promise.resolve({
              admission: { fence: "closed-failure-turn" },
              events: {
                async *[Symbol.asyncIterator]() {
                  await new Promise<void>(() => {});
                },
              },
              completion: new Promise<TurnResult>(() => {}),
              async abort() {},
              async forceDispose() {},
            }),
            closed,
            async abort() {},
            async forceDispose() {},
          };
        },
      },
      { now: () => "2026-08-08T00:00:00.000Z" },
    );
    while ((await readHeart(allocated.paths)).latestBody === null)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await started;
    rejectClosed(new Error("provider resource close failed"));
    await Promise.race([
      body,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Body did not supervise provider closure")), 1_000)),
    ]);
    const heart = await readHeart(allocated.paths);
    assert.deepEqual(heart.latestBody?.hung, {
      diagnostic: "provider resource close failed",
      at: "2026-08-08T00:00:00.000Z",
    });
    assert.equal(heart.latestBody?.end, "broke-off");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stalled Tell is fenced by Body cancellation before leash release", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-violating-tell-"));
  try {
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "c0ffee02" });
    await initializeHeart(allocated.paths);
    let aborted = false;
    let tellStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      tellStarted = resolve;
    });
    let releaseTell!: () => void;
    const tellReleased = new Promise<void>((resolve) => {
      releaseTell = resolve;
    });
    let settle!: (result: TurnResult) => void;
    const completion = new Promise<TurnResult>((resolve) => {
      settle = resolve;
    });
    const body = driveAkumaBody(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
        initialBody: "work",
      },
      {
        admitOptions(options) {
          return { kind: "admitted", options };
        },
        async start() {
          return {
            admission: { fence: "violating-tell-turn" },
            events: {
              async *[Symbol.asyncIterator]() {
                while (!aborted) await new Promise((resolve) => setTimeout(resolve, 10));
              },
            },
            completion,
            async tell() {
              tellStarted();
              await tellReleased;
              return { kind: "turn-ended" as const };
            },
            async abort() {
              aborted = true;
              settle({ kind: "failed", diagnostic: "paused" });
            },
          };
        },
      },
      { now: () => new Date().toISOString() },
    );
    while ((await readHeart(allocated.paths)).latestBody === null)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await recordTell(allocated.paths, {
      id: "violating-live-tell",
      body: "steer",
      recordedAt: new Date().toISOString(),
    });
    await started;
    await requestPause(allocated.paths, new Date().toISOString());
    await body;
    assert.equal(await probeLeash(allocated.paths), "free");
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    releaseTell();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await readHeart(allocated.paths)).pending.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("heart loss wakes a Body stalled on provider observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-heart-gone-stalled-"));
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "bad0caff" });
  await initializeHeart(allocated.paths);
  let aborted = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const body = driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        cwd: root,
      },
      initialBody: "start",
    },
    {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      async start() {
        markStarted();
        return {
          admission: { fence: "heart-gone-stalled-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              await new Promise(() => undefined);
            },
          },
          completion: new Promise(() => undefined),
          async abort() {
            aborted = true;
          },
        };
      },
    },
    { now: () => "2026-08-08T00:00:00.000Z" },
  );
  while ((await readHeart(allocated.paths)).latestBody === null) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await started;
  unlinkSync(allocated.paths.heart);
  await Promise.race([
    body,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Body did not observe Heart loss")), 1_000)),
  ]);
  assert.equal(aborted, true);
  assert.equal(existsSync(allocated.paths.heart), false);
  rmSync(root, { recursive: true, force: true });
});
