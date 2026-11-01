import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { refreshOrReopen } from "../plugins/paseo/plugin/server/reopen.js";

const snapshot = (id: string, world: string, akuId: string, archivedAt: string | null = null): PaseoAgent => ({
  id, provider: "keiyaku", cwd: world, model: null, createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z", lastUserMessageAt: null, status: "idle", capabilities: {
    supportsStreaming: false, supportsSessionPersistence: true, supportsDynamicModes: false, supportsMcpServers: false,
    supportsReasoningStream: false, supportsToolInvocations: true,
  }, currentModeId: null, availableModes: [], pendingPermissions: [], persistence: {
    provider: "keiyaku", sessionId: `opaque/${id}`, metadata: { pluginProviderPersistence: { version: 1, data: { world, akuId } } },
  }, title: "untrusted title", archivedAt, labels: {},
});

async function harness(t: TestContext, options: {
  pages?: PaseoAgent[][];
  refreshed?: (id: string) => PaseoAgent | null;
  afterRefetch?: (id: string) => PaseoAgent | null;
  blockRefetch?: Promise<void>;
  timelineError?: string | null;
} = {}, worldPath?: string) {
  const world = worldPath ?? await mkdtemp(join(tmpdir(), "paseo-reopen-"));
  t.after(() => rm(world, { recursive: true, force: true }));
  const listed: unknown[] = [], refreshed: string[] = [], refetched: Array<[string, number | undefined]> = [];
  let refetchStartedResolve!: () => void;
  const refetchStarted = new Promise<void>(resolve => { refetchStartedResolve = resolve; });
  const defaultAgent = snapshot("mirror", world, "aku/test/1");
  const pages = options.pages ?? [[defaultAgent]];
  const optionsForTest = options;
  const client = {
    getLastServerInfoMessage() { return { serverId: "test-server" }; },
    async fetchAgents(input: { filter?: unknown; page?: { cursor?: string; limit?: number } }) {
      listed.push(input);
      const index = input.page?.cursor ? Number(input.page.cursor) : 0;
      return { requestId: "list", entries: (pages[index] ?? []).map(agent => ({ agent, project: null })),
        pageInfo: { hasMore: index + 1 < pages.length, nextCursor: index + 1 < pages.length ? String(index + 1) : null, prevCursor: null } };
    },
    async fetchAgent(input: { agentId: string }) {
      refreshed.push(input.agentId);
      const agent = optionsForTest.refreshed ? optionsForTest.refreshed(input.agentId) : defaultAgent;
      return agent ? { agent, project: null } : null;
    },
    async fetchAgentTimeline(agentId: string, options?: { limit?: number }) {
      refetched.push([agentId, options?.limit]);
      refetchStartedResolve();
      await optionsForTest.blockRefetch;
      const agent = optionsForTest.afterRefetch ? optionsForTest.afterRefetch(agentId) : defaultAgent;
      return { requestId: "timeline", agentId, agent, entries: [], error: optionsForTest.timelineError ?? null,
        pageInfo: { hasMore: false, nextCursor: null } };
    },
  } as unknown as DaemonClient;
  const paseo = createPaseoApi(client);
  t.after(() => paseo.dispose());
  const refreshLocal = async () => ({ woken: 0 });
  return { world, paseo, listed, refreshed, refetched, refreshLocal, refetchStarted };
}

test("refresh reopens only the canonical persisted mirror through a zero-item read-only timeline fetch", async t => {
  const h = await harness(t);
  assert.deepEqual(await refreshOrReopen(h.paseo, { world: h.world, akuId: "aku/test/1" }, h.refreshLocal), { woken: 1 });
  assert.deepEqual(h.listed.map(value => (value as { filter: unknown }).filter), [{ includeArchived: true, includeBackground: true }]);
  assert.deepEqual(h.refreshed, ["mirror"]);
  assert.deepEqual(h.refetched, [["mirror", 0]]);
});

test("a persisted mirror from another real World is not reopened", async t => {
  const otherWorld = await mkdtemp(join(tmpdir(), "paseo-reopen-other-world-"));
  t.after(() => rm(otherWorld, { recursive: true, force: true }));
  const h = await harness(t);
  const matching = snapshot("mirror", h.world, "aku/test/1");
  t.mock.method(h.paseo.agents, "list", async () => ({ requestId: "list",
    entries: [snapshot("foreign-world", otherWorld, "aku/test/1"), matching].map(agent => ({ agent, project: null })),
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }));
  assert.deepEqual(await refreshOrReopen(h.paseo, { world: h.world, akuId: "aku/test/1" }, h.refreshLocal), { woken: 1 });
  assert.deepEqual(h.refreshed, ["mirror"]);
  assert.deepEqual(h.refetched, [["mirror", 0]]);
});

