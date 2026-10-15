import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderEvent, ProviderInput, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginContext } from "../src/plugin/public.js";
import { akumaCallerFromEnvironment } from "../src/cli/akuma-caller.js";
import { createForwarder } from "../plugins/paseo/forwarder/index.js";
import contribute from "../plugins/paseo/plugin/index.server.js";
import { createProvider } from "../plugins/paseo/plugin/server/provider.js";
import { identityKeys, readKeiyaku, runKeiyaku, type CommandRunner, type Reader, type Row } from "../plugins/paseo/plugin/server/keiyaku.js";

const at = "2026-10-15T00:00:00.000Z";
const turn = (sequence: number, n = 1): Row => ({ kind: "turn", sequence, turnSequence: n, at });
const tell = (sequence: number, state: "pending" | "told" = "told"): Row =>
  ({ kind: "tell", sequence, tellId: `tell/${sequence}`, text: `input ${sequence}`, state, at });
const answer = (sequence: number, n = 1, failed = false): Row => ({ kind: "outcome", sequence, turnSequence: n, at,
  outcome: failed ? { kind: "failed", diagnostic: "provider broke" } : { kind: "answered", answer: "hello" } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const killed = (evidence: string) =>
  ({ code: 0, stdout: JSON.stringify({ results: [{ id: "aku/test/1", evidence }] }), stderr: "" });
async function harness(reader: Reader, command: CommandRunner = async () => { throw new Error("unexpected mutation"); }) {
  const root = await mkdtemp(join(tmpdir(), "paseo-provider-"));
  const calls: { world: string; args: string[]; stdin?: string }[] = [];
  const bridge = createProvider(reader, async (world, args, signal, stdin) => {
    calls.push({ world, args, ...(stdin === undefined ? {} : { stdin }) });
    return command(world, args, signal, stdin);
  });
  const connection = await bridge.provider.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "prompt.steer", "session.archive"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const config: ProviderSessionConfig = { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true,
    providerOptions: { world: root, akuId: "aku/test/1" } };
  const open = (extra: Partial<Extract<ProviderInput, { type: "session.open" }>> = {}) => connection.send({
    type: "session.open", requestId: "open", sessionId: "session", config, history: "replay", ...extra,
  });
  return { bridge, connection, events, calls, root, config, open,
    refresh: () => bridge.refresh({ world: root, akuId: "aku/test/1" }),
    async close() { await connection.close(); await bridge.close(); await rm(root, { recursive: true, force: true }); } };
}
const items = (events: ProviderEvent[]) => events.filter((e) => e.type === "timeline.item");
const turns = (events: ProviderEvent[]) => events.filter((e) => e.type === "session.turn");

test("open, event-only refresh, reply mapping, and persisted replay through the same session seam", async (t) => {
  let rows: Row[] = [turn(2), tell(1)];
  let reads = 0;
  const h = await harness(async () => { reads++; return rows; });
  t.after(() => h.close());
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  await h.connection.send({ type: "catalog", requestId: "catalog" });
  assert.deepEqual(h.events.find((e) => e.type === "catalog")?.catalog, {
    models: [{ id: "mirror", label: "Akuma mirror" }], defaultModel: "mirror", modes: [],
  });
  await h.open();
  assert.equal(reads, 1);
  assert.deepEqual(h.connection.capabilities, ["session.persistence", "prompt.message", "prompt.steer"]);
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"]]);
  t.mock.timers.tick(60_000);
  assert.equal(reads, 1, "idle has zero reads and no periodic wakeup");
  assert.deepEqual(await h.bridge.refresh({ world: h.root, akuId: "aku/other/1" }), { woken: 0 });
  assert.equal(reads, 1);
  const alias = join(h.root, "alias");
  await symlink(h.root, alias);
  rows = [answer(3), turn(2), tell(1)];
  assert.deepEqual(await h.bridge.refresh({ world: alias, akuId: "aku/test/1" }), { woken: 1 });
  await tick();
  assert.deepEqual(items(h.events).map((e) => [e.item.id, e.item.type, e.timestamp]), [
    ["keiyaku:tell/tell/1", "user_message", at], ["keiyaku:turn/1", "assistant_message", at],
  ]);
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started", "completed"]);
  await h.refresh(); await tick();
  assert.equal(items(h.events).length, 2, "same signatures do not republish");
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
  const h = await harness(async () => rows);
  t.after(() => h.close());
  await h.open({ history: "skip" });
  assert.deepEqual(h.events.map((event) => event.type), ["session.opened", "session.turn", "session.ready"],
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
    "keiyaku:window/10", "keiyaku:tell/tell/10", "keiyaku:turn/1", "keiyaku:tell/tell/13",
    "keiyaku:tell/tell/15", "keiyaku:turn/2",
  ], "replay still exposes retained history and its retention notice");
  assert.deepEqual(turns(h.events).map((event) => [event.turnId, event.state]), [
    ["turn/1", "started"], ["turn/1", "completed"], ["turn/2", "started"], ["turn/2", "completed"],
  ], "replay publishes ordered historical start/terminal pairs");
  assert.deepEqual(h.calls, [], "opening, refreshing and closing remain observation-only");
});

test("skip retains open and closed Turn state for Steer and Stop without historical starts", async (t) => {
  let rows: Row[] = [tell(1), turn(2, 7)];
  const receipt = messageReceipt("live");
  const h = await harness(async () => rows, async (_world, args) => {
    if (args[0] === "kill") return killed("killed");
    rows = [...rows, receipt.tell.row];
    return { code: 0, stdout: JSON.stringify(receipt), stderr: "" };
  });
  t.after(() => h.close());
  await h.open({ history: "skip" });
  await h.connection.send(promptInput());
  assert.deepEqual(promptResults(h.events).map((event) => event.result), [{ type: "steer", turnId: "turn/7" }]);
  assert.deepEqual(items(h.events).map((event) => event.item), [
    { type: "user_message", id: "keiyaku:tell/new-tell", text: "change direction", clientMessageId: "client-1" },
  ]);
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  await h.refresh(); await tick();
  assert.deepEqual(h.calls.map((call) => call.args[0]), ["tell", "kill"]);
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

test("in-flight hints coalesce and RPC returns without waiting for reads", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0, active = 0, peak = 0;
  const h = await harness(async () => { calls++; peak = Math.max(peak, ++active); await blocked; active--; return []; });
  t.after(() => h.close());
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
  const commands: string[][] = [];
  const h = await harness(async () => { reads++; if (broken) throw new Error("unavailable"); return rows; }, async (_world, args) => {
    commands.push(args);
    return { code: 0, stdout: JSON.stringify({ results: [{ id: "aku/test/1", evidence: "killed" }] }), stderr: "" };
  });
  t.after(() => h.close());
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
    ["turn/1", "started"], ["turn/1", "canceled"], ["turn/2", "started"],
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
  assert.deepEqual(commands, [["kill", "aku/test/1", "--json"]]);
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
  assert.equal(commands.length, 1, "observation close never kills");
  assert.equal(turns(h.events).filter((e) => e.turnId === "turn/3").length, 2);
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(h.root)), [], "no World writes");
  broken = true;
  await h.open();
  assert.equal(items(h.events).filter((e) => e.item.id.startsWith("keiyaku:unreadable/")).length, 3);
});

