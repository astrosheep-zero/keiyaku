import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { soulFixture } from "./support/akuma-fixtures.js";
import { World } from "../src/world.js";
import { appendActivity, beginTurn, endTurn, HeldAkumaLeash } from "../src/akuma/heart/index.js";
import test, { type TestContext } from "node:test";
import { ProviderEventSchema, type ProviderEvent, type ProviderInput, type ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginContext } from "../src/plugin/public.js";
import { akumaCallerFromEnvironment } from "../src/cli/akuma-caller.js";
import { createForwarder } from "../plugins/paseo/forwarder/index.js";
import contribute from "../plugins/paseo/plugin/index.server.js";
import { createProvider } from "../plugins/paseo/plugin/server/provider.js";
import type { Tell, TellAdmission } from "../plugins/paseo/plugin/server/message.js";
import { stopAttempt, type Stop } from "../plugins/paseo/plugin/server/stop.js";
import type { AkumaTransport, StatusReader } from "../plugins/paseo/plugin/server/transport.js";
import { type History, type Row } from "../plugins/paseo/plugin/server/keiyaku.js";

const at = "2026-10-15T00:00:00.000Z";
const turn = (sequence: number, n = 1): Row => ({ kind: "turn", sequence, turnSequence: n, at });
const tell = (sequence: number, state: "pending" | "told" = "told"): Row =>
  ({ kind: "tell", sequence, tellId: `tell/${sequence}`, text: `input ${sequence}`, state, at });
