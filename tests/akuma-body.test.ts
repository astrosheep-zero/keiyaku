import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import { allocatedHeart, claudeBodyLaunch, driveWithTell, recordTell, insertLegacyPauseControl } from "./support/akuma-fixtures.js";
import {
  expectBodySettles, installAkumaBodyIdleFinishBarrier, installAkumaBodyPidReceipt,
  settlementProbe, waitForCondition, waitForPidReceiptExit,
} from "./support/process.js";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/runtime/proc/run.js";
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
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CONTROL_RESPONSE_MS, driveAkumaBody } from "../src/akuma/body.js";
import { bodyLaunchSchema, type BodyLaunch, type LiveBodyLaunch } from "../src/akuma/body-launch.js";
import { bodyProcessInput, spawnAkumaBody } from "../src/akuma/detached-body.js";
import { createClaudeProvider } from "../src/akuma/providers/claude/index.js";
import { akumaExecutionEnvironment } from "../src/akuma/providers/execution-environment.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import {
  HeldAkumaLeash,
  activitySlice,
  probeLeash,
  readHeart,
  readTell,
  readTurn,
  readLatestTurnForBody,
  recordSession,
  recordTell as heartRecordTell,
  requestStop,
} from "../src/akuma/heart/index.js";
import type { ProviderOptions } from "../src/akuma/provider-recipe.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import {
  createProviderAttempt,
  AGENT_EVENT_QUEUE_LIMIT,
  AgentEventChannel,
  type AgentEvent,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "../src/akuma/provider.js";
import type { PluginSignal } from "../src/plugin/public.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { Akuma } from "../src/akuma/index.js";
import { World } from "../src/world.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

/** Lifecycle watchdogs exclude optional default-observer startup and delivery. */
function bodyTestDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({ plugins: { square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false } } }),
  );
  return root;
}

type TurnOutcomePluginRecorder = {
  activations: number;
  observations: Array<Readonly<{ signal: PluginSignal; outcomes: unknown }>>;
  observe(signal: PluginSignal, participation: AbortSignal): Promise<void>;
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
      "    if (globalThis.__keiyakuTurnOutcomePluginRecorder) globalThis.__keiyakuTurnOutcomePluginRecorder.activations += 1;",
      "    return { signals: {",
      '      "akuma.turn-outcome": (signal, participation) => { globalThis.__keiyakuTurnSignalRecorder?.push(signal); return globalThis.__keiyakuTurnOutcomePluginRecorder?.observe(signal, participation); },',
      '      "akuma.turn-started": (signal) => { globalThis.__keiyakuTurnSignalRecorder?.push(signal); return globalThis.__keiyakuHangingStartedHandler ? new Promise(() => {}) : undefined; },',
      "    } };",
      "  },",
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(plugins, "broken.mjs"),
    [
      "export default {",
      '  manifest: { id: "broken", apiVersion: 1 },',
      '  activate() { return { signals: { "akuma.turn-started": () => { throw new Error("started observer failure"); }, "akuma.turn-outcome": () => { throw new Error("observer failure"); } } }; },',
      "};",
    ].join("\n"),
  );
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: {
        square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
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
    JSON.stringify({
      plugins: {
        square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
        "body-observer": { package: "./plugins/body-observer.mjs" },
      },
    }),
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
  KEIYAKU_EXTERNAL_CALLER: "outer:parent",
  KEIYAKU_CLAUDE_ACTOR_SESSION: "parent-claimed-session",
} as const;

const PARENT_HARNESS_KEYS = Object.keys(PARENT_HARNESS_ENVIRONMENT) as Array<keyof typeof PARENT_HARNESS_ENVIRONMENT>;

test("Body launch and provider setup isolate parent harness identity without mutating concurrent inputs", async () => {
  const parent = {
    ...PARENT_HARNESS_ENVIRONMENT,
    PATH: "/test/path",
    API_TOKEN: "credential",
    SQUARE_LOCATION: "configured-location",
    SENTINEL: "survives",
    KEIYAKU_ACTOR_ID: "aku/body/1234abcd",
    KEIYAKU_ACTOR_WORLD: "/body/world",
  };
  const overrides = {
    ...PARENT_HARNESS_ENVIRONMENT,
    API_TOKEN: "provider-credential",
    PROVIDER_SENTINEL: "provider-survives",
  };
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => akumaExecutionEnvironment(parent, overrides, [], {
      akumaId: "aku/child/abcdef12", world: "/child/world",
    })),
    Promise.resolve().then(() => akumaExecutionEnvironment(parent, overrides)),
  ]);
  for (const key of PARENT_HARNESS_KEYS) {
    assert.equal(first[key], undefined);
    assert.equal(second[key], undefined);
  }
  assert.equal(first.KEIYAKU_ACTOR_ID, "aku/child/abcdef12");
  assert.equal(first.KEIYAKU_ACTOR_WORLD, "/child/world");
  assert.equal(second.KEIYAKU_ACTOR_ID, undefined);
  assert.equal(second.KEIYAKU_ACTOR_WORLD, undefined);
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
    KEIYAKU_ACTOR_ID: "aku/body/1234abcd",
    KEIYAKU_ACTOR_WORLD: "/body/world",
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
    const allocated = await allocateAkumaDirectory({ worldRoot: root, akumaName: "claude", draw: () => "e11d0001" });
    const input = await bodyProcessInput(
      {
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          akumaName: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: root,
        },
      },
      import.meta.url,
    );
    for (const key of PARENT_HARNESS_KEYS) {
      assert.equal(input.env[key], undefined);
    }
    assert.equal(input.env.KEIYAKU_ACTOR_ID, allocated.id);
    assert.equal(input.env.KEIYAKU_ACTOR_WORLD, root);
    assert.equal(input.env.KEIYAKU_EXTERNAL_CALLER, undefined);
    assert.equal(process.env.PI_SESSION_ID, "parent-pi");
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

const turnSignalPluginGlobal = globalThis as typeof globalThis & { __keiyakuTurnSignalRecorder?: PluginSignal[] };

const hangingStartedPluginGlobal = globalThis as typeof globalThis & { __keiyakuHangingStartedHandler?: boolean };

/** Record turn-started beside turn-outcome in producer order, so the order itself is evidence. */
function installTurnSignalRecorder(): PluginSignal[] {
  const signals: PluginSignal[] = [];
  turnSignalPluginGlobal.__keiyakuTurnSignalRecorder = signals;
  return signals;
}

/** Install one turn-outcome recorder that snapshots the scenario Heart on every observation. */
function installTurnOutcomeRecorder(
  paths: Parameters<typeof outcomes>[0],
  observe?: TurnOutcomePluginRecorder["observe"],
): TurnOutcomePluginRecorder {
  const recorder: TurnOutcomePluginRecorder = {
    activations: 0,
    observations: [],
    async observe(signal, participation) {
      this.observations.push({ signal, outcomes: await outcomes(paths) });
      await observe?.(signal, participation);
    },
  };
  turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder = recorder;
  return recorder;
}

type FixtureResource = Readonly<{
  abort?: () => Promise<void>;
  forceDispose?: () => Promise<void>;
}>;

function sessionResource(completion: Session["completion"], resource: FixtureResource = {}): Readonly<{
  closed: Promise<void>;
  abort(): Promise<void>;
  forceDispose(): Promise<void>;
}> {
  let settleClosed!: () => void;
  const defaultClosed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });
  void completion.then(settleClosed, settleClosed);
  return {
    closed: defaultClosed,
    abort: async () => {
      await resource.abort?.();
      settleClosed();
    },
    forceDispose: async () => {
      await (resource.forceDispose ?? resource.abort)?.();
      settleClosed();
    },
  };
}

/** One scenario provider that admits every option; its attempt stays at the call site. */
function scenarioProvider(
  start: ProviderAdapter["start"],
  extra: Omit<ProviderAdapter, "admitOptions" | "start"> = {},
): ProviderAdapter {
  return { admitOptions: (options) => ({ kind: "admitted", options }), start, ...extra };
}

function unresolved<T = never>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function hangingSession(fence: string): Session {
  return {
    admission: { fence },
    events: {
      async *[Symbol.asyncIterator]() {
        await unresolved();
      },
    },
    completion: unresolved<TurnResult>(),
  };
}

function hangingAdapter(fence: string, abort: () => Promise<void> = async () => {}, onStart?: () => void): ProviderAdapter {
  return scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
    onStart?.();
    const session = hangingSession(fence);
    custody.own(sessionResource(session.completion, { abort }));
    return session;
  }));
}

async function waitUntilLatestBody(
  paths: Parameters<typeof readHeart>[0],
  settlement?: Promise<unknown>,
): Promise<void> {
  await waitForCondition(
    "the active Body recorded in Heart",
    async () => {
      const { latestBody } = await readHeart(paths);
      return latestBody !== null && latestBody.end === undefined;
    },
    settlement === undefined
      ? {}
      : { terminalState: settlementProbe(settlement, () => "the driving Body pump settled without a recorded Body") },
  );
}

