import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import pino from "pino";
import { AgentManager } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-manager.js";
import { AgentStorage } from "../node_modules/@getpaseo/server/dist/server/server/agent/agent-storage.js";
import { PluginAgentClientRegistry } from "../node_modules/@getpaseo/server/dist/server/server/agent/plugin-provider.js";
import { PluginHookHandlers } from "../node_modules/@getpaseo/server/dist/server/server/plugins/lifecycle/index.js";
import type { PluginLifecycle } from "../node_modules/@getpaseo/server/dist/server/server/plugins/lifecycle/index.js";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { createProvider } from "../plugins/paseo/plugin/server/provider.js";
import { registerModelCorrection } from "../plugins/paseo/plugin/server/model.js";
import type { AkumaTransport, StatusObservation } from "../plugins/paseo/plugin/server/transport.js";

type Model = { id: string; label: string; isSelectable?: boolean };
type Selection = { activeModelId: string | null; displayModel: string };
type SelectionInput = { models: readonly Model[]; runtimeModelId?: string | null; configuredModelId?: string | null };
const actual = "kimi-coding/k3-256k";
const logger = pino({ level: "silent" });
const emptyHistory = { rows: [], omitted: 0, hasEarlier: false, hasLater: false, historyLost: false, lowestRetained: null, highest: 0 };

async function installedModelResolver(): Promise<(input: SelectionInput) => Selection> {
  const directory = resolve("node_modules/@getpaseo/server/dist/server/web-ui/_expo/static/js/web");
  let file: string | undefined;
  for (const candidate of await readdir(directory)) {
    if (!candidate.endsWith(".js")) continue;
    if ((await readFile(join(directory, candidate), "utf8")).includes("resolveAgentModelSelection=function")) {
      file = candidate;
      break;
    }
  }
  assert.ok(file, "the installed Paseo web bundle contains the model resolver");
  const source = await readFile(join(directory, file), "utf8");
  const line = source.split("\n").find((candidate) => candidate.includes("resolveAgentModelSelection=function"));
  assert.ok(line);
  const exports: Record<string, unknown> = {};
  type Factory = (global: unknown, require: (id: number) => unknown, interop: unknown, module: unknown,
    record: unknown, output: Record<string, unknown>, dependencies: number[]) => void;
  runInNewContext(line, {
    __d(factory: Factory, _id: number, dependencies: number[]) {
      const require = (id: number): unknown => id === 3247
        ? { i18n: { t: (key: string) => key } }
        : id === 4688
          ? { formatThinkingOptionLabel: (option: { id: string; label?: string }) => option.label ?? option.id }
          : id === 4720 ? {} : {};
      factory({}, require, {}, {}, {}, exports, dependencies);
    },
  });
  return exports.resolveAgentModelSelection as (input: SelectionInput) => Selection;
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-model-resolution-"));
  const world = await realpath(directory);
  const alias = join(directory, "alias");
  await symlink(world, alias);
  const statuses = new Map<string, StatusObservation | Error>([
    ["aku/test/known", { provider: "pi", model: actual }],
    ["aku/test/unknown", { provider: "pi" }],
    ["aku/test/failed", new Error("status offline")],
  ]);
  const reads: string[] = [];
  const transport: AkumaTransport = {
    async status(root, akuId) {
      assert.equal(root, world);
      reads.push(akuId);
      const value = statuses.get(akuId) ?? {};
      if (value instanceof Error) throw value;
      return value;
    },
    stream: () => ({ [Symbol.asyncIterator]: () => {
      let first = true;
      return {
        async next() {
          if (first) { first = false; return { done: false as const, value: emptyHistory }; }
          return await new Promise<IteratorResult<typeof emptyHistory>>((_resolve, reject) => {
            reject(new Error("observation released"));
          });
        },
        async return() { return { done: true as const, value: undefined }; },
      };
    } }),
    async tell() { throw new Error("unexpected Tell"); },
    async stop() { throw new Error("unexpected Stop"); },
    async close() {},
  };
  const mirror = createProvider(transport);
  const registry = new PluginAgentClientRegistry(logger);
  registry.replace([mirror.provider]);
  const hooks = new PluginHookHandlers(() => {});
  const removeCorrection = registerModelCorrection(hooks, transport.status);
  const lifecycle = {
    before(name: Parameters<PluginLifecycle["before"]>[0], request: Parameters<PluginLifecycle["before"]>[1]) {
      return hooks.invoke("model-resolution-test", "before", name, request, {} as never);
    },
    emit(name: Parameters<PluginLifecycle["emit"]>[0], event: Parameters<PluginLifecycle["emit"]>[1]) {
      void hooks.invoke("model-resolution-test", "event", name, event, {} as never);
    },
  } as unknown as PluginLifecycle;
  const storage = new AgentStorage(join(directory, "agents"), logger);
  await storage.initialize();
  const manager = new AgentManager({ logger, clients: registry.clients(), providerDefinitions: { keiyaku: { enabled: true } },
    registry: storage, pluginLifecycle: lifecycle });
  const close = async () => {
    manager.prepareForShutdown();
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
    await registry.shutdown();
    await mirror.close();
    removeCorrection();
    hooks.close();
    await manager.flushForShutdown();
    await storage.flush();
    await rm(directory, { recursive: true, force: true });
  };
  return { alias, world, transport, mirror, hooks, manager, storage, close, reads,
    config(akuId: string) {
      return { provider: "keiyaku", model: "mirror", cwd: world, title: "Mirror", systemPrompt: "retained",
        providerOptions: { world: alias, akuId }, };
    },
    async create(akuId: string) {
      return await manager.createAgent(this.config(akuId), undefined, { workspaceId: undefined });
    },
  };
}