const answer = (sequence: number, n = 1, failed = false): Extract<Row, { kind: "outcome" }> => ({ kind: "outcome", sequence, turnSequence: n, at,
  outcome: failed ? { kind: "failed", diagnostic: "provider broke" } : { kind: "answered", answer: "hello" } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function page(rows: Row[], metadata: Partial<Omit<History, "rows">> = {}): History {
  return { rows, omitted: 0, hasEarlier: false, hasLater: false, historyLost: false,
    lowestRetained: rows[0]?.sequence ?? null, highest: Math.max(0, ...rows.map((row) => row.sequence)), ...metadata };
}

/** One bridge mutation as the typed transport sees it; there is no command line left to record. */
type BridgeCall =
  | Readonly<{ op: "tell"; world: string; akuId: string; text: string }>
  | Readonly<{ op: "stop"; world: string; akuId: string }>;

type MockTransport = Readonly<{
  /** The complete window one observation frame reports; the default is empty. */
  window?: (world: string, akuId: string, signal: AbortSignal) => Promise<Row[] | History>;
  tell?: Tell;
  stop?: Stop;
  status?: StatusReader;
}>;

async function harness(t: TestContext, mock: MockTransport = {}) {
  const root = await mkdtemp(join(tmpdir(), "paseo-provider-"));
  const calls: BridgeCall[] = [];
  /** One delivered outcome of the live observation: a window, or the read that failed. */
  type Outcome = Readonly<{ frame: History }> | Readonly<{ error: Error }>;
  let waiting: ((outcome: Outcome) => void) | undefined;
  const queued: Outcome[] = [];
  const produce = (outcome: Outcome): void => {
    const slot = waiting;
    waiting = undefined;
    if (slot === undefined) queued.push(outcome);
    else slot(outcome);
  };
  const read = async (world: string, akuId: string, signal: AbortSignal): Promise<History> => {
    const value = await (mock.window ?? (async () => []))(world, akuId, signal);
    return Array.isArray(value) ? page(value) : value;
  };
  // A mirror observes through its one stream; paging history beside it would
  // double the producers it trusts and is never a correct stand-in here.
  const transport: AkumaTransport = {
    stream: (world, akuId, signal) => ({
      [Symbol.asyncIterator]: () => {
        let opened = false;
        const bounded = (outcome: Outcome): IteratorResult<History> => {
          if ("error" in outcome) throw outcome.error;
          return { done: false, value: outcome.frame };
        };
        return {
          async next(): Promise<IteratorResult<History>> {
            // Every subscription opens with the current window, exactly like the
            // public stream, so an explicit refresh needs no second read.
            if (!opened) { opened = true; return { done: false, value: await read(world, akuId, signal) }; }
            const delivered = queued.shift();
            if (delivered !== undefined) return bounded(delivered);
            return bounded(await new Promise<Outcome>((resolve, reject) => {
              const abort = () => { waiting = undefined;
                reject(signal.reason instanceof Error ? signal.reason : new Error("observation released")); };
              if (signal.aborted) { abort(); return; }
              signal.addEventListener("abort", abort, { once: true });
              waiting = (outcome) => { signal.removeEventListener("abort", abort); resolve(outcome); };
            }));
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
    status: mock.status ?? (async () => ({})),
    close: async () => {},
  };
  const bridge = createProvider(transport);
  const connection = await bridge.provider.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "prompt.steer", "session.archive"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const config: ProviderSessionConfig = { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true,
    providerOptions: { world: root, akuId: "aku/test/1" } };
  const open = (extra: Partial<Extract<ProviderInput, { type: "session.open" }>> = {}) => connection.send({
    type: "session.open", requestId: "open", sessionId: "session", config, history: "replay", ...extra,
  });
  const close = async (): Promise<void> => {
    await connection.close();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  };
  t.after(close);
  return { bridge, connection, events, calls, root, config, open,
    /** Publish one change through the live observation, as the real producer does. */
    push(value: Row[] | History) { produce({ frame: Array.isArray(value) ? page(value) : value }); },
    /** Fail the pull still in flight, as a producer whose read broke does. */
    fail(error: Error) { produce({ error }); },
    refresh: () => bridge.refresh({ world: root, akuId: "aku/test/1" }),
    sync: () => bridge.sync({ world: root, akuId: "aku/test/1" }),
    close };
}
const items = (events: ProviderEvent[]) => events.filter((e) => e.type === "timeline.item");
const turns = (events: ProviderEvent[]) => events.filter((e) => e.type === "session.turn");

test("durable cancellation from external control finishes only its Turn and reopens terminal without error", async (t) => {
  const canceled: Row = { kind: "outcome", sequence: 3, turnSequence: 1, at, outcome: { kind: "canceled", historyId: "turn/1" } };
  let rows: Row[] = [turn(1)];
  const h = await harness(t, { window: async () => rows });
  await h.open();
  rows = [turn(1), canceled, turn(4, 4)];
  h.push(rows);
  await tick();
  assert.deepEqual(turns(h.events).map((event) => [event.turnId, event.state]), [
    ["turn/1", "started"], ["turn/1", "canceled"], ["turn/4", "started"],
  ]);
  assert.equal(items(h.events).some((event) => event.item.type === "error"), false);
  h.push(rows);
  await tick();
  assert.equal(turns(h.events).filter((event) => event.state === "canceled").length, 1);
  const reopened = await harness(t, { window: async () => [turn(1), canceled] });
  await reopened.open({ history: "skip" });
  assert.deepEqual(turns(reopened.events), [], "seed does not restart the already-canceled Turn");
  assert.equal(items(reopened.events).some((event) => event.item.type === "error"), false);
});

test("open, lifecycle-owned refresh, reply mapping, and persisted replay through the same session seam", async (t) => {
  let rows: Row[] = [turn(2), tell(1)];
  let reads = 0;
  const h = await harness(t, { window: async () => { reads++; return rows; } });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await h.connection.send({ type: "catalog", requestId: "catalog" });
  assert.deepEqual(h.events.find((e) => e.type === "catalog")?.catalog, {
    models: [{ id: "mirror", label: "Akuma mirror" }], defaultModel: "mirror", modes: [],
  });
  await h.open();
  assert.equal(reads, 1);
  assert.deepEqual(h.connection.capabilities, ["session.persistence", "prompt.message", "prompt.steer"]);
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"]]);
  t.mock.timers.tick(60_000); await tick();
  assert.equal(reads, 1, "an open Turn is observed by its stream, never by a timer");
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started"], "an idle observation never reannounces cached running state");
  assert.deepEqual(await h.bridge.refresh({ world: h.root, akuId: "aku/other/1" }), { woken: 0 });
  assert.equal(reads, 1, "an unrelated World is never woken");
  const alias = join(h.root, "alias");
  await symlink(h.root, alias);
  rows = [answer(3), turn(2), tell(1)];
  assert.deepEqual(await h.bridge.refresh({ world: alias, akuId: "aku/test/1" }), { woken: 1 });
  await tick();
  assert.equal(reads, 2, "a refresh alias-names its World and reopens the one observation");
  assert.deepEqual(items(h.events).map((e) => [e.item.id, e.item.type, e.timestamp]), [
    ["keiyaku:tell/tell/1", "user_message", at], ["keiyaku:turn/1", "assistant_message", at],
  ]);
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started", "completed"]);
  h.push(rows); await tick();
  assert.equal(items(h.events).length, 2, "an identical window does not republish");
  const opened = h.events.find((e) => e.type === "session.opened");
  assert.ok(opened?.persistence);
  assert.deepEqual(opened.persistence, { version: 1, data: { world: await realpath(h.root), akuId: "aku/test/1" } });
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  h.events.length = 0;
  await h.open({ persistence: opened.persistence, config: { ...h.config, providerOptions: {} } });
  assert.deepEqual(items(h.events).map((e) => e.item.id), ["keiyaku:tell/tell/1", "keiyaku:turn/1"], "resume replays in sequence order");
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"], ["turn/1", "completed"]],
    "retained short turns publish their real start and terminal on replay");
});

test("skip seeds retained history once, then publishes new activity and leaves replay unchanged", async (t) => {
  let rows: Row[] = [turn(14, 2), tell(13, "pending"), answer(12), turn(11), tell(10)];
  const h = await harness(t, { window: async () => rows });
  await h.open({ history: "skip" });
  assert.deepEqual(h.events.map((event) => event.type), ["session.opened", "session.config", "session.turn", "session.ready"],
    "opening skip emits current execution state but no retained items or window notices");
  await h.refresh(); await tick();
  assert.deepEqual(items(h.events), []);
  assert.deepEqual(turns(h.events).map((event) => [event.turnId, event.state]), [["turn/2", "started"]]);
  rows = rows.map((row) => row.kind === "tell" ? { ...row, state: "told" } : row);
  await h.refresh(); await tick();
  assert.deepEqual(items(h.events), [], "changed Tell signatures still retain opening Tell deduplication");
  rows = [...rows, tell(15), answer(16, 2)];
  await h.refresh(); await tick();
  await h.refresh(); await tick();
  assert.deepEqual(items(h.events).map((event) => [event.item.id, event.item.type]), [
    ["keiyaku:tell/tell/15", "user_message"], ["keiyaku:turn/2", "assistant_message"],
  ], "new activity is published exactly once, not hidden by a permanent skip mode");
  assert.deepEqual(turns(h.events).map((event) => [event.turnId, event.state]), [["turn/2", "started"], ["turn/2", "completed"]],
    "the observed open Turn still takes its new outcome");
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  h.events.length = 0;
  await h.open({ history: "replay" });
  assert.deepEqual(items(h.events).map((event) => event.item.id), [
    "keiyaku:tell/tell/10", "keiyaku:turn/1", "keiyaku:tell/tell/13",
    "keiyaku:tell/tell/15", "keiyaku:turn/2",
  ], "replay exposes retained history without guessing loss from sequence numbers");
  assert.deepEqual(turns(h.events).map((event) => [event.turnId, event.state]), [
    ["turn/1", "started"], ["turn/1", "completed"], ["turn/2", "started"], ["turn/2", "completed"],
  ], "replay publishes ordered historical start/terminal pairs");
  assert.deepEqual(h.calls, [], "opening, refreshing and closing remain observation-only");
});

test("skip retains open and closed Turn state for Steer and Stop without historical starts", async (t) => {
  let rows: Row[] = [tell(1), turn(2, 7)];
  const receipt = tellReceipt("live");
  const h = await harness(t, { window: async () => rows,
    tell: async () => { rows = [...rows, receipt.row]; return receipt; },
    stop: async () => stopAttempt("killed", "aku/test/1") });
  await h.open({ history: "skip" });
  await h.connection.send(promptInput());
  assert.deepEqual(promptResults(h.events).map((event) => event.result), [{ type: "steer", turnId: "turn/7" }]);
  assert.deepEqual(items(h.events).map((event) => event.item), [
    { type: "user_message", id: "keiyaku:tell/new-tell", text: "change direction", clientMessageId: "client-1" },
  ]);
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  await h.refresh(); await tick();
  await h.sync();
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "stop"]);
  assert.deepEqual(turns(h.events).map((event) => [event.turnId, event.state]), [["turn/7", "started"], ["turn/7", "canceled"]],
    "Stop captures the observed Turn and identical refresh never restarts it");
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  rows = [...rows, answer(4, 7)];
  h.events.length = 0;
  await h.open({ history: "skip" });
  await assert.rejects(h.connection.send(promptInput()), /No observed Paseo Turn/u);
  assert.equal(h.calls.length, 2, "a seeded completed Turn is not steerable");
  assert.deepEqual(items(h.events), []);
  assert.deepEqual(turns(h.events), []);
});

test("post-attach sync needs a successful fresh read and never restarts an ended Turn", async (t) => {
  let rows: Row[] = [tell(1), turn(2, 7)];
  let broken = false, reads = 0;
  const h = await harness(t, { window: async () => { reads++; if (broken) throw new Error("unavailable"); return rows; } });
  await h.open({ history: "skip" });
  h.events.length = 0;
  broken = true;
  await h.sync();
  assert.equal(reads, 2, "sync makes a fresh read, not a cached announcement");
  assert.deepEqual(turns(h.events), [], "failed read cannot reannounce the cached open Turn");
  assert.equal(items(h.events).length, 1);
  assert.match(notices(h.events)[0]!, /read surface unavailable/u);
  broken = false;
  rows = [...rows, answer(3, 7)];
  h.events.length = 0;
  await h.sync();
  assert.deepEqual(turns(h.events).map((event) => [event.turnId, event.state]), [["turn/7", "completed"]]);
  assert.deepEqual(items(h.events).map((event) => event.item.type), ["assistant_message"], "normal new output is still published");
  h.events.length = 0;
  await h.sync();
  assert.deepEqual(h.events, [], "ended Turn stays sealed");
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  const before = reads;
  await h.sync();
  await h.bridge.sync({ world: h.root, akuId: "aku/other/1" });
  assert.equal(reads, before, "closed and missing sessions are harmless");
  assert.deepEqual(h.calls, [], "sync never performs actual work or controls execution");
});

test("in-flight hints coalesce and RPC returns without waiting for reads", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0, active = 0, peak = 0;
  const h = await harness(t, { window: async () => { calls++; peak = Math.max(peak, ++active); await blocked; active--; return []; } });
  const opening = h.open();
  while (!calls) await tick();
  for (let n = 0; n < 8; n++) assert.deepEqual(await h.refresh(), { woken: 1 });
  assert.equal(calls, 1);
  release(); await opening;
  assert.equal(calls, 2); assert.equal(peak, 1);
});

test("changed told rows, gaps, read failure recovery, Stop control and observation-only close", async (t) => {
  let rows: Row[] = [tell(1, "pending"), turn(2)];
  let broken = false, reads = 0;
  const h = await harness(t, { window: async () => { reads++; if (broken) throw new Error("unavailable");
    return page(rows, { historyLost: rows[0]?.sequence === 9 }); },
    stop: async () => stopAttempt("killed", "aku/test/1") });
  await h.open();
  assert.equal(items(h.events).length, 1, "pending history remains visible as input, not delivery proof");
  rows = [tell(1), turn(2)];
  await h.refresh(); await tick();
  assert.equal(items(h.events).length, 1, "a pending-to-told change does not duplicate user input");
  broken = true;
  await h.refresh(); await tick(); await h.refresh(); await tick();
  assert.equal(items(h.events).filter((e) => e.item.id.startsWith("keiyaku:unreadable/")).length, 1);
  broken = false;
  rows = [turn(9), answer(10), turn(11, 2)];
  await h.refresh(); await tick(); await h.refresh(); await tick();
  assert.equal(items(h.events).filter((e) => e.item.id === "keiyaku:window/9").length, 1);
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [
    ["turn/1", "started"], ["turn/1", "completed"], ["turn/2", "started"],
  ]);
  broken = true;
  await h.refresh(); await tick();
  assert.equal(items(h.events).filter((e) => e.item.id.startsWith("keiyaku:unreadable/")).length, 2, "recovery resets unhealthy");
  broken = false;
  rows = [...rows, answer(12, 2, true)];
  await h.refresh(); await tick();
  assert.equal(turns(h.events).at(-1)?.error?.message, "provider broke");
  const tail = h.events.slice(-2);
  assert.deepEqual(tail.map((e) => e.type), ["timeline.item", "session.turn"], "answer precedes terminal");
  rows = [...rows, turn(13, 3)];
  await h.refresh(); await tick();
  await h.connection.send({ type: "session.interrupt", requestId: "interrupt", sessionId: "session" });
  assert.match(turns(h.events).at(-1)?.error?.message ?? "", /stopped from Paseo/u);
  assert.deepEqual(h.calls.map((call) => call.op), ["stop"]);
  await h.refresh(); await tick();
  assert.equal(turns(h.events).filter((e) => e.turnId === "turn/3").length, 2, "sealed turn never restarts");
  await h.connection.send({ type: "session.archive", requestId: "archive", persistence: { version: 1, data: {} } });
  await assert.rejects(h.connection.send({ type: "session.prompt", sessionId: "session", prompt: {
    clientMessageId: "prompt", delivery: "auto", input: { type: "message", content: [{ type: "text", text: " " }] },
  } }), /nonblank/u);
  const before = reads;
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  assert.deepEqual(await h.refresh(), { woken: 0 });
  assert.equal(reads, before);
  assert.equal(h.calls.length, 1, "observation close never stops anything");
  assert.equal(turns(h.events).filter((e) => e.turnId === "turn/3").length, 2);
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(h.root)), [], "no World writes");
  broken = true;
  await h.open();
  assert.equal(items(h.events).filter((e) => e.item.id.startsWith("keiyaku:unreadable/")).length, 3);
});