/**
 * Wait until the driving Body has started its provider session.
 *
 * A Tell recorded while a Body is still being born can be drained into the Turn's launch submission
 * instead of reaching the session's live tell callback: the Body snapshots its pending Tells before
 * it starts the provider. A test that expects the live callback records
 * only after this handshake. The Body's own settlement ends the wait by name instead of spinning.
 */
async function awaitProviderSession(
  started: () => boolean,
  driving: Promise<unknown>,
  description: string,
): Promise<void> {
  await waitForCondition(description, started, {
    terminalState: settlementProbe(driving, () => "the driving Body settled before its provider session started"),
  });
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
        launchTells: readonly Readonly<{ id: string; text: string }>[];
        schemaJson?: string;
        options: ProviderOptions;
        session: "fresh" | string;
      }>
    >;
  }>,
): ProviderAdapter {
  const drive = (
    call: Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0],
  ) => createProviderAttempt(call.signal, async (custody) => {
    const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
    const sessionId = call.session.kind === "fresh" ? "fresh" : call.session.coordinate.sessionId;
    if (sessionId !== "fresh") assert.ok(sessionId);
    input.starts.push({
      launchTells: call.launchTells,
      ...(call.schemaJson === undefined ? {} : { schemaJson: call.schemaJson }),
      options: call.options,
      session: sessionId,
    });
    const session = {
      admission: { fence: `fixture-${input.starts.length}` },
      events: {
        async *[Symbol.asyncIterator]() {
          for (const event of input.events) yield event;
          finishEvents();
        },
      },
      completion: eventsFinished.then(() => input.result),
    };
    custody.own(sessionResource(session.completion));
    return session;
  });
  return scenarioProvider(drive, { resume: drive });
}

test("birth observes durable Soul and Body once, without Turn ownership or replay", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-body-born-");
  const world = await World.at(root);
  const output = join(root, "births.jsonl");
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "plugins", "birth.mjs"), `
    import { appendFileSync } from "node:fs";
    import { readHeart, readLatestTurnForBody } from ${JSON.stringify(new URL("../src/akuma/heart/index.js", import.meta.url).href)};
    import { pathsForAkumaId } from ${JSON.stringify(new URL("../src/akuma/identity.js", import.meta.url).href)};
    export default { manifest: { id: "birth", apiVersion: 1 }, activate(context) {
      return { signals: { "akuma.born": async (signal) => {
        const heart = await readHeart(pathsForAkumaId(context.world, signal.akumaId));
        const turn = await readLatestTurnForBody(pathsForAkumaId(context.world, signal.akumaId), signal.bodySequence);
        appendFileSync(context.config.output, JSON.stringify({ signal, soul: heart.soul, body: heart.latestBody, turn }) + "\\n");
        throw new Error("birth observer failure");
      } } };
    } };
  `);
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {
    birth: { package: "./plugins/birth.mjs", config: { output } },
  } }));
  const allocated = await allocatedHeart(world, "claude", "b1700001");
  const empty = claudeBodyLaunch(allocated, root, { birthInitiator: "Submitter", completion: { contractId: "kei/birth" } });
  const starts: Parameters<typeof adapter>[0]["starts"] = [];
  await driveAkumaBody(empty, adapter({ starts, events: [], result: { kind: "failed", diagnostic: "unexpected drive" } }));
  assert.deepEqual(starts, [], "prompt-free birth never invokes the provider");
  const observations = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].signal, {
    kind: "akuma.born", akumaId: allocated.id, bodySequence: 1,
    origin: { kind: "direct" }, caller: { kind: "unknown" }, initiator: "Submitter", contractId: "kei/birth",
  });
  assert.equal(observations[0].soul.id, allocated.id);
  assert.equal(observations[0].body.sequence, 1);
  assert.equal(observations[0].body.end, undefined);
  assert.equal(observations[0].turn, null);
  assert.equal((await readHeart(allocated.paths)).latestBody?.end, "exited");
  assert.match(readFileSync(allocated.paths.log, "utf8"), /plugin birth failed: plugin birth signal: birth observer failure/u);
  await driveAkumaBody(empty, undefined); // Even a stale launch carrying the seed is not another birth.
  await driveAkumaBody({ paths: allocated.paths }, undefined); // Ordinary wake also stays silent.
  assert.equal(readFileSync(output, "utf8").trim().split("\n").length, 1);

  const sealed = await allocatedHeart(world, "claude", "b1700002");
  const leash = (await HeldAkumaLeash.try(sealed.paths))!;
  await leash.sealIfUnborn(sealed.paths, { evidence: "sealed", at: new Date().toISOString() });
  leash.release();
  await driveAkumaBody(claudeBodyLaunch(sealed, root), undefined);
  assert.equal((await readHeart(sealed.paths)).soul, null);
  assert.equal(readFileSync(output, "utf8").trim().split("\n").length, 1);

  const interrupted = await allocatedHeart(world, "claude", "b1700003");
  const failedLaunch = { ...empty, paths: interrupted.paths, seed: { ...empty.seed!, id: interrupted.id } };
  const record = t.mock.method(HeldAkumaLeash.prototype, "recordBody", async () => { throw new Error("lost before Body"); });
  await assert.rejects(driveAkumaBody(failedLaunch, undefined), /lost before Body/u);
  record.mock.restore();
  const lost = await readHeart(interrupted.paths);
  assert.equal(lost.soul?.id, interrupted.id);
  assert.equal(lost.latestBody, null);
  await driveAkumaBody(failedLaunch, undefined);
  assert.equal(readFileSync(output, "utf8").trim().split("\n").length, 1);
});

