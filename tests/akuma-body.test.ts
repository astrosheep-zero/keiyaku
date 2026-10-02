import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import { allocatedHeart, claudeBodyLaunch, recordTell } from "./support/akuma-fixtures.js";
import { expectBodySettles, settlementProbe, waitForCondition } from "./support/process.js";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  bodyProcessInput,
  bodyLaunchSchema,
  CONTROL_RESPONSE_MS,
  LEASH_HELD_EXIT,
  handoffPendingTells,
  spawnAkumaBody,
} from "../src/akuma/body.js";
import { akumaExecutionEnvironment } from "../src/akuma/providers/execution-environment.js";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import { driveAkumaBody as runAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import {
  HeldAkumaLeash,
  activitySlice,
  admitRequest, decidePendingTellDisposition,
  pauseRequested,
  probeLeash,
  resolvePendingTellDisposition,
  readHeart,
  readOpenPendingTellDisposition, readTell,
  readTurn,
  recordSession,
  recordTell as heartRecordTell,
  requestPause,
  requestStop,
  reserveRequest,
  stopRequested
} from "../src/akuma/heart/index.js";
import type { ProviderOptions } from "../src/akuma/provider-recipe.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import {
  createProviderAttempt,
  type AgentEvent,
  type ProviderAdapter,
  type ProviderAttempt,
  type Session,
  type TurnResult,
} from "../src/akuma/provider.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import type { PluginSignal } from "../src/plugin/public.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { World } from "../src/world.js";

type TurnOutcomePluginRecorder = {
  activations: number;
  observations: Array<Readonly<{ signal: PluginSignal; outcomes: unknown }>>;
  observe(signal: PluginSignal): Promise<void>;
};


const turnOutcomePluginGlobal = globalThis as typeof globalThis & {
  __keiyakuTurnOutcomePluginRecorder?: TurnOutcomePluginRecorder;
};


function configureTurnOutcomePlugins(root: string): void {
  const plugins = join(root, "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, "observer.mjs"),
    [
      "export default {",
      '  manifest: { id: "observer", apiVersion: 1 },',
      "  activate() {",
      "    globalThis.__keiyakuTurnOutcomePluginRecorder.activations += 1;",
      '    return { signals: { "akuma.turn-outcome": (signal) => globalThis.__keiyakuTurnOutcomePluginRecorder.observe(signal) } };',
      "  },",
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(plugins, "broken.mjs"),
    [
      "export default {",
      '  manifest: { id: "broken", apiVersion: 1 },',
      '  activate() { return { signals: { "akuma.turn-outcome": () => { throw new Error("observer failure"); } } }; },',
      "};",
    ].join("\n"),
  );
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: {
        broken: { package: "./plugins/broken.mjs" },
        observer: { package: "./plugins/observer.mjs" },
      },
    }),
  );
}

type BodyEndPluginRecorder = {
  signals: PluginSignal[];
  observe(signal: PluginSignal): Promise<void> | void;
};

const bodyEndPluginGlobal = globalThis as typeof globalThis & {
  __keiyakuBodyEndPluginRecorder?: BodyEndPluginRecorder;
};

/** Observe the producer's emitted Body-end signals without disturbing the Turn recorder. */
function configureBodyEndPlugins(root: string): void {
  const plugins = join(root, "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, "body-observer.mjs"),
    [
      "export default {",
      '  manifest: { id: "body-observer", apiVersion: 1 },',
      "  activate() {",
      '    return { signals: { "akuma.body-ended": (signal) => globalThis.__keiyakuBodyEndPluginRecorder?.observe(signal) } };',
      "  },",
      "};",
    ].join("\n"),
  );
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({ plugins: { "body-observer": { package: "./plugins/body-observer.mjs" } } }),
  );
}


const PARENT_HARNESS_ENVIRONMENT = {
  CLAUDE_CODE_SESSION_ID: "parent-claude",
  CLAUDE_CODE_CHILD_SESSION: "parent-claude-child",
  CLAUDECODE: "parent-claude-code",
  CODEX_THREAD_ID: "parent-codex",
  OPENCODE_SESSION_ID: "parent-opencode",
  PI_SESSION_ID: "parent-pi",
  PI_SESSION_FILE: "/parent/pi.jsonl",
  PASEO_AGENT_ID: "parent-paseo",
  SQUARE_PARTICIPANT_NAME: "Parent",
  AKUMA_REQUESTS: "/parent/requests",
} as const;

const PARENT_HARNESS_KEYS = Object.keys(PARENT_HARNESS_ENVIRONMENT) as Array<keyof typeof PARENT_HARNESS_ENVIRONMENT>;

