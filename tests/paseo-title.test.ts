import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { backfillMirrorTitles, createForwarder, syncMirrorTitles } from "../plugins/paseo/forwarder/index.js";
import { attach } from "../plugins/paseo/plugin/server/attach.js";
import { World } from "../src/world.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkuId } from "../src/akuma/identity.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import type { PluginContext } from "../src/plugin/public.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "paseo-titles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const world = await World.at(root);
  const alias = join(root, "alias"); await symlink(world, alias);
  const bind = (name: string, id: string) => moveAlias({ world, alias: parseAkumaAlias(`@${name}`), akuId: parseAkuId(id).id });
  return { world, alias, bind };
}
function snapshot(id: string, world: string, akuId: string, title: string | null) {
  return { id, provider: "keiyaku", title, persistence: { provider: "keiyaku", sessionId: "opaque-do-not-decode",
    metadata: { pluginProviderPersistence: { version: 1, data: { world, akuId } } } } } as unknown as AgentSnapshotPayload;
}
const pageInfo = { hasMore: false, nextCursor: null, prevCursor: null };

test("new alias/no-alias mirrors and mutable aliases preserve the daemon creation fingerprint", async t => {
  for (const initiallyAliased of [true, false]) await t.test(initiallyAliased ? "aliased" : "bare", async t => {
    const h = await fixture(t), akuId = "aku/elite/1234abcd", other = "aku/elite/8765abcd";
    if (initiallyAliased) await h.bind("reviewer", akuId);
    let child: AgentSnapshotPayload | undefined;
    let fingerprint: string | undefined, creates = 0;
    const renames: string[] = [];
    const wire: Parameters<DaemonClient["createAgent"]>[0][] = [];
    const client = {
      async fetchAgent() { return { agent: { id: "parent", cwd: h.world, archivedAt: null }, project: null }; },
      async fetchAgents() { return { entries: child ? [{ agent: child, project: null }] : [], pageInfo }; },
      async createAgent(options: Parameters<DaemonClient["createAgent"]>[0]) {
        const request = JSON.stringify(options);
        if (fingerprint !== undefined) assert.equal(request, fingerprint, "changed idempotent payload would conflict");
        else { fingerprint = request; creates++; child = snapshot("mirror", h.world, akuId, options.config?.title ?? null); }
        wire.push(options);
        return child!;
      },
      async updateAgent(id: string, update: { name?: string }) {
        assert.equal(id, child!.id); child!.title = update.name!; renames.push(update.name!);
      },
      async invokePluginRpc(_plugin: string, method: string, input: unknown) {
        return method === "attach" ? await attach(input as Parameters<typeof attach>[0], { paseo }, async () => {}) : { woken: 0 };
      },
      async close() {},
    };
    const paseo = createPaseoApi(client as unknown as DaemonClient);
    t.after(() => paseo.dispose());
    const forwarder = createForwarder(async () => client as unknown as DaemonClient);
    const { signals } = await forwarder.activate({ world: h.alias as PluginContext["world"], config: undefined,
      writablePath() { throw new Error("no plugin storage"); } });
    const born = { kind: "akuma.born" as const, akumaId: akuId, bodySequence: 1, origin: { kind: "direct" as const },
      caller: { kind: "external" as const, integration: "paseo", id: "parent" } };
    await signals?.["akuma.born"]?.(born);
    assert.equal(child!.title, initiallyAliased ? `${akuId} (reviewer)` : akuId);
    await h.bind("reviewer", akuId);
    await h.bind("audit", akuId);
    await signals?.["akuma.born"]?.(born);
    assert.equal(child!.title, `${akuId} (audit, reviewer)`);
    await h.bind("reviewer", other); await h.bind("audit", other);
    await signals?.["akuma.turn-outcome"]?.({ kind: "akuma.turn-outcome", akumaId: akuId, bodySequence: 1,
      turnSequence: 1, outcome: { kind: "answered", text: "done" } });
    assert.equal(child!.title, `${akuId} (audit, reviewer)`, "runtime refresh never does title work");
    assert.equal(await syncMirrorTitles(client as unknown as DaemonClient, h.alias, akuId), 1);
    assert.equal(child!.title, akuId, "explicit backfill removes aliases moved away");
    await signals?.["akuma.born"]?.(born);
    assert.equal(creates, 1);
    assert.equal(wire.length, 3);
    for (const input of wire) {
      assert.equal(input.config?.title, akuId, "create is always bare ID, even after rename");
      assert.equal(input.idempotencyKey, `keiyaku:${h.world}:${akuId}`);
    }
    assert.deepEqual(renames, [...(initiallyAliased ? [`${akuId} (reviewer)`] : []), `${akuId} (audit, reviewer)`, akuId]);
  });
});