test("new mirrors persist the observed model and the installed Paseo resolver displays it with an empty catalog", async (t) => {
  const h = await harness();
  t.after(h.close);
  const resolver = await installedModelResolver();
  assert.equal(resolver({ models: [], runtimeModelId: actual, configuredModelId: "mirror" }).displayModel, "mirror",
    "the rejected empty-catalog-only approach still leaves the placeholder visible");
  const input = { config: h.config("aku/test/known"), env: { RETAINED: "yes" } };
  const transformed = await h.hooks.invoke("model-resolution-test", "before", "agent.create", input, {} as never) as typeof input;
  assert.deepEqual(transformed.config, { ...input.config, model: actual },
    "the hook keeps native provider identity and preserves the other creation configuration");
  const agent = await h.create("aku/test/known");
  assert.equal(agent.config.provider, "keiyaku");
  assert.equal(agent.config.model, actual);
  const stored = await h.storage.get(agent.id);
  assert.ok(stored);
  assert.ok(stored.config);
  assert.equal(stored.config.model, actual);
  assert.equal((await agent.session!.getRuntimeInfo()).model, actual);
  const events: ProviderEvent[] = [];
  const connection = await h.mirror.provider.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message"] });
  connection.onEvent((event) => events.push(event));
  await connection.send({ type: "catalog", requestId: "catalog" });
  assert.deepEqual(events.find((event) => event.type === "catalog")?.catalog, { models: [], modes: [] });
  await connection.close();
  assert.equal(resolver({ models: [], runtimeModelId: actual, configuredModelId: actual }).displayModel, actual);
});

test("unknown and failed observations remove mirror without fallback, and foreign providers pass through", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const h = await harness();
  t.after(h.close);
  const unknown = await h.hooks.invoke("model-resolution-test", "before", "agent.create",
    { config: h.config("aku/test/unknown"), env: {} }, {} as never) as { config: Record<string, unknown> };
  assert.equal(Object.hasOwn(unknown.config, "model"), false);
  const unknownAgent = await h.create("aku/test/unknown");
  assert.equal(unknownAgent.config.model == null, true);
  assert.equal((await unknownAgent.session!.getRuntimeInfo()).model == null, true);
  const failed = await h.hooks.invoke("model-resolution-test", "before", "agent.create", { config: h.config("aku/test/failed"), env: {} }, {} as never) as { config: Record<string, unknown> };
  assert.equal(Object.hasOwn(failed.config, "model"), false);
  const failedAgent = await h.create("aku/test/failed");
  assert.equal(failedAgent.config.model == null, true);
  const before = h.reads.length;
  const foreign = { config: { provider: "pi", cwd: h.world, model: "native" }, env: {} };
  assert.deepEqual(await h.hooks.invoke("model-resolution-test", "before", "agent.create", foreign, {} as never), foreign);
  assert.equal(h.reads.length, before);
  assert.ok(warning.mock.calls.some(({ arguments: args }) => String(args[0]).includes("status offline")));
});
