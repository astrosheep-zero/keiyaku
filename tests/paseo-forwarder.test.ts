import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createForwarder } from "../plugins/paseo/forwarder/index.js";
import type { PluginContext } from "../src/plugin/public.js";

async function context(t: { after(fn: () => Promise<void>): void }): Promise<PluginContext> {
  const root = await mkdtemp(join(tmpdir(), "paseo-forwarder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = join(root, "alias"); await symlink(root, alias);
  return { world: alias as PluginContext["world"], config: undefined, writablePath() { throw new Error("no writes"); } };
}
const started = { kind: "akuma.turn-started" as const, akumaId: "aku/test/1", turnSequence: 1 };
const born = { kind: "akuma.born" as const, akumaId: started.akumaId, bodySequence: 1,
  origin: { kind: "direct" as const }, caller: { kind: "external" as const, integration: "paseo", id: "parent" } };

test("born callers and three refresh signals reuse one lazy client", async (t) => {
  const ctx = await context(t);
  const calls: unknown[][] = [];
  let connects = 0, closes = 0;
  const plugin = createForwarder(async () => {
    connects++;
    return { async invokePluginRpc(...args) { calls.push(args); return args[1] === "attach" ? { attached: false } : { woken: 0 }; },
      async close() { closes++; } };
  });
  const { signals } = await plugin.activate(ctx);
  assert.equal(connects, 0);
  const callers = [born.caller, { kind: "akuma", world: "/parent/world", akuId: "aku/parent/1" }, { kind: "unknown" }] as const;
  for (const caller of callers) await signals?.["akuma.born"]?.({ ...born, caller });
  await signals?.["akuma.turn-started"]?.(started);
  await signals?.["akuma.turn-outcome"]?.({ ...started, kind: "akuma.turn-outcome", bodySequence: 1,
    outcome: { kind: "answered", text: "done" } });
  await signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: started.akumaId, bodySequence: 1, end: "exited" });
  assert.equal(connects, 1); assert.equal(closes, 1, "Body end releases the persistent client");
  const world = await realpath(ctx.world);
  assert.deepEqual(calls, [
    ...callers.map((caller) => ["keiyaku-paseo", "attach", { world, akuId: started.akumaId, caller }]),
    ...Array.from({ length: 3 }, () => ["keiyaku-paseo", "refresh", { world, akuId: started.akumaId }]),
  ]);
});

test("a hung RPC is bounded, closes its connection and permits the next event to reconnect", async (t) => {
  const ctx = await context(t);
  let connects = 0, closes = 0;
  const plugin = createForwarder(async (): Promise<Pick<DaemonClient, "invokePluginRpc" | "close">> => {
    connects++;
    return { async invokePluginRpc() { if (connects === 1) return await new Promise(() => {}); return { woken: 1 }; },
      async close() { closes++; } };
  });
  const { signals } = await plugin.activate(ctx);
  const hold = setTimeout(() => {}, 3000); t.after(async () => { clearTimeout(hold); });
  const start = performance.now();
  await assert.rejects(async () => signals?.["akuma.born"]?.(born), { name: "TimeoutError" });
  assert.ok(performance.now() - start < 2800);
  await signals?.["akuma.turn-started"]?.(started);
  assert.equal(connects, 2); assert.equal(closes, 1);
});
