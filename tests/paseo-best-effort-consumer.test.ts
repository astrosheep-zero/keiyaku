import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import pino from "pino";
import { PluginAgentClientRegistry } from "../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js";
import { AgentManager } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js";
import { AgentStorage } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-storage.js";
import { createIdleRuntimeCleanup } from "../node_modules/@getpaseo/server/dist/server/server/agent/idle-runtime-cleanup/index.js";
import { PluginHookHandlers } from "../node_modules/@getpaseo/server/dist/server/server/plugins/lifecycle/index.js";
import type { PluginLifecycle } from "../node_modules/@getpaseo/server/dist/server/server/plugins/lifecycle/index.js";
import { startAgentRun } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-prompt.js";
import type { AgentStreamEvent } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-sdk-types.js";
import type { PaseoAgent, PaseoAgentListResult, SubscriptionObserver } from "@getpaseo/client";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createProvider } from "../plugins/paseo/plugin/server/provider.js";
import { createRegistrationHandoff, registerRegistrationHooks } from "../plugins/paseo/plugin/server/handoff.js";
import { activityHistorySchema, projectTurns } from "../src/akuma/projection.js";
import { akumaId } from "../src/akuma/identity.js";
import { activityFact, turnEndFact } from "./support/akuma-fixtures.js";
import { expectBodySettles } from "./support/process.js";
import type { TimelineFact } from "../src/akuma/heart/index.js";
import { projectTimelineRows } from "../node_modules/@getpaseo/server/dist/server/server/agent/timeline-projection.js";
import { createHistorySchema, type History, type Row } from "../plugins/paseo/plugin/server/keiyaku.js";
import type { Tell, TellAdmission } from "../plugins/paseo/plugin/server/message.js";
import { stopAttempt, type Stop } from "../plugins/paseo/plugin/server/stop.js";
import type { AkumaTransport } from "../plugins/paseo/plugin/server/transport.js";
const historySchema = createHistorySchema(activityHistorySchema);
const logger = pino({ level: "silent" });
const at = "2026-10-15T00:00:00.000Z";
const AKUMA_ID = akumaId({ akumaName: "test", suffix: "be57eff0" });
const turn = (n: number): Row => ({ kind: "turn", sequence: n, bodySequence: n, at });
const answer = (n: number, sequence: number, text = "done"): Row => ({ kind: "outcome", sequence, turnSequence: n, at, outcome: { kind: "answered", answer: text } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function receipt(_text: string, id: string, launch?: number, failed = false): TellAdmission {
  const subject = { akumaId: AKUMA_ID, tellId: id };
  return failed ? { kind: "failed", ...subject, failures: [{ stage: "wake", diagnostic: "test wake failed" }] }
    : { kind: "admitted", ...subject, ...(launch === undefined ? {} : { wake: { kind: "pending" as const } }) };
}

/** One bridge mutation as the typed transport sees it; there is no command line left to record. */
type BridgeCall =
  | Readonly<{ op: "tell"; world: string; akuId: string; text: string }>
  | Readonly<{ op: "stop"; world: string; akuId: string }>;
type MockTransport = Readonly<{
  /** The complete window one observation frame reports; the default is the test's current rows. */
  window?: (world: string, akuId: string, signal: AbortSignal) => Promise<Row[] | History>;
  tell?: Tell;
  stop?: Stop;
}>;
async function harness(t: TestContext, mock: MockTransport = {}, initialRows: Row[] = [], withResidency = false) {
  const root = await mkdtemp(join(tmpdir(), "paseo-best-effort-consumer-"));
  let rows: Row[] = initialRows;
  const calls: BridgeCall[] = [];
  const providerEvents: ProviderEvent[] = [];
  let waiting: ((frame: History) => void) | undefined;
  const queued: History[] = [];
  const read = async (world: string, akuId: string, signal: AbortSignal): Promise<History> => {
    const value = await (mock.window ?? (async () => rows))(world, akuId, signal);
    return Array.isArray(value) ? page(value) : value;
  };
  // The mirror observes through its one stream; paging history beside it would
  // double the producers it trusts and is never a correct stand-in here.
  const handoff = withResidency ? createRegistrationHandoff() : undefined;
  const bridge = createProvider({
    stream: (world, akuId, signal) => ({
      [Symbol.asyncIterator]: () => {
        let opened = false;
        return {
          async next(): Promise<IteratorResult<History>> {
            // Every subscription opens with the current window, exactly like the
            // public stream, so an explicit refresh needs no second read.
            if (!opened) { opened = true; return { done: false, value: await read(world, akuId, signal) }; }
            const delivered = queued.shift();
            if (delivered !== undefined) return { done: false, value: delivered };
            return { done: false, value: await new Promise<History>((resolve, reject) => {
              const abort = () => { waiting = undefined;
                reject(signal.reason instanceof Error ? signal.reason : new Error("observation released")); };
              if (signal.aborted) { abort(); return; }
              signal.addEventListener("abort", abort, { once: true });
              waiting = (frame) => { signal.removeEventListener("abort", abort); resolve(frame); };
            }) };
          },
          async return(): Promise<IteratorResult<History>> { return { done: true, value: undefined }; },
        };
      },
    }),
    tell: async (world, akuId, signal, text) => {
      calls.push({ op: "tell", world, akuId, text });
      if (mock.tell === undefined) throw new Error("unexpected Tell");
      return await mock.tell(world, akuId, signal, text);
    },
    stop: async (world, akuId, signal) => {
      calls.push({ op: "stop", world, akuId });
      if (mock.stop === undefined) throw new Error("unexpected Stop");
      return await mock.stop(world, akuId, signal);
    },
    status: async () => ({}),
    close: async () => {},
  } satisfies AkumaTransport, handoff);
  let beforePrompt: (() => Promise<void>) | undefined;
  const registry = new PluginAgentClientRegistry(logger);
  registry.replace([{ ...bridge.provider, async connect(request) {
    const connection = await bridge.provider.connect(request);
    return { ...connection,
      onEvent(listener) { return connection.onEvent(event => { providerEvents.push(event); listener(event); }); },
      async send(input) {
        if (input.type === "session.prompt") await beforePrompt?.();
        await connection.send(input);
      } };
  } }]);
  let directoryOpens = 0;
  let activeDirectoryListeners = 0;
  let releaseDirectoryListener: (() => void) | undefined;
  const hooks = withResidency ? new PluginHookHandlers(() => {}) : undefined;
  const paseo = withResidency ? {
    agents: {
      async list(options: { filter?: unknown; page?: unknown; subscribe?: unknown; signal?: AbortSignal }) {
        directoryOpens++;
        assert.deepEqual(options.filter, { includeArchived: true, includeBackground: true });
        const current = { requestId: "directory", subscriptionId: "manager-directory", entries: [],
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } } satisfies PaseoAgentListResult;
        return { ...current, subscription: {
          subscriptionId: "manager-directory",
          ready: Promise.resolve({ ...current, subscriptionId: "manager-directory" }),
          subscribe(observer: SubscriptionObserver<PaseoAgentListResult & { subscriptionId: string }>) {
            const unsubscribe = manager.subscribe(event => {
              if (event.type !== "agent_state") return;
              const agent = { id: event.agent.id, provider: event.agent.provider, status: event.agent.lifecycle,
                archivedAt: null } as PaseoAgent;
              observer.update({ type: "agent_update", payload: { kind: "upsert", agent } } as SessionOutboundMessage);
            }, { replayState: false });
            activeDirectoryListeners++;
            let active = true;
            const releaseListener = () => {
              if (!active) return;
              active = false;
              activeDirectoryListeners--;
              unsubscribe();
              if (releaseDirectoryListener === releaseListener) releaseDirectoryListener = undefined;
            };
            releaseDirectoryListener = releaseListener;
            return releaseListener;
          },
          async release() { releaseDirectoryListener?.(); },
        } };
      },
    },
  } as unknown as PluginHookContext["paseo"] : undefined;
  let manager!: AgentManager;
  const removeHandoff = hooks && handoff ? registerRegistrationHooks(hooks, handoff) : undefined;
  const pluginLifecycle = hooks && paseo ? {
      before(name: Parameters<PluginLifecycle["before"]>[0], request: Parameters<PluginLifecycle["before"]>[1]) {
      return hooks.invoke("keiyaku-paseo", "before", name, request, paseo) as ReturnType<PluginLifecycle["before"]>;
    },
    emit(name: Parameters<PluginLifecycle["emit"]>[0], event: Parameters<PluginLifecycle["emit"]>[1]) {
      void hooks.invoke("keiyaku-paseo", "event", name, event, paseo);
    },
  } as PluginLifecycle : undefined;
  const storage = withResidency ? new AgentStorage(join(root, "agents"), logger) : undefined;
  await storage?.initialize();
  manager = new AgentManager({ logger, clients: registry.clients(), providerDefinitions: { keiyaku: { enabled: true } },
    ...(storage ? { registry: storage } : {}), ...(pluginLifecycle ? { pluginLifecycle } : {}) });
  const stateWaiters = new Map<string, Array<() => void>>();
  manager.subscribe(event => {
    if (event.type !== "agent_state") return;
    for (const resolve of stateWaiters.get(event.agent.lifecycle) ?? []) resolve();
  }, { replayState: false });
  const agent = await manager.createAgent({ provider: "keiyaku", cwd: root, providerOptions: { world: root, akuId: AKUMA_ID } }, undefined, { workspaceId: undefined });
  const events: AgentStreamEvent[] = [];
  agent.session!.subscribe((event) => events.push(event));
  const drain = async () => { await tick(); await manager.flush(); };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    return closing ??= (async () => {
      manager.prepareForShutdown();
      await manager.closeAgent(agent.id);
      await handoff?.close();
      removeHandoff?.();
      await registry.shutdown();
      await manager.flushForShutdown();
      await storage?.flush();
      await rm(root, { recursive: true, force: true });
    })();
  };
  t.after(close);
  return { agent, bridge, manager, storage, calls, events, providerEvents, root, drain,
    setBeforePrompt(callback: () => Promise<void>) { beforePrompt = callback; },
    setRows(value: Row[]) { rows = value; },
    waitForLifecycle(status: string) {
      if (manager.getAgent(agent.id)?.lifecycle === status) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let timer!: ReturnType<typeof setTimeout>;
        const waiter = () => { clearTimeout(timer); resolve(); };
        const waiters = stateWaiters.get(status) ?? [];
        stateWaiters.set(status, [...waiters, waiter]);
        timer = setTimeout(() => {
          stateWaiters.set(status, (stateWaiters.get(status) ?? []).filter(item => item !== waiter));
          reject(new Error(`agent did not reach ${status}`));
        }, 3_000);
      });
    },
    getDirectoryOpens() { return directoryOpens; },
    getDirectoryListeners() { return activeDirectoryListeners; },
    /** Publish one change through the live observation, as the real producer does. */
    push(value: Row[]) { const frame = page(value); const deliver = waiting; waiting = undefined;
      if (deliver === undefined) queued.push(frame); else deliver(frame); },
    async sync() { await bridge.sync({ world: root, akuId: AKUMA_ID }); await drain(); },
    async refresh() { await bridge.refresh({ world: root, akuId: AKUMA_ID }); await drain(); },
    close,
    send(text: string, id: string) { return startAgentRun(manager, agent.id, text, logger, { activeTurnBehavior: "steer", replaceRunning: true, clearPendingPermissions: true, runOptions: { clientMessageId: id } }); },
  };
}
const page = (rows: Row[], metadata: Partial<Omit<History, "rows">> = {}): History => ({ rows, omitted: 0, hasEarlier: false,
  hasLater: false, historyLost: false, lowestRetained: rows[0]?.sequence ?? null,
  highest: Math.max(0, ...rows.map((row) => row.sequence)), ...metadata });

