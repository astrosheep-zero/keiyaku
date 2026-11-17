import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { createPaseoApi, type PaseoAgent, type PaseoAgentListOptions, type PaseoAgentListResult } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { attach } from "../plugins/paseo/plugin/server/attach.js";
import { createDirectoryIndex, StaleDirectory } from "../plugins/paseo/plugin/server/directory.js";
import { createReopener } from "../plugins/paseo/plugin/server/reopen.js";
import { directorySubscriptions } from "./support/paseo-directory.js";

const world = await realpath(tmpdir());
const at = "2026-11-17T00:00:00.000Z";
const later = "2026-11-17T00:00:01.000Z";
const pageInfo = { hasMore: false, nextCursor: null, prevCursor: null };
const agent = (id: string, sessionId = id, status: PaseoAgent["status"] = "idle"): PaseoAgent => ({
  id, provider: "pi", cwd: world, status, archivedAt: null, updatedAt: at,
  persistence: { provider: "pi", sessionId },
} as PaseoAgent);
const mirror = (id: string, akuId = "aku/test/1"): PaseoAgent => ({ ...agent(id), provider: "keiyaku",
  persistence: { provider: "keiyaku", sessionId: `opaque/${id}`,
    metadata: { pluginProviderPersistence: { version: 1, data: { world, akuId } } } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(t: TestContext, initial: PaseoAgent[] = [agent("parent", "native")]) {
  const agents = new Map(initial.map((value) => [value.id, value]));
  const lists: PaseoAgentListOptions[] = [], fetched: string[] = [], created: string[] = [], refetched: string[] = [];
  let onList: ((options: PaseoAgentListOptions) => void | Promise<void>) | undefined;
  let onFetch: ((id: string) => void | Promise<void>) | undefined;
  let onCreate: ((value: PaseoAgent) => void | Promise<void>) | undefined;
  const directory = createDirectoryIndex();
  const refresh = createReopener(directory);
  const stream = directorySubscriptions(async () => ({ requestId: "sub", entries: [],
    pageInfo: { hasMore: true, nextCursor: "not-complete", prevCursor: null } }));
  const client = {
    observeAgents: stream.observeAgents,
    getLastServerInfoMessage: () => ({ serverId: "test" }),
    async fetchAgents(options: PaseoAgentListOptions): Promise<PaseoAgentListResult> {
      lists.push(options);
      await onList?.(options);
      options.signal?.throwIfAborted();
      const matching = [...agents.values()].filter(value => options.filter?.statuses?.includes(value.status));
      const offset = Number(options.page?.cursor ?? 0), limit = options.page?.limit ?? 200;
      const hasMore = offset + limit < matching.length;
      return { requestId: "page", entries: matching.slice(offset, offset + limit).map(value => ({ agent: value,
        project: { projectKey: world, projectName: "test", checkout: { cwd: world, isGit: false, worktreeRoot: null,
          currentBranch: null, remoteUrl: null, isPaseoOwnedWorktree: false, mainRepoRoot: null } } })),
        pageInfo: { ...pageInfo, hasMore, nextCursor: hasMore ? String(offset + limit) : null } };
    },
    async fetchAgent({ agentId }: { agentId: string }) {
      fetched.push(agentId);
      // Capture before the hook to exercise delayed exact-ID responses.
      const value = agents.get(agentId);
      await onFetch?.(agentId);
      return value ? { agent: value, project: null } : null;
    },
    async createAgent(options: Parameters<DaemonClient["createAgent"]>[0]) {
      const akuId = (options.config!.providerOptions as { akuId: string }).akuId;
      created.push(akuId);
      const value = mirror(`created-${akuId}`, akuId);
      agents.set(value.id, value);
      await onCreate?.(value);
      return value;
    },
    async fetchAgentTimeline(agentId: string) {
      refetched.push(agentId);
      return { requestId: "timeline", agentId, agent: agents.get(agentId) ?? null, entries: [], error: null, pageInfo };
    },
  };
  const paseo = createPaseoApi(client as unknown as DaemonClient);
  t.after(async () => { await directory.close(); await paseo.dispose(); });
  const input = { world, akuId: "aku/test/1", caller: { kind: "external" as const, integration: "pi", id: "native" } };
  return { agents, lists, fetched, created, refetched, directory, stream, paseo, input, client,
    attach: (target = input) => attach(target, { paseo }, directory),
    refresh: () => refresh(paseo, input, async () => ({ woken: 0 })),
    onList: (hook: typeof onList) => { onList = hook; }, onFetch: (hook: typeof onFetch) => { onFetch = hook; },
    onCreate: (hook: typeof onCreate) => { onCreate = hook; },
  };
}

test("one complete status-partitioned seed serves concurrent and warm attachment plus reopen in a large directory", async t => {
  const h = harness(t, [agent("parent", "native"), ...Array.from({ length: 3499 }, (_, i) => agent(`other-${i}`))]);
  assert.deepEqual(await Promise.all([h.attach(), h.attach()]), [{ attached: true }, { attached: true }]);
  assert.equal(h.lists.length, 19, "one hot page and all 18 remaining pages shared by both callers");
  assert.deepEqual(h.lists[0]!.filter, { includeArchived: true, includeBackground: true, statuses: ["running", "initializing"] });
  assert.deepEqual(h.lists[1]!.filter?.statuses, ["idle", "error", "closed"]);
  assert.deepEqual(await h.attach(), { attached: true });
  assert.deepEqual(await h.refresh(), { woken: 1 });
  assert.equal(h.lists.length, 19, "attachment and recovery share the warm activation index");
  assert.ok(h.fetched.includes("created-aku/test/1"), "warm mirrors get fresh exact-ID reads");
  assert.deepEqual(h.refetched, ["created-aku/test/1"]);
});

test("cold bootstrap buffers status transitions outside both queried partitions and refuses partial membership", async t => {
  const parent = agent("parent", "native", "idle");
  const h = harness(t, [parent]);
  const gate = deferred<void>(), started = deferred<void>();
  h.onList(async options => {
    if (options.filter?.statuses?.includes("idle")) {
      const moving = { ...parent, status: "running" as const, updatedAt: later };
      h.agents.set(moving.id, moving);
      h.stream.update({ kind: "upsert", agent: moving });
      started.resolve();
      await gate.promise;
    }
  });
  const pending = h.attach();
  await started.promise;
  assert.deepEqual(h.created, [], "a hot page and bounded subscription snapshot never authorize absence");
  gate.resolve();
  assert.deepEqual(await pending, { attached: true });
  assert.deepEqual(h.fetched, ["parent"]);
});

test("older buffered updates cannot roll newer paginated identity back; equal conflicting stamps refuse", async t => {
  for (const stamp of [later, at]) await t.test(stamp, async t => {
    const h = harness(t);
    h.onList(options => {
      if (options.filter?.statuses?.includes("running")) h.stream.update({ kind: "upsert", agent: agent("parent", "obsolete") });
      if (options.filter?.statuses?.includes("idle")) h.agents.set("parent", { ...agent("parent", "native"), updatedAt: stamp });
    });
    t.mock.method(console, "warn", () => {});
    assert.deepEqual(await h.attach(), { attached: stamp === later });
    assert.equal(h.created.length, stamp === later ? 1 : 0);
  });
});

test("warm updates replace identity, retain inactive duplicates and remove old membership", async t => {
  const h = harness(t);
  await h.directory.read(h.paseo, t.signal);
  const replacement = { ...agent("parent", "replacement"), updatedAt: later };
  h.agents.set("parent", replacement);
  h.stream.update({ kind: "upsert", agent: replacement });
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(await h.attach(), { attached: false });
  const duplicate = { ...agent("closed-duplicate", "replacement", "closed"), archivedAt: "now" };
  h.agents.set(duplicate.id, duplicate);
  h.stream.update({ kind: "upsert", agent: duplicate });
  const next = { ...h.input, caller: { ...h.input.caller, id: "replacement" } };
  assert.deepEqual(await h.attach(next), { attached: false });
  h.agents.delete(duplicate.id);
  h.stream.update({ kind: "remove", agentId: duplicate.id });
  assert.deepEqual(await h.attach(next), { attached: true });
  const child = h.agents.get("created-aku/test/1")!;
  h.agents.delete(child.id);
  h.stream.update({ kind: "remove", agentId: child.id });
  assert.deepEqual(await h.refresh(), { woken: 0 });
  assert.equal(h.lists.length, 2, "all updates maintain the same warm index");
});

test("reconnect snapshots and null subscription IDs invalidate generations without treating page one as complete", async t => {
  const h = harness(t);
  const before = await h.directory.read(h.paseo, t.signal);
  h.stream.disconnect();
  assert.throws(before.assertCurrent, StaleDirectory);
  h.agents.set("duplicate", agent("duplicate", "native", "closed"));
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(await h.attach(), { attached: false });
  assert.equal(h.lists.length, 4);
  const connected = await h.directory.read(h.paseo, t.signal);
  h.stream.reconnect();
  assert.throws(connected.assertCurrent);
  assert.equal(h.stream.listeners(), 0, "replacement snapshot retires its observer immediately");
  assert.deepEqual(await h.attach(), { attached: false });
  assert.equal(h.lists.length, 6);
});

test("late exact-ID reads cannot create against replaced membership or a retired connection", async t => {
  for (const mode of ["replacement", "duplicate", "reconnect", "dispose"]) await t.test(mode, async t => {
    const h = harness(t);
    let changed = false;
    h.onFetch(async () => {
      if (changed) return;
      changed = true;
      if (mode === "replacement") {
        const replacement = { ...agent("parent", "other"), updatedAt: later };
        h.agents.set("parent", replacement);
        h.stream.update({ kind: "upsert", agent: replacement });
      } else if (mode === "duplicate") {
        const duplicate = agent("duplicate", "native", "closed");
        h.agents.set("duplicate", duplicate);
        h.stream.update({ kind: "upsert", agent: duplicate });
      } else if (mode === "reconnect") {
        h.stream.disconnect();
        h.stream.reconnect();
        h.agents.delete("parent");
      } else await h.directory.close();
    });
    t.mock.method(console, "warn", () => {});
    assert.deepEqual(await h.attach(), { attached: false });
    assert.deepEqual(h.created, []);
  });
});

test("reconnect during bootstrap retires pending pages and only a new complete generation can authorize absence", async t => {
  const h = harness(t), gate = deferred<void>(), started = deferred<void>();
  let first = true;
  h.onList(async () => {
    if (!first) return;
    first = false;
    started.resolve();
    await gate.promise;
  });
  const pending = h.directory.read(h.paseo, t.signal);
  await started.promise;
  h.stream.disconnect();
  h.stream.reconnect();
  await assert.rejects(pending);
  h.agents.set("archived-child", { ...mirror("archived-child"), archivedAt: "now" });
  gate.resolve();
  await tick();
  assert.deepEqual(await h.attach(), { attached: true });
  assert.deepEqual(h.created, [], "fresh complete membership preserves archived child intent");
  assert.equal(h.lists.length, 3, "retired first page cannot replace the new two-partition seed");
});

test("reopen refuses a duplicate introduced while its exact-ID refresh is in flight", async t => {
  const h = harness(t, [mirror("selected")]);
  h.onFetch(() => {
    const duplicate = { ...mirror("archived-duplicate"), archivedAt: "now" };
    h.agents.set(duplicate.id, duplicate);
    h.stream.update({ kind: "upsert", agent: duplicate });
  });
  assert.deepEqual(await h.refresh(), { woken: 0 });
  assert.deepEqual(h.refetched, [], "a stale unique candidate cannot authorize the timeline read");
  assert.equal(h.lists.length, 2);
});

test("recursive parent and child accept their exact own upserts before create resolves", async t => {
  const h = harness(t);
  h.onCreate(value => h.stream.update({ kind: "upsert", agent: value }));
  const result = await attach({ world, akuId: "aku/child/2", caller: { kind: "akuma", world, akuId: "aku/parent/1" } },
    { paseo: h.paseo }, h.directory, async () => ({ caller: { kind: "external", integration: "pi", id: "native" } }));
  assert.deepEqual(result, { attached: true });
  assert.deepEqual(h.created, ["aku/parent/1", "aku/child/2"]);
  assert.equal(h.lists.length, 2, "own stream upserts consume no retry or rebootstrap");
  const warm = await h.directory.read(h.paseo, t.signal);
  assert.deepEqual((await warm.mirrors(world, "aku/child/2")).map(value => value.id), ["created-aku/child/2"]);
});

test("own creation never forgives a different watched key changing or an ambiguous new mirror", async t => {
  for (const mode of ["parent-replaced", "duplicate-child"]) await t.test(mode, async t => {
    const h = harness(t);
    h.onCreate(value => {
      h.stream.update({ kind: "upsert", agent: value });
      const changed = mode === "parent-replaced" ? { ...agent("parent", "other"), updatedAt: later } : mirror("duplicate");
      h.agents.set(changed.id, changed);
      h.stream.update({ kind: "upsert", agent: changed });
    });
    const evidence = await h.directory.read(h.paseo, t.signal);
    evidence.native("pi", "native");
    await evidence.mirrors(world, "aku/test/1");
    const handle = await h.paseo.agents.create({ cwd: world, config: { provider: "keiyaku/mirror", options: { world, akuId: "aku/test/1" } } });
    assert.throws(() => evidence.created(handle.current()!), StaleDirectory);
  });
});

test("one cancelled seed waiter cannot abort another caller's bootstrap", async t => {
  const h = harness(t), gate = deferred<void>(), started = deferred<void>();
  h.onList(async () => { started.resolve(); await gate.promise; });
  const cancelled = new AbortController();
  const first = h.directory.read(h.paseo, cancelled.signal);
  const second = h.directory.read(h.paseo, t.signal);
  await started.promise;
  cancelled.abort(new Error("only first waiter cancelled"));
  await assert.rejects(first, /only first waiter/u);
  gate.resolve();
  const evidence = await second;
  assert.equal(evidence.native("pi", "native").length, 1);
  assert.equal(h.lists.length, 2);
  assert.equal(h.stream.releases(), 0);
});

test("subscription error, bounded bootstrap overflow and unordered removal cannot publish partial membership", async t => {
  for (const mode of ["error", "overflow", "remove"]) await t.test(mode, async t => {
    const h = harness(t);
    h.onList(() => {
      if (mode === "error") h.stream.error(new Error("directory unavailable"));
      if (mode === "overflow") for (let i = 0; i < 4097; i++) h.stream.update({ kind: "upsert", agent: agent(`update-${i}`) });
      if (mode === "remove") h.stream.update({ kind: "remove", agentId: "parent" });
    });
    t.mock.method(console, "warn", () => {});
    assert.deepEqual(await h.attach(), { attached: false });
    assert.deepEqual(h.created, []);
    assert.equal(h.stream.listeners(), 0);
  });
});

test("disposal waits for late subscription acquisition, releases it once and fences late seed completion", async t => {
  const h = harness(t), acquired = deferred<PaseoAgentListResult>();
  const original = directorySubscriptions(() => acquired.promise);
  t.mock.method(h.client, "observeAgents", original.observeAgents);
  const pending = h.directory.read(h.paseo, t.signal);
  await tick();
  let finished = false;
  const closing = h.directory.close().then(() => { finished = true; });
  await assert.rejects(pending);
  await tick();
  assert.equal(finished, false, "cleanup owns late subscription acquisition");
  acquired.resolve({ requestId: "late", entries: [], pageInfo });
  await closing;
  assert.equal(original.releases(), 1);
  assert.equal(original.listeners(), 0);
  assert.deepEqual(h.lists, []);
  await h.directory.close();
  assert.equal(original.releases(), 1);
});
