import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPaseoApi } from "@getpaseo/client";
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
      assert.deepEqual(options.filter, { includeArchived: true, includeBackground: true });
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
    async createAgent(options: unknown) { created.push(options); return { id: "child", cwd: world }; },
  } as unknown as DaemonClient);
  t.after(() => paseo.dispose());
  const run = (integration: string, id = "native-session") => attach({ world, akuId: "aku/test/1234abcd",
    caller: { kind: "external", integration, id } }, { paseo });
  return { world, run, listed, fetched, created };
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
      config: { provider: "keiyaku", model: "mirror", cwd: "/parent/cwd",
        providerOptions: { world, akuId: "aku/test/1234abcd" } },
      callerAgentId: "parent", idempotencyKey: `keiyaku:${world}:aku/test/1234abcd`,
    }]);
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
