import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import "./support/local-public-package.js";
const { backfillMirrorTitles, createForwarder, syncMirrorTitles } = await import("../plugins/paseo/forwarder/index.js");
import { attach } from "../plugins/paseo/plugin/server/attach.js";
import { World } from "../src/world.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import type { PluginContext } from "../src/plugin/public.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "paseo-titles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const world = await World.at(root);
  const alias = join(root, "alias"); await symlink(world, alias);
  const bind = (name: string, id: string) => moveAlias({ world, alias: parseAkumaAlias(`@${name}`), akumaId: parseAkumaId(id).id });
  return { world, alias, bind };
}
function snapshot(id: string, world: string, akuId: string, title: string | null) {
  return { id, provider: "keiyaku", title, persistence: { provider: "keiyaku", sessionId: "opaque-do-not-decode",
    metadata: { pluginProviderPersistence: { version: 1, data: { world, akuId } } } } } as unknown as AgentSnapshotPayload;
}
const pageInfo = { hasMore: false, nextCursor: null, prevCursor: null };

test("birth and ordinary refresh converge alias titles without changing the creation fingerprint", async t => {
  for (const initiallyAliased of [true, false]) await t.test(initiallyAliased ? "aliased" : "bare", async t => {
    const h = await fixture(t), akuId = "aku/elite/1234abcd", other = "aku/elite/8765abcd";
    if (initiallyAliased) await h.bind("reviewer", akuId);
    let child: AgentSnapshotPayload | undefined;
    const nextTarget = snapshot("next-target", h.world, other, other);
    let fingerprint: string | undefined, creates = 0;
    const renames: string[] = [];
    const wire: Parameters<DaemonClient["createAgent"]>[0][] = [];
    const client = {
      getLastServerInfoMessage() { return { serverId: "test-server" }; },
      async fetchAgent() { return { agent: { id: "parent", cwd: h.world, archivedAt: null }, project: null }; },
      async fetchAgents() { return { entries: child ? [child, nextTarget].map(agent => ({ agent, project: null })) : [], pageInfo }; },
      async createAgent(options: Parameters<DaemonClient["createAgent"]>[0]) {
        const request = JSON.stringify(options);
        if (fingerprint !== undefined) assert.equal(request, fingerprint, "changed idempotent payload would conflict");
        else { fingerprint = request; creates++; child = snapshot("mirror", h.world, akuId, options.config?.title ?? null); }
        wire.push(options);
        return child!;
      },
      async updateAgent(id: string, update: { name?: string }) {
        const target = id === child!.id ? child! : nextTarget;
        target.title = update.name!; renames.push(update.name!);
      },
      async invokePluginRpc(_plugin: string, method: string, input: unknown) {
        return method === "attach" ? await attach(input as Parameters<typeof attach>[0], { paseo }) : { woken: 0 };
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
    assert.equal(child!.title, initiallyAliased ? `@reviewer (${akuId})` : akuId);
    await h.bind("reviewer", akuId);
    await h.bind("audit", akuId);
    await signals?.["akuma.turn-started"]?.({ kind: "akuma.turn-started", akumaId: akuId, turnSequence: 1 });
    assert.equal(child!.title, `@audit, @reviewer (${akuId})`, "post-birth bindings appear on the next refresh");
    assert.equal(await syncMirrorTitles(client as unknown as DaemonClient, h.world, akuId), 0);
    await h.bind("reviewer", other); await h.bind("audit", other);
    await signals?.["akuma.turn-outcome"]?.({ kind: "akuma.turn-outcome", akumaId: akuId, bodySequence: 1,
      turnSequence: 1, outcome: { kind: "answered", text: "done" } });
    assert.equal(child!.title, akuId, "the old target loses moved aliases on its own refresh");
    assert.equal(nextTarget.title, other, "refresh does not globally rename other mirrors");
    await signals?.["akuma.turn-started"]?.({ kind: "akuma.turn-started", akumaId: other, turnSequence: 1 });
    assert.equal(nextTarget.title, `@audit, @reviewer (${other})`, "the new target converges on its own refresh");
    await signals?.["akuma.born"]?.(born);
    assert.equal(creates, 1);
    assert.equal(wire.length, 2);
    for (const input of wire) {
      assert.equal(input.config?.title, akuId, "create is always bare ID, even after rename");
      assert.equal(input.idempotencyKey, `keiyaku:${h.world}:${akuId}`);
    }
    assert.deepEqual(renames, [...(initiallyAliased ? [`@reviewer (${akuId})`] : []),
      `@audit, @reviewer (${akuId})`, akuId, `@audit, @reviewer (${other})`]);
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
      if (id === "old") await h.bind("reviewer", bare);
    },
  } as unknown as Pick<DaemonClient, "fetchAgents" | "updateAgent">;
  assert.equal(await syncMirrorTitles(client, h.alias), 3);
  assert.deepEqual(updates, [["old", { name: `@reviewer (${akuId})` }], ["bare", { name: bare }],
    ["archived", { name: `@reviewer (${akuId})` }]], "alias moves during rename do not split the batch's name snapshot");
  await h.bind("reviewer", akuId);
  assert.equal(await syncMirrorTitles(client, h.world), 0, "correct titles do not produce redundant mutations");
  assert.equal(updates.length, 3);
  await writeFile(join(h.world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  await assert.rejects(syncMirrorTitles(client, h.world), /invalid Alias JSON/u);
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
  assert.deepEqual(updates, [["selected", { name: `@reviewer (${selected})` }]]);
  assert.equal(agents[1]!.title, "other customized title");
});

test("failed owned title attempts preserve attach, ordinary refresh and runtime cleanup", async t => {
  const h = await fixture(t), akuId = "aku/elite/1234abcd";
  await h.bind("reviewer", akuId);
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
  assert.match(String(warning.mock.calls[0]?.arguments[0]), /title synchronization failed: rename unavailable/u);
  await signals?.["akuma.turn-started"]?.({ kind: "akuma.turn-started", akumaId: akuId, turnSequence: 1 });
  await writeFile(join(h.world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  await signals?.["akuma.turn-outcome"]?.({ kind: "akuma.turn-outcome", akumaId: akuId, bodySequence: 1,
    turnSequence: 1, outcome: { kind: "answered", text: "done" } });
  assert.equal(opens, 4, "each title attempt owns a new connection while runtime refresh reuses the first");
  assert.equal(titleCloses, 3);
  assert.equal(runtimeCloses, 0);
  assert.equal(warning.mock.callCount(), 3);
  assert.match(String(warning.mock.calls[2]?.arguments[0]), /invalid Alias JSON/u);
  assert.equal(refreshes, 2);
  await signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: akuId, bodySequence: 1, end: "exited" });
  assert.equal(runtimeCloses, 1, "Body end still owns normal runtime cleanup");
  assert.equal(refreshes, 3);
  assert.equal(titleCloses, 4);
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