test("Stop kills the controlled Akuma, refreshes, and ends only the observed turn", async (t) => {
  let rows: Row[] = [turn(2)];
  let reads = 0;
  const h = await harness(t, { window: async () => { reads++; return rows; }, stop: async () => stopAttempt("killed", "aku/test/1") });
  await h.open();
  assert.equal(h.calls.length, 0, "opening never controls the Akuma");
  const before = reads;
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(h.calls, [{ op: "stop", world: await realpath(h.root), akuId: "aku/test/1" }],
    "Stop reaches the typed transport with the canonical world identity");
  assert.equal(reads, before + 1, "a proven stop refreshes authoritative history");
  assert.deepEqual(h.events.filter((e) => e.type === "request.completed" || e.type === "request.failed"),
    [{ type: "request.completed", requestId: "stop" }]);
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"], ["turn/1", "canceled"]]);
  assert.match(turns(h.events).at(-1)?.error?.message ?? "", /stopped from Paseo/u);
  assert.equal(h.events.some((e) => e.type === "session.closed"), false, "the mirror stays open for a later Tell");
  rows = [turn(2), turn(4, 2)];
  await h.refresh(); await tick();
  assert.deepEqual(turns(h.events).map((e) => e.turnId), ["turn/1", "turn/1", "turn/2"], "a later turn still arrives");
  const sealed = turns(h.events).filter((e) => e.turnId === "turn/1");
  rows = [turn(2), answer(3), turn(4, 2)];
  await h.refresh(); await tick();
  assert.deepEqual(turns(h.events).filter((e) => e.turnId === "turn/1"), sealed,
    "late natural output cannot reopen or re-terminate the canceled Turn");
  assert.equal(turns(h.events).at(-1)?.turnId, "turn/2");
});

