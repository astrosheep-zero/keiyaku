import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NoGitWorldError } from "@astrosheep/keiyaku";
import extension from "../plugins/pi/keiyaku.ts";
import { deferred } from "./support/process.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Readers = NonNullable<Parameters<typeof extension>[1]>;
const flush = async () => await new Promise<void>((resolve) => setImmediate(resolve));

function fixture(readers: Readers) {
  const handlers = new Map<string, Handler[]>();
  const writes: Array<[string, string | undefined]> = [];
  const commands: string[] = [];
  const tools: string[] = [];
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    registerMcpServer() {},
    registerCommand(name: string) { commands.push(name); },
    registerFlag() {}, getFlag() { return false; },
  } as unknown as ExtensionAPI;
  const context = (mode: string, cwd = "/fixture") => ({
    mode, cwd, sessionManager: { getSessionId: () => "session" },
    ui: { setStatus: (key: string, text: string | undefined) => writes.push([key, text]) },
  }) as unknown as ExtensionContext;
  const emit = (name: string, ctx: ExtensionContext) => {
    for (const handler of handlers.get(name) ?? []) void handler({}, ctx);
  };
  extension(pi, readers);
  return { writes, commands, tools, context, emit };
}

const report = (akuma: unknown, contracts: unknown, debts: unknown) => ({
  root: null, observedAt: new Date().toISOString(), akuma, contracts, debts,
});
const present = (value: number) => ({ kind: "present", value });
const absent = { kind: "absent" };
const failed = { kind: "failed", failure: { message: "unavailable" } };

test("only TUI starts asynchronous observations; scope and section availability stay honest", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: unknown[] = [];
  const first = deferred<unknown>();
  const repo = { root: "/primary" };
  const readers = {
    repo: async (input: unknown) => { calls.push(input); return repo; },
    world: async (input: unknown) => { calls.push(input); return { root: "/primary" }; },
    counts: async (input: unknown) => { calls.push(input); return await first.promise; },
  } as unknown as Readers;
  const f = fixture(readers);
  assert.deepEqual(calls, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.commands, ["keiyaku"]);
  assert.equal(f.tools.length, 10);
  for (const mode of ["rpc", "json", "print"]) {
    const ctx = f.context(mode);
    f.emit("session_start", ctx); f.emit("agent_settled", ctx); f.emit("session_shutdown", ctx);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(f.writes, []);
  const ctx = f.context("tui", "/worktree");
  f.emit("session_start", ctx);
  assert.deepEqual(f.writes, [["keiyaku", "aku ? · kei ? · debt ?"]]);
  await flush();
  assert.deepEqual(calls, [{ path: "/worktree" }, { cwd: "/worktree", repositoryRoot: "/primary" }, { world: "/primary", repo }]);
  first.resolve(report(present(0), absent, failed));
  await flush();
  assert.deepEqual(f.writes.at(-1), ["keiyaku", "aku 0 · kei - · debt ?"]);
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls.length, 6);
  f.emit("session_shutdown", ctx);
  assert.deepEqual(f.writes.at(-1), ["keiyaku", undefined]);
});

test("settled bursts coalesce, replacement fences delayed reads, and failures do not preserve old values", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reads: Array<ReturnType<typeof deferred<unknown>>> = [];
  const worlds: unknown[] = [];
  let discoveryFails = false;
  const readers = {
    repo: async () => { if (discoveryFails) throw new Error("discovery failed"); throw new NoGitWorldError("/outside"); },
    world: async (input: unknown) => { worlds.push(input); return { root: null }; },
    counts: async () => { const read = deferred<unknown>(); reads.push(read); return await read.promise; },
  } as unknown as Readers;
  const f = fixture(readers);
  const old = f.context("tui", "/old");
  f.emit("session_start", old);
  await flush();
  assert.deepEqual(worlds, [{ cwd: "/old" }]);
  f.emit("agent_settled", old); f.emit("agent_settled", old); f.emit("agent_settled", old);
  assert.equal(reads.length, 1);
  reads[0]!.resolve(report(present(3), absent, present(1)));
  await flush();
  assert.equal(reads.length, 2);
  const current = f.context("tui", "/new");
  f.emit("session_start", current);
  await flush();
  assert.equal(reads.length, 3);
  const before = f.writes.length;
  reads[1]!.resolve(report(present(99), absent, present(99)));
  await flush();
  assert.equal(f.writes.length, before);
  reads[2]!.resolve(report(present(1), absent, present(2)));
  await flush();
  assert.deepEqual(f.writes.at(-1), ["keiyaku", "aku 1 · kei - · debt 2"]);
  discoveryFails = true;
  f.emit("agent_settled", current);
  await flush();
  assert.deepEqual(f.writes.at(-1), ["keiyaku", "aku ? · kei ? · debt ?"]);
  assert.equal(worlds.length, 3);
  discoveryFails = false;
  f.emit("agent_settled", current);
  await flush();
  assert.equal(reads.length, 4);
  f.emit("session_shutdown", current);
  f.emit("session_shutdown", current);
  const closed = f.writes.length;
  reads[3]!.resolve(report(present(7), absent, present(8)));
  await flush();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(f.writes.length, closed);
  assert.equal(reads.length, 4);
});
