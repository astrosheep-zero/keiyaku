import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PaseoAgent, PaseoAgentListResult, SubscriptionObserver } from "@getpaseo/client";
import type { PluginHookContext, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import type { ProviderEvent, ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createProvider } from "../plugins/paseo/plugin/server/provider.js";
import { createRegistrationHandoff, registerRegistrationHooks } from "../plugins/paseo/plugin/server/handoff.js";
import type { History, Row } from "../plugins/paseo/plugin/server/keiyaku.js";
import type { AkumaTransport } from "../plugins/paseo/plugin/server/transport.js";

const at = "2026-10-20T00:00:00.000Z";
const turn: Row = { kind: "turn", sequence: 1, bodySequence: 1, at };
const answer: Row = { kind: "outcome", sequence: 2, turnSequence: 1, at, outcome: { kind: "answered", answer: "done" } };
const history = (rows: Row[]): History => ({ rows, omitted: 0, hasEarlier: false, hasLater: false,
  historyLost: false, lowestRetained: rows[0]?.sequence ?? null, highest: rows.at(-1)?.sequence ?? 0 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function exercise(reason: PluginSessionOpenRequest["reason"], rows: Row[]) {
  const world = await mkdtemp(join(tmpdir(), "paseo-handoff-"));
  const hostId = `host-${reason}`;
  let directoryObserver: SubscriptionObserver<PaseoAgentListResult & { subscriptionId: string }> | undefined;
  let subscriptionReleased = 0, reads = 0;
  const directory = {
    subscriptionId: "directory-subscription",
    ready: Promise.resolve({ requestId: "list", subscriptionId: "directory-subscription", entries: [],
      pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }),
    subscribe(observer: SubscriptionObserver<PaseoAgentListResult & { subscriptionId: string }>) {
      directoryObserver = observer;
      observer.snapshot(awaitedSnapshot);
      return () => { directoryObserver = undefined; };
    },
    async release() { subscriptionReleased++; directoryObserver = undefined; },
  };
  const awaitedSnapshot = { requestId: "list", subscriptionId: "directory-subscription", entries: [],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } } satisfies PaseoAgentListResult;
  const paseo = { agents: { async list(options: { filter: unknown; page: unknown; subscribe: unknown; signal: AbortSignal }) {
    const { signal, ...query } = options;
    assert.deepEqual(query, { filter: { includeArchived: true, includeBackground: true }, page: { limit: 1 }, subscribe: {} });
    assert.ok(signal instanceof AbortSignal);
    await directory.ready;
    return { ...awaitedSnapshot, subscription: directory };
  } } } as unknown as PluginHookContext["paseo"];
  const controller = new AbortController();
  let before: ((input: { request: PluginSessionOpenRequest }, context: PluginHookContext) => void | Promise<void>) | undefined;
  let archived: ((event: { agent: { id: string } }) => void | Promise<void>) | undefined;
  let closed: ((event: { agent: { id: string } }) => void | Promise<void>) | undefined;
  const fakeServer = {
    before(_name: "agent.session_open", handler: typeof before) { before = handler; return () => { before = undefined; }; },
    on(name: "agent.archived" | "agent.closed", handler: ((event: { agent: { id: string } }) => void | Promise<void>)) {
      if (name === "agent.archived") archived = handler; else closed = handler;
      return () => { if (name === "agent.archived") archived = undefined; else closed = undefined; };
    },
  } as unknown as Pick<PluginServerContext, "before" | "on">;
  const handoff = createRegistrationHandoff();
  const removeHooks = registerRegistrationHooks(fakeServer, handoff);
  const transport: AkumaTransport = {
    stream: (_world, _akuId, signal) => ({ [Symbol.asyncIterator]: () => {
      let first = true;
      return {
        async next() {
          if (first) { first = false; reads++; return { done: false as const, value: history(rows) }; }
          return await new Promise<IteratorResult<History>>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("observation closed")), { once: true });
          });
        },
        async return() { return { done: true as const, value: undefined }; },
      };
    } }),
    async tell() { throw new Error("unexpected Tell"); }, async stop() { throw new Error("unexpected Stop"); },
    async status() { return {}; }, async close() {},
  };
  const mirror = createProvider(transport, handoff);
  const connection = await mirror.provider.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message", "prompt.steer", "session.can_stop_runtime"] });
  const events: ProviderEvent[] = [];
  connection.onEvent(event => events.push(event));
  const request: PluginSessionOpenRequest = { agentId: hostId, workspaceId: null, provider: "keiyaku", cwd: world,
    reason, purpose: "interactive", title: null, labels: {}, tools: [], env: {}, mcpServers: {} };
  const hook = before!({ request }, { paseo, signal: controller.signal });
  await hook;
  assert.ok(directoryObserver, "the hook establishes an owned directory listener before returning");
  assert.equal(controller.signal.aborted, false, "a successful hook return does not abort the process-wide lifecycle signal");
  const config: ProviderSessionConfig = { cwd: world, env: { PASEO_AGENT_ID: hostId }, mcpServers: {}, settings: {}, persist: true,
    providerOptions: { world, akuId: "aku/test/1" } };
  await connection.send({ type: "session.open", requestId: "open", sessionId: `session-${reason}`, config, history: "replay" });
  assert.equal(reads, 1);
  const update = (agent: Partial<PaseoAgent>) => directoryObserver?.update({ type: "agent_update", payload: {
    kind: "upsert", agent: { id: hostId, provider: "keiyaku", status: "idle", archivedAt: null, ...agent } as PaseoAgent,
  } } as SessionOutboundMessage);
  update({ status: "initializing" });
  await tick();
  assert.equal(reads, 1, "initializing is not the post-registration idle handoff");
  update({ status: "idle" });
  await tick(); await tick();
  assert.equal(reads, 2, "the exact registered agent's idle update reopens fresh history once");
  const starts = () => events.filter(event => event.type === "session.turn" && event.state === "started");
  assert.equal(starts().length, rows.some(row => row.kind === "turn") && !rows.some(row => row.kind === "outcome") ? 2 : 1,
    "only a fresh still-open Turn is reannounced; completed history is not resurrected");
  update({ status: "idle" });
  await tick();
  assert.equal(reads, 2, "the one-shot handoff releases after synchronization");
  assert.equal(subscriptionReleased, 1);
  await archived!({ agent: { id: hostId } });
  await closed!({ agent: { id: hostId } });
  assert.equal(subscriptionReleased, 1, "archive and close leave no per-open directory subscription behind");
  assert.equal(events.some(event => event.type === "request.completed" || event.type === "request.failed"), false);
  await connection.close();
  await mirror.close();
  removeHooks();
  handoff.close();
  await rm(world, { recursive: true, force: true });
}