test("an unproven Stop reports the transport's own words and never cancels the observed turn", async (t) => {
  // Four ways a Stop fails to prove itself: a refusal, custody that is not a
  // stop, an unprovable outcome, and a transport that reports its own doubt.
  // Every one keeps the transport's exact words and leaves the Turn running.
  const cases: readonly Readonly<{ kind: string; stop: Stop; message: string; refreshes: boolean }>[] = [
    { kind: "refused", stop: async () => { throw new Error("Akuma aku/test/1 is not born"); },
      message: "Keiyaku could not prove the stop: Akuma aku/test/1 is not born", refreshes: false },
    { kind: "held custody", stop: async () => stopAttempt("hung", "aku/test/1"),
      message: "Keiyaku reported hung for aku/test/1", refreshes: false },
    { kind: "unprovable", stop: async () => { throw new Error("Keiyaku Stop outcome is uncertain: signal timed out"); },
      message: "Keiyaku could not prove the stop: Keiyaku Stop outcome is uncertain: signal timed out", refreshes: true },
    { kind: "undecided", stop: async () => ({ kind: "uncertain", message: "Keiyaku could not prove the stop: the receipt was lost" }),
      message: "Keiyaku could not prove the stop: the receipt was lost", refreshes: false },
  ];
  for (const { kind, stop, message, refreshes } of cases) {
    let reads = 0;
    const h = await harness(t, { window: async () => { reads++; return [turn(2)]; }, stop });
    await h.open();
    const before = reads;
    await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
    assert.deepEqual(h.events.filter((e) => e.type === "request.completed" || e.type === "request.failed"),
      [{ type: "request.failed", requestId: "stop", error: { message } }],
      `${kind}: the transport's own words reach the host as the only answer`);
    assert.deepEqual(turns(h.events).map((e) => e.state), ["started"], `${kind}: an unproven stop never cancels the turn`);
    if (refreshes) assert.equal(reads, before + 1, `${kind}: a thrown failure still refreshes authoritative history`);
  }
});

test("overlapping Stops share one kill attempt and each request receives one receipt", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let kills = 0;
  const h = await harness(t, { window: async () => [turn(2)],
    stop: async () => { kills++; await blocked; return stopAttempt("already-stopped", "aku/test/1"); } });
  await h.open();
  const first = h.connection.send({ type: "session.interrupt", requestId: "stop-1", sessionId: "session" });
  const second = h.connection.send({ type: "session.interrupt", requestId: "stop-2", sessionId: "session" });
  assert.equal(kills, 1, "a Stop already in flight is reused");
  release();
  await Promise.all([first, second]);
  assert.equal(kills, 1);
  assert.deepEqual(h.events.filter((e) => e.type === "request.completed").map((e) => e.requestId),
    ["stop-1", "stop-2"]);
  assert.equal(turns(h.events).filter((e) => e.state === "canceled").length, 1, "one terminal event for one turn");
});

test("a natural completion racing the Stop keeps its own outcome and one terminal event", async (t) => {
  let rows: Row[] = [turn(2)];
  const h = await harness(t, { window: async () => rows,
    stop: async () => { rows = [turn(2), answer(3)]; return stopAttempt("already-stopped", "aku/test/1"); } });
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"], ["turn/1", "completed"]]);
  assert.equal(h.events.filter((e) => e.type === "request.completed").length, 1);
});

test("a produced put-down failure remains the only terminal event after a proven Stop", async (t) => {
  let rows: Row[] = [turn(2)];
  const h = await harness(t, { window: async () => rows,
    stop: async () => { rows = [turn(2), answer(4, 1, true)]; return stopAttempt("killed", "aku/test/1"); } });
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"], ["turn/1", "failed"]]);
  assert.deepEqual(h.events.filter((e) => e.type === "request.completed"), [{ type: "request.completed", requestId: "stop" }]);
});

test("a natural outcome held by Tell correlation is not overwritten by concurrent Stop", async (t) => {
  let rows: Row[] = [turn(2)];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness(t, { window: async () => rows,
    stop: async () => stopAttempt("already-stopped", "aku/test/1"),
    tell: async () => { await blocked; return tellReceipt(undefined, { kind: "held" }); } });
  await h.open();
  const submitting = h.connection.send(promptInput());
  rows = [turn(2), answer(4)];
  await h.refresh(); await tick();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started"], "the natural outcome is still held, not canceled");
  release(); await submitting;
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"], ["turn/1", "completed"]]);
  assert.deepEqual(h.calls.map((call) => call.op), ["tell", "stop"]);
});

test("a proven Stop settles the turn it captured even after a newer Turn replaced it", async (t) => {
  let rows: Row[] = [turn(2)];
  const h = await harness(t, { window: async () => rows,
    stop: async () => { rows = [turn(2), turn(4, 2)]; return stopAttempt("killed", "aku/test/1"); } });
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]),
    [["turn/1", "started"], ["turn/2", "started"], ["turn/1", "canceled"]],
    "the captured turn settles once instead of being dropped");
  assert.equal(turns(h.events).filter((e) => e.turnId === "turn/2" && e.state === "canceled").length, 0,
    "a newer Turn is never closed by an older Stop");
  assert.equal(h.events.filter((e) => e.type === "request.completed").length, 1);
});

test("a captured turn still takes its own outcome after a newer Turn replaced it", async (t) => {
  let rows: Row[] = [turn(2)];
  const h = await harness(t, { window: async () => rows,
    stop: async () => { rows = [turn(2), turn(4, 2)]; throw new Error("Akuma aku/test/1 is not born"); } });
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => e.turnId), ["turn/1", "turn/2"], "a refusal leaves the turn running");
  rows = [turn(2), answer(3, 1), turn(4, 2)];
  await h.refresh(); await tick();
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]),
    [["turn/1", "started"], ["turn/2", "started"], ["turn/1", "completed"]],
    "the captured turn closes from its own outcome, never from the Stop");
});

