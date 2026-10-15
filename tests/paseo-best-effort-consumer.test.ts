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
import type { CommandRunner, Row } from "../plugins/paseo/plugin/server/keiyaku.js";
const logger = pino({ level: "silent" });
const at = "2026-10-15T00:00:00.000Z";
const turn = (n: number): Row => ({ kind: "turn", sequence: n, turnSequence: n, at });
const answer = (n: number, sequence: number): Row => ({ kind: "outcome", sequence, turnSequence: n, at, outcome: { kind: "answered", answer: "done" } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function receipt(text: string, id: string, launch?: number, failed = false) {
  return { code: failed ? 2 : 0, stderr: "", stdout: JSON.stringify({ akuma: "aku/test/best-effort", tell: {
    admission: { fact: "recorded", tellId: id },
    row: { kind: "tell", sequence: 1, at, tellId: id, text, state: "pending", deliveries: launch === undefined ? [] : [{ route: "launch", turnSequence: launch, deliveredAt: at }] },
    wake: failed ? { kind: "failed", diagnostic: "test wake failed" } : { kind: launch === undefined ? "held" : "told" },
  } }) };
}
async function harness(command: CommandRunner) {
  const root = await mkdtemp(join(tmpdir(), "paseo-best-effort-consumer-"));
  let rows: Row[] = [];
  const calls: string[][] = [];
  const bridge = createProvider(async () => rows, async (...args) => { calls.push(args[1]); return command(...args); });
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
    async refresh() { await bridge.refresh({ world: root, akuId: "aku/test/best-effort" }); await drain(); },
    async close() { await registry.shutdown(); await rm(root, { recursive: true, force: true }); },
    send(text: string, id: string) { return startAgentRun(manager, agent.id, text, logger, { activeTurnBehavior: "steer", replaceRunning: true, runOptions: { clientMessageId: id } }); },
  };
}
for (const failed of [false, true]) test(`recorded steer succeeds with ${failed ? "failed wake" : "no live receipt"}, one Tell and no interrupt`, async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  let n = 0;
  const h = await harness(async (_world, _args, _signal, text) => {
    n++;
    if (n === 1) h.setRows([turn(2)]);
    return receipt(text!, `id-${n}`, n === 1 ? 2 : undefined, n > 1 && failed);
  });
  t.after(() => h.close());
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  assert.deepEqual(await h.send("steering", "steering"), { disposition: "steered" });
  assert.deepEqual(h.calls.map((args) => args[0]), ["tell", "tell"]);
  assert.equal(h.events.some((event) => event.type === "turn_completed" || event.type === "turn_canceled"), false);
  assert.equal(h.events.some((event) => event.type === "timeline" && event.item.type === "notification" && /delivery pending/u.test(event.item.message)), false);
  assert.equal(warnings.mock.callCount(), failed ? 1 : 0, "a failed wake retains its diagnostic without failing the recorded message");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});

test("a Turn transition during Tell keeps its captured acknowledgement and does not fall back", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  let n = 0;
  const h = await harness(async (_world, _args, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text!, "initial", 2); }
    began(); await blocked; return receipt(text!, "steering");
  });
  t.after(() => h.close());
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  const sending = h.send("steering", "steering"); await started;
  h.setRows([turn(2), answer(2, 3), turn(4)]); await h.refresh();
  release();
  assert.deepEqual(await sending, { disposition: "steered" }); await h.drain();
  assert.deepEqual(h.calls.map((args) => args[0]), ["tell", "tell"]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/4");
  assert.equal(h.events.filter((event) => event.type === "turn_completed" && event.turnId === "turn/2").length, 1);
  h.setRows([turn(2), answer(2, 3), turn(4), answer(4, 5)]); await h.refresh();
});

test("a transition before plugin receipt can still make the host reject the acknowledgement, but never retries", async (t) => {
  let n = 0;
  const h = await harness(async (_world, _args, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text!, "initial", 2); }
    return receipt(text!, "accepted-on-transition");
  });
  t.after(() => h.close());
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  h.setBeforePrompt(async () => {
    h.setRows([turn(2), answer(2, 3), turn(4)]);
    await h.refresh();
  });
  await assert.rejects(h.send("accepted during transport", "raced"), /Active turn changed/u);
  assert.deepEqual(h.calls.map((args) => args[0]), ["tell", "tell"]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/4");
  h.setRows([turn(2), answer(2, 3), turn(4), answer(4, 5)]); await h.refresh();
});

test("idle admission completes a host send command, then later real Akuma execution is still tracked", async (t) => {
  const h = await harness(async (_world, _args, _signal, text) => receipt(text!, "idle"));
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
  const h = await harness(async (_world, _args, _signal, text) => { h.setRows([turn(2)]); return receipt(text!, "idle"); });
  t.after(() => h.close());
  await h.send("idle input", "idle"); await h.drain();
  assert.equal(h.manager.getAgent(h.agent.id)!.lifecycle, "running");
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});

test("uncertain steer fails honestly without host replacement, retry, or touching the existing Turn", async (t) => {
  let n = 0;
  const h = await harness(async (_world, _args, _signal, text) => {
    n++;
    if (n === 1) { h.setRows([turn(2)]); return receipt(text!, "initial", 2); }
    return { code: 3, stdout: "", stderr: "lost receipt after possible admission" };
  });
  t.after(() => h.close());
  await h.send("initial", "initial"); await h.manager.waitForAgentRunStart(h.agent.id);
  await assert.rejects(h.send("uncertain", "uncertain"), /outcome is uncertain.*lost receipt/u);
  assert.deepEqual(h.calls.map((args) => args[0]), ["tell", "tell"]);
  assert.equal(h.manager.getAgent(h.agent.id)!.activeTurnId, "turn/2");
  h.setRows([turn(2), answer(2, 3)]); await h.refresh();
});
