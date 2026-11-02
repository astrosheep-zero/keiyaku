import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPaseoApi, type PaseoAgent } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { attach } from "../plugins/paseo/plugin/server/attach.js";

type Parent = ReturnType<typeof parent>;
const parent = (id: string, provider: string, sessionId: string) => ({
  id, provider: "not-the-persistence-provider", cwd: "/parent/cwd", archivedAt: null as string | null,
  persistence: { provider, sessionId, nativeHandle: "/session/file-not-a-UUID" },
});
async function harness(t: TestContext, pages: Parent[][], refreshed: Parent | null) {
  const world = await mkdtemp(join(tmpdir(), "native-parent-"));
  t.after(() => rm(world, { recursive: true, force: true }));
  const listed: unknown[] = [], fetched: string[] = [], created: unknown[] = [];
  const paseo = createPaseoApi({
    async fetchAgents(options: { filter: unknown; page: { limit: number; cursor?: string }; scope?: string }) {
      listed.push(options);
      assert.deepEqual(options.filter, { includeArchived: true });
      assert.equal(options.scope, undefined, "do not narrow to active agents");
      assert.equal(options.page.limit, 200);
      const index = options.page.cursor ? Number(options.page.cursor) : 0;
      assert.equal(index, listed.length - 1);
      return { requestId: "list", entries: pages[index]!.map(agent => ({ agent, project: null })),
        pageInfo: { hasMore: index + 1 < pages.length,
          nextCursor: index + 1 < pages.length ? String(index + 1) : null, prevCursor: null } };
    },
    async fetchAgent({ agentId }: { agentId: string }) {
      fetched.push(agentId);
      return refreshed ? { agent: refreshed, project: null } : null;
    },
    getLastServerInfoMessage() { return { serverId: "test-server" }; },
    async createAgent(options: unknown) { created.push(options); return { id: "child", cwd: world }; },
  } as unknown as DaemonClient);
  const create = t.mock.method(paseo.agents, "create");
  t.after(() => paseo.dispose());
  const run = (integration: string, id = "native-session") => attach({ world, akuId: "aku/test/1234abcd",
    caller: { kind: "external", integration, id } }, { paseo });
  return { world, run, listed, fetched, created, create, paseo };
}

test("native parents match exact persistence provider/sessionId across every directory page, then refresh", async t => {
  for (const provider of ["codex", "pi", "claude"]) await t.test(provider, async t => {
    const selected = parent("parent", provider, "native-session");
    const wrongProvider = parent("wrong-provider", "other", "native-session");
    const handleOnly = parent("handle-only", provider, "another-session");
    handleOnly.persistence.nativeHandle = "native-session";
    const h = await harness(t, [[wrongProvider, handleOnly], [selected], []], selected);
    assert.deepEqual(await h.run(provider), { attached: true });
    assert.equal(h.listed.length, 3, "finish enumeration even after a first match");
    assert.deepEqual(h.fetched, ["parent"]);
    const world = await realpath(h.world);
    assert.deepEqual(h.created, [{
      config: { provider: "keiyaku", model: "mirror", cwd: "/parent/cwd", title: "aku/test/1234abcd",
        providerOptions: { world, akuId: "aku/test/1234abcd" } },
      callerAgentId: "parent", idempotencyKey: `keiyaku:${world}:aku/test/1234abcd`, labels: {},
    }]);
    assert.equal(h.create.mock.calls[0]?.arguments[0]?.title, "aku/test/1234abcd",
      "the public SDK call carries the full Akuma identity as its title");
  });
});