test("a live report remains informational until its exact Turn outcome", async (t) => {
  const h = await harness(t);
  const report: Row = { kind: "report", sequence: 3, bodySequence: 1, turnSequence: 2,
    text: "working", at };
  h.push([turn(2)]); await h.drain();
  h.push(historySchema.shape.rows.parse([turn(2), report])); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  const reports = () => h.events.filter((event) => event.type === "timeline" && event.item.type === "notification"
    && event.item.message === "Progress report: working");
  assert.equal(reports().length, 1);
  const observed = reports()[0];
  assert.ok(observed?.type === "timeline" && observed.item.type === "notification");
  assert.equal(observed.item.message, "Progress report: working");
  h.push(historySchema.shape.rows.parse([turn(2), report])); await h.drain();
  assert.equal(reports().length, 1);
  h.push(historySchema.shape.rows.parse([turn(2), report, answer(2, 4)])); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  assert.ok(h.events.some((event) => event.type === "turn_completed" && event.turnId === "turn/2"));
  assert.equal(reports().length, 1);
});

test("bad records keep observation incomplete until a genuine outcome", async (t) => {
  const h = await harness(t);
  const rows = historySchema.shape.rows.parse([turn(2),
    { kind: "future", sequence: 3, at, payload: "secret" },
    { kind: "outcome", sequence: 4, turnSequence: 2, at, outcome: { kind: "answered", answer: 7 } }]);
  h.push(rows); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  const notices = () => h.events.filter((event) => event.type === "timeline" && event.item.type === "notification"
    && event.item.message.startsWith("Observation incomplete:"));
  assert.equal(notices().length, 2);
  assert.ok(!JSON.stringify(notices()).includes("secret"));
  h.push(rows); await h.drain();
  assert.equal(notices().length, 2);
  h.push([...rows, answer(2, 5)]); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  assert.ok(h.events.some((event) => event.type === "turn_completed" && event.turnId === "turn/2"));
});