test("close during an in-flight Stop retires the owned stop before the session closes", async (t) => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let kills = 0, retired = false;
  const h = await harness(t, { window: async () => [turn(2)],
    stop: async (_world, _akuId, signal) => {
      kills++;
      began();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      retired = true;
      throw new Error("Keiyaku Stop outcome is uncertain: observation closed");
    } });
  await h.open();
  const stopping = h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  await started;
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  await stopping;
  assert.equal(kills, 1, "close never starts a second kill");
  assert.equal(retired, true, "the owned kill retired before the session closed");
  assert.match(h.events.find((e) => e.type === "request.failed")?.error.message ?? "", /could not prove the stop/u);
  assert.ok(
    h.events.findIndex((e) => e.type === "request.failed") < h.events.findIndex((e) => e.type === "session.closed"),
    "the Stop answers before the session reports itself closed",
  );
});

test("a Stop for a session that is not open fails without controlling anything", async (t) => {
  const h = await harness(t, { window: async () => [] });
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "absent" });
  assert.deepEqual(h.events, [{ type: "request.failed", requestId: "stop",
    error: { message: "Keiyaku mirror session is not open" } }]);
  assert.equal(h.calls.length, 0);
});

test("close during a pull releases the observation and never publishes its late window", async (t) => {
  let reads = 0, retired = false;
  const h = await harness(t, { window: async (_world, _akuId, signal) => {
    reads++;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    retired = true;
    return [tell(1)];
  } });
  const opening = h.open();
  while (!reads) await tick();
  await h.refresh();
  assert.equal(reads, 1, "a refresh during an open pull coalesces into the one observation");
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  await opening;
  assert.equal(retired, true, "session close waits for the pull it released");
  assert.equal(reads, 1, "the coalesced refresh never opens a second observation after close");
  assert.deepEqual(items(h.events), [], "no released pull's window is published");
  assert.deepEqual(await h.refresh(), { woken: 0 });
  assert.deepEqual(h.events.map((e) => e.type), ["session.opened", "session.config", "session.closed", "request.completed"]);
});

test("native born attach, SDK creation and identity retries share the registered plugin seam without env injection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paseo-attach-"));
  await World.at(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = join(root, "alias"); await symlink(root, alias);
  const world = await realpath(root), akuId = "aku/test/1";
  const wire: Parameters<DaemonClient["createAgent"]>[0][] = [];
  const created = new Map<string, { id: string; cwd: string }>();
  const parent = { id: "parent", cwd: root, archivedAt: null,
    persistence: { provider: "codex", sessionId: "native-codex", nativeHandle: "native-codex" } };
  const paseo = createPaseoApi({
    async fetchAgents(options: { filter: unknown }) {
      assert.deepEqual(options.filter, { includeArchived: true });
      return { requestId: "list", entries: [{ agent: parent, project: null }],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } };
    },
    async fetchAgent({ agentId }: { agentId: string }) {
      return agentId === "parent" ? { agent: parent, project: null } : null;
    },
    async createAgent(options: Parameters<DaemonClient["createAgent"]>[0]) {
      wire.push(options);
      assert.ok(options.idempotencyKey);
      if (!created.has(options.idempotencyKey)) created.set(options.idempotencyKey, { id: "child", cwd: root });
      return created.get(options.idempotencyKey)!;
    },
  } as unknown as DaemonClient);
  t.after(() => paseo.dispose());
  const create = t.mock.method(paseo.agents, "create");
  const before = t.mock.fn<PluginServerContext["before"]>(() => () => {});
  const handlers = new Map<string, (input: unknown) => unknown>();
  let providerId = "";
  const cleanup = contribute({
    registerProvider(provider) { providerId = provider.id; },
    handle(contract, handler) { handlers.set(contract.name, (input) => handler(contract.input.parse(input), { paseo })); },
    registerSettings() { throw new Error("unused"); },
    registerUsageSource() { throw new Error("unused"); },
    on() { throw new Error("unused"); }, before,
  });
  t.after(async () => { await cleanup(); });
  assert.equal(providerId, "keiyaku");
  assert.deepEqual([...handlers.keys()], ["refresh", "attach"]);
  assert.equal(before.mock.callCount(), 0, "native identity needs no session_open injection");
  const forwarder = createForwarder(async () => ({
    async invokePluginRpc(_plugin, method, input) { return await handlers.get(method)!(input); },
    fetchAgents: (async () => ({ requestId: "list", entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } })) as unknown as DaemonClient["fetchAgents"],
    async updateAgent() {},
    async close() {},
  }));
  const { signals } = await forwarder.activate({ world: alias as PluginContext["world"], config: undefined,
    writablePath() { throw new Error("no writes"); } });
  const caller = await akumaCallerFromEnvironment({ CODEX_THREAD_ID: "native-codex" });
  assert.deepEqual(caller, { kind: "external", integration: "codex", id: "native-codex" });
  await signals?.["akuma.born"]?.({ kind: "akuma.born", akumaId: akuId, bodySequence: 1, origin: { kind: "direct" }, caller });
  assert.deepEqual(create.mock.calls[0]?.arguments[0], { parent: "parent", cwd: root, title: akuId,
    config: { provider: "keiyaku/mirror", options: { world, akuId } }, idempotencyKey: `keiyaku:${world}:${akuId}` });
  assert.equal(created.size, 1);
  assert.deepEqual(wire[0], { config: { provider: "keiyaku", model: "mirror", cwd: root, title: akuId,
      providerOptions: { world, akuId } },
    callerAgentId: "parent", idempotencyKey: `keiyaku:${world}:${akuId}` });
  assert.deepEqual(await handlers.get("attach")!({ world: alias, akuId, caller }), { attached: true });
  assert.equal(created.size, 1, "canonical identity reuses daemon idempotency, not a bridge registry");
  assert.equal(wire[1]?.idempotencyKey, wire[0]?.idempotencyKey);
  assert.deepEqual(await handlers.get("attach")!({ world, akuId,
    caller: { kind: "external", integration: "paseo", id: "parent" } }), { attached: true });
  assert.equal(created.size, 1, "legacy Paseo caller replays the same canonical child");
  const diagnostics = t.mock.method(console, "warn", () => {});
  for (const other of [undefined, { kind: "unknown" }, { kind: "akuma", world, akuId },
    { ...caller, integration: "other" }, { ...caller, id: "gone" }]) {
    const before = diagnostics.mock.callCount();
    assert.deepEqual(await handlers.get("attach")!({ world, akuId, caller: other }), { attached: false });
    assert.equal(diagnostics.mock.callCount(), before + 1);
  }
  assert.equal(create.mock.callCount(), 3, "only the initial attach and its native/legacy retries reach create");
});

