import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { attach } from "../plugins/paseo/plugin/server/attach.js";
import { createDirectoryIndex } from "../plugins/paseo/plugin/server/directory.js";
import { directorySubscriptions } from "./support/paseo-directory.js";

type Parent = ReturnType<typeof parent>;
const parent = (id: string, provider: string, sessionId: string, metadata?: Record<string, unknown>) => ({
  id, provider: "not-the-persistence-provider", cwd: "/parent/cwd", archivedAt: null as string | null,
  persistence: { provider, sessionId, nativeHandle: "/session/file-not-a-UUID", metadata },
});
async function harness(t: TestContext, pages: Parent[][], refreshed: Parent | null) {
  const world = await mkdtemp(join(tmpdir(), "native-parent-"));
  t.after(() => rm(world, { recursive: true, force: true }));
  const listed: unknown[] = [], fetched: string[] = [], created: unknown[] = [];
  const directory = createDirectoryIndex();
  const stream = directorySubscriptions(async () => ({ requestId: "sub", entries: [],
    pageInfo: { hasMore: true, nextCursor: "partial", prevCursor: null } }));
  t.after(() => directory.close());
  const paseo = createPaseoApi({
    observeAgents: stream.observeAgents,
    async fetchAgents(options: { filter: { statuses?: string[] }; page: { limit: number; cursor?: string }; scope?: string }) {
      listed.push(options);
      assert.deepEqual(options.filter, { includeArchived: true, includeBackground: true, statuses: options.filter.statuses });
      assert.equal(options.scope, undefined, "do not narrow to active agents");
      assert.equal(options.page.limit, 200);
      if (options.filter.statuses?.includes("running")) return { requestId: "list", entries: [],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } };
      const index = options.page.cursor ? Number(options.page.cursor) : 0;
      return { requestId: "list", entries: pages[index]!.map(agent => ({ agent, project: null })),
        pageInfo: { hasMore: index + 1 < pages.length,
          nextCursor: index + 1 < pages.length ? String(index + 1) : null, prevCursor: null } };
    },
    async fetchAgent({ agentId }: { agentId: string }) {
      fetched.push(agentId);
      return refreshed ? { agent: refreshed, project: null } : null;
    },
    getLastServerInfoMessage() { return { serverId: "test-server" }; },
    async createAgent(options: unknown) {
      created.push(options);
      return mirrorParent("child", world, "aku/test/1234abcd");
    },
  } as unknown as DaemonClient);
  const create = t.mock.method(paseo.agents, "create");
  t.after(() => paseo.dispose());
  const run = (integration: string, id = "native-session") => attach({ world, akuId: "aku/test/1234abcd",
    caller: { kind: "external", integration, id } }, { paseo }, directory);
  return { world, run, listed, fetched, created, create, paseo, directory };
}

test("custom Claude provider attaches by native persistence metadata and exact session", async t => {
  const selected = parent("parent", "wwz", "native-session", { provider: "claude" });
  const wrongSession = parent("wrong-session", "wwz", "other-session", { provider: "claude" });
  const wrongNative = parent("wrong-native", "wwz", "native-session", { provider: "codex" });
  const h = await harness(t, [[wrongSession, wrongNative], [selected]], selected);
  assert.deepEqual(await h.run("claude"), { attached: true });
  assert.deepEqual(h.fetched, ["parent"]);
  assert.equal(h.create.mock.calls[0]?.arguments[0]?.parent, "parent");
});

test("custom native identity still refuses ambiguous and changed mappings", async t => {
  const selected = parent("parent", "wwz", "native-session", { provider: "claude" });
  for (const scenario of [
    { name: "duplicate native session", pages: [[selected], [parent("other", "claude", "native-session")]],
      refreshed: selected, reason: /ambiguous claude session/u },
    { name: "native metadata changed on refresh", pages: [[selected]],
      refreshed: parent("parent", "wwz", "native-session", { provider: "codex" }), reason: /changed native identity/u },
    { name: "native metadata lost on refresh", pages: [[selected]],
      refreshed: parent("parent", "wwz", "native-session"), reason: /changed native identity/u },
  ]) await t.test(scenario.name, async t => {
    const h = await harness(t, scenario.pages, scenario.refreshed);
    const warning = t.mock.method(console, "warn", () => {});
    assert.deepEqual(await h.run("claude"), { attached: false });
    assert.equal(h.create.mock.callCount(), 0);
    assert.match(String(warning.mock.calls[0]?.arguments[0]), scenario.reason);
  });
});

