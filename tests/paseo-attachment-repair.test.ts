import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import "./support/local-public-package.js";
import { World } from "../src/index.js";
import { bornLineageAkuma } from "./support/akuma-fixtures.js";
import { temporaryDirectory } from "./support/process.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { createSdkTransport } from "../plugins/paseo/plugin/server/sdk.js";
import { attach } from "../plugins/paseo/plugin/server/attach.js";
const { createForwarder } = await import("../plugins/paseo/forwarder/index.js");

const at = "2026-11-11T00:00:00.000Z";
const pageInfo = { hasMore: false, nextCursor: null, prevCursor: null };

test("execution refresh repairs missing mirrors and parents using retained callers through the public SDK", { timeout: 10_000 }, async t => {
  const world = await World.at(temporaryDirectory(t, "paseo-repair-"));
  await writeFile(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
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
  const rpc: string[] = [];
  const client = {
    getLastServerInfoMessage() { return { serverId: "isolated-test" }; },
    async fetchAgents() { return { requestId: "list", entries: [...agents.values()].map(agent => ({ agent, project: null })), pageInfo }; },
    async fetchAgent({ agentId }: { agentId: string }) { const agent = agents.get(agentId); return agent ? { agent, project: null } : null; },
    async createAgent(options: Parameters<DaemonClient["createAgent"]>[0]) {
      const target = options.config!.providerOptions as { world: string; akuId: string };
      const status = await transport.status(target.world, target.akuId, t.signal);
      assert.ok(status.caller);
      const stream = transport.stream(target.world, target.akuId, t.signal)[Symbol.asyncIterator]();
      await stream.next();
      await stream.return?.();
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
  const started = { kind: "akuma.turn-started" as const, akumaId: child.id, turnSequence: 1 };
  await Promise.all([signals?.["akuma.turn-started"]?.(started), signals?.["akuma.turn-started"]?.(started)]);
  assert.deepEqual(parents, [[parent.id, "host"], [child.id, "mirror-0"]]);
  assert.equal(rpc.filter(method => method === "attach").length, 2);
  assert.equal(rpc.filter(method => method === "refresh").length, 2);
  await signals?.["akuma.turn-outcome"]?.({ ...started, kind: "akuma.turn-outcome", bodySequence: 1,
    outcome: { kind: "answered", text: "done" } });
  await signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: child.id, bodySequence: 1, end: "exited" });
  assert.equal(creations.size, 2, "repeated execution refreshes reuse the same parent and child mirrors");
});

test("retained caller cycles terminate without pending-ensure deadlock or invented parents", { timeout: 5000 }, async t => {
  const world = await World.at(temporaryDirectory(t, "paseo-repair-cycle-"));
  await writeFile(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
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
      assert.ok(options.signal instanceof AbortSignal);
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