const promptInput = (id = "client-1", text = "change direction"): Extract<ProviderInput, { type: "session.prompt" }> => ({
  type: "session.prompt", sessionId: "session", prompt: {
    clientMessageId: id, delivery: "steer", clearPendingPermissions: true,
    input: { type: "message", content: [{ type: "text", text }] },
  },
});
function tellReceipt(route?: "live" | "launch", wake: TellAdmission["wake"] = { kind: "told" }, tellId = "new-tell"): TellAdmission {
  return { admission: { fact: "recorded", tellId },
    row: { kind: "tell", sequence: 3, at, tellId, text: "change direction", state: "pending",
      deliveries: route ? [{ route, turnSequence: 7, deliveredAt: at, receipt: "required" }] : [] }, wake };
}
const promptResults = (events: ProviderEvent[]) => events.filter((event) => event.type === "session.prompt_result");
const notices = (events: ProviderEvent[]) => items(events).flatMap((event) => event.item.type === "notification" ? [event.item.message] : []);

test("live steering correlates the optimistic message before racing history and never interrupts", async (t) => {
  let rows: Row[] = [turn(1, 7)];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const receipt = tellReceipt("live");
  const calls: unknown[] = [];
  const h = await harness(t, { window: async () => rows,
    tell: async (world, akuId, signal, text) => {
      calls.push({ world, akuId, text });
      await Promise.race([blocked, new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })]);
      return receipt;
    } });
  await h.open();
  const submission = h.connection.send(promptInput());
  rows = [turn(1, 7), receipt.row, answer(4, 7)];
  await h.refresh(); await tick();
  assert.equal(items(h.events).length, 0, "a racing snapshot waits for exact Tell identity");
  release(); await submission;
  assert.deepEqual(calls, [{ world: await realpath(h.root), akuId: "aku/test/1", text: "change direction" }]);
  assert.deepEqual(promptResults(h.events).map((event) => event.result), [{ type: "steer", turnId: "turn/7" }]);
  const user = items(h.events).filter((event) => event.item.type === "user_message");
  assert.deepEqual(user.map((event) => event.item), [{ type: "user_message", id: "keiyaku:tell/new-tell", text: "change direction", clientMessageId: "client-1" }]);
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started", "completed"]);
  assert.ok(h.events.findIndex((event) => event.type === "session.prompt_result") < h.events.findIndex((event) => event.type === "session.turn" && event.state === "completed"));
  await h.refresh(); await tick();
  assert.equal(items(h.events).filter((event) => event.item.type === "user_message").length, 1);
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  h.events.length = 0;
  await h.open();
  assert.equal(calls.length, 1, "reopen only reads, never resends");
  assert.deepEqual(items(h.events).filter((event) => event.item.type === "user_message").map((event) => event.item), [
    { type: "user_message", id: "keiyaku:tell/new-tell", text: "change direction" },
  ]);
});

test("pending admission and failed wake acknowledge success without inventing Akuma lifecycle or pending UI", async (t) => {
  let receipt = tellReceipt(undefined, { kind: "held" });
  const h = await harness(t, { window: async () => [], tell: async () => receipt });
  await h.open();
  t.mock.method(console, "warn", () => {});
  const request = () => { const input = promptInput(); input.prompt.delivery = "auto"; return input; };
  await h.connection.send(request());
  assert.deepEqual(promptResults(h.events).at(-1)?.result, { type: "completed" });
  assert.deepEqual(notices(h.events), []);
  assert.equal(turns(h.events).length, 0, "admission does not start or finish an Akuma Turn");
  receipt = tellReceipt(undefined, { kind: "failed", diagnostic: "frozen directory is missing" }, "failed-wake");
  const second = request(); second.prompt.clientMessageId = "client-2";
  await h.connection.send(second);
  assert.deepEqual(promptResults(h.events).at(-1)?.result, { type: "completed" });
  assert.deepEqual(notices(h.events), []);
  assert.equal(turns(h.events).length, 0);
  receipt = tellReceipt("launch", { kind: "pursuing", bodySequence: 5 }, "launch-tell");
  const third = request(); third.prompt.clientMessageId = "client-3";
  await h.connection.send(third);
  assert.deepEqual(promptResults(h.events).at(-1)?.result, { type: "turn", turnId: "turn/7" });
  assert.equal(turns(h.events).length, 0, "only authoritative history can publish Turn lifecycle");
});

test("unsupported input refuses before Tell admission and ambiguous failure never retries", async (t) => {
  let calls = 0;
  const h = await harness(t, { window: async () => [],
    tell: async () => { calls++; throw new Error("connection lost after write"); } });
  await h.open();
  for (const input of [
    { type: "command" as const, name: "foo", arguments: "" },
    { type: "message" as const, content: [{ type: "image" as const, data: "", mimeType: "image/png" }] },
    { type: "message" as const, content: [{ type: "text" as const, text: " " }] },
  ]) {
    const request = promptInput(); request.prompt.input = input;
    await assert.rejects(h.connection.send(request));
  }
  assert.equal(calls, 0);
  assert.equal(promptResults(h.events).length, 3);
  const request = promptInput(); request.prompt.delivery = "auto";
  await assert.rejects(h.connection.send(request), /may already be recorded/u);
  assert.equal(calls, 1);
  assert.equal(promptResults(h.events).length, 4, "exactly one receipt per request");
  const failed = promptResults(h.events).at(-1)?.result;
  assert.equal(failed?.type, "failed");
  if (failed?.type === "failed") assert.match(failed.error.message, /connection lost after write.*may already be recorded.*not retried/u);
  assert.deepEqual(items(h.events), []);
  assert.deepEqual(turns(h.events), []);
});