test("outcome plugins observe each committed Turn once and finish before the next Turn", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-plugin-turn-answered-");
  const { promise: held, resolve: releaseHook } = promiseBarrier<void>();
  const { promise: queued, resolve: markQueued } = promiseBarrier<void>();
  let body: Promise<unknown> | undefined;
  try {
    const allocated = await allocatedHeart(root, "claude", "1234abce");
    configureTurnOutcomePlugins(root);
    const at = "2026-08-08T00:00:00.000Z";
    const opening = { id: "opening", body: "build it", initiator: "Alice" };
    const groups = [
      [opening],
      [
        { id: "adjust", body: "adjust it", initiator: "Bob" },
        { id: "check", body: "also check tests", initiator: "Carol" },
      ],
      [
        { id: "continue", body: "continue without attribution" },
        { id: "extra", body: "also continue", initiator: "Dana" },
      ],
    ];
    let nextGroup = 1;
    let firstHookFinished = false;
    const recorder = installTurnOutcomeRecorder(allocated.paths, async () => {
      const index = nextGroup++;
      for (const tell of groups[index] ?? []) await recordTell(allocated.paths, { ...tell, recordedAt: at });
      if (index === 1) {
        markQueued();
        await held;
        firstHookFinished = true;
      }
    });
    const starts: Parameters<typeof adapter>[0]["starts"] = [];
    const answer = { kind: "answered", answer: "done" } as const;
    const session = { sessionId: "plugin-session" };
    const provider = adapter({ starts, events: [{ type: "session", coordinate: session }], result: answer });
    body = driveWithTell(
      claudeBodyLaunch(allocated, root, { completion: { contractId: "kei/example" }, birthInitiator: "Submitter" }),
      opening,
      {
        ...provider,
        resume(input) {
          assert.ok(firstHookFinished, "a normal next Turn must not overlap outcome participation");
          return provider.resume!(input);
        },
      },
      { now: () => at },
    );
    await expectBodySettles(queued, "the first outcome hook did not queue its next input");
    releaseHook();
    await body;

    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "exited");
    const sequences = await committedTurnSequences(allocated.paths);
    const expectedSubmissions = groups.map((group) => group.map(({ id, body }) => ({ id, text: body })));
    assert.deepEqual(starts.map((start) => start.launchTells), expectedSubmissions);
    const audiences = [
      { initiator: "Alice", participants: ["Alice"] },
      { initiator: "Bob", participants: ["Bob", "Carol"] },
      { participants: ["Dana"] },
    ];
    assert.deepEqual(
      recorder.observations.map(({ signal }) => signal),
      audiences.map((audience, index) => ({
        kind: "akuma.turn-outcome",
        akumaId: allocated.id,
        bodySequence: 2,
        turnSequence: sequences[index],
        at,
        outcome: { kind: "answered", text: "done" },
        contractId: "kei/example",
        ...audience,
      })),
    );
    assert.deepEqual(
      recorder.observations.map(({ outcomes: seen }) => seen),
      audiences.map((_, index) => Array.from({ length: index + 1 }, () => ({ ...answer, session }))),
    );
  } finally {
    releaseHook();
    await body?.catch(() => undefined);
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn-outcome plugins observe a committed failed Turn without changing it", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-plugin-turn-failed-");
  try {
    const allocated = await allocatedHeart(root, "claude", "1234abcf");
    configureTurnOutcomePlugins(root);
    const recorder = installTurnOutcomeRecorder(allocated.paths);
    await pluginRuntime({ world: await World.at(root) });
    await eventually(() => recorder.activations === 1);

    await driveWithTell(
      claudeBodyLaunch(allocated, root),
      "build it",
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
          bodySequence: 2,
          turnSequence: (await committedTurnSequences(allocated.paths))[0],
          at: "2026-08-08T00:00:00.000Z",
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

test("turn-started plugins observe one start per Turn of one Body before each outcome", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-plugin-turn-started-");
  try {
    const allocated = await allocatedHeart(root, "claude", "1234abd0");
    configureTurnOutcomePlugins(root);
    const signals = installTurnSignalRecorder();
    hangingStartedPluginGlobal.__keiyakuHangingStartedHandler = true;
    await pluginRuntime({ world: await World.at(root) });
    const { promise: released, resolve: release } = promiseBarrier<void>();
    let started = false;
    let refused = false;
    let first = true;
    const session = (input: Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0]) => createProviderAttempt(input.signal, async (custody) => {
      const wasFirst = first;
      first = false;
      const session = {
        admission: { fence: "started-turn" },
        events: {
          async *[Symbol.asyncIterator]() {
            started = true;
            yield { type: "session", coordinate: { sessionId: "started-same-body" } } satisfies AgentEvent;
            if (wasFirst) await released;
          },
        },
        completion: wasFirst
          ? released.then(() => ({ kind: "answered" as const, answer: "one" }))
          : Promise.resolve({ kind: "failed" as const, diagnostic: "provider failed" }),
        async tell() {
          refused = true;
          return { kind: "turn-ended" as const };
        },
      };
      custody.own(sessionResource(session.completion));
      return session;
    });
    const body = driveWithTell(claudeBodyLaunch(allocated, root), { body: "build it", initiator: "Alice" }, scenarioProvider(session, { resume: session }), {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await awaitProviderSession(() => started, body, "the provider session to start after the bounded signal wait");
    hangingStartedPluginGlobal.__keiyakuHangingStartedHandler = false;
    await recordTell(allocated.paths, { id: "started-live-tell", body: "steer", recordedAt: "2026-08-08T00:00:01.000Z" });
    await waitForCondition("the refused live Tell", () => refused, {
      terminalState: settlementProbe(body, () => "the Body settled before the live Tell was refused"),
    });
    release();
    await body;
    const sequences = await committedTurnSequences(allocated.paths);
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 2);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "broke-off");
    await eventually(() => signals.length === 4);
    assert.deepEqual(signals, [
      { kind: "akuma.turn-started", akumaId: allocated.id, turnSequence: sequences[0], initiator: "Alice" },
      { kind: "akuma.turn-outcome", akumaId: allocated.id, bodySequence: 2, turnSequence: sequences[0], at: "2026-08-08T00:00:00.000Z", initiator: "Alice", participants: ["Alice"], outcome: { kind: "answered", text: "one" } },
      { kind: "akuma.turn-started", akumaId: allocated.id, turnSequence: sequences[1] },
      { kind: "akuma.turn-outcome", akumaId: allocated.id, bodySequence: 2, turnSequence: sequences[1], at: "2026-08-08T00:00:00.000Z", outcome: { kind: "failed", reason: "provider failed" } }
    ]);
    /* The first Turn's started handler hung and the second Turn's threw; both Turns still began and ended. */
    await eventually(() => readFileSync(allocated.paths.log, "utf8").includes("timed out after 5000ms") && readFileSync(allocated.paths.log, "utf8").includes("started observer failure"), 15_000);
  } finally {
    delete hangingStartedPluginGlobal.__keiyakuHangingStartedHandler;
    delete turnSignalPluginGlobal.__keiyakuTurnSignalRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("body-ended plugins attribute only the exact Body's latest admitted Turn", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-plugin-body-end-");
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

    await driveWithTell(
      claudeBodyLaunch(allocated, root),
      { body: "first", initiator: "Alice" },
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "body-one" } }],
        result: { kind: "answered", answer: "one", historyId: "history-one" },
      }),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );
    await recordTell(allocated.paths, {
      id: "second", body: "second", initiator: "Bob", recordedAt: "2026-08-08T00:00:00.200Z",
    });
    await recordTell(allocated.paths, {
      id: "body-end-teller",
      body: "extra input",
      initiator: "Carol",
      recordedAt: "2026-08-08T00:00:00.500Z",
    });
    await driveAkumaBody(
      { paths: allocated.paths },
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "body-two" } }],
        result: { kind: "answered", answer: "two", historyId: "history-two" },
      }),
      { now: () => "2026-08-08T00:00:01.000Z" },
    );
    await recordTell(allocated.paths, { id: "third", body: "third", recordedAt: "2026-08-08T00:00:01.200Z" });
    await recordTell(allocated.paths, {
      id: "body-end-ownerless-teller",
      body: "third input",
      initiator: "Dana",
      recordedAt: "2026-08-08T00:00:01.500Z",
    });
    await driveAkumaBody(
      { paths: allocated.paths },
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "body-three" } }],
        result: { kind: "answered", answer: "three", historyId: "history-three" },
      }),
      { now: () => "2026-08-08T00:00:02.000Z" },
    );

    // The pending Tell cannot supply attribution to a Body that never admits a Turn.
    // The recipe requires resume, which this adapter does not support.
    await driveWithTell(
      { paths: allocated.paths },
      { body: "fourth", initiator: "Carol" },
      {
        admitOptions: (options) => ({ kind: "admitted", options }),
        start() {
          throw new Error("start must not be reached before a Turn exists");
        },
      },
      { now: () => "2026-08-08T00:00:03.000Z" },
    );

    assert.deepEqual(recorder.signals, [
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 1, end: "exited", at: "2026-08-08T00:00:00.000Z" },
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 2, end: "exited", at: "2026-08-08T00:00:00.000Z", initiator: "Alice", participants: ["Alice"] },
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 3, end: "exited", at: "2026-08-08T00:00:01.000Z", initiator: "Bob", participants: ["Bob", "Carol"] },
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 4, end: "exited", at: "2026-08-08T00:00:02.000Z", participants: ["Dana"] },
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 5, end: "broke-off", at: "2026-08-08T00:00:03.000Z" },
    ]);
  } finally {
    delete bodyEndPluginGlobal.__keiyakuBodyEndPluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("live receipt persistence waits for its Body-scoped delivery mapping", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-live-tell-");
  const { promise: eventsReleased, resolve: releaseEvents } = promiseBarrier<void>();
  const { promise: receiptReleased, resolve: releaseReceipt } = promiseBarrier<void>();
  let body: ReturnType<typeof driveAkumaBody> | undefined;
  try {
    const allocated = await allocatedHeart(root, "claude", "1a2b3c4d");
    configureTurnOutcomePlugins(root);
    const recorder = installTurnOutcomeRecorder(allocated.paths);
    let observed = false;
    const tellObserved = () => { observed = true; };
    let sessionStarted = false;
    const live: ProviderAdapter = scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
        sessionStarted = true;
        const session = {
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
        };
        custody.own(sessionResource(session.completion));
        return session;
    }));
    const runtime = { now: () => "2026-08-08T00:00:00.000Z" };
    await driveAkumaBody(claudeBodyLaunch(allocated, root), live, runtime);
    await recordTell(allocated.paths, { id: "opening", body: "work", initiator: "Alice", recordedAt: runtime.now() });
    await recordTell(allocated.paths, {
      id: "tell-launch",
      body: "coalesced",
      initiator: "Carol",
      recordedAt: "2026-08-08T00:00:00.000Z",
    });
    body = driveAkumaBody({ paths: allocated.paths }, live, runtime);
    await waitUntilLatestBody(allocated.paths, body);
    await awaitProviderSession(
      () => sessionStarted,
      body,
      "the provider session to start before recording the live Tell",
    );
    await recordTell(allocated.paths, {
      id: "tell-live",
      body: "steer",
      initiator: "Bob",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await waitForCondition("the live Tell callback", () => observed, {
      terminalState: settlementProbe(body, () => "Body settled before the live Tell callback"),
    });
    releaseEvents();
    await body;
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    assert.deepEqual(recorder.observations.map(({ signal }) => signal.kind === "akuma.turn-outcome" ? {
      initiator: signal.initiator,
      participants: signal.participants,
    } : null), [{ initiator: "Alice", participants: ["Alice", "Carol", "Bob"] }]);
  } finally {
    releaseReceipt();
    releaseEvents();
    await body;
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude's receipt-free live acknowledgement settles the Tell in the current Body", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-live-ack-");
  const { promise: eventsReleased, resolve: releaseEvents } = promiseBarrier<void>();
  let body: ReturnType<typeof driveAkumaBody> | undefined;
  try {
    const allocated = await allocatedHeart(root, "claude", "1a2b3c40");
    let input: AsyncIterator<SDKUserMessage>;
    let pullingLive = false;
    let yielded: IteratorResult<SDKUserMessage> | undefined;
    const live = createClaudeProvider(async () => ({
      query({ prompt }) {
        assert.notEqual(typeof prompt, "string");
        input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        const query = (async function* () {
          await input.next();
          // The next pull acknowledges launch and waits for the first live Tell.
          void input.next().then((message) => { yielded = message; }, () => {});
          pullingLive = true;
          yield { type: "system", subtype: "init", session_id: "live-session" };
          await eventsReleased;
          yield { type: "result", subtype: "success", session_id: "live-session", result: "done" };
        })() as unknown as Query;
        query.close = releaseEvents;
        return query;
      },
    }));
    body = driveWithTell(claudeBodyLaunch(allocated, root), "work", live, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await waitUntilLatestBody(allocated.paths, body);
    await awaitProviderSession(
      () => pullingLive,
      body,
      "the Claude Query to pull after launch before recording the live Tell",
    );
    await recordTell(allocated.paths, {
      id: "tell-live",
      body: "steer",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    await waitForCondition("Claude to receive the live Tell", () => yielded !== undefined, {
      terminalState: settlementProbe(body, () => "Body settled before Claude received the live Tell"),
    });
    assert.ok(yielded && !yielded.done);
    assert.equal(yielded.value.message.content, "steer");
    assert.equal((await readTell(allocated.paths, "tell-live"))?.state, "pending");

    const afterAcknowledgement = input!.next();
    await waitForCondition(
      "the live acknowledgement to settle the pending Tell",
      async () => (await readTell(allocated.paths, "tell-live"))?.state === "told",
      { terminalState: settlementProbe(body, () => "the driving Body pump settled with the Tell still pending") },
    );
    const tell = await readTell(allocated.paths, "tell-live");
    assert.ok(tell?.binding);
    assert.deepEqual(tell.deliveries, [
      {
        route: "live",
        turnSequence: tell.binding.turnSequence,
        receipt: "unavailable",
        deliveredAt: "2026-08-08T00:00:00.000Z",
      },
    ]);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    releaseEvents();
    await body;
    assert.equal((await afterAcknowledgement).done, true);
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 2);
  } finally {
    releaseEvents();
    await body;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi native steer evidence keeps a Tell in its current Body and Turn", async () => {
  const root = bodyTestDirectory("keiyaku-pi-body-steer-");
  try {
    const allocated = await allocatedHeart(root, "pi", "1a2b3c41");
    const { promise: released, resolve: release } = promiseBarrier<void>();
    const nativeListeners = new Set<(event: { type: string; message?: unknown }) => void>();
    let steered: { role: string; content: unknown } | undefined;
    let sessionStarted = false;
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
      async bindExtensions() {},
      async prompt() {
        sessionStarted = true;
        await released;
        this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "steered answer" }] } });
      },
      async abort() { release(); },
      extensionRunner: { emit: async () => {}, onError: () => () => {} },
      dispose() {},
    };
    const sdk = {
      createAgentSessionFromServices: async () => ({ session }),
      createEventBus,
      createAgentSessionServices: async () => ({ resourceLoader: { getExtensions: () => ({ errors: [] }) } }),
      createBashToolDefinition: () => ({}),
      getAgentDir: () => "/agent",
      SessionManager: { create: () => manager, open: () => manager },
    } as unknown as PiSdk;
    const body = driveWithTell({
      paths: allocated.paths,
      seed: { id: allocated.id, akumaName: "pi", provider: { name: "pi", kind: "pi" }, options: {}, origin: { kind: "direct" }, cwd: root },
    }, "work", createPiProvider({ name: "pi", kind: "pi" }, async () => sdk), { now: () => "2026-08-08T00:00:00.000Z" });
    await waitUntilLatestBody(allocated.paths, body);
    await awaitProviderSession(
      () => sessionStarted,
      body,
      "the Pi session to start before recording the live Tell",
    );
    const initialTurn = await readLatestTurnForBody(allocated.paths, 2);
    assert.ok(initialTurn !== null);
    await recordTell(allocated.paths, { id: "pi-live", body: "steer", recordedAt: "2026-08-08T00:00:01.000Z" });
    await waitForCondition("Pi to queue the native steer", () => steered !== undefined, { terminalState: settlementProbe(body, () => "Body settled before native steer") });
    assert.deepEqual(steered?.content, [{ type: "text", text: "steer" }]);
    assert.equal((await readTell(allocated.paths, "pi-live"))?.state, "pending");
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 2);
    session.listener?.({ type: "agent_end", messages: [], willRetry: false });
    assert.equal((await readTell(allocated.paths, "pi-live"))?.state, "pending");
    for (const listener of nativeListeners) listener({ type: "message_end", message: steered });
    await waitForCondition("Pi native evidence to settle the Tell", async () =>
      (await readTell(allocated.paths, "pi-live"))?.state === "told", { terminalState: settlementProbe(body, () => "Body settled before native evidence") });
    const turnSequence = (await readTell(allocated.paths, "pi-live"))?.binding?.turnSequence;
    assert.equal(turnSequence, initialTurn.sequence);
    release();
    await body;
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 2);
    assert.equal((await readTurn(allocated.paths, turnSequence!))?.end?.outcome.kind, "answered");
    assert.equal(nativeListeners.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi native end without steer evidence carries the pending Tell to the next Turn", async () => {
  const root = bodyTestDirectory("keiyaku-pi-body-late-");
  try {
    const allocated = await allocatedHeart(root, "pi", "1a2b3c42");
    const { promise: released, resolve: release } = promiseBarrier<void>();
    const nativeListeners = new Set<(event: { type: string; message?: unknown }) => void>();
    const prompts: string[] = [];
    let steered = false;
    let sessionStarted = false;
    let sessions = 0;
    const manager = { getLeafId: () => `pi-answer-${sessions}` };
    const sdk = {
      createEventBus,
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
          async bindExtensions() {},
          async prompt(text: string) {
            sessionStarted = true;
            prompts.push(text);
            if (first) await released;
            this.listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
          },
          async abort() { release(); },
          extensionRunner: { emit: async () => {}, onError: () => () => {} },
          dispose() {},
        };
        return { session };
      },
      createBashToolDefinition: () => ({}),
      createAgentSessionServices: async () => ({ resourceLoader: { getExtensions: () => ({ errors: [] }) } }),
      getAgentDir: () => "/agent",
      SessionManager: { create: () => manager, open: () => manager },
    } as unknown as PiSdk;
    const body = driveWithTell({
      paths: allocated.paths,
      seed: { id: allocated.id, akumaName: "pi", provider: { name: "pi", kind: "pi" }, options: {}, origin: { kind: "direct" }, cwd: root },
    }, "work", createPiProvider({ name: "pi", kind: "pi" }, async () => sdk), { now: () => "2026-08-08T00:00:00.000Z" });
    await waitUntilLatestBody(allocated.paths, body);
    await awaitProviderSession(
      () => sessionStarted,
      body,
      "the Pi session to start before recording the live Tell",
    );
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
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 2);
    assert.equal(nativeListeners.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const phase of ["setup", "execution"] as const) {
  test(`provider ${phase} failure strands the Body and a later ordinary Tell wakes retained input`, { timeout: 10_000 }, async (t) => {
    const root = bodyTestDirectory("keiyaku-akuma-queue-failure-");
    const started = promiseBarrier<void>();
    const fail = promiseBarrier<void>();
    let body: Promise<unknown> | undefined;
    let woken: Promise<unknown> | undefined;
    try {
      const allocated = await allocatedHeart(root, "claude", "ca1ce105");
      const owner = new AkumaOwner(allocated.id, await World.at(root));
      const diagnostic = `native ${phase} refused`;
      const failing = scenarioProvider((input) => createProviderAttempt(input.signal, async () => {
        started.resolve();
        const completion = fail.promise.then(() => ({ kind: "failed" as const, diagnostic }));
        if (phase === "setup") {
          await completion;
          throw new Error(diagnostic);
        }
        return {
          admission: { fence: "first" },
          events: { async *[Symbol.asyncIterator]() {} },
          completion,
        };
      }));
      body = driveWithTell(claudeBodyLaunch(allocated, root), { id: "opening", body: "work" }, failing, { signal: t.signal });
      await expectBodySettles(started.promise, "provider never began setup");
      const predecessor = (await readHeart(allocated.paths)).latestBody!;
      await recordTell(allocated.paths, { id: "queued", body: "retain me", recordedAt: new Date().toISOString() });
      fail.resolve();
      await expectBodySettles(body, "failed Body did not settle");
      const stranded = await readHeart(allocated.paths);
      assert.equal(stranded.latestBody?.sequence, predecessor.sequence);
      assert.equal(stranded.latestBody?.end, "broke-off");
      assert.deepEqual(await outcomes(allocated.paths), [{ kind: "failed", diagnostic }]);
      const retained = phase === "setup" ? ["opening", "queued"] : ["queued"];
      assert.deepEqual(stranded.pending.map((tell) => tell.id), retained);
      assert.equal(stranded.pending.at(-1)?.binding, undefined);
      assert.deepEqual(await owner.tellOutcome("queued", { timeoutMs: 0 }), {
        reason: "completed", outcome: null, completedAt: null,
      });

      const starts: Parameters<typeof adapter>[0]["starts"] = [];
      const answering = adapter({
        starts,
        events: [{ type: "session", coordinate: { sessionId: "new-attempt" } }],
        result: { kind: "answered", answer: "drained" },
      });
      await owner.tell("wake", "next", undefined, {
        async spawn(paths) {
          const launched = driveAkumaBody({ paths, refuseIfHeld: true }, answering);
          woken = launched;
          return {
            completed: launched.then(() => ({ diagnostic: "wake ended" })),
            async cancel() {},
            release() {},
          };
        },
      }, { signal: t.signal });
      await woken;
      assert.deepEqual(starts[0]?.launchTells.map((tell) => tell.id), [...retained, "next"]);
      const settled = await readHeart(allocated.paths);
      assert.equal(settled.latestBody?.sequence, predecessor.sequence + 1);
      assert.equal(settled.latestBody?.end, "exited");
      assert.deepEqual(settled.pending, []);
      assert.equal((await owner.tellOutcome("queued", { timeoutMs: 0 })).outcome?.kind, "answered");
    } finally {
      fail.resolve();
      await Promise.allSettled([body, woken]);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("receipt persistence failure aborts the Session and terminates the Body", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-receipt-failure-");
  try {
    const allocated = await allocatedHeart(root, "claude", "1a2b3c4e");
    let aborted = false;
    const { promise: eventsReleased, resolve: releaseEvents } = promiseBarrier<void>();
    const body = driveWithTell(
      claudeBodyLaunch(allocated, root),
      "work",
      scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
          const session = {
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
          };
          custody.own(sessionResource(session.completion, {
            abort: async () => {
              aborted = true;
              releaseEvents();
            },
          }));
          return session;
      })),
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

test("an answer without an admitted or resumed session is retained as a failed turn", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-sessionless-answer-");
  try {
    const allocated = await allocatedHeart(root, "claude", "decafbad");
    await driveWithTell(
      claudeBodyLaunch(allocated, root),
      "start",
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
  const root = bodyTestDirectory("keiyaku-akuma-orphan-stop-");
  try {
    const allocated = await allocatedHeart(root, "claude", "a1b2c3d4");
    const soul = {
      id: allocated.id,
      akumaName: "claude",
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
    assert.notEqual((await readHeart(allocated.paths)).stop, null);
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
    assert.equal((await readHeart(allocated.paths)).stop, null);
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
  const root = bodyTestDirectory("keiyaku-akuma-setup-pause-");
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffed00");
    const { promise: started, resolve: setupStarted } = promiseBarrier<void>();
    const body = driveWithTell(
      claudeBodyLaunch(allocated, root),
      { id: "opening", body: "work" },
      scenarioProvider((input) => createProviderAttempt(input.signal, async () => {
          setupStarted();
          await new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
          });
          throw new Error("unreachable setup continuation");
      })),
      {
        now: () => "2026-08-08T00:00:00.000Z",
      },
    );
    await started;
    const current = (await readHeart(allocated.paths)).latestBody!;
    const requestedAt = performance.now();
    await insertLegacyPauseControl(allocated.paths, current.sequence, "2026-08-08T00:00:01.000Z");
    await expectBodySettles(body, "Body did not abort stalled setup", 500);
    assert.ok(performance.now() - requestedAt < CONTROL_RESPONSE_MS);
    assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, current.sequence);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.deepEqual(await outcomes(allocated.paths), [{ kind: "canceled" }]);
    const input = await readTell(allocated.paths, "opening");
    assert.deepEqual(input && { id: input.id, body: input.body, state: input.state }, {
      id: "opening", body: "work", state: "pending",
    });
    assert.equal(await probeLeash(allocated.paths), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("kill publishes cancellation only after provider closure and emits that committed terminal once", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-proven-cancel-");
  const { promise: closed, resolve: close } = promiseBarrier<void>();
  const { promise: aborting, resolve: abort } = promiseBarrier<void>();
  const { promise: started, resolve: start } = promiseBarrier<void>();
  let driven: Promise<unknown> | undefined;
  try {
    const allocated = await allocatedHeart(root, "claude", "ca1ce102");
    configureTurnOutcomePlugins(root);
    const recorder = installTurnOutcomeRecorder(allocated.paths);
    driven = driveWithTell(claudeBodyLaunch(allocated, root), { body: "opening work", initiator: "Alice" },
      scenarioProvider(() => {
        start();
        return {
        result: Promise.resolve({ admission: { fence: "proven" }, events: { async *[Symbol.asyncIterator]() { await unresolved(); } }, completion: unresolved<TurnResult>() }),
        closed,
        async abort() { abort(); },
        async forceDispose() { close(); },
      }; }), { now: () => new Date().toISOString() });
    await started;
    const current = (await readHeart(allocated.paths)).latestBody!;
    await recordTell(allocated.paths, {
      id: "queued-at-kill",
      body: "continue later",
      recordedAt: new Date().toISOString(),
    });
    const killing = Akuma.select(await World.at(root), allocated.id).kill({ signal: AbortSignal.timeout(5_000) });
    await aborting;
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, undefined);
    assert.deepEqual(await outcomes(allocated.paths), [], "stop request and abort acknowledgement are not closure proof");
    close();
    assert.equal(await killing, "killed");
    await driven;
    assert.deepEqual(await outcomes(allocated.paths), [{ kind: "canceled" }]);
    const heart = await readHeart(allocated.paths);
    assert.equal(heart.latestBody?.sequence, current.sequence);
    assert.deepEqual(heart.pending.map((tell) => tell.id), ["queued-at-kill"]);
    assert.equal(recorder.observations.length, 1);
    const signal = recorder.observations[0]?.signal;
    assert.equal(signal?.kind, "akuma.turn-outcome");
    if (signal?.kind === "akuma.turn-outcome") assert.deepEqual(signal.outcome, { kind: "canceled" });
    assert.deepEqual(recorder.observations[0]?.outcomes, [{ kind: "canceled" }]);
    const status = await Akuma.select(await World.at(root), allocated.id).status();
    assert.equal(status.work.kind, "idle");
    assert.equal(status.work.outcome?.verdict, "canceled");
  } finally {
    close();
    await driven?.catch(() => undefined);
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("public kill cancels a held outcome hook but still requires Attempt closure", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-kill-after-answer-");
  const { promise: closed, resolve: releaseClosed } = promiseBarrier<void>();
  const { promise: held, resolve: releaseHook } = promiseBarrier<void>();
  let participation: AbortSignal | undefined;
  let aborted = 0;
  let body: Promise<unknown> | undefined;
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee08");
    configureTurnOutcomePlugins(root);
    const recorder = installTurnOutcomeRecorder(allocated.paths, async (_signal, cancellation) => {
      participation = cancellation;
      await held;
    });
    const answer = { kind: "answered", answer: "answer", historyId: "answer-history" } as const;
    const sessionId = "answer-before-close";
    const running = scenarioProvider((input) =>
      createProviderAttempt(input.signal, async (custody) => {
        custody.own({
          closed,
          abort: async () => {
            aborted += 1;
          },
          forceDispose: async () => releaseClosed(),
        });
        const events = new AgentEventChannel();
        events.emit({ type: "session", coordinate: { sessionId } });
        events.end();
        return { admission: { fence: sessionId }, events, completion: Promise.resolve(answer) };
      }),
    );
    body = driveWithTell(claudeBodyLaunch(allocated, root), "work", running);
    await waitForCondition("the real outcome hook to hold", () => participation !== undefined, { budgetMs: 5_000 });
    const committed = [{ ...answer, session: { sessionId } }];
    assert.deepEqual(recorder.observations[0]?.outcomes, committed);
    const killing = Akuma.select(await World.at(root), allocated.id).kill();
    await waitForCondition(
      "hook cancellation and provider abort",
      () => participation?.aborted === true && aborted === 1,
      {
        terminalState: settlementProbe(killing, String),
        budgetMs: 5_000,
      },
    );
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, undefined);
    assert.equal(await probeLeash(allocated.paths), "held");
    releaseClosed();
    assert.equal(await killing, "killed");
    await expectBodySettles(body, "canceled participation must not leave a later hook drain");
    assert.deepEqual(await outcomes(allocated.paths), committed);
    assert.equal(recorder.observations.length, 1);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.equal(await probeLeash(allocated.paths), "free");
    await eventually(() => readFileSync(allocated.paths.log, "utf8").includes("dropped on producer control"));
  } finally {
    releaseHook();
    releaseClosed();
    await body?.catch(() => undefined);
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt supervises an answered Turn until Attempt closure proof", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-interrupt-after-answer-");
  const { promise: closed, resolve: releaseClosed } = promiseBarrier<void>();
  let aborted = 0;
  let body: Promise<unknown> | undefined;
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee09");
    const answer = { kind: "answered", answer: "answer", historyId: "answer-history" } as const;
    const sessionId = "interrupt-before-close";
    const running = scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
      const session = {
        admission: { fence: sessionId },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId } };
          },
        },
        completion: Promise.resolve(answer),
      };
      custody.own({
        closed,
        abort: async () => {
          aborted += 1;
          releaseClosed();
        },
        forceDispose: async () => {},
      });
      return session;
    }));
    body = driveWithTell(claudeBodyLaunch(allocated, root), "work", running, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await waitForCondition("the committed answer before interrupt", async () => (await outcomes(allocated.paths)).length > 0, {
      budgetMs: 5_000,
    });
    const committed = [{ ...answer, session: { sessionId } }];
    assert.deepEqual(await outcomes(allocated.paths), committed);
    const interrupted = await new AkumaOwner(allocated.id, await World.at(root)).interrupt("continue", {
      runtime: {
        async spawn() {
          throw new Error("fixture successor unavailable");
        },
      },
    });
    assert.equal("kind" in interrupted, false);
    if ("kind" in interrupted) throw new Error("interrupt was unavailable");
    assert.equal(interrupted.interruption?.kind, "completed");
    await body;
    assert.equal(aborted, 1);
    assert.deepEqual(await outcomes(allocated.paths), committed);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.equal((await readHeart(allocated.paths)).pending.length, 1);
    assert.deepEqual(interrupted.wake, { kind: "failed", diagnostic: "fixture successor unavailable" });
  } finally {
    releaseClosed();
    await body?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "fixture gates retire on owner loss, launch cancellation, and supervisor close",
  {
    skip: process.platform === "win32" && "Windows cannot unlink the open fixture Heart",
  },
  async () => {
    const root = await World.at(bodyTestDirectory("keiyaku-owned-gates-"));
    const barrier = join(root, "barrier");
    const receipt = join(root, "body-pids");
    mkdirSync(barrier);
    const restoreReceipt = installAkumaBodyPidReceipt(receipt);
    const restoreBarrier = installAkumaBodyIdleFinishBarrier(barrier);
    let launch: LiveBodyLaunch | undefined;
    try {
      const allocated = await allocatedHeart(root, "claude", "c3000000");
      launch = await spawnAkumaBody(claudeBodyLaunch(allocated, root));
      await waitForCondition(
        "detached Body at both fixture gates",
        () => existsSync(join(barrier, "idle-ready")) && existsSync(join(barrier, "observation-ready")),
        {
          budgetMs: 5_000,
          terminalState: settlementProbe(
            launch.completed,
            (end) => `${end.diagnostic}: ${readFileSync(allocated.paths.log, "utf8")}`,
          ),
        },
      );
      // Fault injection removes only this launch's gate owner and Heart. Keep its
      // log and captured launch capability until physical departure is witnessed.
      rmSync(barrier, { recursive: true });
      rmSync(allocated.paths.heart);
      await expectBodySettles(launch.completed, "ownerless fixture gates retained the detached Body", 5_000);
      await waitForPidReceiptExit(receipt, 2_000, { requireBirth: true });
    } finally {
      try {
        if (existsSync(barrier)) {
          writeFileSync(join(barrier, "release"), "release\n");
          writeFileSync(join(barrier, "observation-release"), "release\n");
        }
        await launch?.cancel();
        await launch?.completed;
        if (launch !== undefined) await waitForPidReceiptExit(receipt, 2_000, { requireBirth: true });
        // This removal is unreachable when exact launch retirement is unproven.
        rmSync(root, { recursive: true, force: true });
      } finally {
        restoreBarrier();
        restoreReceipt();
      }
    }

    const scoped = await World.at(bodyTestDirectory("keiyaku-owned-gate-cancellation-"));
    try {
      const result = await runOwnedWaitFixture("gates", scoped);
      assert.equal(result.kind, "terminal", JSON.stringify(result));
      if (result.kind === "terminal") assert.equal(result.code, 0, result.stderr);
    } finally {
      rmSync(scoped, { recursive: true, force: true });
    }
  },
);