test("Stop kills the controlled Akuma, refreshes, and ends only the observed turn", async (t) => {
  let rows: Row[] = [turn(2)];
  let reads = 0;
  const h = await harness(async () => { reads++; return rows; }, async () => killed("killed"));
  t.after(() => h.close());
  await h.open();
  assert.equal(h.calls.length, 0, "opening never controls the Akuma");
  const before = reads;
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(h.calls.map((call) => [call.world, ...call.args]),
    [[await realpath(h.root), "kill", "aku/test/1", "--json"]], "kill runs through the bounded public CLI");
  assert.equal(h.calls[0]?.stdin, undefined, "kill carries no stdin");
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

test("a refused Stop reports the CLI diagnostic and leaves the observed turn running", async (t) => {
  const h = await harness(async () => [turn(2)],
    async () => ({ code: 1, stdout: "", stderr: "Akuma aku/test/1 is not born\n" }));
  t.after(() => h.close());
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(h.events.filter((e) => e.type === "request.failed"),
    [{ type: "request.failed", requestId: "stop", error: { message: "Akuma aku/test/1 is not born" } }]);
  assert.equal(h.events.some((e) => e.type === "request.completed"), false);
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started"], "an unproven stop never cancels the turn");
});

test("a hung or untidy Body reports the receipt's own evidence instead of a stop", async (t) => {
  const h = await harness(async () => [turn(2)], async () => ({ code: 1, stdout: JSON.stringify(
    { results: [{ id: "aku/test/1", evidence: "hung" }] }), stderr: "" }));
  t.after(() => h.close());
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(h.events.filter((e) => e.type === "request.failed"),
    [{ type: "request.failed", requestId: "stop", error: { message: "Keiyaku reported hung for aku/test/1" } }]);
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started"], "held custody is not a stopped turn");
});

test("an unprovable Stop reports uncertainty instead of an outcome", async (t) => {
  let reads = 0;
  const h = await harness(async () => { reads++; return [turn(2)]; },
    async () => { throw new Error("Keiyaku command outcome is uncertain: signal timed out"); });
  t.after(() => h.close());
  await h.open();
  const before = reads;
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  const failed = h.events.find((e) => e.type === "request.failed");
  assert.match(failed?.error.message ?? "", /could not prove the stop/u);
  assert.match(failed?.error.message ?? "", /timed out/u);
  assert.equal(reads, before + 1, "a thrown failure still refreshes authoritative history");
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started"]);
});

test("a Stop nobody proves still answers every request and never stops in the dark", async (t) => {
  const h = await harness(async () => [turn(2)], async () => ({ code: 0, stdout: "", stderr: "" }));
  t.after(() => h.close());
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(h.events.filter((e) => e.type === "request.completed" || e.type === "request.failed"),
    [{ type: "request.failed", requestId: "stop", error: { message: "Keiyaku reported no stop receipt" } }]);
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started"]);
});

test("overlapping Stops share one kill attempt and each request receives one receipt", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let kills = 0;
  const h = await harness(async () => [turn(2)], async () => {
    kills++;
    await blocked;
    return killed("already-stopped");
  });
  t.after(() => h.close());
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
  const h = await harness(async () => rows, async () => {
    rows = [turn(2), answer(3)];
    return killed("already-stopped");
  });
  t.after(() => h.close());
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"], ["turn/1", "completed"]]);
  assert.equal(h.events.filter((e) => e.type === "request.completed").length, 1);
});

test("a CLI-produced put-down failure remains the only terminal event after a proven Stop", async (t) => {
  let rows: Row[] = [turn(2)];
  const h = await harness(async () => rows, async () => {
    rows = [turn(2), answer(4, 1, true)];
    return killed("killed");
  });
  t.after(() => h.close());
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"], ["turn/1", "failed"]]);
  assert.deepEqual(h.events.filter((e) => e.type === "request.completed"), [{ type: "request.completed", requestId: "stop" }]);
});

test("a natural outcome held by Tell correlation is not overwritten by concurrent Stop", async (t) => {
  let rows: Row[] = [turn(2)];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness(async () => rows, async (_world, args) => {
    if (args[0] === "kill") return killed("already-stopped");
    await blocked;
    return { code: 0, stdout: JSON.stringify(messageReceipt(undefined, { kind: "held" })), stderr: "" };
  });
  t.after(() => h.close());
  await h.open();
  const submitting = h.connection.send(promptInput());
  rows = [turn(2), answer(4)];
  await h.refresh(); await tick();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => e.state), ["started"], "the natural outcome is still held, not canceled");
  release(); await submitting;
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]), [["turn/1", "started"], ["turn/1", "completed"]]);
  assert.deepEqual(h.calls.map((call) => call.args[0]), ["tell", "kill"]);
});