test("Body launch and provider setup isolate parent harness identity without mutating concurrent inputs", async () => {
  const parent = {
    ...PARENT_HARNESS_ENVIRONMENT,
    PATH: "/test/path",
    API_TOKEN: "credential",
    SQUARE_LOCATION: "configured-location",
    SENTINEL: "survives",
  };
  const overrides = {
    ...PARENT_HARNESS_ENVIRONMENT,
    API_TOKEN: "provider-credential",
    PROVIDER_SENTINEL: "provider-survives",
  };
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => akumaExecutionEnvironment(parent, overrides, "/child/requests")),
    Promise.resolve().then(() => akumaExecutionEnvironment(parent, overrides, "/child/requests")),
  ]);
  assert.deepEqual(first, second);
  for (const key of PARENT_HARNESS_KEYS) {
    if (key !== "AKUMA_REQUESTS") assert.equal(first[key], undefined);
  }
  assert.equal(first.AKUMA_REQUESTS, "/child/requests");
  assert.equal(first.PATH, parent.PATH);
  assert.equal(first.API_TOKEN, "provider-credential");
  assert.equal(first.SQUARE_LOCATION, parent.SQUARE_LOCATION);
  assert.equal(first.SENTINEL, parent.SENTINEL);
  assert.equal(first.PROVIDER_SENTINEL, "provider-survives");
  assert.deepEqual(parent, {
    ...PARENT_HARNESS_ENVIRONMENT,
    PATH: "/test/path",
    API_TOKEN: "credential",
    SQUARE_LOCATION: "configured-location",
    SENTINEL: "survives",
  });
  assert.deepEqual(overrides, {
    ...PARENT_HARNESS_ENVIRONMENT,
    API_TOKEN: "provider-credential",
    PROVIDER_SENTINEL: "provider-survives",
  });

  const root = mkdtempSync(join(tmpdir(), "keiyaku-body-environment-"));
  const previous = Object.fromEntries(PARENT_HARNESS_KEYS.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, PARENT_HARNESS_ENVIRONMENT);
    const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "claude", draw: () => "e11d0001" });
    const input = await bodyProcessInput(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
          allowed: ALLOWED_ACTIONS,
        },
      },
      import.meta.url,
    );
    for (const key of PARENT_HARNESS_KEYS) {
      assert.equal(input.env[key], undefined);
    }
    assert.equal(input.env.KEIYAKU_ACTOR_ID, allocated.id);
    assert.equal(process.env.AKUMA_REQUESTS, "/parent/requests");
  } finally {
    for (const key of PARENT_HARNESS_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function outcomes(paths: Parameters<typeof activitySlice>[0]) {
  return (await activitySlice(paths)).rows.filter((fact) => fact.kind === "turn-end").map((fact) => fact.outcome);
}

async function committedTurnSequences(paths: Parameters<typeof activitySlice>[0]): Promise<readonly number[]> {
  return (await activitySlice(paths)).rows.filter((fact) => fact.kind === "turn-end").map((fact) => fact.turnSequence);
}

/** Install one turn-outcome recorder that snapshots the scenario Heart on every observation. */
function installTurnOutcomeRecorder(paths: Parameters<typeof outcomes>[0]): TurnOutcomePluginRecorder {
  const recorder: TurnOutcomePluginRecorder = {
    activations: 0,
    observations: [],
    async observe(signal) {
      this.observations.push({ signal, outcomes: await outcomes(paths) });
    },
  };
  turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder = recorder;
  return recorder;
}

function sessionResource(session: Session) {
  const { promise: closed, resolve: settleClosed } = promiseBarrier<void>();
  void session.completion.then(() => settleClosed(), () => settleClosed());
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

type FixtureProviderAdapter = Omit<ProviderAdapter, "start" | "resume"> & {
  start: (input: Parameters<ProviderAdapter["start"]>[0]) => Promise<FixtureSession> | ProviderAttempt<FixtureSession>;
  resume?: (
    input: Parameters<NonNullable<ProviderAdapter["resume"]>>[0],
  ) => Promise<FixtureSession> | ProviderAttempt<FixtureSession>;
};

/** One scenario provider that admits every option; its session body stays at the call site. */
function scenarioProvider(
  start: FixtureProviderAdapter["start"],
  extra: Omit<FixtureProviderAdapter, "admitOptions" | "start"> = {},
): FixtureProviderAdapter {
  return { admitOptions: (options) => ({ kind: "admitted", options }), start, ...extra };
}

type FixtureSession = Omit<Session, "forceDispose"> & { forceDispose?: () => Promise<void> };

function normalizeSession(session: FixtureSession): Session {
  return { ...session, forceDispose: session.forceDispose ?? (async () => {}) };
}

function attemptForFixtureSession(
  value: Promise<FixtureSession> | ProviderAttempt<FixtureSession>,
): ProviderAttempt<Session> {
  if ("result" in value) return value as unknown as ProviderAttempt<Session>;
  return createProviderAttempt(undefined, async (custody) => {
    const session = normalizeSession(await value);
    custody.own(sessionResource(session));
    return session;
  });
}

function bodyAdapter(adapter: FixtureProviderAdapter): ProviderAdapter {
  return {
    ...adapter,
    start: (input) => attemptForFixtureSession(adapter.start(input)),
    ...(adapter.resume === undefined
      ? {}
      : {
          resume: (input: Parameters<NonNullable<ProviderAdapter["resume"]>>[0]) =>
            attemptForFixtureSession(adapter.resume!(input)),
        }),
  } as ProviderAdapter;
}

type FixtureBodyLaunch = Omit<BodyLaunch, "seed"> & {
  seed?: (Omit<NonNullable<BodyLaunch["seed"]>, "allowed"> & { allowed?: NonNullable<BodyLaunch["seed"]>["allowed"] }) | undefined;
};

function normalizeLaunch(launch: FixtureBodyLaunch): BodyLaunch {
  return (
    launch.seed === undefined ? launch : { ...launch, seed: { allowed: ALLOWED_ACTIONS, ...launch.seed } }
  ) as BodyLaunch;
}

async function driveAkumaBody(
  launch: FixtureBodyLaunch,
  adapter: FixtureProviderAdapter | undefined,
  runtime: Parameters<typeof runAkumaBody>[2],
): Promise<void> {
  const normalized = normalizeLaunch(launch);
  if (adapter === undefined) await runAkumaBody(normalized, undefined, runtime);
  else await runAkumaBody(normalized, bodyAdapter(adapter), runtime);
}

function unresolved<T = never>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function hangingSession(fence: string, abort: () => Promise<void> = async () => {}): FixtureSession {
  return {
    admission: { fence },
    events: {
      async *[Symbol.asyncIterator]() {
        await unresolved();
      },
    },
    completion: unresolved<TurnResult>(),
    abort,
  };
}

function hangingAdapter(fence: string, abort?: () => Promise<void>): FixtureProviderAdapter {
  return scenarioProvider(async () => {
      return hangingSession(fence, abort);
  });
}

function acpLaunch(allocated: Awaited<ReturnType<typeof allocateAkumaDirectory>>, root: string): FixtureBodyLaunch {
  return {
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
  };
}

async function waitUntilLatestBody(
  paths: Parameters<typeof readHeart>[0],
  settlement?: Promise<unknown>,
): Promise<void> {
  await waitForCondition(
    "the first Body recorded in Heart",
    async () => (await readHeart(paths)).latestBody !== null,
    settlement === undefined
      ? {}
      : { terminalState: settlementProbe(settlement, () => "the driving Body pump settled without a recorded Body") },
  );
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for plugin observation");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function adapter(
  input: Readonly<{
    events: readonly AgentEvent[];
    result: TurnResult;
    starts: Array<
      Readonly<{
        body: string;
        launchTells: readonly Readonly<{ id: string; text: string }>[];
        schemaJson?: string;
        options: ProviderOptions;
        session: "fresh" | string;
      }>
    >;
  }>,
): FixtureProviderAdapter {
  const drive = async (
    call: Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0],
  ) => {
    const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
    assert.ok(call.requests);
    const sessionId = call.session.kind === "fresh" ? "fresh" : call.session.coordinate.sessionId;
    if (sessionId !== "fresh") assert.ok(sessionId);
    input.starts.push({
      body: call.body,
      launchTells: call.launchTells,
      ...(call.schemaJson === undefined ? {} : { schemaJson: call.schemaJson }),
      options: call.options,
      session: sessionId,
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
  return scenarioProvider((input) => sessionAttempt(async () => await drive(input)), {
    resume: (input) => sessionAttempt(async () => await drive(input)),
  });
}

test("turn-outcome plugins observe every committed answered Turn exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-plugin-turn-answered-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "1234abce");
    configureTurnOutcomePlugins(root);
    const recorder = installTurnOutcomeRecorder(allocated.paths);
    await pluginRuntime({ world: await World.at(root) });
    await eventually(() => recorder.activations === 1);
    const launch: FixtureBodyLaunch = claudeBodyLaunch(allocated, root, "build it", {
      completion: { contractId: "kei/example" },
      initiator: "Alice",
    });
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(launch))).sort(), [
      "completion",
      "initialBody",
      "initiator",
      "paths",
      "seed",
    ]);

    await driveAkumaBody(
      launch,
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "plugin-session" } }],
        result: { kind: "answered", answer: "done", historyId: "plugin-history" },
      }),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );

    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "exited");
    await eventually(() => recorder.activations === 1 && recorder.observations.length === 1);
    assert.deepEqual(recorder.observations, [
      {
        signal: {
          kind: "akuma.turn-outcome",
          akumaId: allocated.id,
          bodySequence: 1,
          turnSequence: 1,
          outcome: { kind: "answered", text: "done" },
          initiator: "Alice",
          participants: ["Alice"],
          contractId: "kei/example",
        },
        outcomes: [
          {
            kind: "answered",
            answer: "done",
            historyId: "plugin-history",
            session: { sessionId: "plugin-session" },
          },
        ],
      },
    ]);
    await recordTell(allocated.paths, {
      id: "plugin-tell",
      body: "adjust it",
      initiator: "Bob",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await recordTell(allocated.paths, {
      id: "plugin-coalesced-tell",
      body: "also check tests",
      initiator: "Carol",
      recordedAt: "2026-08-08T00:00:01.001Z",
    });
    await driveAkumaBody(
      { paths: allocated.paths, initiator: "Alice" },
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "plugin-session-2" } }],
        result: { kind: "answered", answer: "adjusted" },
      }),
      { now: () => "2026-08-08T00:00:02.000Z" },
    );

    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "exited");
    await eventually(() => recorder.activations === 1 && recorder.observations.length === 2);
    const sequences = await committedTurnSequences(allocated.paths);
    assert.deepEqual(
      recorder.observations.map(({ signal }) =>
        signal.kind === "akuma.turn-outcome" ? signal.turnSequence : undefined,
      ),
      sequences,
    );
    assert.deepEqual(recorder.observations[1], {
      signal: {
        kind: "akuma.turn-outcome",
        akumaId: allocated.id,
        bodySequence: 2,
        turnSequence: sequences[1],
        outcome: { kind: "answered", text: "adjusted" },
        initiator: "Bob",
        participants: ["Bob", "Carol"],
      },
      outcomes: [
        {
          kind: "answered",
          answer: "done",
          historyId: "plugin-history",
          session: { sessionId: "plugin-session" },
        },
        {
          kind: "answered",
          answer: "adjusted",
          session: { sessionId: "plugin-session-2" },
        },
      ],
    });
    await recordTell(allocated.paths, {
      id: "plugin-unattributed-tell",
      body: "continue without attribution",
      recordedAt: "2026-08-08T00:00:03.000Z",
    });
    await recordTell(allocated.paths, {
      id: "plugin-attributed-after-unattributed",
      body: "also continue",
      initiator: "Dana",
      recordedAt: "2026-08-08T00:00:03.001Z",
    });
    await driveAkumaBody(
      { paths: allocated.paths, initiator: "Alice" },
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "plugin-session-3" } }],
        result: { kind: "answered", answer: "unattributed" },
      }),
      { now: () => "2026-08-08T00:00:04.000Z" },
    );
    assert.equal(recorder.observations.length, 3);
    assert.equal("initiator" in recorder.observations[2]!.signal, false);
    assert.deepEqual(recorder.observations[2]!.signal.kind === "akuma.turn-outcome" ? recorder.observations[2]!.signal.participants : null, ["Dana"]);
  } finally {
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn-outcome plugins observe a committed failed Turn without changing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-plugin-turn-failed-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "1234abcf");
    configureTurnOutcomePlugins(root);
    const recorder = installTurnOutcomeRecorder(allocated.paths);
    await pluginRuntime({ world: await World.at(root) });
    await eventually(() => recorder.activations === 1);

    await driveAkumaBody(
      claudeBodyLaunch(allocated, root, "build it"),
      adapter({ starts: [], events: [], result: { kind: "failed", diagnostic: "provider failed" } }),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );

    const heart = await readHeart(allocated.paths);
    assert.equal(heart.latestBody?.end, "broke-off");
    assert.deepEqual(await outcomes(allocated.paths), [{ kind: "failed", diagnostic: "provider failed" }]);
    await eventually(() => recorder.activations === 1 && recorder.observations.length === 1);
    assert.deepEqual(recorder.observations, [
      {
        signal: {
          kind: "akuma.turn-outcome",
          akumaId: allocated.id,
          bodySequence: 1,
          turnSequence: 1,
          outcome: { kind: "failed", reason: "provider failed" },
        },
        outcomes: [{ kind: "failed", diagnostic: "provider failed" }],
      },
    ]);
  } finally {
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("body-ended plugins attribute only the exact Body's latest admitted Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-plugin-body-end-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "b0d1e2f3");
    configureBodyEndPlugins(root);
    const recorder: BodyEndPluginRecorder = {
      signals: [],
      observe(signal) {
        this.signals.push(signal);
      },
    };
    bodyEndPluginGlobal.__keiyakuBodyEndPluginRecorder = recorder;

    await driveAkumaBody(
      claudeBodyLaunch(allocated, root, "first", { initiator: "Alice" }),
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "body-one" } }],
        result: { kind: "answered", answer: "one", historyId: "history-one" },
      }),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );
    await recordTell(allocated.paths, {
      id: "body-end-teller",
      body: "extra input",
      initiator: "Carol",
      recordedAt: "2026-08-08T00:00:00.500Z",
    });
    await driveAkumaBody(
      claudeBodyLaunch(allocated, root, "second", { initiator: "Bob" }),
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "body-two" } }],
        result: { kind: "answered", answer: "two", historyId: "history-two" },
      }),
      { now: () => "2026-08-08T00:00:01.000Z" },
    );
    await recordTell(allocated.paths, {
      id: "body-end-ownerless-teller",
      body: "third input",
      initiator: "Dana",
      recordedAt: "2026-08-08T00:00:01.500Z",
    });
    await driveAkumaBody(
      claudeBodyLaunch(allocated, root, "third"),
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "body-three" } }],
        result: { kind: "answered", answer: "three", historyId: "history-three" },
      }),
      { now: () => "2026-08-08T00:00:02.000Z" },
    );

    // A Body that never admits a Turn carries no attribution even though its launch named one.
    // The recipe resumes the predecessor session, and this adapter has no resume path, so the
    // Body breaks off before any Turn is admitted.
    await driveAkumaBody(
      claudeBodyLaunch(allocated, root, "fourth", { initiator: "Carol" }),
      {
        admitOptions: (options) => ({ kind: "admitted", options }),
        async start() {
          throw new Error("start must not be reached before a Turn exists");
        },
      },
      { now: () => "2026-08-08T00:00:03.000Z" },
    );

    assert.deepEqual(recorder.signals, [
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 1, end: "exited", initiator: "Alice", participants: ["Alice"] },
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 2, end: "exited", initiator: "Bob", participants: ["Bob", "Carol"] },
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 3, end: "exited", participants: ["Dana"] },
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 4, end: "broke-off" },
    ]);
  } finally {
    delete bodyEndPluginGlobal.__keiyakuBodyEndPluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("live receipt persistence waits for its Body-scoped delivery mapping", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-live-tell-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "1a2b3c4d");
    configureTurnOutcomePlugins(root);
    const recorder = installTurnOutcomeRecorder(allocated.paths);
    const { promise: eventsReleased, resolve: releaseEvents } = promiseBarrier<void>();
    const { promise: receiptReleased, resolve: releaseReceipt } = promiseBarrier<void>();
    const { promise: observed, resolve: tellObserved } = promiseBarrier<void>();
    const live: FixtureProviderAdapter = scenarioProvider(async () => {
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
    });
    const launch = claudeBodyLaunch(allocated, root, "work", { initiator: "Alice" });
    const leash = (await HeldAkumaLeash.try(allocated.paths))!;
    try {
      await leash.birth(allocated.paths, { ...launch.seed!, createdAt: "2026-08-08T00:00:00.000Z" });
    } finally {
      leash.release();
    }
    await recordTell(allocated.paths, {
      id: "tell-launch",
      body: "coalesced",
      initiator: "Carol",
      recordedAt: "2026-08-08T00:00:00.000Z",
    });
    const body = driveAkumaBody(launch, live, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await waitUntilLatestBody(allocated.paths, body);
    await recordTell(allocated.paths, {
      id: "tell-live",
      body: "steer",
      initiator: "Bob",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await observed;
    releaseEvents();
    await body;
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    assert.deepEqual(recorder.observations.map(({ signal }) => signal.kind === "akuma.turn-outcome" ? {
      initiator: signal.initiator,
      participants: signal.participants,
    } : null), [{ initiator: "Alice", participants: ["Alice", "Carol", "Bob"] }]);
  } finally {
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a receipt-free live acknowledgement settles the tell in the current Body", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-live-ack-"));
  try {
    const allocated = await allocatedHeart(root, "codex", "1a2b3c40");
    const { promise: eventsReleased, resolve: releaseEvents } = promiseBarrier<void>();
    const { promise: observed, resolve: tellObserved } = promiseBarrier<void>();
    const live: FixtureProviderAdapter = scenarioProvider(() => {
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
    });
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
    await waitUntilLatestBody(allocated.paths, body);
    await recordTell(allocated.paths, {
      id: "tell-live",
      body: "steer",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await observed;
    await waitForCondition(
      "the live acknowledgement to settle the pending Tell",
      async () => (await readHeart(allocated.paths)).pending.length === 0,
      { terminalState: settlementProbe(body, () => "the driving Body pump settled with the Tell still pending") },
    );
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    releaseEvents();
    await body;
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi native steer evidence keeps a Tell in its current Body and Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-pi-body-steer-"));
  try {
    const allocated = await allocatedHeart(root, "pi", "1a2b3c41");
    const { promise: released, resolve: release } = promiseBarrier<void>();
    const nativeListeners = new Set<(event: { type: string; message?: unknown }) => void>();
    let steered: { role: string; content: unknown } | undefined;
    const manager = { getLeafId: () => "pi-answer" };
    const session = {
      sessionFile: "/sessions/pi-body.jsonl", sessionId: "pi-body", sessionManager: manager,
      agent: {
        subscribe(listener: (event: { type: string; message?: unknown }) => void) {
          nativeListeners.add(listener);
          return () => { nativeListeners.delete(listener); };
        },
        steer(message: { role: string; content: unknown }) { steered = message; },
      },
      subscribe(listener: (event: { type: string; message?: unknown; messages?: unknown[]; willRetry?: boolean }) => void) {
        this.listener = listener;
        return () => { this.listener = undefined; };
      },
      listener: undefined as ((event: { type: string; message?: unknown; messages?: unknown[]; willRetry?: boolean }) => void) | undefined,
      async prompt() {
        await released;
        this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "steered answer" }] } });
      },
      async abort() { release(); },
      dispose() {},
    };
    const sdk = {
      createAgentSessionFromServices: async () => ({ session }),
      createAgentSessionServices: async () => ({}),
      createBashToolDefinition: () => ({}),
      getAgentDir: () => "/agent",
      SessionManager: { create: () => manager, open: () => manager },
    } as unknown as PiSdk;
    const body = runAkumaBody(normalizeLaunch({
      paths: allocated.paths,
      seed: { id: allocated.id, archetype: "pi", provider: { name: "pi", kind: "pi" }, options: {}, origin: { kind: "direct" }, cwd: root },
      initialBody: "work",
    }), createPiProvider({ name: "pi", kind: "pi" }, async () => sdk), { now: () => "2026-08-08T00:00:00.000Z" });
    await waitUntilLatestBody(allocated.paths, body);
    await recordTell(allocated.paths, { id: "pi-live", body: "steer", recordedAt: "2026-08-08T00:00:01.000Z" });
    await waitForCondition("Pi to queue the native steer", () => steered !== undefined, { terminalState: settlementProbe(body, () => "Body settled before native steer") });
    assert.deepEqual(steered?.content, [{ type: "text", text: "steer" }]);
    assert.equal((await readTell(allocated.paths, "pi-live"))?.state, "pending");
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 1);
    session.listener?.({ type: "agent_end", messages: [], willRetry: false });
    assert.equal((await readTell(allocated.paths, "pi-live"))?.state, "pending");
    for (const listener of nativeListeners) listener({ type: "message_end", message: steered });
    await waitForCondition("Pi native evidence to settle the Tell", async () =>
      (await readTell(allocated.paths, "pi-live"))?.state === "told", { terminalState: settlementProbe(body, () => "Body settled before native evidence") });
    const turnSequence = (await readTell(allocated.paths, "pi-live"))?.binding?.turnSequence;
    assert.equal(turnSequence, 2);
    release();
    await body;
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 1);
    assert.equal((await readTurn(allocated.paths, turnSequence!))?.end?.outcome.kind, "answered");
    assert.equal(nativeListeners.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi native end without steer evidence carries the pending Tell to the next Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-pi-body-late-"));
  try {
    const allocated = await allocatedHeart(root, "pi", "1a2b3c42");
    const { promise: released, resolve: release } = promiseBarrier<void>();
    const nativeListeners = new Set<(event: { type: string; message?: unknown }) => void>();
    const prompts: string[] = [];
    let steered = false;
    let sessions = 0;
    const manager = { getLeafId: () => `pi-answer-${sessions}` };
    const sdk = {
      createAgentSessionFromServices: async () => {
        sessions += 1;
        const first = sessions === 1;
        const session = {
          sessionFile: "/sessions/pi-late.jsonl", sessionId: `pi-${sessions}`, sessionManager: manager,
          agent: {
            subscribe(listener: (event: { type: string; message?: unknown }) => void) {
              if (first) nativeListeners.add(listener);
              return () => { nativeListeners.delete(listener); };
            },
            steer() { steered = true; },
          },
          subscribe(listener: (event: { type: string; message?: unknown }) => void) {
            this.listener = listener;
            return () => { this.listener = undefined; };
          },
          listener: undefined as ((event: { type: string; message?: unknown }) => void) | undefined,
          async prompt(text: string) {
            prompts.push(text);
            if (first) await released;
            this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
          },
          async abort() { release(); },
          dispose() {},
        };
        return { session };
      },
      createBashToolDefinition: () => ({}),
      createAgentSessionServices: async () => ({}),
      getAgentDir: () => "/agent",
      SessionManager: { create: () => manager, open: () => manager },
    } as unknown as PiSdk;
    const body = runAkumaBody(normalizeLaunch({
      paths: allocated.paths,
      seed: { id: allocated.id, archetype: "pi", provider: { name: "pi", kind: "pi" }, options: {}, origin: { kind: "direct" }, cwd: root },
      initialBody: "work",
    }), createPiProvider({ name: "pi", kind: "pi" }, async () => sdk), { now: () => "2026-08-08T00:00:00.000Z" });
    await waitUntilLatestBody(allocated.paths, body);
    await recordTell(allocated.paths, { id: "pi-late", body: "late input", recordedAt: "2026-08-08T00:00:01.000Z" });
    await waitForCondition("Pi to queue the late steer", () => steered, { terminalState: settlementProbe(body, () => "Body settled before native steer") });
    for (const listener of nativeListeners) listener({ type: "agent_end" });
    assert.equal((await readTell(allocated.paths, "pi-late"))?.state, "pending");
    release();
    await expectBodySettles(body, "Pi Body did not start the next Turn after native end");
    const tell = await readTell(allocated.paths, "pi-late");
    assert.equal(tell?.state, "told");
    assert.deepEqual(tell?.deliveries.map((delivery) => delivery.route), ["launch"]);
    assert.equal(sessions, 2);
    assert.deepEqual(prompts, ["work", "late input"]);
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 1);
    assert.equal(nativeListeners.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed release recovery spawn records Heart undelivered disposition", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-release-spawn-failure-"));
  try {
    const allocated = await allocatedHeart(root, "acp", "1a2b3c45");
    let spawnAttempts = 0;
    const body = driveAkumaBody(acpLaunch(allocated, root), hangingAdapter("release-spawn-failure"), {
      now: () => "2026-08-08T00:00:00.000Z",
      async spawnBody() {
        spawnAttempts += 1;
        const open = await readOpenPendingTellDisposition(allocated.paths);
        assert.deepEqual(open?.tellIds, ["release-spawn-failure"]);
        assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
        assert.equal(await probeLeash(allocated.paths), "free");
        throw new Error("spawn denied");
      },
    });
    await waitUntilLatestBody(allocated.paths, body);
    await recordTell(allocated.paths, {
      id: "release-spawn-failure",
      body: "continue",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await expectBodySettles(body, "Body did not release after spawn failure");
    assert.equal(spawnAttempts, 1);
    assert.equal(await probeLeash(allocated.paths), "free");
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    assert.equal((await readTell(allocated.paths, "release-spawn-failure"))?.state, "told");
    assert.equal(await readOpenPendingTellDisposition(allocated.paths), null);
    assert.match(readFileSync(allocated.paths.log, "utf8"), /pending Tell disposition undelivered: spawn denied/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate wake after a recorded successor disposition does not create a second Body", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-duplicate-wake-"));
  try {
    const allocated = await allocatedHeart(root, "acp", "1a2b3c46");
    let spawnCount = 0;
    const body = driveAkumaBody(acpLaunch(allocated, root), hangingAdapter("duplicate-wake"), {
      now: () => "2026-08-08T00:00:00.000Z",
      async spawnBody(launch) {
        spawnCount += 1;
        void driveAkumaBody(launch, hangingAdapter("successor-held"), {
          now: () => "2026-08-08T00:00:02.000Z",
        });
        return {
          pid: spawnCount,
          exited: unresolved(),
          async terminate() {},
          release() {},
        } satisfies OwnedProcess;
      },
    });
    await waitUntilLatestBody(allocated.paths, body);
    await recordTell(allocated.paths, {
      id: "tell-duplicate",
      body: "once",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await expectBodySettles(body, "Body did not dispose pending Tell");
    await waitForCondition("the successor Body recorded after the duplicate wake", async () => {
      return (await readHeart(allocated.paths)).latestBody?.sequence === 2;
    });
    await waitForCondition("the duplicate Tell to reach a terminal delivery", async () => {
      return (await readTell(allocated.paths, "tell-duplicate"))?.state !== "pending";
    });
    assert.equal(spawnCount, 1);
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 2);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, undefined);
    assert.equal((await readTell(allocated.paths, "tell-duplicate"))?.state, "told");
    assert.equal(await readOpenPendingTellDisposition(allocated.paths), null);
    await handoffPendingTells(allocated.paths, async () => {
      spawnCount += 1;
      throw new Error("duplicate disposition must not spawn");
    });
    assert.equal(spawnCount, 1);
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 2);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successor Body record before admission failure yields Heart undelivered for the snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-successor-admission-fail-"));
  try {
    const allocated = await allocatedHeart(root, "acp", "1a2b3c52");
    const emptyLog = { path: allocated.paths.log, from: 0, to: 0 };
    let spawnAttempts = 0;
    const body = driveAkumaBody(acpLaunch(allocated, root), hangingAdapter("parent-before-successor-fail"), {
      now: () => "2026-08-08T00:00:00.000Z",
      async spawnBody(launch) {
        spawnAttempts += 1;
        const exited = new Promise<Awaited<OwnedProcess["exited"]>>((resolve) => {
          void driveAkumaBody(
            launch,
            scenarioProvider(async () => {
                throw new Error("native admission refused after body record");
            }),
            { now: () => "2026-08-08T00:00:02.000Z" },
          ).finally(() => resolve({ code: 1, signal: null, log: emptyLog }));
        });
        return {
          pid: spawnAttempts,
          exited,
          async terminate() {},
          release() {},
        } satisfies OwnedProcess;
      },
    });
    await waitUntilLatestBody(allocated.paths, body);
    await recordTell(allocated.paths, {
      id: "tell-admission-fail",
      body: "continue",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await expectBodySettles(body, "Body did not settle successor admission failure", 2_000);
    assert.equal(spawnAttempts, 1);
    const heart = await readHeart(allocated.paths);
    assert.ok((heart.latestBody?.sequence ?? 0) > 1);
    assert.equal(heart.latestBody?.end, "broke-off");
    assert.deepEqual(heart.pending, []);
    assert.equal((await readTell(allocated.paths, "tell-admission-fail"))?.state, "told");
    assert.equal(await readOpenPendingTellDisposition(allocated.paths), null);
    assert.match(
      readFileSync(allocated.paths.log, "utf8"),
      /pending Tell disposition undelivered: pre-admission exit 1/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent handoff before ending-body leash release does not consume the snapshot", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-concurrent-leash-handoff-");
  const allocated = await allocatedHeart(root, "acp", "1a2b3c53");
  const seed = {
    id: allocated.id,
    archetype: "acp",
    provider: { name: "acp", kind: "acp" as const },
    options: {},
    origin: { kind: "direct" as const },
    cwd: root,
    allowed: ALLOWED_ACTIONS,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
  const leash = await HeldAkumaLeash.try(allocated.paths);
  assert.ok(leash !== null);
  assert.equal(await leash.birth(allocated.paths, seed), "born");
  const body = await leash.recordBody(allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
  await recordTell(allocated.paths, {
    id: "tell-concurrent-leash",
    body: "continue",
    recordedAt: "2026-08-08T00:00:01.000Z",
  });
  const decided = await decidePendingTellDisposition(allocated.paths, {
    bodySequence: body.sequence,
    at: "2026-08-08T00:00:02.000Z",
    handoff: true,
  });
  assert.deepEqual(decided?.tellIds, ["tell-concurrent-leash"]);
  assert.equal(await probeLeash(allocated.paths), "held");
  assert.equal(await resolvePendingTellDisposition(allocated.paths, decided!.bodySequence, seed.createdAt), false);
  let spawnAttempts = 0;
  await handoffPendingTells(allocated.paths, async () => {
    spawnAttempts += 1;
    return {
      pid: 1,
      exited: Promise.resolve({
        code: 75,
        signal: null,
        log: { path: allocated.paths.log, from: 0, to: 0 },
      }),
      async terminate() {},
      release() {},
    } satisfies OwnedProcess;
  });
  assert.equal(spawnAttempts, 1);
  assert.deepEqual(await readOpenPendingTellDisposition(allocated.paths), decided);
  assert.equal((await readTell(allocated.paths, "tell-concurrent-leash"))?.state, "pending");
  assert.deepEqual(
    (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
    ["tell-concurrent-leash"],
  );
  leash.release();
});

test("open disposition referencing a missing Tell is Heart corruption, not proven", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-disposition-missing-tell-");
  const allocated = await allocatedHeart(root, "acp", "1a2b3c54");
  const seed = {
    id: allocated.id,
    archetype: "acp",
    provider: { name: "acp", kind: "acp" as const },
    options: {},
    origin: { kind: "direct" as const },
    cwd: root,
    allowed: ALLOWED_ACTIONS,
    createdAt: "2026-08-08T00:00:00.000Z",
  };
  const leash = await HeldAkumaLeash.try(allocated.paths);
  assert.ok(leash !== null);
  assert.equal(await leash.birth(allocated.paths, seed), "born");
  const body = await leash.recordBody(allocated.paths, { leashTakenAt: "2026-08-08T00:00:00.000Z" });
  await recordTell(allocated.paths, {
    id: "tell-missing-row",
    body: "continue",
    recordedAt: "2026-08-08T00:00:01.000Z",
  });
  const decided = await decidePendingTellDisposition(allocated.paths, {
    bodySequence: body.sequence,
    at: "2026-08-08T00:00:02.000Z",
    handoff: true,
  });
  assert.deepEqual(decided?.tellIds, ["tell-missing-row"]);
  leash.release();

  const heart = new DatabaseSync(allocated.paths.heart);
  heart.exec("PRAGMA foreign_keys=OFF");
  const tellSequence = (
    heart.prepare("SELECT sequence FROM tells WHERE id = ?").get("tell-missing-row") as
      | { sequence: number }
      | undefined
  )?.sequence;
  assert.ok(tellSequence !== undefined);
  heart.prepare("DELETE FROM tells WHERE id = ?").run("tell-missing-row");
  heart.prepare("DELETE FROM timeline WHERE sequence = ?").run(tellSequence);
  heart.close();

  await assert.rejects(
    resolvePendingTellDisposition(allocated.paths, decided!.bodySequence, seed.createdAt),
    /Akuma disposition references missing tell tell-missing-row/u,
  );
  await assert.rejects(
    handoffPendingTells(allocated.paths, async () => {
      throw new Error("corrupt disposition must not spawn");
    }),
    /Akuma disposition references missing tell tell-missing-row/u,
  );
  assert.deepEqual(await readOpenPendingTellDisposition(allocated.paths), decided);
});


test("receipt persistence failure aborts the Session and terminates the Body", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-receipt-failure-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "1a2b3c4e");
    let aborted = false;
    const { promise: eventsReleased, resolve: releaseEvents } = promiseBarrier<void>();
    const body = driveAkumaBody(
      claudeBodyLaunch(allocated, root, "work"),
      scenarioProvider(async () => {
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
      }),
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
    const allocated = await allocatedHeart(root, "claude", "1a2b3c4e");
    let aborted = false;
    let directory!: string;
    const { promise: eventsReleased, resolve: releaseEvents } = promiseBarrier<void>();
    const body = driveAkumaBody(
      claudeBodyLaunch(allocated, root, "work"),
      scenarioProvider(async (input) => {
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
      }),
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );

    await waitForCondition(
      "the provider launch to publish its request directory",
      () => directory !== undefined,
      { terminalState: settlementProbe(body, () => "the driving Body pump settled without publishing a request directory") },
    );
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
    const allocated = await allocatedHeart(root, "claude", "1a2b3c4e");
    let directory!: string;
    const { promise: started, resolve: setupStarted } = promiseBarrier<void>();
    const { promise: setupAbortObserved, resolve: setupAborted } = promiseBarrier<void>();
    let setupAbortReason: unknown;
    const body = driveAkumaBody(
      claudeBodyLaunch(allocated, root, "work"),
      scenarioProvider(async (input) => {
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
      }),
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

test("an answer without an admitted or resumed session is retained as a failed turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-sessionless-answer-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "decafbad");
    await driveAkumaBody(
      claudeBodyLaunch(allocated, root, "start"),
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
    const allocated = await allocatedHeart(root, "claude", "a1b2c3d4");
    const soul = {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" as const },
      options: {},
      origin: { kind: "direct" as const },
      cwd: root,
      allowed: ALLOWED_ACTIONS,
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
    const allocated = await allocatedHeart(root, "claude", "c0ffed00");
    const { promise: started, resolve: setupStarted } = promiseBarrier<void>();
    const body = driveAkumaBody(
      claudeBodyLaunch(allocated, root, "work"),
      scenarioProvider(async (input) => {
          setupStarted();
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
          });
          throw new Error("unreachable setup continuation");
      }),
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    await started;
    const current = (await readHeart(allocated.paths)).latestBody!;
    const requestedAt = performance.now();
    await requestPause(allocated.paths, "2026-08-08T00:00:01.000Z");
    await expectBodySettles(body, "Body did not abort stalled setup", 500);
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
    const allocated = await allocatedHeart(root, "claude", "c0ffed01");
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
    const child = await allocatedHeart(root, "worker", "c0ffed02");
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
      await expectBodySettles(body, "Body did not interrupt request settlement", 500);
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
    const allocated = await allocatedHeart(root, "claude", "c0ffee00");
    let aborted = false;
    let forced = false;
    const { promise: completion, resolve: settle } = promiseBarrier<TurnResult>();
    const running: FixtureProviderAdapter = scenarioProvider(async () => {
        return {
          admission: { fence: "pause-fixture-turn" },
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
            throw new Error("graceful disposal failed");
          },
          async forceDispose() {
            forced = true;
            aborted = true;
            settle({ kind: "failed", diagnostic: "paused" });
          },
        };
    });
    const body = driveAkumaBody(claudeBodyLaunch(allocated, root, "work"), running, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await waitUntilLatestBody(allocated.paths, body);
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
    const allocated = await allocatedHeart(root, "claude", "c0ffee06");
    const body = driveAkumaBody(
      claudeBodyLaunch(allocated, root, "work"),
      scenarioProvider(async () => {
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
      }),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );
    await waitUntilLatestBody(allocated.paths, body);
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
    const allocated = await allocatedHeart(root, "claude", "c0ffee07");
    const { promise: closed, reject: rejectClosed } = promiseBarrier<void>();
    const { promise: started, resolve: markStarted } = promiseBarrier<void>();
    const body = driveAkumaBody(
      claudeBodyLaunch(allocated, root, "work"),
      scenarioProvider(() => {
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
      }),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );
    await waitUntilLatestBody(allocated.paths, body);
    await started;
    rejectClosed(new Error("provider resource close failed"));
    await expectBodySettles(body, "Body did not supervise provider closure", 1_000);
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
  let releaseTell: (() => void) | undefined;
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee02");
    let aborted = false;
    const { promise: started, resolve: tellStarted } = promiseBarrier<void>();
    const tellReleased = new Promise<void>((resolve) => {
      releaseTell = resolve;
    });
    const { promise: returned, resolve: tellReturned } = promiseBarrier<void>();
    const { promise: completion, resolve: settle } = promiseBarrier<TurnResult>();
    let successorSpawns = 0;
    const body = driveAkumaBody(
      claudeBodyLaunch(allocated, root, "work"),
      scenarioProvider(async () => {
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
              tellReturned();
              return { kind: "turn-ended" as const };
            },
            async abort() {
              aborted = true;
              settle({ kind: "failed", diagnostic: "paused" });
            },
          };
      }),
      {
        now: () => new Date().toISOString(),
        async spawnBody() {
          successorSpawns += 1;
          return {
            pid: 0,
            exited: Promise.resolve({
              code: LEASH_HELD_EXIT,
              signal: null,
              log: { path: allocated.paths.log, from: 0, to: 0 },
            }),
            async terminate() {},
            release() {},
          } satisfies OwnedProcess;
        },
      },
    );
    await waitUntilLatestBody(allocated.paths, body);
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
    assert.equal(successorSpawns, 0);
    if (releaseTell === undefined) throw new Error("stalled Tell did not retain a release handle");
    releaseTell();
    await returned;
    assert.equal((await readHeart(allocated.paths)).pending.length, 1);
  } finally {
    releaseTell?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema Turn malformed JSON is invalid-output and open bound Turns fail when Body is put down", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-invalid-output-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "bad00001");
    const schemaJson = '{"type":"object"}';
    const born = (await HeldAkumaLeash.try(allocated.paths))!;
    await born.birth(allocated.paths, {
      id: allocated.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      cwd: root,
      allowed: ALLOWED_ACTIONS,
      createdAt: "2026-08-08T00:00:00.000Z",
    });
    born.release();
    await heartRecordTell(allocated.paths, {
      kind: "tell",
      id: "schema-bad",
      body: "structured",
      recordedAt: "2026-08-08T00:00:01.000Z",
      schemaJson,
    });
    await driveAkumaBody(
      { paths: allocated.paths },
      scenarioProvider(async () => {
          return {
            admission: { fence: "bad-json" },
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: "session", coordinate: { sessionId: "native-bad" } } satisfies AgentEvent;
              },
            },
            completion: Promise.resolve({ kind: "answered" as const, answer: "not-json", historyId: "history-bad" }),
            async abort() {},
          };
      }),
      { now: () => "2026-08-08T00:00:02.000Z" },
    );
    const tell = await readTell(allocated.paths, "schema-bad");
    const turn = tell?.binding === undefined ? null : await readTurn(allocated.paths, tell.binding.turnSequence);
    assert.equal(turn?.end?.outcome.kind, "invalid-output");
    if (turn?.end?.outcome.kind === "invalid-output") assert.equal(turn.end.outcome.answer, "not-json");

    await recordTell(allocated.paths, {
      id: "open-bound",
      body: "steer",
      recordedAt: "2026-08-08T00:00:03.000Z",
    });
    const { promise: resumeStarted, resolve: resumed } = promiseBarrier<void>();
    const resumableHanging = {
      ...hangingAdapter("g4-open"),
      async resume() {
        resumed();
        return hangingSession("g4-open");
      },
    } satisfies FixtureProviderAdapter;
    const hanging = driveAkumaBody({ paths: allocated.paths }, resumableHanging, {
      now: () => "2026-08-08T00:00:04.000Z",
    });
    await resumeStarted;
    const bound = await readTell(allocated.paths, "open-bound");
    await requestPause(allocated.paths, "2026-08-08T00:00:05.000Z");
    await expectBodySettles(hanging, "Body did not put down open bound Turn");
    const failed = bound?.binding === undefined ? null : await readTurn(allocated.paths, bound.binding.turnSequence);
    assert.equal(failed?.end?.outcome.kind, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spawn ENOENT diagnosis preserves the original failure as cause", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-body-spawn-cause-"));
  const liveExecPath = process.execPath;
  try {
    const allocated = await allocatedHeart(root, "claude", "ca5e0001");
    const vanishedCwd = join(root, "vanished-cwd");
    const vanishedExecutable = join(root, "vanished-runtime", "keiyaku-body");
    Object.defineProperty(process, "execPath", { value: vanishedExecutable, configurable: true });
    await assert.rejects(
      spawnAkumaBody({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: vanishedCwd,
          allowed: ALLOWED_ACTIONS,
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Body spawn failed/);
        assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
        const cause = (error as Error & { cause?: unknown }).cause as NodeJS.ErrnoException | undefined;
        assert.ok(cause !== undefined, "diagnosis preserves the original ENOENT as cause");
        assert.equal(cause.code, "ENOENT");
        return true;
      },
    );
  } finally {
    Object.defineProperty(process, "execPath", { value: liveExecPath, configurable: true });
    rmSync(root, { recursive: true, force: true });
  }
});


test("Body launch validates the real argv value without minting World or process authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-launch-schema-"));
  try {
    const allocated = await allocatedHeart(root, "claude", "1234abcd");
    const launch = claudeBodyLaunch(allocated, root, "work");
    const input = await bodyProcessInput(launch);
    const raw: unknown = JSON.parse(Buffer.from(input.argv.at(-1)!, "base64url").toString("utf8"));
    assert.deepEqual(bodyLaunchSchema.parse(raw), launch);
    assert.equal(bodyLaunchSchema.safeParse({ ...launch, process: { pid: 1 } }).success, false);
    assert.equal(bodyLaunchSchema.safeParse({ ...launch, paths: { ...launch.paths, heart: 1 } }).success, false);
    assert.equal(bodyLaunchSchema.safeParse({ ...launch, seed: { ...launch.seed, id: "aku/not-a-coordinate" } }).success, false);
    assert.equal(bodyLaunchSchema.safeParse({ paths: launch.paths }).success, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
