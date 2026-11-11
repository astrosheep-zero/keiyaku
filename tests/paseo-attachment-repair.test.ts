import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import "./support/local-public-package.js";
import { Akuma, Keiyaku, World } from "../src/index.js";
import { HeldAkumaLeash, beginTurn, endTurn } from "../src/akuma/heart/index.js";
import { allocatedHeart, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { temporaryDirectory } from "./support/process.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { createSdkTransport } from "../plugins/paseo/plugin/server/sdk.js";
import { attach } from "../plugins/paseo/plugin/server/attach.js";
import type { PluginSignal } from "../src/plugin/public.js";
const { createForwarder } = await import("../plugins/paseo/forwarder/index.js");

const at = "2026-11-11T00:00:00.000Z";
const pageInfo = { hasMore: false, nextCursor: null, prevCursor: null };

test("invocation status repairs missed birth and nested parents through passive in-process SDK reads", { timeout: 10_000 }, async t => {
  const world = await World.at(temporaryDirectory(t, "paseo-repair-"));
  const parent = await bornLineageAkuma({ root: world, akumaName: "parent", draw: "1234abcd", createdAt: at,
    caller: { kind: "external", integration: "claude", id: "native-parent" } });
  const child = await bornLineageAkuma({ root: world, akumaName: "child", draw: "5678abcd", createdAt: at,
    caller: { kind: "akuma", world, akumaId: parent.id },
    origin: { kind: "fork", parent: "aku/unrelated/11111111" as typeof parent.id, at: "turn/1" } });
  const transport = createSdkTransport({ entry: resolve("build/src/index.js") });
  t.after(() => transport.close());
  const agents = new Map<string, PaseoAgent>();
  agents.set("host", { id: "host", provider: "wwz", cwd: world, archivedAt: null,
    persistence: { provider: "wwz", sessionId: "native-parent", metadata: { provider: "claude" } } } as unknown as PaseoAgent);
  const creations = new Map<string, string>();
  const parents: Array<[string, string | undefined]> = [];
  const reads: string[] = [];
  const rpc: string[] = [];
  const client = {
    getLastServerInfoMessage() { return { serverId: "isolated-test" }; },
    async fetchAgents() { return { requestId: "list", entries: [...agents.values()].map(agent => ({ agent, project: null })), pageInfo }; },
    async fetchAgent({ agentId }: { agentId: string }) { const agent = agents.get(agentId); return agent ? { agent, project: null } : null; },
    async createAgent(options: Parameters<DaemonClient["createAgent"]>[0]) {
      const target = options.config!.providerOptions as { world: string; akuId: string };
      // Real creation performs model correction and opens a mirror before its
      // mapping is visible. These public SDK reads must never notify us again.
      const status = await transport.status(target.world, target.akuId, t.signal);
      assert.ok(status.caller);
      const stream = transport.stream(target.world, target.akuId, t.signal)[Symbol.asyncIterator]();
      await stream.next();
      await stream.return?.();
      reads.push(target.akuId);
      let id = creations.get(options.idempotencyKey!);
      if (!id) {
        id = `mirror-${creations.size}`;
        creations.set(options.idempotencyKey!, id);
        parents.push([target.akuId, options.callerAgentId]);
        agents.set(id, { id, provider: "keiyaku", cwd: world, archivedAt: null, title: options.config!.title,
          persistence: { provider: "keiyaku", sessionId: `opaque/${id}`,
            metadata: { pluginProviderPersistence: { version: 1, data: target } } } } as unknown as PaseoAgent);
      }
      return agents.get(id)!;
    },
    async updateAgent() {},
    async invokePluginRpc(_plugin: string, method: string, input: unknown) {
      rpc.push(method);
      const target = input as Parameters<typeof attach>[0];
      if (method === "attach") return attach(target, { paseo }, transport.status);
      await transport.status(target.world, target.akuId, t.signal);
      return { woken: 1 };
    },
    async close() {},
  };
  const paseo = createPaseoApi(client as unknown as DaemonClient);
  t.after(() => paseo.dispose());
  const { signals } = await createForwarder(async () => client as unknown as DaemonClient).activate({
    world, config: undefined, writablePath() { throw new Error("no observer store"); },
  });
  const key = `paseo-repair-${world}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  let observations = 0;
  let outcomeObservations = 0;
  globals[key] = async (event: PluginSignal, cancellation?: AbortSignal) => {
    if (event.kind === "akuma.observed") {
      assert.ok(++observations < 10, "recursive public observation");
      await signals?.["akuma.observed"]?.(event, cancellation);
    } else { outcomeObservations++; }
  };
  t.after(() => { delete globals[key]; });
  await mkdir(join(world, "plugins"));
  await writeFile(join(world, "plugins", "repair.mjs"), `export default {
    manifest: { id: "repair", apiVersion: 1 }, activate() { const receive = globalThis[${JSON.stringify(key)}];
      return { signals: { "akuma.observed": receive, "akuma.outcome-observed": receive } }; }
  };`);
  await writeFile(join(world, ".keiyaku", "settings.json"), JSON.stringify({
    plugins: { repair: { package: "./plugins/repair.mjs" } },
  }));
  const invocation = Keiyaku.at({ cwd: world, environment: {
    KEIYAKU_EXTERNAL_CALLER: "paseo:wrong-parent", CODEX_THREAD_ID: "wrong-current-turn",
  } });
  const [result] = await Promise.all([
    invocation.run("status", { selector: child.id }),
    invocation.run("status", { selector: child.id }),
  ]);
  assert.equal("life" in result ? result.life : undefined, "asleep");
  assert.deepEqual(parents, [[parent.id, "host"], [child.id, "mirror-0"]]);
  assert.equal(observations, 2, "concurrent first repair never reenters through SDK correction or streams");
  assert.equal(outcomeObservations, 0);
  assert.equal(rpc.filter(method => method === "attach").length, 2);
  assert.equal(rpc.filter(method => method === "refresh").length, 2);
  assert.deepEqual([...new Set(reads)], [parent.id, child.id]);

  // The same explicit status boundary offers repair while running, before any outcome.
  const running = await allocatedHeart(world, "running", "9876abcd");
  const leash = (await HeldAkumaLeash.try(running.paths))!;
  t.after(() => leash.release());
  await leash.birth(running.paths, { ...child.soul, id: running.id, akumaName: "running" });
  const body = await leash.recordBody(running.paths, { leashTakenAt: at });
  const activeTurn = await beginTurn(running.paths, { bodySequence: body.sequence, startedAt: at, call: "still working" });
  await signals?.["akuma.turn-started"]?.({ kind: "akuma.turn-started", akumaId: running.id, turnSequence: activeTurn.sequence });
  assert.equal(creations.size, 3, "a later Turn boundary repairs a missed birth before status observation");
  assert.equal(observations, 2, "runtime refresh uses passive reads too");
  const live = await invocation.run("status", { selector: running.id });
  assert.equal("life" in live ? live.life : undefined, "running");
  assert.equal(creations.size, 3);
  assert.equal(observations, 3);

  await Promise.all([invocation.run("status", { selector: child.id }), Akuma.select(world, child.id).status()]);
  assert.equal(creations.size, 3, "repeated/concurrent observation creates no duplicates");
  assert.equal(observations, 5);
  const passive = Akuma.read(world, child.id);
  assert.equal("tell" in passive, false);
  assert.equal("kill" in passive, false);
  await passive.status();
  await passive.history();
  const stream = passive.stream()[Symbol.asyncIterator]();
  await stream.next();
  await stream.return?.();
  assert.equal(observations, 5);
  await endTurn(running.paths, { turnSequence: activeTurn.sequence, completedAt: at,
    outcome: { kind: "answered", answer: "retained answer", session: { sessionId: "repair-session" } } });
  const terminal = Akuma.read(world, running.id);
  await terminal.status();
  await terminal.history();
  const terminalStream = terminal.stream()[Symbol.asyncIterator]();
  await terminalStream.next();
  await terminalStream.return?.();
  assert.equal(outcomeObservations, 0, "passive reads never emit retained-outcome notifications either");
  const unborn = await allocatedHeart(world, "unborn", "8765abcd");
  await assert.rejects(invocation.run("status", { selector: unborn.id }));
  assert.equal(observations, 5, "unborn status emits no observation signal");
  assert.equal(await realpath(world), world);
});

test("retained caller cycles terminate without pending-ensure deadlock or invented parents", { timeout: 5000 }, async t => {
  const world = await World.at(temporaryDirectory(t, "paseo-repair-cycle-"));
  const firstId = parseAkumaId("aku/first/1234abcd").id;
  const secondId = parseAkumaId("aku/second/5678abcd").id;
  await bornLineageAkuma({ root: world, akumaName: "first", draw: "1234abcd", createdAt: at,
    caller: { kind: "akuma", world, akumaId: secondId } });
  await bornLineageAkuma({ root: world, akumaName: "second", draw: "5678abcd", createdAt: at,
    caller: { kind: "akuma", world, akumaId: firstId } });
  const transport = createSdkTransport({ entry: resolve("build/src/index.js") });
  t.after(() => transport.close());
  let creates = 0;
  const paseo = createPaseoApi({
    async fetchAgents(options: { signal?: AbortSignal }) {
      assert.ok(options.signal instanceof AbortSignal, "directory reads receive the attachment deadline");
      return { requestId: "list", entries: [], pageInfo };
    },
    async createAgent() { creates++; throw new Error("must not create"); },
  } as unknown as DaemonClient);
  t.after(() => paseo.dispose());
  const warning = t.mock.method(console, "warn", () => {});
  let reads = 0;
  assert.deepEqual(await attach({ world, akuId: firstId }, { paseo }, async (...args) => {
    reads++;
    return transport.status(...args);
  }), { attached: false });
  assert.equal(reads, 2);
  assert.equal(creates, 0);
  assert.match(String(warning.mock.calls[0]?.arguments[0]), /cyclic or excessively deep/u);
});
