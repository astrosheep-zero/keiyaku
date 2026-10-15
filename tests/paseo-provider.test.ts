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
import { createForwarder } from "../plugins/paseo/forwarder/index.js";
import contribute from "../plugins/paseo/plugin/index.server.js";
import { createProvider } from "../plugins/paseo/plugin/server/provider.js";
import { identityKeys, readKeiyaku, type Reader, type Row } from "../plugins/paseo/plugin/server/keiyaku.js";

const at = "2026-10-15T00:00:00.000Z";
const turn = (sequence: number, n = 1): Row => ({ kind: "turn", sequence, turnSequence: n, at });
const tell = (sequence: number, state: "pending" | "told" = "told"): Row =>
  ({ kind: "tell", sequence, tellId: `tell/${sequence}`, text: `input ${sequence}`, state, at });
const answer = (sequence: number, n = 1, failed = false): Row => ({ kind: "outcome", sequence, turnSequence: n, at,
  outcome: failed ? { kind: "failed", diagnostic: "provider broke" } : { kind: "answered", answer: "hello" } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function harness(reader: Reader) {
  const root = await mkdtemp(join(tmpdir(), "paseo-provider-"));
  const bridge = createProvider(reader);
  const connection = await bridge.provider.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "session.archive"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const config: ProviderSessionConfig = { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true,
    providerOptions: { world: root, akuId: "aku/test/1" } };
  const open = (extra: Partial<Extract<ProviderInput, { type: "session.open" }>> = {}) => connection.send({
    type: "session.open", requestId: "open", sessionId: "session", config, history: "replay", ...extra,
  });
  return { bridge, connection, events, root, config, open,
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
    models: [{ id: "mirror", label: "Akuma mirror（只读）" }], defaultModel: "mirror", modes: [],
  });
  await h.open();
  assert.equal(reads, 1);
  assert.deepEqual(h.connection.capabilities, ["session.persistence"]);
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
  assert.equal(turns(h.events).length, 0, "already ended short turns never start");
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

test("changed told rows, gaps, read failure recovery, interrupt and close remain read-only", async (t) => {
  let rows: Row[] = [tell(1, "pending"), turn(2)];
  let broken = false, reads = 0;
  const h = await harness(async () => { reads++; if (broken) throw new Error("unavailable"); return rows; });
  t.after(() => h.close());
  await h.open();
  assert.equal(items(h.events).length, 0);
  rows = [tell(1), turn(2)];
  await h.refresh(); await tick();
  assert.equal(items(h.events).length, 1, "a pending-to-told change publishes");
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
  assert.match(turns(h.events).at(-1)?.error?.message ?? "", /Akuma was not interrupted/u);
  await h.refresh(); await tick();
  assert.equal(turns(h.events).filter((e) => e.turnId === "turn/3").length, 2, "sealed turn never restarts");
  await h.connection.send({ type: "session.archive", requestId: "archive", persistence: { version: 1, data: {} } });
  await h.connection.send({ type: "session.prompt", sessionId: "session", prompt: {
    clientMessageId: "prompt", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "no" }] },
  } });
  const before = reads;
  await h.connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
  assert.deepEqual(await h.refresh(), { woken: 0 });
  assert.equal(reads, before);
  assert.equal(turns(h.events).filter((e) => e.turnId === "turn/3").length, 2);
  assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readdir(h.root)), [], "no World writes");
  broken = true;
  await h.open();
  assert.equal(items(h.events).filter((e) => e.item.id.startsWith("keiyaku:unreadable/")).length, 3);
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

test("session env, born attach, SDK creation and identity retries share the registered plugin seam", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paseo-attach-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = join(root, "alias"); await symlink(root, alias);
  const world = await realpath(root), akuId = "aku/test/1";
  const wire: Parameters<DaemonClient["createAgent"]>[0][] = [];
  const created = new Map<string, { id: string; cwd: string }>();
  const paseo = createPaseoApi({
    async fetchAgent({ agentId }: { agentId: string }) {
      return agentId === "parent" ? { agent: { id: agentId, cwd: root }, project: null } : null;
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
  const [name, hook] = before.mock.calls[0]!.arguments;
  assert.equal(name, "agent.session_open");
  for (const provider of ["codex", "keiyaku"]) {
    const request = { agentId: "parent", workspaceId: null, provider, cwd: root,
      reason: "create" as const, purpose: "interactive" as const, env: { KEEP: "yes", KEIYAKU_EXTERNAL_CALLER: "stale" } };
    assert.deepEqual(await hook({ request }, { paseo, signal: new AbortController().signal }), {
      ...request, env: { KEEP: "yes", KEIYAKU_EXTERNAL_CALLER: "paseo:parent" },
    });
  }
  const forwarder = createForwarder(async () => ({
    async invokePluginRpc(_plugin, method, input) { return await handlers.get(method)!(input); }, async close() {},
  }));
  const { signals } = await forwarder.activate({ world: alias as PluginContext["world"], config: undefined,
    writablePath() { throw new Error("no writes"); } });
  const caller = { kind: "external" as const, integration: "paseo", id: "parent" };
  await signals?.["akuma.born"]?.({ kind: "akuma.born", akumaId: akuId, bodySequence: 1, origin: { kind: "direct" }, caller });
  assert.deepEqual(create.mock.calls[0]?.arguments[0], { parent: "parent", cwd: root,
    config: { provider: "keiyaku/mirror", options: { world, akuId } }, idempotencyKey: `keiyaku:${world}:${akuId}` });
  assert.equal(created.size, 1);
  assert.deepEqual(wire[0], { config: { provider: "keiyaku", model: "mirror", cwd: root, providerOptions: { world, akuId } },
    callerAgentId: "parent", idempotencyKey: `keiyaku:${world}:${akuId}` });
  assert.deepEqual(await handlers.get("attach")!({ world: alias, akuId, caller }), { attached: true });
  assert.equal(created.size, 1, "canonical identity reuses daemon idempotency, not a bridge registry");
  assert.equal(wire[1]?.idempotencyKey, wire[0]?.idempotencyKey);
  const diagnostics = t.mock.method(console, "warn", () => {});
  for (const other of [undefined, { kind: "unknown" }, { kind: "akuma", world, akuId },
    { ...caller, integration: "other" }, { ...caller, id: "gone" }]) {
    const before = diagnostics.mock.callCount();
    assert.deepEqual(await handlers.get("attach")!({ world, akuId, caller: other }), { attached: false });
    assert.equal(diagnostics.mock.callCount(), before + 1);
  }
  assert.equal(create.mock.callCount(), 2, "only the initial attach and its retry reach create");
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
});