test("one-shot backfill renames only exact world mirrors, enumerating all pages before changing titles", async t => {
  const h = await fixture(t), akuId = "aku/elite/1234abcd", bare = "aku/intern/1234abcd";
  await h.bind("reviewer", akuId);
  const agents = [snapshot("old", h.world, akuId, "old truncated title"), snapshot("bare", h.world, bare, "old (stale)"),
    snapshot("archived", h.world, akuId, "old archived title"), snapshot("foreign", `${h.world}/other`, akuId, "leave alone"),
    { ...snapshot("other-provider", h.world, akuId, "leave alone"), provider: "pi" },
    { ...snapshot("unknown-metadata", h.world, akuId, "leave alone"), persistence: { provider: "keiyaku", sessionId: "opaque" } }];
  let lists = 0;
  const updates: unknown[] = [];
  const client = {
    async fetchAgents(options: { filter?: unknown; page?: { cursor?: string } }) {
      lists++;
      assert.deepEqual(options.filter, { includeArchived: true });
      const second = options.page?.cursor === "second";
      return { entries: agents.slice(second ? 2 : 0, second ? undefined : 2).map(agent => ({ agent, project: null })),
        pageInfo: { ...pageInfo, hasMore: !second, nextCursor: second ? null : "second" } };
    },
    async updateAgent(id: string, update: { name?: string }) {
      assert.equal(lists % 2, 0, "do not reorder directory while paginating");
      updates.push([id, update]); agents.find(agent => agent.id === id)!.title = update.name!;
    },
  } as unknown as Pick<DaemonClient, "fetchAgents" | "updateAgent">;
  assert.equal(await syncMirrorTitles(client, h.alias), 3);
  assert.deepEqual(updates, [["old", { name: `${akuId} (reviewer)` }], ["bare", { name: bare }],
    ["archived", { name: `${akuId} (reviewer)` }]]);
  assert.equal(await syncMirrorTitles(client, h.world), 0, "correct titles do not produce redundant mutations");
  assert.equal(updates.length, 3);
  await writeFile(join(h.world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  await assert.rejects(syncMirrorTitles(client, h.world), /Keiyaku aliases unavailable/u);
  assert.equal(updates.length, 3, "unavailable aliases never erase known titles");
});

test("AkuId-filtered backfill leaves another mirror in the same World unchanged", async t => {
  const h = await fixture(t), selected = "aku/elite/1234abcd", other = "aku/elite/8765abcd";
  await h.bind("reviewer", selected); await h.bind("other", other);
  const agents = [snapshot("selected", h.world, selected, "old selected title"),
    snapshot("other", h.world, other, "other customized title")];
  const updates: unknown[] = [];
  const client = {
    async fetchAgents() { return { entries: agents.map(agent => ({ agent, project: null })), pageInfo }; },
    async updateAgent(id: string, update: { name?: string }) { updates.push([id, update]); },
  } as unknown as DaemonClient;
  assert.equal(await syncMirrorTitles(client, h.world, selected), 1);
  assert.deepEqual(updates, [["selected", { name: `${selected} (reviewer)` }]]);
  assert.equal(agents[1]!.title, "other customized title");
});

test("failed owned title attempts preserve the successful attach and cached runtime client", async t => {
  const h = await fixture(t), akuId = "aku/elite/1234abcd";
  let opens = 0, runtimeCloses = 0, titleCloses = 0, refreshes = 0;
  const warning = t.mock.method(console, "warn", () => {});
  const runtime = {
    async invokePluginRpc(_plugin: string, method: string) {
      if (method === "attach") return { attached: true };
      refreshes++; return { woken: 1 };
    },
    async fetchAgents() { throw new Error("runtime client must not scan titles"); },
    async updateAgent() { throw new Error("runtime client must not rename"); },
    async close() { runtimeCloses++; },
  } as unknown as DaemonClient;
  const title = {
    async fetchAgents() { return { entries: [{ agent: snapshot("mirror", h.world, akuId, "old"), project: null }], pageInfo }; },
    async updateAgent() { throw new Error("rename unavailable"); },
    async close() { titleCloses++; },
  } as unknown as DaemonClient;
  const { signals } = await createForwarder(async () => (++opens === 1 ? runtime : title)).activate({
    world: h.world, config: undefined, writablePath() { throw new Error("no storage"); },
  });
  await signals?.["akuma.born"]?.({ kind: "akuma.born", akumaId: akuId, bodySequence: 1, origin: { kind: "direct" },
    caller: { kind: "external", integration: "paseo", id: "parent" } });
  assert.equal(titleCloses, 1, "the title attempt is closed before born delivery returns");
  assert.equal(runtimeCloses, 0, "rename failure does not close the successful attach connection");
  assert.equal(warning.mock.callCount(), 1);
  assert.match(String(warning.mock.calls[0]?.arguments[0]), /attached, but title synchronization failed: rename unavailable/u);
  await signals?.["akuma.turn-started"]?.({ kind: "akuma.turn-started", akumaId: akuId, turnSequence: 1 });
  await signals?.["akuma.turn-outcome"]?.({ kind: "akuma.turn-outcome", akumaId: akuId, bodySequence: 1,
    turnSequence: 1, outcome: { kind: "answered", text: "done" } });
  assert.equal(opens, 2, "refreshes reuse the original runtime connection without opening title connections");
  assert.equal(refreshes, 2);
  await signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: akuId, bodySequence: 1, end: "exited" });
  assert.equal(runtimeCloses, 1, "Body end still owns normal runtime cleanup");
});

test("canceling a title attempt closes and drains its owned in-flight rename before returning", async t => {
  const h = await fixture(t), akuId = "aku/elite/1234abcd";
  const cancellation = new AbortController();
  let retireRename: (error: Error) => void = () => { throw new Error("rename was not started"); };
  let renameRetired = false, closeRetired = false, closes = 0;
  const client = {
    async fetchAgents() { return { entries: [{ agent: snapshot("mirror", h.world, akuId, "old"), project: null }], pageInfo }; },
    async updateAgent() {
      try {
        await new Promise<void>((_resolve, reject) => {
          retireRename = reject;
          cancellation.abort(new Error("title deadline"));
        });
      } finally { renameRetired = true; }
    },
    async close() {
      closes++;
      await new Promise<void>(resolve => setImmediate(resolve));
      retireRename(cancellation.signal.reason);
      closeRetired = true;
    },
  } as unknown as DaemonClient;
  await assert.rejects(backfillMirrorTitles(h.world, akuId, cancellation.signal, async () => client), /title deadline/u);
  assert.equal(closes, 1);
  assert.equal(renameRetired, true);
  assert.equal(closeRetired, true);
});