test("skip opening exposes an incomplete observation without replaying retained history", async (t) => {
  const rows = historySchema.shape.rows.parse([turn(2),
    { kind: "said", sequence: 3, turnSequence: 2, at, text: "old speech" },
    { kind: "future", sequence: 4, at, payload: "secret" }]);
  const h = await harness(t, {}, rows);
  const history = async () => {
    const events: AgentStreamEvent[] = [];
    for await (const event of h.agent.session!.streamHistory()) events.push(event);
    return events;
  };
  const opening = await history();
  const notices = opening.filter((event) => event.type === "timeline" && event.item.type === "notification"
    && event.item.message === "Observation incomplete: unsupported or malformed future record at sequence 4.");
  assert.equal(notices.length, 1);
  assert.ok(!JSON.stringify(opening).includes("secret") && !JSON.stringify(opening).includes("old speech"));
  assert.equal(opening.filter((event) => event.type === "turn_started" && event.turnId === "turn/2").length, 1);
  assert.equal(opening.some((event) => event.type === "turn_completed" || event.type === "turn_canceled"), false);
  await h.refresh();
  assert.deepEqual(await history(), opening, "refresh deduplicates the seeded warning");
  await h.sync();
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  h.push([...rows, answer(2, 5)]); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  assert.ok(h.events.some((event) => event.type === "turn_completed" && event.turnId === "turn/2"));
});
for (const failed of [false, true]) test(`recorded steer succeeds with ${failed ? "failed wake" : "no live receipt"}, one Tell and no interrupt`, async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  let n = 0;
  const h = await harness(t, { tell: async (_world, _akuId, _signal, text) => {
    n++;
    if (n === 1) h.setRows([turn(2)]);
    return receipt(text, `id-${n}`, n === 1 ? 2 : undefined, n > 1 && failed);
  } });
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  assert.deepEqual(await h.send("steering", "steering"), { disposition: "steered" });
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "tell"]);
  assert.equal(h.events.some((event) => event.type === "turn_completed" || event.type === "turn_canceled"), false);
  assert.equal(h.events.some((event) => event.type === "timeline" && event.item.type === "notification" && /delivery pending/u.test(event.item.message)), false);
  assert.equal(warnings.mock.callCount(), failed ? 1 : 0, "a failed wake retains its diagnostic without failing the recorded message");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});