test("proven provider retirement leaves no deadline retaining the subprocess", async () => {
  const root = await World.at(bodyTestDirectory("keiyaku-owned-wait-retirement-"));
  try {
    const result = await runOwnedWaitFixture("retirement", root);
    assert.equal(result.kind, "terminal", JSON.stringify(result));
    if (result.kind !== "terminal") return;
    assert.equal(result.code, 0, result.stderr);
    const receipt: { departureMs: number; deadlineMs: number } = JSON.parse(result.stdout);
    assert.ok(receipt.departureMs < receipt.deadlineMs * 0.75, JSON.stringify(receipt));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runOwnedWaitFixture(mode: "gates" | "retirement", root: string) {
  const compiled = import.meta.url.endsWith(".js");
  const fixture = new URL("./support/owned-wait-retirement.js", import.meta.url);
  if (!compiled) fixture.pathname = fixture.pathname.replace(/\.js$/u, ".ts");
  return await runProcess({
    argv: [
      process.execPath,
      ...(compiled ? [] : ["--import", "tsx"]),
      fileURLToPath(fixture),
      mode,
      root,
    ],
    timeoutMs: 15_000,
  });
}

test("ordinary wake recovers an interrupt admitted before its caller disappears", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-interrupt-caller-loss-");
  const { promise: closed, resolve: releaseClosed } = promiseBarrier<void>();
  let body: Promise<unknown> | undefined;
  let oldLiveTells = 0;
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee10");
    const { promise: eventsEnded, resolve: markEventsEnded } = promiseBarrier<void>();
    const oldProvider = scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
      const session = {
        admission: { fence: "old-body" },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "old-body" } };
            markEventsEnded();
          },
        },
        completion: Promise.resolve<TurnResult>({ kind: "answered", answer: "old answer", historyId: "old-answer" }),
        tell: async () => {
          oldLiveTells += 1;
          return { kind: "accepted" as const, fence: "old-body" };
        },
      };
      custody.own({ closed, abort: async () => releaseClosed(), forceDispose: async () => releaseClosed() });
      return session;
    }));
    body = driveWithTell(claudeBodyLaunch(allocated, root), "work", oldProvider, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await waitUntilLatestBody(allocated.paths, body);
    await eventsEnded;

    const owner = new AkumaOwner(allocated.id, await World.at(root));
    const admission = await owner.admitTell("continue", { tellId: "caller-lost-interrupt", interrupt: true });
    assert.equal(admission.kind, "recorded");
    assert.equal((await readHeart(allocated.paths)).pause?.frontierTellId, admission.tell.id);

    // No completion observer runs: the durable barrier and Tell are all that survive.
    await body;
    assert.equal((await readHeart(allocated.paths)).pause?.frontierTellId, admission.tell.id);
    assert.equal(oldLiveTells, 0, "the protected input never reached the predecessor provider");

    const delivered: Readonly<{ id: string; text: string }>[] = [];
    const nextProvider = scenarioProvider(
      (input) => createProviderAttempt(input.signal, async () => {
        throw new Error("an existing session should be resumed");
      }),
      {
        resume: (input) => createProviderAttempt(input.signal, async (custody) => {
          delivered.push(...input.launchTells);
          const session = {
            admission: { fence: "successor-body" },
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: "session" as const, coordinate: { sessionId: "old-body" } };
              },
            },
            completion: Promise.resolve<TurnResult>({ kind: "answered", answer: "recovered", historyId: "recovered" }),
          };
          custody.own({ closed: Promise.resolve(), forceDispose: async () => {} });
          return session;
        }),
      },
    );
    await driveAkumaBody({ paths: allocated.paths }, nextProvider, {
      now: () => "2026-08-08T00:00:02.000Z",
    });

    assert.deepEqual(delivered, [{ id: admission.tell.id, text: "continue" }]);
    assert.equal(oldLiveTells, 0);
    assert.equal((await readTell(allocated.paths, admission.tell.id))?.state, "told");
    assert.equal((await readTell(allocated.paths, admission.tell.id))?.deliveries.length, 1);
    assert.equal((await readHeart(allocated.paths)).pause, null);
  } finally {
    releaseClosed();
    await body?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});