async function nestedHarness(t: TestContext, childWorld: string, pages: PaseoAgent[][],
  refreshed: (id: string) => PaseoAgent | null | Promise<PaseoAgent | null>) {
  const listed: unknown[] = [], fetched: string[] = [], created: unknown[] = [];
  const paseo = createPaseoApi({
    async fetchAgents(options: { filter: unknown; page: { limit: number; cursor?: string } }) {
      listed.push(options);
      assert.deepEqual(options.filter, { includeArchived: true, includeBackground: true });
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
    async createAgent(options: unknown) { created.push(options); return { id: "child", cwd: childWorld }; },
  } as unknown as DaemonClient);
  const create = t.mock.method(paseo.agents, "create");
  t.after(() => paseo.dispose());
  return { paseo, listed, fetched, created, create };
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
  const h = await nestedHarness(t, childWorld,
    [[mirrorParent("wrong-world", childWorld, parentId)], [matching]], id => id === matching.id ? matching : null);
  assert.deepEqual(await attach({ world: childWorld, akuId: childId,
    caller: { kind: "akuma", world: alias, akuId: parentId } }, { paseo: h.paseo }), { attached: true });
  assert.equal(h.listed.length, 2, "finish the public directory traversal");
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
    { name: "unreadable refresh", pages: [[selected]], refreshed: () => { throw new Error("parent read failed"); }, reason: /could not be read: parent read failed/u },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const h = await nestedHarness(t, childWorld, scenario.pages, scenario.refreshed);
    const warning = t.mock.method(console, "warn", () => {});
    assert.deepEqual(await attach({ world: childWorld, akuId: childId,
      caller: { kind: "akuma", world: parentWorld, akuId: parentId } }, { paseo: h.paseo }), { attached: false });
    assert.equal(h.created.length, 0);
    assert.equal(h.create.mock.callCount(), 0);
    assert.equal(warning.mock.callCount(), 1);
    assert.match(String(warning.mock.calls[0]?.arguments[0]), scenario.reason);
  });
});

test("missing, duplicate (including archived), archived and stale parent mappings diagnose non-attachment", async t => {
  const selected = parent("parent", "pi", "native-session");
  const archived = { ...selected, id: "archived", archivedAt: "2026-10-15T00:00:00Z" };
  for (const scenario of [
    { name: "missing", pages: [[]], refreshed: null, reason: /no parent for pi session/u, refreshes: 0 },
    { name: "duplicate on later page", pages: [[selected], [archived]], refreshed: selected,
      reason: /ambiguous pi session/u, refreshes: 0 },
    { name: "archived", pages: [[archived]], refreshed: archived, reason: /is archived/u, refreshes: 1 },
    { name: "disappeared", pages: [[selected]], refreshed: null, reason: /does not exist/u, refreshes: 1 },
    { name: "changed ID", pages: [[selected]], refreshed: parent("parent", "pi", "new-session"),
      reason: /changed native identity/u, refreshes: 1 },
    { name: "changed provider", pages: [[selected]], refreshed: parent("parent", "claude", "native-session"),
      reason: /changed native identity/u, refreshes: 1 },
  ]) await t.test(scenario.name, async t => {
    const h = await harness(t, scenario.pages, scenario.refreshed);
    const warning = t.mock.method(console, "warn", () => {});
    assert.deepEqual(await h.run("pi"), { attached: false });
    assert.equal(h.created.length, 0);
    assert.equal(h.fetched.length, scenario.refreshes);
    assert.equal(warning.mock.callCount(), 1);
    assert.match(String(warning.mock.calls[0]?.arguments[0]), scenario.reason);
  });
});

test("attachment no longer synchronizes outside the registration handoff", async t => {
  const h = await harness(t, [], parent("parent", "pi", "native-session"));
  const input = { world: h.world, akuId: "aku/test/1234abcd",
    caller: { kind: "external" as const, integration: "paseo", id: "parent" } };
  assert.deepEqual(await attach(input, { paseo: h.paseo }), { attached: true });
  assert.equal(h.created.length, 1);
  t.mock.method(h.paseo.agents, "create", async () => { throw new Error("creation failed"); });
  await assert.rejects(attach(input, { paseo: h.paseo }), /creation failed/u);
  assert.equal(h.created.length, 1);
});

test("legacy Paseo IDs retain direct lookup without the native directory; archive still refuses", async t => {
  const selected = parent("legacy-parent", "pi", "native-session");
  const h = await harness(t, [], selected);
  assert.deepEqual(await h.run("paseo", "legacy-parent"), { attached: true });
  assert.equal(h.listed.length, 0);
  assert.deepEqual(h.fetched, ["legacy-parent"]);
  selected.archivedAt = "2026-10-15T00:00:00Z";
  const warning = t.mock.method(console, "warn", () => {});
  assert.deepEqual(await h.run("paseo", "legacy-parent"), { attached: false });
  assert.equal(h.created.length, 1);
  assert.match(String(warning.mock.calls[0]?.arguments[0]), /is archived/u);
});
