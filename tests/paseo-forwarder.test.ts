import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import "./support/local-public-package.js";
const { createForwarder } = await import("../plugins/paseo/forwarder/index.js");
import { World } from "../src/world.js";
import type { PluginContext } from "../src/plugin/public.js";

const emptyDirectory = (async () => ({ requestId: "directory", entries: [],
  pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } })) as unknown as DaemonClient["fetchAgents"];

async function context(t: { after(fn: () => Promise<void>): void }): Promise<PluginContext> {
  const root = await mkdtemp(join(tmpdir(), "paseo-forwarder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await World.at(root);
  const alias = join(root, "alias"); await symlink(root, alias);
  return { world: alias as PluginContext["world"], config: undefined, writablePath() { throw new Error("no writes"); } };
}
const started = { kind: "akuma.turn-started" as const, akumaId: "aku/test/1234abcd", turnSequence: 1 };

test("three execution events share ensure-and-refresh; Body end retires the runtime client", async t => {
  const ctx = await context(t);
  const calls: unknown[][] = [];
  let connects = 0, closes = 0;
  const { signals } = await createForwarder(async () => {
    connects++;
    return { async invokePluginRpc(...args) { calls.push(args); return args[1] === "attach" ? { attached: false } : { woken: 0 }; },
      fetchAgents: emptyDirectory, async updateAgent() {}, async close() { closes++; } };
  }).activate(ctx);
  assert.equal(connects, 0);
  assert.equal(signals?.["akuma.born"], undefined);
  await signals?.["akuma.turn-started"]?.(started);
  await signals?.["akuma.turn-outcome"]?.({ ...started, kind: "akuma.turn-outcome", bodySequence: 1,
    outcome: { kind: "answered", text: "done" } });
  await signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: started.akumaId, bodySequence: 1, end: "exited" });
  assert.equal(connects, 4);
  assert.equal(closes, connects, "title clients and the shared runtime client all retire");
  const world = await realpath(ctx.world);
  assert.deepEqual(calls, Array.from({ length: 3 }, () => [
    ["keiyaku-paseo", "attach", { world, akuId: started.akumaId }],
    ["keiyaku-paseo", "refresh", { world, akuId: started.akumaId }],
  ]).flat());
});

test("a hung attachment is bounded and independent refresh reconnects", async t => {
  const ctx = await context(t);
  let connects = 0, closes = 0;
  const { signals } = await createForwarder(async () => {
    connects++;
    return { async invokePluginRpc(_plugin, method) { if (connects === 1) return await new Promise(() => {});
      return method === "attach" ? { attached: false } : { woken: 1 }; },
      fetchAgents: emptyDirectory, async updateAgent() {}, async close() { closes++; } };
  }).activate(ctx);
  const hold = setTimeout(() => {}, 5000); t.after(() => clearTimeout(hold));
  await assert.rejects(async () => signals?.["akuma.turn-started"]?.(started), { name: "TimeoutError" });
  assert.equal(connects, 3);
  assert.equal(closes, 2, "failed attachment and title clients close; refresh keeps its runtime client");
  await signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: started.akumaId, bodySequence: 1, end: "exited" });
  assert.equal(closes, connects);
});

test("attachment errors still allow independent runtime refresh and title cleanup", async t => {
  const ctx = await context(t);
  const calls: string[] = [];
  let closes = 0;
  const { signals } = await createForwarder(async () => ({
    async invokePluginRpc(_plugin, method) {
      calls.push(method);
      if (method === "attach") throw new Error("attachment unavailable");
      return { woken: 1 };
    },
    fetchAgents: emptyDirectory, async updateAgent() {}, async close() { closes++; },
  })).activate(ctx);
  await assert.rejects(async () => signals?.["akuma.turn-started"]?.(started), /attachment unavailable/u);
  assert.deepEqual(calls, ["attach", "refresh"]);
  assert.equal(closes, 2, "failed attachment and title clients close independently");
});