test("a proven Stop settles the turn it captured even after a newer Turn replaced it", async (t) => {
  let rows: Row[] = [turn(2)];
  const h = await harness(async () => rows, async () => {
    rows = [turn(2), turn(4, 2)];
    return killed("killed");
  });
  t.after(() => h.close());
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
  const h = await harness(async () => rows, async () => {
    rows = [turn(2), turn(4, 2)];
    return { code: 1, stdout: "", stderr: "Akuma aku/test/1 is not born\n" };
  });
  t.after(() => h.close());
  await h.open();
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  assert.deepEqual(turns(h.events).map((e) => e.turnId), ["turn/1", "turn/2"], "a refusal leaves the turn running");
  rows = [turn(2), answer(3, 1), turn(4, 2)];
  await h.refresh(); await tick();
  assert.deepEqual(turns(h.events).map((e) => [e.turnId, e.state]),
    [["turn/1", "started"], ["turn/2", "started"], ["turn/1", "completed"]],
    "the captured turn closes from its own outcome, never from the Stop");
});

test("close during an in-flight Stop retires the owned kill before the session closes", async (t) => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let kills = 0, retired = false;
  const h = await harness(async () => [turn(2)], async (_world, _args, signal) => {
    kills++;
    began();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    retired = true;
    throw new Error("Keiyaku command outcome is uncertain: signal aborted");
  });
  t.after(() => h.close());
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
  const h = await harness(async () => []);
  t.after(() => h.close());
  await h.connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "absent" });
  assert.deepEqual(h.events, [{ type: "request.failed", requestId: "stop",
    error: { message: "Keiyaku mirror session is not open" } }]);
  assert.equal(h.calls.length, 0);
});