test("installed AgentManager registration automatically recovers the missed open Turn through the real handoff hook", async t => {
  const snapshot = [
    { kind: "tell" as const, sequence: 10, at, tellId: "old", text: "old input", state: "told" as const, deliveries: [] },
    turn(11), answer(11, 12, "old answer"), turn(13),
  ];
  const h = await harness(t, {}, snapshot, true);
  await h.waitForLifecycle("running");
  await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/13");
  const starts = h.providerEvents.filter(event => event.type === "session.turn" && event.turnId === "turn/13" && event.state === "started");
  assert.equal(starts.length, 2, "open history and the one post-registration handoff name the same active Turn");
  const timelineItems = h.providerEvents.filter(event => event.type === "timeline.item");
  assert.equal(new Set(timelineItems.map(event => event.type === "timeline.item" ? event.item.id : "")).size, timelineItems.length,
    "a fresh post-registration observation never duplicates a timeline identity");
  assert.deepEqual(h.calls, [], "registration handoff does not tell or stop the Akuma");
  assert.equal(await h.manager.getAgent(h.agent.id)!.session!.canStopRuntime?.(), false,
    "the real PluginAgentSession refuses runtime collection while the mirror is open");
});

test("installed AgentManager refresh keeps an idle mirror through actual GC and later follows a new Turn", async t => {
  const h = await harness(t, {}, [], true);
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  assert.equal(h.getDirectoryOpens(), 1);
  await h.drain();
  const session = h.manager.getAgent(h.agent.id)!.session;
  const candidates = h.manager.getRuntimeCleanupCandidates();
  assert.equal(candidates.length, 1, "a persisted mirror must actually enter the host's cleanup candidate set");
  assert.equal(candidates[0]!.isEligible(), true, "baseline eligibility must not hide a missing provider veto");
  const probesBefore = h.providerEvents.filter(event => event.type === "session.can_stop_runtime").length;
  const cleanup = createIdleRuntimeCleanup({ enabled: true, runtimes: () => h.manager.getRuntimeCleanupCandidates(),
    now: () => Date.now() + 2 * 60 * 60 * 1000, schedule: () => () => {}, logger });
  const result = await cleanup.sweep();
  assert.equal(h.providerEvents.filter(event => event.type === "session.can_stop_runtime").length, probesBefore + 1,
    "the real collector must reach the provider's safety reply");
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.collected, []);
  assert.equal(h.manager.getAgent(h.agent.id)!.session, session, "the installed provider veto retains the idle runtime");
  await cleanup.close();
  await h.manager.reloadAgentSession(h.agent.id);
  await h.drain();
  assert.equal(h.getDirectoryOpens(), 2, "refresh arms a new registration observation before session open");
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  const storage = h.storage!;
  const applySnapshot = storage.applySnapshot.bind(storage);
  let entered!: () => void;
  let release!: () => void;
  let snapshotFinished = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(storage, "applySnapshot", async (...args: Parameters<typeof storage.applySnapshot>) => {
    entered();
    await gate;
    const result = await applySnapshot(...args);
    snapshotFinished = true;
    return result;
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    h.push([turn(2)]);
    await h.waitForLifecycle("running");
    await expectBodySettles(started, "snapshot did not start");
    assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
    assert.deepEqual(h.calls, [], "idle cleanup, refresh and later external execution never interrupt the Akuma");
    closing = h.close().then(() => { closed = true; });
    await tick();
    assert.equal(closed, false, "shutdown waits for the owned persistence");
    assert.equal(existsSync(h.root), true, "the fixture remains until its writer retires");
  } finally {
    release();
  }
  await closing;
  assert.equal(snapshotFinished, true, "owned persistence finishes before fixture removal");
  assert.equal(existsSync(h.root), false);
  assert.equal(h.getDirectoryListeners(), 0, "the owned manager subscription is released on shutdown");
});