async function nestedHarness(t: TestContext, childWorld: string, pages: PaseoAgent[][],
  refreshed: (id: string) => PaseoAgent | null | Promise<PaseoAgent | null>) {
  const listed: unknown[] = [], fetched: string[] = [], created: unknown[] = [];
  const directory = createDirectoryIndex();
  const stream = directorySubscriptions(async () => ({ requestId: "sub", entries: [],
    pageInfo: { hasMore: true, nextCursor: "partial", prevCursor: null } }));
  t.after(() => directory.close());
  const paseo = createPaseoApi({
    observeAgents: stream.observeAgents,
    async fetchAgents(options: { filter: { statuses?: string[] }; page: { limit: number; cursor?: string } }) {
      listed.push(options);
      assert.deepEqual(options.filter, { includeArchived: true, includeBackground: true, statuses: options.filter.statuses });
      if (options.filter.statuses?.includes("running")) return { requestId: "list", entries: [],
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } };
      const index = options.page.cursor ? Number(options.page.cursor) : 0;
      return { requestId: "list", entries: (pages[index] ?? []).map(agent => ({ agent, project: null })),
        pageInfo: { hasMore: index + 1 < pages.length,
          nextCursor: index + 1 < pages.length ? String(index + 1) : null, prevCursor: null } };
    },
    async fetchAgent({ agentId }: { agentId: string }) {
      fetched.push(agentId);
      const agent = await refreshed(agentId);
      return agent ? { agent, project: null } : null;
    },
    getLastServerInfoMessage() { return { serverId: "test-server" }; },
    async createAgent(options: { config?: { providerOptions?: { akuId?: string } } }) {
      created.push(options);
      return mirrorParent("child", childWorld, options.config?.providerOptions?.akuId ?? "aku/child/5678abcd");
    },
  } as unknown as DaemonClient);
  const create = t.mock.method(paseo.agents, "create");
  t.after(() => paseo.dispose());
  return { paseo, listed, fetched, created, create, directory };
}

const mirrorParent = (id: string, world: string, akuId: string, archivedAt: string | null = null) => ({
  id, provider: "keiyaku", cwd: `/cwd/${id}`, model: null, createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z", lastUserMessageAt: null, status: "idle", capabilities: {
    supportsStreaming: false, supportsSessionPersistence: true, supportsDynamicModes: false, supportsMcpServers: false,
    supportsReasoningStream: false, supportsToolInvocations: true,
  }, currentModeId: null, availableModes: [], pendingPermissions: [], persistence: {
    provider: "keiyaku", sessionId: `opaque/${id}`, metadata: { pluginProviderPersistence: { version: 1, data: { world, akuId } } },
  }, title: "untrusted title", archivedAt, labels: {},
} as unknown as PaseoAgent);

test("nested Akuma attaches beneath the unique persisted parent across canonical World aliases", async t => {
  const parentWorld = await mkdtemp(join(tmpdir(), "nested-parent-world-"));
  const childWorld = await mkdtemp(join(tmpdir(), "nested-child-world-"));
  t.after(() => Promise.all([rm(parentWorld, { recursive: true, force: true }), rm(childWorld, { recursive: true, force: true })]));
  const alias = join(tmpdir(), `nested-parent-alias-${process.pid}-${Date.now()}`);
  await symlink(parentWorld, alias);
  t.after(() => rm(alias, { force: true }));
  const parentId = "aku/parent/1234abcd", childId = "aku/child/5678abcd";
  const matching = mirrorParent("parent-mirror", parentWorld, parentId);
  const directory = [mirrorParent("wrong-world", childWorld, parentId), ...Array.from({ length: 3497 }, (_, index) =>
    parent(`unrelated-${index}`, "pi", `unrelated-${index}`) as unknown as PaseoAgent), matching];
  const pages = Array.from({ length: Math.ceil(directory.length / 200) }, (_, index) => directory.slice(index * 200, (index + 1) * 200));
  const h = await nestedHarness(t, childWorld, pages, id => id === matching.id ? matching : null);
  assert.deepEqual(await attach({ world: childWorld, akuId: childId,
    caller: { kind: "akuma", world: alias, akuId: parentId } }, { paseo: h.paseo }, h.directory), { attached: true });
  assert.equal(h.listed.length, 19, "complete hot and remaining partitions for the 3499-entry directory");
  assert.deepEqual(h.fetched, ["parent-mirror"]);
  const canonicalChild = await realpath(childWorld);
  assert.deepEqual(h.create.mock.calls[0]?.arguments[0], {
    parent: "parent-mirror", cwd: "/cwd/parent-mirror", title: childId,
    config: { provider: "keiyaku/mirror", options: { world: canonicalChild, akuId: childId } },
    idempotencyKey: `keiyaku:${canonicalChild}:${childId}`,
  });
});