test("close during a read aborts the pump and discards its pending wake", async (t) => {
  let reads = 0;
  const h = await harness(async (_world, _akuId, signal) => {
    reads++;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return [tell(1)];
  });
  t.after(() => h.close());
  const opening = h.open();
  while (!reads) await tick();
  await h.refresh();
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  await opening;
  assert.equal(reads, 1);
  assert.deepEqual(items(h.events), []);
  assert.deepEqual(await h.refresh(), { woken: 0 });
  assert.deepEqual(h.events.map((e) => e.type), ["session.opened", "session.closed", "request.completed"]);
});

test("native born attach, SDK creation and identity retries share the registered plugin seam without env injection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paseo-attach-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = join(root, "alias"); await symlink(root, alias);
  const world = await realpath(root), akuId = "aku/test/1";
  const wire: Parameters<DaemonClient["createAgent"]>[0][] = [];
  const created = new Map<string, { id: string; cwd: string }>();
  const parent = { id: "parent", cwd: root, archivedAt: null,
    persistence: { provider: "codex", sessionId: "native-codex", nativeHandle: "native-codex" } };
  const paseo = createPaseoApi({
    async fetchAgents(options: { filter: unknown }) {
      assert.deepEqual(options.filter, { includeArchived: true, includeBackground: true });
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
    async invokePluginRpc(_plugin, method, input) { return await handlers.get(method)!(input); }, async close() {},
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

test("reader spawns only bounded history, strips inherited identities, and rejects bad/nonzero reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paseo-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); await mkdir(bin);
  const log = join(root, "calls.json");
  await writeFile(join(bin, "keiyaku"), `#!/usr/bin/env node\nconst fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),env:process.env}));
if(process.env.READER_FAIL==='exit')process.exit(1);
console.log(process.env.READER_FAIL==='json'?'invalid':JSON.stringify({kind:'history',history:{rows:[]}}));\n`, { mode: 0o755 });
  const previous = { ...process.env };
  t.after(() => { for (const key of [...identityKeys, "PATH", "READER_FAIL"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  for (const key of identityKeys) process.env[key] = "inherited-participant";
  process.env.PATH = `${bin}:${process.env.PATH}`;
  assert.deepEqual(await readKeiyaku(root, "aku/test/1", new AbortController().signal), []);
  const call = JSON.parse(await readFile(log, "utf8")) as { argv: string[]; env: NodeJS.ProcessEnv };
  assert.deepEqual(call.argv, ["-C", root, "history", "aku/test/1", "--json", "--limit", "200"]);
  for (const key of identityKeys) assert.equal(call.env[key], undefined, key);
  process.env.READER_FAIL = "json";
  await assert.rejects(readKeiyaku(root, "aku/test/1", new AbortController().signal));
  process.env.READER_FAIL = "exit";
  await assert.rejects(readKeiyaku(root, "aku/test/1", new AbortController().signal));
  await assert.rejects(readKeiyaku(root, "aku/test/1", AbortSignal.abort()));
  await writeFile(join(bin, "keiyaku"), `#!/usr/bin/env node
const fs=require('node:fs');
const stdin=fs.readFileSync(0,'utf8');
console.log(JSON.stringify({argv:process.argv.slice(2),stdin}));
console.error('wake failed');process.exit(2);\n`, { mode: 0o755 });
  const result = await runKeiyaku(root, ["tell", "aku/test/1", "--json", "-"], new AbortController().signal, "steer\ntext");
  assert.equal(result.code, 2, "nonzero receipts remain available to the mutation decoder");
  assert.deepEqual(JSON.parse(result.stdout), { argv: ["-C", root, "tell", "aku/test/1", "--json", "-"], stdin: "steer\ntext" });
  assert.match(result.stderr, /wake failed/u);
});

const promptInput = (id = "client-1", text = "change direction"): Extract<ProviderInput, { type: "session.prompt" }> => ({
  type: "session.prompt", sessionId: "session", prompt: {
    clientMessageId: id, delivery: "steer", input: { type: "message", content: [{ type: "text", text }] },
  },
});
function messageReceipt(route?: "live" | "launch", wake: { kind: "told" | "held" | "pursuing" | "failed"; diagnostic?: string; bodySequence?: number } = { kind: "told" }, tellId = "new-tell") {
  return { akuma: "aku/test/1", tell: { admission: { fact: "recorded", tellId },
    row: { kind: "tell" as const, sequence: 3, at, tellId, text: "change direction", state: "pending" as const,
      deliveries: route ? [{ route, turnSequence: 7, deliveredAt: at, receipt: "required" as const }] : [] }, wake } };
}
const promptResults = (events: ProviderEvent[]) => events.filter((event) => event.type === "session.prompt_result");
const notices = (events: ProviderEvent[]) => items(events).flatMap((event) => event.item.type === "notification" ? [event.item.message] : []);

test("live steering correlates the optimistic message before racing history and never interrupts", async (t) => {
  let rows: Row[] = [turn(1, 7)];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const receipt = messageReceipt("live");
  const calls: unknown[] = [];
  const h = await harness(async () => rows, async (world, args, signal, stdin) => {
    calls.push({ world, args, stdin });
    await Promise.race([blocked, new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })]);
    return { code: 0, stdout: JSON.stringify(receipt), stderr: "" };
  });
  t.after(() => h.close());
  await h.open();
  const submission = h.connection.send(promptInput());
  rows = [turn(1, 7), receipt.tell.row, answer(4, 7)];
  await h.refresh(); await tick();
  assert.equal(items(h.events).length, 0, "a racing snapshot waits for exact Tell identity");
  release(); await submission;
  assert.deepEqual(calls, [{ world: await realpath(h.root), args: ["tell", "aku/test/1", "--json", "-"], stdin: "change direction" }]);
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
  let receipt = messageReceipt(undefined, { kind: "held" });
  let code = 0;
  const h = await harness(async () => [], async () => ({ code, stdout: JSON.stringify(receipt), stderr: "" }));
  t.after(() => h.close());
  await h.open();
  t.mock.method(console, "warn", () => {});
  const request = () => { const input = promptInput(); input.prompt.delivery = "auto"; return input; };
  await h.connection.send(request());
  assert.deepEqual(promptResults(h.events).at(-1)?.result, { type: "completed" });
  assert.deepEqual(notices(h.events), []);
  assert.equal(turns(h.events).length, 0, "admission does not start or finish an Akuma Turn");
  receipt = messageReceipt(undefined, { kind: "failed", diagnostic: "frozen directory is missing" }, "failed-wake");
  code = 2;
  const second = request(); second.prompt.clientMessageId = "client-2";
  await h.connection.send(second);
  assert.deepEqual(promptResults(h.events).at(-1)?.result, { type: "completed" });
  assert.deepEqual(notices(h.events), []);
  assert.equal(turns(h.events).length, 0);
  receipt = messageReceipt("launch", { kind: "pursuing", bodySequence: 5 }, "launch-tell");
  code = 0;
  const third = request(); third.prompt.clientMessageId = "client-3";
  await h.connection.send(third);
  assert.deepEqual(promptResults(h.events).at(-1)?.result, { type: "turn", turnId: "turn/7" });
  assert.equal(turns(h.events).length, 0, "only authoritative history can publish Turn lifecycle");
});

test("unsupported input refuses before CLI admission and ambiguous failure never retries", async (t) => {
  let calls = 0;
  const h = await harness(async () => [], async () => { calls++; return { code: 1, stdout: "not JSON", stderr: "connection lost after write" }; });
  t.after(() => h.close());
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
  await assert.rejects(h.connection.send(request), /outcome is uncertain/u);
  assert.equal(calls, 1);
  assert.equal(promptResults(h.events).length, 4, "exactly one receipt per request");
  const failed = promptResults(h.events).at(-1)?.result;
  assert.equal(failed?.type, "failed");
  if (failed?.type === "failed") assert.match(failed.error.message, /uncertain.*exit 1.*connection lost after write.*may already be recorded/u);
  assert.deepEqual(items(h.events), []);
  assert.deepEqual(turns(h.events), []);
});

test("close retires an owned Tell subprocess without kill, automatic retry, or late history publication", async (t) => {
  const calls: string[][] = [];
  const h = await harness(async () => [], async (_world, args, signal) => {
    calls.push(args);
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Tell outcome uncertain after observation closed")), { once: true }));
    throw new Error("unreachable");
  });
  t.after(() => h.close());
  await h.open();
  const request = promptInput(); request.prompt.delivery = "auto";
  const submitting = assert.rejects(h.connection.send(request), /outcome uncertain/u);
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  await submitting;
  assert.deepEqual(calls, [["tell", "aku/test/1", "--json", "-"]]);
  assert.equal(promptResults(h.events).length, 1);
  assert.equal(promptResults(h.events)[0]?.result.type, "failed");
  assert.deepEqual(items(h.events), []);
  assert.deepEqual(h.events.slice(-2).map((event) => event.type), ["session.closed", "request.completed"]);
});