test("post-create sync restores the installed consumer's running Turn without replay or execution", async (t) => {
  const snapshot = [
    { kind: "tell" as const, sequence: 10, at, tellId: "old", text: "old input", state: "told" as const, deliveries: [] },
    turn(11), answer(11, 12, "old answer"), turn(13),
  ];
  const h = await harness(t, {}, snapshot);
  const history = async () => {
    const events: AgentStreamEvent[] = [];
    for await (const event of h.agent.session!.streamHistory()) events.push(event);
    return events;
  };
  const opening = await history();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle", "opening precedes manager subscription");
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, null);
  await h.refresh();
  assert.deepEqual(await history(), opening, "normal refresh keeps the opening snapshot deduplicated");
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle", "a normal hint cannot recover the missed start");
  await h.sync();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "running");
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/13");
  await h.sync();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "running");
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/13");
  assert.deepEqual(h.events.map((event) => [event.type, "turnId" in event ? event.turnId : undefined]),
    [["turn_started", "turn/13"], ["turn_started", "turn/13"]], "sync only reannounces the same execution identity");
  assert.equal(h.manager.listAgents().length, 1, "repeated sync creates no additional agent");
  h.setRows([...snapshot, answer(13, 14, "new answer")]); await h.refresh();
  assert.deepEqual(h.events.flatMap((event) => {
    if (event.type === "timeline" && event.item.type === "assistant_message")
      return [[event.item.text, event.turnId]];
    if (event.type === "turn_completed") return [[event.type, event.turnId]];
    return [];
  }), [["new answer", "turn/13"], ["turn_completed", "turn/13"]]);
  assert.deepEqual(opening.map((event) => event.type),
    ["mode_changed", "model_changed", "thinking_option_changed", "turn_started"],
    "opening reports the observed configuration, then only the current execution state, never historical starts or timeline");
  const settled = await history();
  await h.sync();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  assert.deepEqual(await history(), settled, "sync never reannounces a completed Turn");
  await h.refresh();
  assert.deepEqual(await history(), settled, "the new outcome is retained once");
  assert.deepEqual(h.calls, [], "opening, sync and refresh never Tell or kill the Akuma");
});