test("nested attachment refuses missing, ambiguous, archived, changed, or unreadable parents", async t => {
  const parentWorld = await mkdtemp(join(tmpdir(), "nested-parent-world-"));
  const childWorld = await mkdtemp(join(tmpdir(), "nested-child-world-"));
  t.after(() => Promise.all([rm(parentWorld, { recursive: true, force: true }), rm(childWorld, { recursive: true, force: true })]));
  const parentId = "aku/parent/1234abcd", childId = "aku/child/5678abcd";
  const selected = mirrorParent("parent-mirror", parentWorld, parentId);
  const archived = mirrorParent("archived-mirror", parentWorld, parentId, "2026-10-15T00:00:00Z");
  const scenarios: Array<{ name: string; pages: PaseoAgent[][]; refreshed: (id: string) => PaseoAgent | null | Promise<PaseoAgent | null>; reason: RegExp }> = [
    { name: "missing", pages: [[]], refreshed: () => null, reason: /no mirror for Akuma parent/u },
    { name: "ambiguous including archived mapping", pages: [[selected], [archived]], refreshed: () => selected, reason: /ambiguous Akuma parent/u },
    { name: "archived", pages: [[archived]], refreshed: () => archived, reason: /is archived/u },
    { name: "disappeared on refresh", pages: [[selected]], refreshed: () => null, reason: /does not exist/u },
    { name: "changed identity on refresh", pages: [[selected]], refreshed: () => mirrorParent("parent-mirror", parentWorld, "aku/other/1234abcd"), reason: /changed identity/u },
    { name: "unreadable refresh", pages: [[selected]], refreshed: () => { throw new Error("parent read failed"); }, reason: /parent read failed/u },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const h = await nestedHarness(t, childWorld, scenario.pages, scenario.refreshed);
    const warning = t.mock.method(console, "warn", () => {});
    assert.deepEqual(await attach({ world: childWorld, akuId: childId,
      caller: { kind: "akuma", world: parentWorld, akuId: parentId } }, { paseo: h.paseo }, h.directory), { attached: false });
    assert.equal(h.created.length, 0);
    assert.equal(h.create.mock.callCount(), 0);
    assert.equal(warning.mock.callCount(), 1);
    assert.match(String(warning.mock.calls[0]?.arguments[0]), scenario.reason);
  });
});

test("incomplete attachment directory cannot authorize creation even with a matching native parent", async t => {
  const selected = parent("parent", "pi", "native-session");
  const h = await harness(t, [[selected]], selected);
  const originalList = h.paseo.agents.list.bind(h.paseo.agents);
  t.mock.method(h.paseo.agents, "list", (options: Parameters<typeof originalList>[0]) => options?.subscribe ? originalList({ ...options, subscribe: {} }) : Promise.resolve({ requestId: "list",
    entries: [{ agent: selected as unknown as PaseoAgent, project: null }],
    pageInfo: { hasMore: true, nextCursor: null, prevCursor: null } }));
  const warning = t.mock.method(console, "warn", () => {});
  assert.deepEqual(await h.run("pi"), { attached: false });
  assert.equal(h.created.length, 0);
  assert.deepEqual(h.fetched, []);
  assert.match(String(warning.mock.calls[0]?.arguments[0]), /incomplete Paseo agent directory pagination/u);
});

test("existing detached and archived child mappings suppress creation and parent lookup", async t => {
  const world = await mkdtemp(join(tmpdir(), "existing-child-world-"));
  t.after(() => rm(world, { recursive: true, force: true }));
  const akuId = "aku/child/5678abcd";
  for (const archivedAt of [null, "2026-11-01T00:00:00Z"]) {
    const existing = mirrorParent("existing-child", world, akuId, archivedAt);
    const h = await nestedHarness(t, world, [[existing]], () => existing);
    assert.deepEqual(await attach({ world, akuId,
      caller: { kind: "external", integration: "pi", id: "new-parent" } }, { paseo: h.paseo }, h.directory), { attached: true });
    assert.equal(h.created.length, 0);
    assert.deepEqual(h.fetched, ["existing-child"]);
  }
});

test("Paseo and unknown external callers do not attach, even when their ID names a host agent", async t => {
  const selected = parent("legacy-parent", "pi", "native-session");
  const h = await harness(t, [[selected]], selected);
  const warning = t.mock.method(console, "warn", () => {});
  for (const integration of ["paseo", "other"]) {
    assert.deepEqual(await h.run(integration, "legacy-parent"), { attached: false });
  }
  assert.deepEqual(h.fetched, []);
  assert.equal(h.created.length, 0);
  assert.equal(warning.mock.callCount(), 2);
  assert.match(String(warning.mock.calls[0]?.arguments[0]), /unsupported caller integration paseo/u);
});
