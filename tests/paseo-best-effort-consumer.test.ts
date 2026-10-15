import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";
import { PluginAgentClientRegistry } from "../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js";
import { AgentManager } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js";
import { startAgentRun } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-prompt.js";
import type { AgentStreamEvent } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-sdk-types.js";
import { createProvider } from "../plugins/paseo/plugin/server/provider.js";
import { projectTurns } from "../src/akuma/projection.js";
import { activityFact, turnEndFact } from "./support/akuma-fixtures.js";
import type { TimelineFact } from "../src/akuma/heart/index.js";
import { projectTimelineRows } from "../node_modules/@getpaseo/server/dist/server/server/agent/timeline-projection.js";
import { historySchema, type History, type Row } from "../plugins/paseo/plugin/server/keiyaku.js";
import type { Tell, TellAdmission } from "../plugins/paseo/plugin/server/message.js";
import { stopAttempt, type Stop } from "../plugins/paseo/plugin/server/stop.js";
import type { AkumaTransport } from "../plugins/paseo/plugin/server/transport.js";
const logger = pino({ level: "silent" });
const at = "2026-10-15T00:00:00.000Z";
const turn = (n: number): Row => ({ kind: "turn", sequence: n, turnSequence: n, at });
const answer = (n: number, sequence: number, text = "done"): Row => ({ kind: "outcome", sequence, turnSequence: n, at, outcome: { kind: "answered", answer: text } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function receipt(text: string, id: string, launch?: number, failed = false): TellAdmission {
  return { admission: { fact: "recorded", tellId: id },
    row: { kind: "tell", sequence: 1, at, tellId: id, text, state: "pending",
      deliveries: launch === undefined ? [] : [{ route: "launch", turnSequence: launch, deliveredAt: at }] },
    wake: failed ? { kind: "failed", diagnostic: "test wake failed" } : { kind: launch === undefined ? "held" : "told" } };
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
async function harness(mock: MockTransport = {}, initialRows: Row[] = []) {
  const root = await mkdtemp(join(tmpdir(), "paseo-best-effort-consumer-"));
  let rows: Row[] = initialRows;
  const calls: BridgeCall[] = [];
  let waiting: ((frame: History) => void) | undefined;
  const queued: History[] = [];
  const read = async (world: string, akuId: string, signal: AbortSignal): Promise<History> => {
    const value = await (mock.window ?? (async () => rows))(world, akuId, signal);
    return Array.isArray(value) ? page(value) : value;
  };
  const bridge = createProvider({
    // The mirror observes through its one stream; paging history beside it would
    // double the producers it trusts and is never a correct stand-in here.
    history: async () => { throw new Error("the mirror must observe through its stream, not paginate history"); },
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
  } satisfies AkumaTransport);
  let beforePrompt: (() => Promise<void>) | undefined;
  const registry = new PluginAgentClientRegistry(logger);
  registry.replace([{ ...bridge.provider, async connect(request) {
    const connection = await bridge.provider.connect(request);
    return { ...connection, async send(input) {
      if (input.type === "session.prompt") await beforePrompt?.();
      await connection.send(input);
    } };
  } }]);
  const manager = new AgentManager({ logger, clients: registry.clients(), providerDefinitions: { keiyaku: { enabled: true } } });
  const agent = await manager.createAgent({ provider: "keiyaku", cwd: root, providerOptions: { world: root, akuId: "aku/test/best-effort" } }, undefined, { workspaceId: undefined });
  const events: AgentStreamEvent[] = [];
  agent.session!.subscribe((event) => events.push(event));
  const drain = async () => { await tick(); await manager.flush(); };
  return { agent, bridge, manager, calls, events, root, drain,
    setBeforePrompt(callback: () => Promise<void>) { beforePrompt = callback; },
    setRows(value: Row[]) { rows = value; },
    /** Publish one change through the live observation, as the real producer does. */
    push(value: Row[]) { const frame = page(value); const deliver = waiting; waiting = undefined;
      if (deliver === undefined) queued.push(frame); else deliver(frame); },
    async sync() { await bridge.sync({ world: root, akuId: "aku/test/best-effort" }); await drain(); },
    async refresh() { await bridge.refresh({ world: root, akuId: "aku/test/best-effort" }); await drain(); },
    async close() { await registry.shutdown(); await rm(root, { recursive: true, force: true }); },
    send(text: string, id: string) { return startAgentRun(manager, agent.id, text, logger, { activeTurnBehavior: "steer", replaceRunning: true, runOptions: { clientMessageId: id } }); },
  };
}
const page = (rows: Row[], metadata: Partial<Omit<History, "rows">> = {}): History => ({ rows, omitted: 0, hasEarlier: false,
  hasLater: false, historyLost: false, lowestRetained: rows[0]?.sequence ?? null,
  highest: Math.max(0, ...rows.map((row) => row.sequence)), ...metadata });
for (const failed of [false, true]) test(`recorded steer succeeds with ${failed ? "failed wake" : "no live receipt"}, one Tell and no interrupt`, async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  let n = 0;
  const h = await harness({ tell: async (_world, _akuId, _signal, text) => {
    n++;
    if (n === 1) h.setRows([turn(2)]);
    return receipt(text, `id-${n}`, n === 1 ? 2 : undefined, n > 1 && failed);
  } });
  t.after(() => h.close());
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  assert.deepEqual(await h.send("steering", "steering"), { disposition: "steered" });
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "tell"]);
  assert.equal(h.events.some((event) => event.type === "turn_completed" || event.type === "turn_canceled"), false);
  assert.equal(h.events.some((event) => event.type === "timeline" && event.item.type === "notification" && /delivery pending/u.test(event.item.message)), false);
  assert.equal(warnings.mock.callCount(), failed ? 1 : 0, "a failed wake retains its diagnostic without failing the recorded message");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});