test("one refresh preserves completed and short Turn output before their terminals and the next open Turn", async (t) => {
  const h = await harness(t);
  h.setRows([turn(2)]); await h.refresh();
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  const snapshot = [turn(2), answer(2, 3, "old answer"), turn(4), answer(4, 5, "short answer"), turn(6)];
  h.setRows(snapshot); await h.refresh();
  assert.deepEqual(h.events.flatMap((event) => {
    if (event.type === "timeline" && event.item.type === "assistant_message")
      return [["answer", event.turnId]];
    if (event.type === "turn_started" || event.type === "turn_completed")
      return [[event.type, event.turnId]];
    return [];
  }), [
    ["turn_started", "turn/2"], ["answer", "turn/2"], ["turn_completed", "turn/2"],
    ["turn_started", "turn/4"], ["answer", "turn/4"], ["turn_completed", "turn/4"],
    ["turn_started", "turn/6"],
  ]);
  const history = async () => {
    const events: AgentStreamEvent[] = [];
    for await (const event of h.agent.session!.streamHistory()) events.push(event);
    return events;
  };
  const retained = await history();
  assert.deepEqual(retained.flatMap((event) => event.type === "timeline" && event.item.type === "assistant_message"
    ? [[event.item.text, event.turnId]] : []), [["old answer", "turn/2"], ["short answer", "turn/4"]]);
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "running");
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/6");
  const count = h.events.length;
  await h.refresh();
  assert.equal(h.events.length, count, "an identical snapshot publishes no duplicate frames");
  assert.deepEqual(await history(), retained);
  assert.deepEqual(h.calls, [], "refresh is observation only");
  h.setRows([...snapshot, answer(6, 7)]); await h.refresh();
});

