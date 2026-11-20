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
import { driveAkumaBody } from "../src/akuma/body.js";
import { type LiveBodyLaunch } from "../src/akuma/body-launch.js";
import { spawnAkumaBody } from "../src/akuma/detached-body.js";
import { createClaudeProvider } from "../src/akuma/providers/claude/index.js";
import {
  HeldAkumaLeash,
  activitySlice,
  probeLeash,
  readHeart,
  readTell,
  readLatestTurnForBody,
  recordSurveillance,
} from "../src/akuma/heart/index.js";
import type { ProviderOptions } from "../src/akuma/provider-recipe.js";
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
      '      "akuma.body-ended": (signal) => { globalThis.__keiyakuTurnSignalRecorder?.push(signal); },',
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

async function outcomes(paths: Parameters<typeof activitySlice>[0]) {
  return (await activitySlice(paths)).rows.filter((fact) => fact.kind === "turn-end").map((fact) => fact.outcome);
}

async function committedTurnSequences(paths: Parameters<typeof activitySlice>[0]): Promise<readonly number[]> {
  return (await activitySlice(paths)).rows.filter((fact) => fact.kind === "turn-end").map((fact) => fact.turnSequence);
}

const turnSignalPluginGlobal = globalThis as typeof globalThis & { __keiyakuTurnSignalRecorder?: PluginSignal[] };

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
    const audiences = [["Alice", "Submitter"], ["Bob", "Carol", "Submitter"], ["Dana", "Submitter"]];
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
        audience,
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

test("normal Body-end mirrors without an audience; abnormal no-Turn end uses only standing", async () => {
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
      claudeBodyLaunch(allocated, root, { birthInitiator: "Standing" }),
      { body: "first", initiator: "Alice" },
      adapter({
        starts: [],
        events: [{ type: "session", coordinate: { sessionId: "body-one" } }],
        result: { kind: "answered", answer: "one", historyId: "history-one" },
      }),
      { now: () => "2026-08-08T00:00:00.000Z" },
    );

    // The pending Tell cannot supply attribution to a Body that never admits a Turn.
    // The recipe requires resume, which this adapter does not support.
    await driveWithTell(
      { paths: allocated.paths },
      { body: "queued", initiator: "Carol" },
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
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 2, end: "exited", at: "2026-08-08T00:00:00.000Z" },
      { kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: 3, end: "broke-off", at: "2026-08-08T00:00:03.000Z", audience: ["Standing"] },
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
    assert.deepEqual(recorder.observations.map(({ signal }) => signal.kind === "akuma.turn-outcome" ? signal.audience : null), [["Alice", "Bob", "Carol"]]);
  } finally {
    releaseReceipt();
    releaseEvents();
    await body;
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
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
    if (signal?.kind === "akuma.turn-outcome") {
      assert.deepEqual(signal.outcome, { kind: "canceled" });
      assert.deepEqual(signal.audience, ["Alice"]);
    }
    assert.deepEqual(recorder.observations[0]?.outcomes, [{ kind: "canceled" }]);
    const status = await Akuma.select(await World.at(root), allocated.id).status();
    assert.equal(status.work.kind, "idle");
    assert.equal(status.work.outcome?.state, "canceled");
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


test("hung cleanup settles and releases the leash before its ordered terminal notifications", async (t) => {
  const root = bodyTestDirectory("keiyaku-akuma-hung-");
  const { promise: held, resolve: releaseHook } = promiseBarrier<void>();
  const { promise: observing, resolve: markObserving } = promiseBarrier<void>();
  let body: ReturnType<typeof driveAkumaBody> | undefined;
  try {
    const allocated = await allocatedHeart(root, "claude", "c0ffee06");
    configureTurnOutcomePlugins(root);
    const signals = installTurnSignalRecorder();
    installTurnOutcomeRecorder(allocated.paths, async () => {
      markObserving();
      await held;
    });
    const recordHung = HeldAkumaLeash.prototype.recordBodyHung;
    let interposed: {
      body: Awaited<ReturnType<typeof readHeart>>["latestBody"];
      turn: Awaited<ReturnType<typeof readLatestTurnForBody>>;
      withdrawal: Awaited<ReturnType<typeof recordSurveillance>>;
    } | undefined;
    t.mock.method(HeldAkumaLeash.prototype, "recordBodyHung", async function (this: HeldAkumaLeash, ...args: Parameters<typeof recordHung>) {
      const receipt = await recordHung.apply(this, args);
      const [paths, { sequence }] = args;
      interposed = {
        body: (await readHeart(paths)).latestBody,
        turn: await readLatestTurnForBody(paths, sequence),
        withdrawal: await recordSurveillance(paths, allocated.id, "Standing", true),
      };
      return receipt;
    });
    const { promise: started, resolve: markStarted } = promiseBarrier<void>();
    body = driveWithTell(
      claudeBodyLaunch(allocated, root, { birthInitiator: "Standing" }),
      { body: "work", initiator: "Alice" },
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
    await expectBodySettles(observing, "hung cleanup did not attempt the failure outcome");
    const heart = await readHeart(allocated.paths);
    const at = "2026-08-08T00:00:00.000Z";
    assert.deepEqual(heart.latestBody?.hung, { diagnostic: "forced disposal failed", at });
    assert.equal(heart.latestBody?.end, "broke-off");
    assert.equal(await probeLeash(allocated.paths), "free");
    const [turnSequence] = await committedTurnSequences(allocated.paths);
    assert.equal(interposed?.withdrawal, "recorded");
    assert.deepEqual(interposed?.body?.hung, heart.latestBody?.hung);
    assert.equal(interposed?.body?.end, undefined, "withdrawal precedes the later broke-off write");
    assert.ok(interposed?.turn && interposed.turn.sequence === turnSequence && interposed.turn.end === undefined);
    const terminalSignals = () => signals.filter((signal) => "bodySequence" in signal && signal.bodySequence === current.sequence);
    assert.deepEqual(terminalSignals(), [{
      kind: "akuma.turn-outcome", akumaId: allocated.id, bodySequence: current.sequence, turnSequence, at,
      audience: ["Alice"], outcome: { kind: "failed", reason: "forced disposal failed" },
    }]);
    releaseHook();
    assert.equal(await body, "hung");
    assert.equal(terminalSignals().length, 2);
    assert.deepEqual(terminalSignals()[1], {
      kind: "akuma.body-ended", akumaId: allocated.id, bodySequence: current.sequence, end: "hung", at,
      diagnostic: "forced disposal failed", audience: ["Alice", "Standing"],
    });
  } finally {
    releaseHook();
    await body?.catch(() => undefined);
    delete turnSignalPluginGlobal.__keiyakuTurnSignalRecorder;
    delete turnOutcomePluginGlobal.__keiyakuTurnOutcomePluginRecorder;
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

test("Body birth ENOENT preserves the original cause and diagnoses both missing coordinates", async () => {
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
        assert.ok(error.message.startsWith(`Body birth for ${allocated.id} failed:`));
        assert.ok(error.message.includes(`frozen execution directory ${vanishedCwd} no longer exists`));
        assert.ok(error.message.includes(`waking process executable ${vanishedExecutable} no longer exists`));
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