test("pause aborts the current drive and records the body as put down", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-pause-");
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee00");
    let aborted = false;
    let forced = false;
    const { promise: started, resolve: markStarted } = promiseBarrier<void>();
    const { promise: completion, resolve: settle } = promiseBarrier<TurnResult>();
    const running: ProviderAdapter = scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
        const session = {
          admission: { fence: "pause-fixture-turn" },
          events: {
            async *[Symbol.asyncIterator]() {
              markStarted();
              while (!aborted) {
                yield { type: "note" as const, text: "Working" };
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            },
          },
          completion,
        };
        custody.own(sessionResource(completion, {
          abort: async () => {
            throw new Error("graceful disposal failed");
          },
          forceDispose: async () => {
            forced = true;
            aborted = true;
            settle({ kind: "failed", diagnostic: "paused" });
          },
        }));
        return session;
    }));
    const body = driveWithTell(claudeBodyLaunch(allocated, root), "work", running, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    await started;
    const current = (await readHeart(allocated.paths)).latestBody!;
    await insertLegacyPauseControl(allocated.paths, current.sequence, "2026-08-08T00:00:01.000Z");
    await body;
    assert.equal(aborted, true);
    assert.equal(forced, true);
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    assert.notEqual((await readHeart(allocated.paths)).pause, null);
    assert.equal(await probeLeash(allocated.paths), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forced disposal failure records hung and broke-off before the Body returns", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-hung-");
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee06");
    const { promise: started, resolve: markStarted } = promiseBarrier<void>();
    const body = driveWithTell(
      claudeBodyLaunch(allocated, root),
      "work",
      scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
          const session = {
            admission: { fence: "hung-fixture-turn" },
            events: {
              async *[Symbol.asyncIterator]() {
                markStarted();
                await new Promise<void>(() => {});
              },
            },
            completion: new Promise<TurnResult>(() => {}),
          };
          custody.own(sessionResource(session.completion, {
            abort: async () => {
              throw new Error("graceful disposal failed");
            },
            forceDispose: async () => {
              throw new Error("forced disposal failed");
            },
          }));
          return session;
      })),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );
    await started;
    const current = (await readHeart(allocated.paths)).latestBody!;
    await insertLegacyPauseControl(allocated.paths, current.sequence, "2026-08-08T00:00:01.000Z");
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
  const root = bodyTestDirectory("keiyaku-akuma-closed-failure-");
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee07");
    const { promise: closed, reject: rejectClosed } = promiseBarrier<void>();
    const { promise: started, resolve: markStarted } = promiseBarrier<void>();
    const body = driveWithTell(
      claudeBodyLaunch(allocated, root),
      "work",
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

test("Claude SDK startup exit retains its native failure and releases Body custody", { skip: !existsSync("/usr/bin/false"), timeout: 15_000 }, async () => {
  const root = bodyTestDirectory("keiyaku-claude-startup-exit-");
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee09");
    const body = driveWithTell(
      claudeBodyLaunch(allocated, root),
      "work",
      createClaudeProvider({ executable: "/usr/bin/false" }),
    );
    await expectBodySettles(body, "Body did not settle failed Claude startup");
    const heart = await readHeart(allocated.paths);
    assert.equal(heart.latestBody?.hung, undefined);
    const outcome = (await readLatestTurnForBody(allocated.paths, heart.latestBody!.sequence))?.end?.outcome;
    assert.equal(outcome?.kind, "failed");
    assert.match(outcome.diagnostic, /Claude Code process exited with code 1/u);
    assert.equal(await probeLeash(allocated.paths), "free");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Body retains a Claude SDK answer despite failed native retirement", { timeout: 15_000 }, async (context) => {
  for (const contended of [false, true])
    await context.test(contended ? "contended Heart" : "held shutdown", async () => {
      const root = bodyTestDirectory("keiyaku-claude-failed-retirement-");
      let writerReleased: Promise<void> | undefined;
      try {
        const allocated = await allocatedHeart(root, "claude", "c0ffee08");
        configureTurnOutcomePlugins(root);
        const recorder = installTurnOutcomeRecorder(allocated.paths);
        const executable = join(root, "claude.mjs");
        const release = join(root, "release-child");
        const waiting = join(root, "child-in-shutdown");
        writeFileSync(
          executable,
          `
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id, response: {},
    } });
  }
  if (message.type === 'user') {
    send({ type: 'assistant', uuid: 'native-assistant', session_id: 'proof', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'native answer' }] } });
    send({ type: 'result', subtype: 'success', session_id: 'proof', result: 'native answer' });
  }
});
lines.on('close', () => {
  writeFileSync(${JSON.stringify(waiting)}, '');
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    console.error('native teardown failed');
    process.exitCode = 7;
  }, 5);
});
`,
        );
        const provider = createClaudeProvider({ executable });
        const adapter = contended
          ? scenarioProvider((input) => {
              const attempt = provider.start(input);
              const result = attempt.result.then((session) => ({
                ...session,
                events: {
                  async *[Symbol.asyncIterator]() {
                    await assert.rejects(attempt.closed, /code 7.*native teardown failed/su);
                    assert.equal((await session.completion).kind, "answered");
                    const writer = new DatabaseSync(allocated.paths.heart, { timeout: 0 });
                    writerReleased = delay(1_400).then(() => writer.close());
                    writer.exec("BEGIN IMMEDIATE");
                    yield* session.events;
                  },
                },
              }));
              return { ...attempt, result };
            })
          : provider;
        const body = driveWithTell(claudeBodyLaunch(allocated, root), "work", adapter);
        const latestBody = async () => (await readHeart(allocated.paths)).latestBody;
        const latestTurn = async () =>
          await readLatestTurnForBody(allocated.paths, (await latestBody())?.sequence ?? 0);
        let committed;
        try {
          await waitForCondition(
            "the child holding shutdown and any uncontended answer committed",
            async () => existsSync(waiting) && (contended || (await latestTurn())?.end !== undefined),
            { budgetMs: 5_000, terminalState: settlementProbe(body, (end) => `Body settled (${end ?? "ordinary"})`) },
          );
          committed = await latestTurn();
          assert.equal(committed?.end !== undefined, !contended);
          assert.equal(existsSync(release), false);
          assert.equal((await latestBody())?.end, undefined);
          assert.equal(await probeLeash(allocated.paths), "held");
        } finally {
          writeFileSync(release, "");
          await expectBodySettles(body, "Body did not supervise failed retirement");
        }
        const ended = await latestBody();
        assert.match(ended?.hung?.diagnostic ?? "", /code 7.*native teardown failed/su);
        assert.equal(ended?.end, "broke-off");
        const turn = await latestTurn();
        const nativeAnswer = {
          kind: "answered",
          answer: "native answer",
          historyId: "native-assistant",
          session: { sessionId: "proof" },
        };
        assert.deepEqual(turn?.end?.outcome, nativeAnswer);
        assert.equal(recorder.observations.length, 1);
        assert.deepEqual(recorder.observations[0]?.outcomes, [nativeAnswer]);
        if (!contended) assert.deepEqual(turn, committed);
        const rows = (await activitySlice(allocated.paths)).rows;
        const assistant = rows.find(
          (fact) => fact.kind === "activity" && fact.event.type === "assistant" && fact.event.text === "native answer",
        );
        assert.ok(assistant && assistant.sequence < turn!.end!.sequence, "native narration precedes the outcome");
        assert.equal(await probeLeash(allocated.paths), "free");
      } finally {
        await writerReleased;
        delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
        rmSync(root, { recursive: true, force: true });
      }
    });
});

test("a stalled Tell is fenced by Body cancellation before leash release", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-violating-tell-");
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
    let sessionStarted = false;
    const body = driveWithTell(
      claudeBodyLaunch(allocated, root),
      "work",
      scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
          sessionStarted = true;
          const session = {
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
          };
          custody.own(sessionResource(completion, {
            abort: async () => {
              aborted = true;
              settle({ kind: "failed", diagnostic: "paused" });
            },
          }));
          return session;
      })),
      { now: () => new Date().toISOString() },
    );
    await waitUntilLatestBody(allocated.paths, body);
    await awaitProviderSession(
      () => sessionStarted,
      body,
      "the provider session to start before recording the stalled Tell",
    );
    await recordTell(allocated.paths, {
      id: "violating-live-tell",
      body: "steer",
      recordedAt: new Date().toISOString(),
    });
    await started;
    const current = (await readHeart(allocated.paths)).latestBody!;
    await insertLegacyPauseControl(allocated.paths, current.sequence, new Date().toISOString());
    await body;
    assert.equal(await probeLeash(allocated.paths), "free");
    assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
    if (releaseTell === undefined) throw new Error("stalled Tell did not retain a release handle");
    releaseTell();
    await returned;
    assert.equal((await readHeart(allocated.paths)).pending.length, 1);
  } finally {
    releaseTell?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema Turn malformed JSON is invalid-output and open bound Turns cancel when Body is put down", async () => {
  const root = bodyTestDirectory("keiyaku-akuma-invalid-output-");
  try {
    const allocated = await allocatedHeart(root, "claude", "bad00001");
    const schemaJson = '{"type":"object"}';
    const born = (await HeldAkumaLeash.try(allocated.paths))!;
    await born.birth(allocated.paths, {
      id: allocated.id,
      akumaName: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      origin: { kind: "direct" },
      cwd: root,
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
      scenarioProvider((input) => createProviderAttempt(input.signal, async (custody) => {
          const session = {
            admission: { fence: "bad-json" },
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: "session", coordinate: { sessionId: "native-bad" } } satisfies AgentEvent;
              },
            },
            completion: Promise.resolve({ kind: "answered" as const, answer: "not-json", historyId: "history-bad" }),
          };
          custody.own(sessionResource(session.completion));
          return session;
      })),
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
      resume(input: Parameters<NonNullable<ProviderAdapter["resume"]>>[0]) {
        return createProviderAttempt(input.signal, async (custody) => {
          resumed();
          const session = hangingSession("g4-open");
          custody.own(sessionResource(session.completion));
          return session;
        });
      },
    } satisfies ProviderAdapter;
    const hanging = driveAkumaBody({ paths: allocated.paths }, resumableHanging, {
      now: () => "2026-08-08T00:00:04.000Z",
    });
    await resumeStarted;
    const bound = await readTell(allocated.paths, "open-bound");
    const current = (await readHeart(allocated.paths)).latestBody!;
    await insertLegacyPauseControl(allocated.paths, current.sequence, "2026-08-08T00:00:05.000Z");
    await expectBodySettles(hanging, "Body did not put down open bound Turn");
    const canceled = bound?.binding === undefined ? null : await readTurn(allocated.paths, bound.binding.turnSequence);
    assert.deepEqual(canceled?.end?.outcome, { kind: "canceled" });
    assert.equal((await readTurn(allocated.paths, turn!.sequence))?.end?.outcome.kind, "invalid-output");
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
          akumaName: "claude",
          provider: { name: "claude", kind: "claude-agent-sdk" },
          options: {},
          origin: { kind: "direct" },
          cwd: vanishedCwd,
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
    const launch = claudeBodyLaunch(allocated, root);
    const input = await bodyProcessInput(launch);
    const raw: unknown = JSON.parse(Buffer.from(input.argv.at(-1)!, "base64url").toString("utf8"));
    assert.deepEqual(bodyLaunchSchema.parse(raw), launch);
    assert.equal(bodyLaunchSchema.safeParse({ ...launch, process: { pid: 1 } }).success, false);
    assert.equal(bodyLaunchSchema.safeParse({ ...launch, paths: { ...launch.paths, heart: 1 } }).success, false);
    assert.equal(bodyLaunchSchema.safeParse({ ...launch, seed: { ...launch.seed, id: "aku/not-a-coordinate" } }).success, false);
    assert.equal(bodyLaunchSchema.safeParse({ paths: launch.paths }).success, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a confirmed native model is the one selection every later Turn resumes with", async () => {
  const root = bodyTestDirectory("keiyaku-runtime-model-turn-");
  try {
    const allocated = await allocatedHeart(root, "claude", "1a2b3c42");
    const launch = claudeBodyLaunch(allocated, root);
    const starts: Parameters<typeof adapter>[0]["starts"] = [];
    await driveWithTell(
      { ...launch, seed: { ...launch.seed!, options: { model: "claude-requested" } } },
      "first",
      adapter({
        starts,
        events: [
          { type: "session", coordinate: { sessionId: "model-session" } },
          { type: "model", model: "claude-native" },
        ],
        result: { kind: "answered", answer: "one", historyId: "model-history" },
      }),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );
    assert.equal(starts[0]?.options.model, "claude-requested", "birth admits the requested selection");
    const born = await readHeart(allocated.paths);
    assert.equal(born.soul?.options.model, "claude-native", "native evidence replaces the seed");
    assert.equal(born.latestSession?.options.model, undefined, "a session row keeps no model copy");
    assert.equal(
      (await activitySlice(allocated.paths)).rows.some(
        (fact) => fact.kind === "activity" && fact.event.type === "model",
      ),
      false,
      "model evidence is never retained as activity",
    );

    await recordTell(allocated.paths, { id: "model-tell", body: "again", recordedAt: "2026-08-08T00:00:01.000Z" });
    await driveAkumaBody(
      { paths: allocated.paths },
      adapter({
        starts,
        events: [{ type: "session", coordinate: { sessionId: "model-session" } }],
        result: { kind: "answered", answer: "two", historyId: "model-history-2" },
      }),
      { now: () => "2026-08-08T00:00:02.000Z" },
    );
    assert.equal(starts[1]?.session, "model-session", "the later Turn resumes the admitted session");
    assert.equal(starts[1]?.options.model, "claude-native", "it runs the confirmed model, not the birth request");

    await recordTell(allocated.paths, { id: "unknown-tell", body: "changed", recordedAt: "2026-08-08T00:00:03.000Z" });
    await driveAkumaBody(
      { paths: allocated.paths },
      adapter({
        starts,
        events: [{ type: "session", coordinate: { sessionId: "model-session" } }, { type: "model" }],
        result: { kind: "answered", answer: "three", historyId: "model-history-3" },
      }),
      { now: () => "2026-08-08T00:00:04.000Z" },
    );
    assert.equal(
      (await readHeart(allocated.paths)).soul?.options.model,
      undefined,
      "an unnamed replacement clears the current selection",
    );

    // A Turn composes its options at setup, so this Turn already ran the model
    // it was admitted with; the cleared value is what the next Turn must see.
    await recordTell(allocated.paths, {
      id: "after-unknown-tell",
      body: "plain",
      recordedAt: "2026-08-08T00:00:05.000Z",
    });
    await driveAkumaBody(
      { paths: allocated.paths },
      adapter({
        starts,
        events: [{ type: "session", coordinate: { sessionId: "model-session" } }],
        result: { kind: "answered", answer: "four", historyId: "model-history-4" },
      }),
      { now: () => "2026-08-08T00:00:06.000Z" },
    );
    assert.equal(
      starts[3]?.options.model,
      undefined,
      "an absent current model removes the stale option instead of replaying it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the model a Turn proved it ran survives narration overflow into Soul and the next Turn", async () => {
  const root = bodyTestDirectory("keiyaku-runtime-model-overflow-");
  try {
    const allocated = await allocatedHeart(root, "claude", "1a2b3c99");
    const launch = claudeBodyLaunch(allocated, root);
    const starts: ProviderOptions[] = [];
    const drive = (
      call:
        | Parameters<ProviderAdapter["start"]>[0]
        | Parameters<NonNullable<ProviderAdapter["resume"]>>[0],
    ) => createProviderAttempt(call.signal, async (custody) => {
      starts.push(call.options);
      // A fast native adapter fills the channel before the Body's durable
      // writers consume anything, which is the overflow a slow consumer sees.
      const events = new AgentEventChannel();
      events.emit({ type: "session", coordinate: { sessionId: "overflow-session" } });
      events.emit({ type: "model", model: "claude-native" });
      for (let index = 0; index < AGENT_EVENT_QUEUE_LIMIT + 8; index += 1)
        events.emit({ type: "assistant", text: `narration-${index}` });
      events.end();
      const session = {
        admission: { fence: `overflow-${starts.length}` },
        events,
        completion: Promise.resolve<TurnResult>({ kind: "answered", answer: "done" }),
      };
      custody.own(sessionResource(session.completion));
      return session;
    });
    const provider: ProviderAdapter = scenarioProvider(drive, { resume: drive });

    await driveWithTell(
      { ...launch, seed: { ...launch.seed!, options: { model: "claude-requested" } } },
      "first",
      provider,
      { now: () => "2026-08-08T00:00:10.000Z" },
    );
    assert.equal(starts[0]?.model, "claude-requested", "birth admits the requested selection");
    assert.equal(
      (await readHeart(allocated.paths)).soul?.options.model,
      "claude-native",
      "the model the attempt reported survives the narration flood",
    );
    const retained = (await activitySlice(allocated.paths)).rows.flatMap((fact) =>
      fact.kind === "activity" ? [fact.event] : [],
    );
    const narration = Array.from({ length: AGENT_EVENT_QUEUE_LIMIT }, (_, index) => ({
      type: "assistant",
      text: `narration-${index + 8}`,
    }));
    assert.deepEqual(
      retained,
      [
        { type: "session", coordinate: { sessionId: "overflow-session" } },
        ...narration.slice(0, -8),
        { type: "note", text: "Agent event queue overflow: 8 ordinary narration events dropped" },
        ...narration.slice(-8),
      ],
      "session and loss evidence do not spend the bounded ordinary narration capacity",
    );

    await recordTell(allocated.paths, { id: "overflow-tell", body: "again", recordedAt: "2026-08-08T00:00:11.000Z" });
    await driveAkumaBody({ paths: allocated.paths }, provider, { now: () => "2026-08-08T00:00:12.000Z" });
    assert.equal(starts[1]?.model, "claude-native", "the next Turn's recipe runs the model the last one proved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