test("a Turn transition during Tell keeps its captured acknowledgement and does not fall back", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let n = 0;
  const h = await harness(t, { tell: async (_world, _akuId, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text, "initial", 2); }
    began(); await blocked; return receipt(text, "steering");
  } });
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  const sending = h.send("steering", "steering"); await started;
  h.setRows([turn(2), answer(2, 3), turn(4)]); await h.refresh();
  release();
  assert.deepEqual(await sending, { disposition: "steered" }); await h.drain();
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "tell"]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/4");
  assert.equal(h.events.filter((event) => event.type === "turn_completed" && event.turnId === "turn/2").length, 1);
  h.setRows([turn(2), answer(2, 3), turn(4), answer(4, 5)]); await h.refresh();
});

test("a transition before plugin receipt can still make the host reject the acknowledgement, but never retries", async (t) => {
  let n = 0;
  const h = await harness(t, { tell: async (_world, _akuId, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text, "initial", 2); }
    return receipt(text, "accepted-on-transition");
  } });
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  h.setBeforePrompt(async () => {
    h.setRows([turn(2), answer(2, 3), turn(4)]);
    await h.refresh();
  });
  await assert.rejects(h.send("accepted during transport", "raced"), /Active turn changed/u);
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "tell"]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/4");
  h.setRows([turn(2), answer(2, 3), turn(4), answer(4, 5)]); await h.refresh();
});

test("idle admission completes a host send command, then later real Akuma execution is still tracked", async (t) => {
  const h = await harness(t, { tell: async (_world, _akuId, _signal, text) => receipt(text, "idle") });
  await h.send("idle input", "idle"); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  assert.deepEqual(h.events.filter((event) => event.type === "turn_started" || event.type === "turn_completed").map((event) => [event.type, event.turnId]), [
    ["turn_started", "command-idle"], ["turn_completed", "command-idle"],
  ]);
  h.setRows([turn(2)]); await h.refresh();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "running");
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  assert.equal(h.events.filter((event) => event.type === "turn_completed" && event.turnId === "turn/2").length, 1);
});

test("idle admission with an already observed native start must not let command completion hide running work", async (t) => {
  const h = await harness(t, { tell: async (_world, _akuId, _signal, text) => { h.setRows([turn(2)]); return receipt(text, "idle"); } });
  await h.send("idle input", "idle"); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "running");
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});

test("combined best-effort Steer, explicit Stop, and later Tell preserve the same Akuma identity", async (t) => {
  let n = 0;
  const h = await harness(t, {
    stop: async () => stopAttempt("killed", AKUMA_ID),
    tell: async (_world, _akuId, _signal, text) => {
      n++;
      if (n === 1) { h.setRows([turn(2)]); return receipt(text, "initial", 2); }
      if (n === 2) return receipt(text, "accepted");
      h.setRows([turn(2), turn(4)]); return receipt(text, "after-stop", 4);
    },
  });
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  assert.deepEqual(await h.send("accepted", "accepted"), { disposition: "steered" });
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "tell"]);
  assert.deepEqual(await h.manager.cancelAgentRun(h.agent.id), { status: "settled" });
  await h.send("after stop", "after-stop"); await h.manager.waitForAgentRunStart(h.agent.id);
  assert.deepEqual(h.calls.map((call) => [call.op, call.akuId]), [["tell", AKUMA_ID], ["tell", AKUMA_ID], ["stop", AKUMA_ID], ["tell", AKUMA_ID]]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/4");
  assert.equal(h.events.filter((event) => event.type === "turn_canceled" && event.turnId === "turn/2").length, 1);
  h.setRows([turn(2), turn(4), answer(4, 5)]); await h.refresh();
});