test("close retires an owned Tell without kill, automatic retry, or late history publication", async (t) => {
  let tells = 0;
  const h = await harness(t, { window: async () => [],
    tell: async (_world, _akuId, signal) => {
      tells++;
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Tell outcome uncertain after observation closed")), { once: true }));
      throw new Error("unreachable");
    } });
  await h.open();
  const request = promptInput(); request.prompt.delivery = "auto";
  const submitting = assert.rejects(h.connection.send(request), /outcome uncertain/u);
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  await submitting;
  assert.equal(tells, 1, "one Tell, never retried");
  assert.equal(promptResults(h.events).length, 1);
  assert.equal(promptResults(h.events)[0]?.result.type, "failed");
  assert.deepEqual(items(h.events), []);
  assert.deepEqual(h.events.slice(-2).map((event) => event.type), ["session.closed", "request.completed"]);
});


test("the real public stream carries a long open Turn into the mirror without inventing cancellation or loss", async (t) => {
  const value = await soulFixture("paseo-stream-cli-");
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  const root = await realpath(value.root);
  const controller = new AbortController();
  let latest: History = page([]);
  // The real public package's one observation path, read exactly as the test
  // needs it: a subscription's first frame is the whole current bounded window,
  // and closing that iterator releases its reader, so every read below is one
  // deterministic pull with no background pump and no deadline of its own.
  const openWindow = async (): Promise<History> => {
    const sdk = await import(resolve("build/src/index.js")) as {
      Akuma: { select: (world: string, akuId: string) => {
        stream(options: { signal?: AbortSignal }): AsyncIterable<History> } } };
    for await (const frame of sdk.Akuma.select(root, value.allocated.id).stream({ signal: controller.signal })) return frame;
    throw new Error("the real public stream opened without a window");
  };
  const h = await harness(t, { window: async () => latest });
  // The harness owns its own close, registered before this hook; node:test runs
  // after hooks in registration order, so the mirror closes first.
  t.after(async () => { controller.abort(); leash.release(); value.close(); });
  await writeFile(join(value.root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await leash.birth(value.allocated.paths, value.soul);
  const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: at });
  const started = await beginTurn(value.allocated.paths, { bodySequence: body.sequence, startedAt: at, call: "work" });
  await appendActivity(value.allocated.paths, { turnSequence: started.sequence, at,
    event: { type: "tool", phase: "started", id: "shell", name: "bash", call: { kind: "run", command: "printf hello" } } });
  latest = await openWindow();
  const running = latest.rows.find((row) => row.kind === "tool");
  assert.ok(running?.kind === "tool");
  assert.equal(running.state, "active", "the opened window reports the call while its Turn is still open");
  await h.open();
  for (let index = 0; index < 245; index++) await appendActivity(value.allocated.paths, {
    turnSequence: started.sequence, at,
    event: index === 0 ? { type: "tool", phase: "completed", id: "shell", name: "bash",
      call: { kind: "run", command: "printf hello" }, result: { status: "ok", message: "hello", exitCode: 0 } }
      : { type: "thought", text: `working ${index}` },
  });
  latest = await openWindow();
  assert.equal(latest.rows.filter((row) => row.kind === "thought").length, 244,
    "one bounded stream window carries the whole retained work of a long open Turn");
  assert.equal(latest.historyLost, false, "projection holes and pagination are not guessed retention loss");
  assert.equal(latest.hasEarlier, false);
  assert.ok(latest.rows.some((row) => row.kind === "turn" && row.turnSequence === started.sequence));
  const tool = latest.rows.find((row) => row.kind === "tool");
  assert.ok(tool?.kind === "tool");
  assert.deepEqual(tool.call, { kind: "run", command: "printf hello" });
  assert.deepEqual(tool.state, { status: "ok", message: "hello", exitCode: 0 },
    "a later frame reports the settled state of the call the opened window saw running");
  assert.equal(tool.toolId, running.toolId, "the settled call keeps the identity the opened window reported");
  await h.refresh(); await tick();
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started"], "long ongoing work stays running");
  // The producer's own identity reaches the mirror as the installed package
  // reports it: with a tool identity the same call pairs across its settlement,
  // and without one running work is only reported as observation, never paired
  // by guesswork.
  const calls = items(h.events).flatMap((event) => event.item.type === "tool_call" ? [[event.item.callId, event.item.status]] : []);
  if (tool.toolId === undefined) {
    assert.deepEqual(calls, [[`tool/record/${tool.sequence}`, "completed"]],
      "a producer without tool identity keeps its own record scope");
    assert.deepEqual(items(h.events).flatMap((event) => event.item.type === "notification" ? [event.item.message] : []),
      ['bash: start observed. {"kind":"run","command":"printf hello"}'],
      "a producer without tool identity is reported as observation, not as a pair");
  } else {
    assert.equal(tool.toolId, "shell", "the real public SDK preserves native identity, not just adapter fixtures");
    assert.deepEqual(calls, [[`tool/${tool.turnSequence}/shell`, "running"], [`tool/${tool.turnSequence}/shell`, "completed"]]);
    assert.deepEqual(items(h.events).flatMap((event) => event.item.type === "tool_call" ? [event.item.detail] : []).at(-1),
      { type: "shell", command: "printf hello", output: "hello", exitCode: 0 });
  }
  for (const event of h.events) ProviderEventSchema.parse(event);
  await appendActivity(value.allocated.paths, { turnSequence: started.sequence, at,
    event: { type: "assistant", text: "done" } });
  latest = await openWindow();
  await h.refresh(); await tick();
  const said = latest.rows.find((row) => row.kind === "said");
  assert.ok(said?.kind === "said");
  await endTurn(value.allocated.paths, { turnSequence: started.sequence, completedAt: at,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "test-session" } } });
  latest = await openWindow();
  const outcome = latest.rows.find((row) => row.kind === "outcome");
  assert.ok(outcome?.kind === "outcome" && outcome.outcome.kind === "answered");
  // The mirror reuses the producer's own narration identity and never invents
  // one; folding the exact final narration needs the identity the producer
  // itself reports.
  if (outcome.outcome.foldedSaidSequence !== undefined)
    assert.equal(outcome.outcome.foldedSaidSequence, said.sequence, "the real public SDK carries the producer's fold identity");
  await h.refresh(); await tick();
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started", "completed"]);
  const narrated = new Set(items(h.events).flatMap((event) => event.item.type === "assistant_message" ? [event.item.id] : []));
  assert.ok(narrated.has(`keiyaku:said/${said.sequence}`), "the producer's narration keeps its own identity");
  assert.ok([...narrated].every((id) => id === `keiyaku:said/${said.sequence}` || id === `keiyaku:turn/${started.sequence}`),
    "the mirror publishes only the producer's own narration identities");
});