test("directory pagination must complete before any candidate can be reopened", async t => {
  const h = await harness(t);
  const warning = t.mock.method(console, "warn", () => {});
  // Make the directory claim another page without providing a usable cursor.
  t.mock.method(h.paseo.agents, "list", async () => ({ requestId: "list",
    entries: [{ agent: snapshot("mirror", h.world, "aku/test/1"), project: null }],
    pageInfo: { hasMore: true, nextCursor: null, prevCursor: null } }));
  assert.deepEqual(await refreshOrReopen(h.paseo, { world: h.world, akuId: "aku/test/1" }, h.refreshLocal), { woken: 0 });
  assert.equal(h.refreshed.length, 0);
  assert.equal(h.refetched.length, 0);
  assert.match(String(warning.mock.calls[0]?.arguments[0]), /incomplete Paseo agent directory pagination/u);
});


test("archived, disappeared, changed and concurrently archived mappings are refused", async t => {
  const scenarios: Array<{ label: string; setup: (world: string) => Parameters<typeof harness>[1]; refetches: number }> = [
    { label: "archived in listing", setup: world => ({ pages: [[snapshot("mirror", world, "aku/test/1", "now")]] }), refetches: 0 },
    { label: "disappeared on refresh", setup: () => ({ refreshed: () => null }), refetches: 0 },
    { label: "changed identity on refresh", setup: world => ({ refreshed: () => snapshot("mirror", world, "aku/other/2") }), refetches: 0 },
    { label: "archived after timeline read", setup: world => ({ afterRefetch: () => snapshot("mirror", world, "aku/test/1", "now") }), refetches: 1 },
    { label: "changed after timeline read", setup: world => ({ afterRefetch: () => snapshot("mirror", world, "aku/other/2") }), refetches: 1 },
    { label: "timeline read error", setup: () => ({ timelineError: "timeline unavailable" }), refetches: 1 },
  ];
  for (const scenario of scenarios) await t.test(scenario.label, async t => {
    const world = await mkdtemp(join(tmpdir(), "paseo-reopen-case-"));
    const h = await harness(t, scenario.setup(world), world);
    assert.deepEqual(await refreshOrReopen(h.paseo, { world: h.world, akuId: "aku/test/1" }, h.refreshLocal), { woken: 0 });
    assert.equal(h.refetched.length, scenario.refetches);
  });
});

test("unversioned and incorrectly shaped provider metadata is never treated as mirror identity", async t => {
  const h = await harness(t);
  const good = snapshot("mirror", h.world, "aku/test/1");
  const wrongShape = { ...good, id: "flat", persistence: { ...good.persistence!, metadata: { world: h.world, akuId: "aku/test/1" } } };
  const wrongVersion = { ...good, id: "v2", persistence: { ...good.persistence!, metadata: {
    pluginProviderPersistence: { version: 2, data: { world: h.world, akuId: "aku/test/1" } },
  } } };
  t.mock.method(h.paseo.agents, "list", async () => ({ requestId: "list",
    entries: [wrongShape, wrongVersion].map(agent => ({ agent, project: null })),
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }));
  assert.deepEqual(await refreshOrReopen(h.paseo, { world: h.world, akuId: "aku/test/1" }, h.refreshLocal), { woken: 0 });
  assert.deepEqual(h.refreshed, []);
  assert.deepEqual(h.refetched, []);
});

test("concurrent refreshes coalesce reopening the same exact agent", { timeout: 5_000 }, async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const h = await harness(t, { blockRefetch: blocked });
  const first = refreshOrReopen(h.paseo, { world: h.world, akuId: "aku/test/1" }, h.refreshLocal);
  const second = refreshOrReopen(h.paseo, { world: h.world, akuId: "aku/test/1" }, h.refreshLocal);
  t.after(release);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([h.refetchStarted, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("timeline refetch did not start")), 2_000);
    })]);
    assert.equal(h.refetched.length, 1);
  } finally {
    if (deadline) clearTimeout(deadline);
    release();
  }
  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(results.map(result => result.status === "fulfilled" ? result.value : undefined), [{ woken: 1 }, { woken: 1 }]);
});

test("an already open local mirror wakes without enumerating persisted agents", async t => {
  const h = await harness(t);
  assert.deepEqual(await refreshOrReopen(h.paseo, { world: h.world, akuId: "aku/test/1" }, async () => ({ woken: 1 })), { woken: 1 });
  assert.deepEqual(h.listed, []);
});