test("installed consumer keeps live said and producer-linked final answer as one native message", async (t) => {
  const h = await harness(t);
  const facts: TimelineFact[] = [
    { kind: "turn-start", sequence: 2, bodySequence: 1, startedAt: at },
    activityFact(3, 2, at, { type: "assistant", text: "intermediate progress" }),
    activityFact(4, 2, at, { type: "tool", phase: "started", id: "work", name: "bash", call: { kind: "run", command: "work" } }),
    activityFact(5, 2, at, { type: "assistant", text: "final answer" }),
  ];
  h.setRows(historySchema.shape.rows.parse(projectTurns(facts).rows)); await h.refresh();
  const saidItems = () => h.events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "assistant_message" ? [{ event, item: event.item }] : []);
  const before = saidItems();
  assert.deepEqual(before.map(({ item }) => item), [
    { type: "assistant_message", text: "intermediate progress", messageId: "keiyaku:said/3" },
    { type: "assistant_message", text: "final answer", messageId: "keiyaku:said/5" },
  ], "intermediate speech is visible before outcome");
  facts.push(turnEndFact(6, 2, at, { kind: "answered", answer: "final answer", session: { sessionId: "native" } }));
  const settled = historySchema.shape.rows.parse(projectTurns(facts).rows);
  const outcome = settled.find((row) => row.kind === "outcome");
  h.setRows(settled); await h.refresh();
  const after = saidItems();
  if (outcome?.kind === "outcome" && outcome.outcome.kind === "answered" && outcome.outcome.foldedSaidSequence !== undefined)
    assert.deepEqual(after, before, "the installed provider drops the identical final upsert by native message identity");
  else
    // Without the producer's own fold identity the mirror can only report the
    // outcome as its own message; it never guesses which speech it replaces.
    assert.deepEqual(after.map(({ item }) => item.messageId), ["keiyaku:said/3", "keiyaku:said/5", "keiyaku:turn/2"],
      "an outcome without a fold identity is published as the outcome's own message");
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "idle");
  assert.equal(h.events.filter((event) => event.type === "turn_completed").length, 1);
});

test("installed native consumer folds tool start and result by producer identity, not invocation text", async (t) => {
  const h = await harness(t);
  const tools: Row[] = ["a", "b"].map((toolId, index) => ({ kind: "tool", sequence: 3 + index, at,
    turnSequence: 2, toolId, name: "bash", call: { kind: "run", command: "same command" }, state: "active" }));
  h.setRows([turn(2), ...tools]); await h.refresh();
  h.setRows([turn(2), { ...tools[0]!, sequence: 6, state: { status: "ok", message: "A" } } as Row,
    { ...tools[1]!, sequence: 5, state: { status: "error", message: "B" } } as Row]);
  await h.refresh();
  const rows = h.events.flatMap((event, index) => event.type === "timeline"
    ? [{ item: event.item, seq: index + 1, timestamp: event.timestamp ?? at,
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }) }] : []);
  const projected = projectTimelineRows({ rows, mode: "projected" });
  const calls = projected.flatMap((entry) => entry.item.type === "tool_call" ? [entry.item] : []);
  assert.deepEqual(calls.map((item) => [item.callId, item.status]), [["tool/2/a", "completed"], ["tool/2/b", "failed"]]);
  assert.deepEqual(calls.map((item) => item.detail), [
    { type: "shell", command: "same command", output: "A" }, { type: "shell", command: "same command", output: "B" },
  ]);
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "running", "tool failure never fabricates Turn failure");
  h.setRows([turn(2), answer(2, 7)]); await h.refresh();
});

test("uncertain steer fails honestly without host replacement, retry, or touching the existing Turn", async (t) => {
  let n = 0;
  const h = await harness(t, { tell: async (_world, _akuId, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text, "initial", 2); }
    throw new Error("lost receipt after possible admission");
  } });
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  await assert.rejects(h.send("uncertain", "uncertain"), /lost receipt after possible admission.*may already be recorded/u);
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "tell"]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});