test("public metadata distinguishes bounded omission and retention loss without ending an open Turn", async (t) => {
  let snapshot = page([turn(2)]);
  const h = await harness(t, { window: async () => snapshot });
  await h.open();
  snapshot = page([{ kind: "thought", sequence: 950, at, turnSequence: 1, text: "still working" }],
    { hasEarlier: true, omitted: 700, lowestRetained: 1 });
  await h.refresh(); await tick();
  assert.match(notices(h.events).at(-1)!, /Earlier retained history.*bounded/u);
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started"]);
  snapshot = { ...snapshot, hasEarlier: false, omitted: 0, historyLost: true, lowestRetained: 900 };
  await h.refresh(); await tick();
  assert.match(notices(h.events).at(-1)!, /outside retention/u);
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started"]);
  snapshot = page([answer(1001)], { historyLost: true, lowestRetained: 900 });
  await h.refresh(); await tick();
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started", "completed"], "real outcome wins even without retained start");
});

test("the live observation publishes intermediate activity, keeps its display through a failure, and reopens only explicitly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let rows: Row[] = [turn(2)];
  let reads = 0;
  const h = await harness(t, { window: async () => { reads++; return rows; } });
  await h.open();
  t.mock.timers.tick(60_000); await tick();
  assert.equal(reads, 1, "an idle session never reads on a timer");
  rows = [...rows,
    { kind: "tool", sequence: 3, turnSequence: 1, toolId: "running", at, name: "bash", call: { kind: "run", command: "work" }, state: "active" },
    { kind: "said", sequence: 4, turnSequence: 1, at, text: "still working" }];
  h.push(rows); await tick();
  assert.deepEqual(items(h.events).map((event) => event.item.type), ["tool_call", "assistant_message"],
    "intermediate output arrives before any outcome signal");
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started"], "mid-turn changes never restart the Turn");
  // A failed frame retains the previous display and never retries itself.
  const before = reads;
  h.fail(new Error("temporarily unreadable")); await tick();
  assert.match(notices(h.events).at(-1) ?? "", /read surface unavailable/u);
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started"], "a failed frame preserves observed execution");
  t.mock.timers.tick(31 * 60_000); await tick();
  assert.equal(reads, before, "a failed observation is never retried on a timer");
  // Only an explicit refresh opens a fresh observation, and it observes now.
  rows = [...rows.filter((row) => row.kind !== "said"),
    { ...answer(5), outcome: { kind: "answered", answer: "still working", foldedSaidSequence: 4 } }];
  await h.refresh(); await tick();
  assert.equal(reads, before + 1, "an explicit refresh opens exactly one observation");
  assert.deepEqual(turns(h.events).map((event) => event.state), ["started", "completed"]);
  t.mock.timers.tick(60_000); await tick();
  assert.equal(reads, before + 1, "an observed terminal ends no observation the caller still holds");
  rows = [...rows, turn(6, 2)];
  await h.refresh(); await tick();
  assert.equal(reads, before + 2, "a real new Turn is observed by the same explicit refresh");
  assert.equal(turns(h.events).filter((event) => event.state === "started").length, 2, "only real Turn identities start");
});

test("session close releases the live observation and discards its in-flight read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, retired = false;
  const h = await harness(t, { window: async (_world, _id, signal) => {
    reads++;
    if (reads > 1) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      retired = true;
    }
    return reads === 1 ? [turn(2)] : [turn(2), answer(3)];
  } });
  await h.open();
  assert.equal(reads, 1);
  await h.refresh(); await tick();
  assert.equal(reads, 2, "an explicit refresh reopens the one observation");
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  assert.equal(retired, true, "session close waits for the read it released");
  t.mock.timers.tick(60_000); await tick();
  assert.equal(reads, 2, "close leaves no observation behind, timer or otherwise");
  assert.deepEqual(items(h.events), [], "the released read's late answer is not published");
  assert.deepEqual(turns(h.events).map((event) => [event.turnId, event.state]),
    [["turn/1", "started"], ["turn/1", "canceled"]],
    "closing the mirror cancels its own presentation and never the Akuma");
  assert.deepEqual(h.calls, [], "observation never submits execution or interrupt");
});

test("an open session reports the observed Akuma model, admits no missing one, and degrades to a notice without failing", async (t) => {
  const h = await harness(t, { window: async () => [turn(2)],
    status: async () => ({ provider: "pi", model: "kimi-coding/k3-256k" }) });
  await h.open();
  assert.deepEqual(h.events.filter((event) => event.type === "session.config").map((event) => event.config), [{
    model: "kimi-coding/k3-256k",
    models: [{ id: "kimi-coding/k3-256k", label: "pi / kimi-coding/k3-256k", isSelectable: false }],
    modes: [], thinkingOptions: [], settings: [],
  }], "the reported configuration is published verbatim, without inventing selectable modes");
  assert.deepEqual(h.events.filter((event) => event.type === "session.notice"), []);
  assert.equal(h.events.filter((event) => event.type === "session.ready").length, 1, "a reported model never delays readiness");

  const unavailable = await harness(t, { window: async () => [turn(2)],
    status: async () => { throw new Error("Akuma status unavailable"); } });
  await unavailable.open();
  assert.deepEqual(unavailable.events.filter((event) => event.type === "session.config"), [],
    "an unreadable configuration is never guessed");
  assert.deepEqual(unavailable.events.filter((event) => event.type === "session.notice").map((event) => event.notice), [{
    id: "keiyaku:model", severity: "warning", title: "Akuma model unavailable", description: "Akuma status unavailable",
  }], "the failure degrades to one warning the host can show");
  assert.equal(unavailable.events.filter((event) => event.type === "session.ready").length, 1);
  assert.deepEqual(unavailable.events.filter((event) => event.type === "session.turn").map((event) => event.state), ["started"],
    "an unavailable model never changes observed execution");

  // A provider the runtime never admitted a model for offers none: the mirror
  // never borrows its own placeholder or a provider default.
  const unspecified = await harness(t, { window: async () => [turn(2)], status: async () => ({ provider: "pi" }) });
  await unspecified.open();
  assert.deepEqual(unspecified.events.filter((event) => event.type === "session.config").map((event) => event.config),
    [{ models: [], modes: [], thinkingOptions: [], settings: [] }],
    "an unspecified model stays unknown instead of borrowing a default");
  assert.deepEqual(unspecified.events.filter((event) => event.type === "session.notice"), []);
  for (const event of [...h.events, ...unavailable.events, ...unspecified.events]) ProviderEventSchema.parse(event);
});