test("registered-idle handoff covers create, resume, refresh and import without awaiting future registration", async t => {
  for (const reason of ["create", "resume", "refresh", "import"] as const) {
    await t.test(reason, async () => exercise(reason, [turn]));
  }
});

test("registered-idle handoff never resurrects a completed retained Turn", async () => {
  await exercise("resume", [turn, answer]);
});

async function pendingHook(fail = false) {
  const handoff = createRegistrationHandoff();
  const controller = new AbortController();
  let listCalls = 0, releases = 0, subscriptions = 0;
  const snapshot = { requestId: "list", subscriptionId: "pending-directory", entries: [],
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } } satisfies PaseoAgentListResult;
  const subscription = {
    subscriptionId: "pending-directory",
    ready: Promise.resolve({ ...snapshot, subscriptionId: "pending-directory" }),
    subscribe(observer: SubscriptionObserver<PaseoAgentListResult & { subscriptionId: string }>) {
      subscriptions++;
      observer.snapshot({ ...snapshot, subscriptionId: "pending-directory" });
      return () => {};
    },
    async release() { releases++; },
  };
  const paseo = { agents: { async list(options: { filter: unknown }) {
    listCalls++;
    assert.deepEqual(options.filter, { includeArchived: true, includeBackground: true });
    if (fail) throw new Error("directory unavailable");
    return { ...snapshot, subscription };
  } } } as unknown as PluginHookContext["paseo"];
  const request: PluginSessionOpenRequest = { agentId: "host-agent", workspaceId: null, provider: "keiyaku", cwd: "/tmp",
    reason: "resume", purpose: "interactive", title: null, labels: {}, tools: [], env: {}, mcpServers: {} };
  return { handoff, controller, listCalls: () => listCalls, releases: () => releases, subscriptions: () => subscriptions,
    open: () => handoff.beforeOpen(request, { paseo, signal: controller.signal }) };
}

test("registration handoff releases pre-aborted, failed, replaced and unloaded attempts", async t => {
  const preaborted = await pendingHook();
  preaborted.controller.abort();
  await preaborted.open();
  assert.equal(preaborted.listCalls(), 0, "an already-aborted hook starts no subscription");

  const failed = await pendingHook(true);
  const warning = t.mock.method(console, "warn", () => {});
  await failed.open();
  assert.equal(failed.releases(), 0);
  assert.equal(warning.mock.callCount(), 1, "failed establishment is diagnosed and does not block open");

  const replaced = await pendingHook();
  await replaced.open();
  assert.equal(replaced.subscriptions(), 1);
  await replaced.open();
  assert.equal(replaced.releases(), 1, "a later open releases the prior attempt before replacing it");
  await replaced.handoff.close();
  assert.equal(replaced.releases(), 2, "plugin teardown awaits release of the current owned subscription");
});

test("registration handoff releases its established directory subscription when hook context aborts", async () => {
  const h = await pendingHook();
  await h.open();
  h.controller.abort();
  await tick();
  assert.equal(h.releases(), 1);
  await h.handoff.close();
  assert.equal(h.releases(), 1, "abort cleanup is idempotent");
});

test("registration handoff timeout releases the owned directory subscription", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await pendingHook();
  await h.open();
  t.mock.timers.tick(90_000);
  await tick();
  assert.equal(h.releases(), 1);
  await h.handoff.close();
});