test("post-create sync restores the installed consumer's running Turn without replay or execution", async (t) => {
  const snapshot = [
    { kind: "tell" as const, sequence: 10, at, tellId: "old", text: "old input", state: "told" as const },
    turn(11), answer(11, 12, "old answer"), turn(13),
  ];
  const h = await harness({}, snapshot);
  t.after(() => h.close());
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
  const h = await harness();
  t.after(() => h.close());
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
  const h = await harness({ tell: async (_world, _akuId, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text, "initial", 2); }
    began(); await blocked; return receipt(text, "steering");
  } });
  t.after(() => h.close());
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
  const h = await harness({ tell: async (_world, _akuId, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text, "initial", 2); }
    return receipt(text, "accepted-on-transition");
  } });
  t.after(() => h.close());
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
  const h = await harness({ tell: async (_world, _akuId, _signal, text) => receipt(text, "idle") });
  t.after(() => h.close());
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
  const h = await harness({ tell: async (_world, _akuId, _signal, text) => { h.setRows([turn(2)]); return receipt(text, "idle"); } });
  t.after(() => h.close());
  await h.send("idle input", "idle"); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "running");
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});

test("combined best-effort Steer, explicit Stop, and later Tell preserve the same Akuma identity", async (t) => {
  let n = 0;
  const h = await harness({
    stop: async () => stopAttempt("killed", "aku/test/best-effort"),
    tell: async (_world, _akuId, _signal, text) => {
      n++;
      if (n === 1) { h.setRows([turn(2)]); return receipt(text, "initial", 2); }
      if (n === 2) return receipt(text, "accepted");
      h.setRows([turn(2), turn(4)]); return receipt(text, "after-stop", 4);
    },
  });
  t.after(() => h.close());
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  assert.deepEqual(await h.send("accepted", "accepted"), { disposition: "steered" });
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "tell"]);
  assert.deepEqual(await h.manager.cancelAgentRun(h.agent.id), { status: "settled" });
  await h.send("after stop", "after-stop"); await h.manager.waitForAgentRunStart(h.agent.id);
  assert.deepEqual(h.calls.map((call) => [call.op, call.akuId]), [["tell", "aku/test/best-effort"], ["tell", "aku/test/best-effort"], ["stop", "aku/test/best-effort"], ["tell", "aku/test/best-effort"]]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/4");
  assert.equal(h.events.filter((event) => event.type === "turn_canceled" && event.turnId === "turn/2").length, 1);
  h.setRows([turn(2), turn(4), answer(4, 5)]); await h.refresh();
});

test("installed consumer keeps live said and producer-linked final answer as one native message", async (t) => {
  const h = await harness();
  t.after(() => h.close());
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
  const h = await harness();
  t.after(() => h.close());
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
  const h = await harness({ tell: async (_world, _akuId, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text, "initial", 2); }
    throw new Error("lost receipt after possible admission");
  } });
  t.after(() => h.close());
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  await assert.rejects(h.send("uncertain", "uncertain"), /lost receipt after possible admission.*may already be recorded/u);
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "tell"]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});
