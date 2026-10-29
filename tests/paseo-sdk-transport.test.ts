import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { appendActivity, beginTurn, endTurn, HeldAkumaLeash } from "../src/akuma/heart/index.js";
import { translatePiEvent, type PiEventState } from "../src/akuma/providers/pi/events.js";
import { soulFixture } from "./support/akuma-fixtures.js";
import { historySchema, type History, type Row } from "../plugins/paseo/plugin/server/keiyaku.js";
import { createMirror } from "../plugins/paseo/plugin/server/mirror.js";
import { tellPresentation, tellReceiptSchema } from "../plugins/paseo/plugin/server/message.js";
import { createSdkTransport } from "../plugins/paseo/plugin/server/sdk.js";
import { ProviderEventSchema, type ProviderConnection, type ProviderEvent,
  type ProviderRegistration } from "@getpaseo/plugin/server/provider";
import * as pluginRuntime from "@getpaseo/plugin";
import * as pluginServerRuntime from "@getpaseo/plugin/server";
import * as pluginProviderRuntime from "@getpaseo/plugin/server/provider";
import * as zod from "zod";

const at = "2026-10-16T00:00:00.000Z";
/**
 * The public package this suite proves the bridge against. The lane's own build
 * is the default; `KEIYAKU_PUBLIC_PACKAGE` points the same tests at a build that
 * already carries an accepted core, so the streaming path is exercised for real
 * instead of being assumed.
 */
const EXPLICIT_PUBLIC_PACKAGE = process.env.KEIYAKU_PUBLIC_PACKAGE;
const PUBLIC_PACKAGE = EXPLICIT_PUBLIC_PACKAGE ?? resolve(".");
const PUBLIC_ENTRY = join(PUBLIC_PACKAGE, "build/src/index.js");
const PUBLIC_CLI = join(PUBLIC_PACKAGE, "build/src/cli/index.js");
const PLUGIN_DIRECTORY = resolve("plugins/paseo/plugin");
const nodeRequire = createRequire(import.meta.url);

/**
 * The public package's own admission, read directly. Comparing it with what the
 * transport returns makes the boundary transparent to the producer's own values.
 */
async function producer(): Promise<{ select(world: string, akuId: string): {
  history(options: Readonly<{ limit: number }>): Promise<History>;
  status(): Promise<unknown>;
} }> {
  const sdk = await import(PUBLIC_ENTRY) as unknown as { Akuma: { select: (world: string, akuId: string) => {
    history(options: Readonly<{ limit: number }>): Promise<History>; status(): Promise<unknown> } } };
  return { select: (world, akuId) => sdk.Akuma.select(world, akuId) };
}
/** One retained row exactly as the producer admits it. */
async function producerRow(root: string, akuId: string, sequence: number): Promise<Row | undefined> {
  const rows = (await (await producer()).select(root, akuId).history({ limit: 200 })).rows;
  return rows.find((row) => row.sequence === sequence);
}
/** The model configuration the public status itself admits, if any. */
async function producerModel(root: string, akuId: string): Promise<Readonly<{ provider?: string; model?: string }>> {
  const fields = await (await producer()).select(root, akuId).status() as Record<string, unknown>;
  return { ...(typeof fields.provider === "string" ? { provider: fields.provider } : {}),
    ...(typeof fields.model === "string" ? { model: fields.model } : {}) };
}

/** The host-supplied module surface Paseo's evaluator provides to a server bundle. */
function runtimeRequire(name: string): unknown {
  if (name === "@getpaseo/plugin") return pluginRuntime;
  if (name === "@getpaseo/plugin/server") return pluginServerRuntime;
  if (name === "@getpaseo/plugin/server/provider") return pluginProviderRuntime;
  if (name === "zod") return zod;
  return nodeRequire(name);
}

/** Evaluate one Paseo server bundle exactly as the plugin process does. */
function evaluate(bundle: string): Record<string, unknown> {
  const evaluateGlobal = (globalThis as unknown as { eval(code: string): unknown }).eval;
  const factory = evaluateGlobal(bundle) as (require: (name: string) => unknown) => Record<string, unknown>;
  return factory(runtimeRequire);
}

/**
 * Paseo's own plugin compiler ships with the installed consumer, not with this
 * repository: `@getpaseo/server` is a declared dependency of the forwarder
 * workspace only. Load it by path so this test skips instead of failing when
 * the consumer is absent, and never claims the compiler is portable.
 */
async function consumerToolchain(): Promise<Readonly<{
  compilePlugin: typeof import("../node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js").compilePlugin;
  evaluateBundle: typeof import("../node_modules/@getpaseo/server/dist/server/server/plugins/bundle-evaluator.js").evaluateBundle;
}> | undefined> {
  try {
    const [compiler, evaluator] = await Promise.all([
      import("../node_modules/@getpaseo/server/dist/server/server/plugins/compiler.js"),
      import("../node_modules/@getpaseo/server/dist/server/server/plugins/bundle-evaluator.js"),
    ]);
    return { compilePlugin: compiler.compilePlugin, evaluateBundle: evaluator.evaluateBundle };
  } catch {
    return undefined;
  }
}

test("the in-process transport serves the real public package's own stream, status, and stop", async (t) => {
  const value = await soulFixture("paseo-sdk-direct-");
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  let released = false;
  const release = () => { if (!released) { released = true; leash.release(); } };
  t.after(() => { release(); value.close(); });
  await writeFile(join(value.root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await leash.birth(value.allocated.paths, value.soul);
  const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: at });
  const started = await beginTurn(value.allocated.paths, { bodySequence: body.sequence, startedAt: at, call: "work" });
  await appendActivity(value.allocated.paths, { turnSequence: started.sequence, at,
    event: { type: "tool", phase: "started", id: "shell", name: "bash", call: { kind: "run", command: "printf hello" } } });
  // The transport's own row validation must not silently drop the observed result
  // text and per-file patch the public projection carries.
  const patch = "@@ -1 +1 @@\n-old\n+new\n";
  await appendActivity(value.allocated.paths, { turnSequence: started.sequence, at,
    event: { type: "tool", phase: "completed", id: "shell", name: "bash",
      call: { kind: "run", command: "printf hello" },
      result: { status: "ok", message: "hello", exitCode: 0, output: "hello" } } });
  await appendActivity(value.allocated.paths, { turnSequence: started.sequence, at,
    event: { type: "tool", phase: "started", id: "edit", name: "edit",
      call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts", patch }] } } });
  const transport = createSdkTransport({ entry: PUBLIC_ENTRY });
  t.after(() => transport.close());
  const root = await realpath(value.root);

  const stream = transport.stream(root, value.allocated.id, new AbortController().signal)[Symbol.asyncIterator]();
  const frame = await stream.next();
  assert.ok(!frame.done, "the transport serves the real package's own bounded window");
  const rows = frame.value.rows;
  const turn = rows.find((row) => row.kind === "turn" && row.turnSequence === started.sequence);
  assert.ok(turn?.kind === "turn", "the real public window keeps the open Turn");
  const tool = rows.find((row) => row.kind === "tool" && row.name === "bash");
  assert.ok(tool?.kind === "tool");
  assert.deepEqual(tool, await producerRow(root, value.allocated.id, tool.sequence),
    "the transport boundary is transparent to the producer's own record, identity included");
  assert.deepEqual(tool.call, { kind: "run", command: "printf hello" });
  assert.deepEqual(tool.state, { status: "ok", message: "hello", exitCode: 0, output: "hello" },
    "the transport boundary keeps the observed result text");
  const carried = rows.flatMap((row) => row.kind === "tool" && row.name === "edit" ? [row] : []);
  assert.equal(carried.length, 1, "the bounded window carries the observed edit record");
  assert.deepEqual(carried[0]?.call, { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts", patch }] },
    "the transport boundary keeps an observed per-file patch");
  await stream.return?.();

  assert.deepEqual(await transport.status(root, value.allocated.id, new AbortController().signal),
    await producerModel(root, value.allocated.id),
    "the transport reports exactly the model configuration the public status admits");

  // Kill waits for custody this fixture still holds; release it first so the
  // public stop path answers with the fixture's own real verdict.
  release();
  const stop = await transport.stop(root, value.allocated.id, new AbortController().signal);
  assert.ok(stop.kind === "stopped" || (stop.kind === "not-stopped" && /^Keiyaku reported \w+ for aku\//u.test(stop.message)),
    JSON.stringify(stop));
});

/**
 * The producer's own native chain, not a fabricated final row: a Pi edit and a
 * bash completion are translated by the real adapter, persisted as Heart
 * activity, read back through the installed public package, and only then
 * mapped into Paseo details.
 */
test("a native Pi completion reaches a Paseo edit detail through the public projection", async (t) => {
  const value = await soulFixture("paseo-tool-output-");
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  t.after(() => { leash.release(); value.close(); });
  await writeFile(join(value.root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await leash.birth(value.allocated.paths, value.soul);
  const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: at });
  const started = await beginTurn(value.allocated.paths, { bodySequence: body.sequence, startedAt: at, call: "work" });
  const pi: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
  let tick = 0;
  const observe = async (event: AgentSessionEvent): Promise<void> => {
    for (const translated of translatePiEvent(event, pi)) {
      await appendActivity(value.allocated.paths, { turnSequence: started.sequence,
        at: new Date(Date.parse(at) + (tick += 1) * 1_000).toISOString(), event: translated });
    }
  };
  const patch = "@@ -1,2 +1,2 @@\n-const answer = 1;\n+const answer = 2;\n";
  await observe({ type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "src/a.ts" } });
  await observe({ type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: false,
    result: { content: [{ type: "text", text: "edited src/a.ts" }], details: { patch } } });
  await observe({ type: "tool_execution_start", toolCallId: "run-1", toolName: "bash", args: { command: "npm test" } });
  await observe({ type: "tool_execution_end", toolCallId: "run-1", toolName: "bash", isError: false,
    result: { content: [{ type: "text", text: "3 passing\n" }] } });

  const root = await realpath(value.root);
  const history = historySchema.parse(await (await producer()).select(root, value.allocated.id).history({ limit: 200 }));
  const events: ProviderEvent[] = [];
  const mirror = createMirror("session", (event) => { ProviderEventSchema.parse(event); events.push(event); });
  mirror.publish(history);
  const calls = events.flatMap((event) => event.type === "timeline.item" && event.item.type === "tool_call"
    ? [event.item] : []);
  assert.deepEqual(calls.map((call) => call.name), ["edit", "bash"]);
  assert.deepEqual(calls[0]?.detail, { type: "edit", filePath: "src/a.ts", unifiedDiff: patch },
    "the native completion's own patch is the edit detail");
  assert.deepEqual(calls[1]?.detail, { type: "shell", command: "npm test", output: "3 passing\n" },
    "the native completion's own output is the shell output, not its diagnostic");
});

const FAKE_SDK = `import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const control = async () => { try { return JSON.parse(await readFile(new URL("./control.json", import.meta.url), "utf8")); } catch { return {}; } };
const empty = { rows: [], omitted: 0, hasEarlier: false, hasLater: false, historyLost: false, lowestRetained: null, highest: null };
const wait = (milliseconds, signal) => delay(milliseconds, undefined, { signal });
export const tellStarted = Promise.withResolvers();
export const streams = [];
export class Akuma {
  constructor(aku) { this.aku = aku; }
  static select(_world, aku) { return new Akuma(aku); }
  async tell(text, options) {
    tellStarted.resolve(options.signal);
    const values = await control();
    // A non-cooperative Tell never settles on its own; close owns the outcome.
    if (values.tellPending === true) await new Promise(() => {});
    if (values.tellDelayMs !== undefined) await wait(values.tellDelayMs, options.signal);
    if (values.tellMismatch === true) return { akuma: "aku/other/1", tell: values.tell.tell };
    return values.tell ?? { akuma: this.aku, tell: { admission: { fact: "recorded", tellId: "tell/1" },
      row: { kind: "tell", sequence: 1, at: "t", tellId: "tell/1", text, state: "pending", deliveries: [] },
      wake: { kind: "told" } } };
  }
  async kill() { return (await control()).evidence ?? "already-stopped"; }
  async status() { return (await control()).status ?? {}; }
  stream(options) {
    let opened = false;
    const observation = { signal: options.signal, returned: false };
    streams.push(observation);
    return { [Symbol.asyncIterator]: () => ({
      async next() {
        const values = await control();
        if (!opened) { opened = true; return { done: false, value: values.streamHistory ?? empty }; }
        await wait(values.streamDelayMs ?? 0, options.signal);
        if (values.streamDone === true) return { done: true, value: undefined };
        return { done: false, value: values.streamHistory ?? empty };
      },
      async return() { observation.returned = true; return { done: true, value: undefined }; },
    }) };
  }
}
`;

async function fakeTransport(t: TestContext, options: Readonly<{ timeoutMs?: number }> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-sdk-fake-"));
  const entry = join(directory, "sdk.mjs");
  await writeFile(entry, FAKE_SDK);
  const observed = await import(pathToFileURL(entry).href) as {
    tellStarted: { promise: Promise<AbortSignal> };
    streams: { signal: AbortSignal; returned: boolean }[];
  };
  // Publishing control atomically keeps each SDK read on a complete value.
  const set = async (values: unknown) => {
    const target = join(directory, "control.json");
    await writeFile(`${target}.next`, JSON.stringify(values));
    await rename(`${target}.next`, target);
  };
  const transport = createSdkTransport({ entry, ...options });
  t.after(async () => { await transport.close(); await rm(directory, { recursive: true, force: true }); });
  return { transport, set, tellStarted: observed.tellStarted.promise, streams: observed.streams };
}

test("PATH discovery retries failed loads, names incompatible versions, and caches success", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-sdk-load-"));
  const previousPath = process.env.PATH;
  const transport = createSdkTransport();
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  });
  const install = async (version: string, source: string): Promise<void> => {
    const root = join(directory, version, "package with spaces");
    const bin = join(directory, version, "bin");
    await mkdir(root, { recursive: true });
    await mkdir(bin);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@astrosheep/keiyaku", version,
      exports: { ".": { import: "./sdk.mjs", default: "./not-the-entry.mjs" } }, main: "./not-the-main.mjs" }));
    await writeFile(join(root, "sdk.mjs"), source);
    await writeFile(join(root, "cli.mjs"), "");
    await symlink(join(root, "cli.mjs"), join(bin, "keiyaku"));
    process.env.PATH = bin;
  };
  const signal = new AbortController().signal;
  process.env.PATH = "";
  await assert.rejects(transport.status("/world", "aku/test/1", signal), /executable is not on PATH/u);
  await install("0.0.1", "export class Akuma { stream() {} }");
  await assert.rejects(transport.status("/world", "aku/test/1", signal), /version 0\.0\.1.*Akuma\.select/u);
  await install("0.0.2", "export class Akuma { static select() {} }");
  await assert.rejects(transport.status("/world", "aku/test/1", signal), /version 0\.0\.2.*Akuma\.prototype\.stream/u);
  await install("1.0.0", FAKE_SDK);
  assert.deepEqual(await transport.status("/world", "aku/test/1", signal), {});
  process.env.PATH = "";
  assert.deepEqual(await transport.status("/world", "aku/test/1", signal), {}, "a successful load is retained for this plugin");
});

test("a bounded stream opening never submits a subscription after cancellation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-sdk-opening-"));
  const entry = join(directory, "sdk.mjs");
  await writeFile(entry, `await new Promise((resolve) => setTimeout(resolve, 100));\n${FAKE_SDK}`);
  const transport = createSdkTransport({ entry, timeoutMs: 20 });
  t.after(async () => { await transport.close(); await rm(directory, { recursive: true, force: true }); });
  const stream = transport.stream("/world", "aku/test/1", new AbortController().signal)[Symbol.asyncIterator]();
  await assert.rejects(stream.next(), /timed out after 20ms; the observation was released/u);
  const sdk = await import(pathToFileURL(entry).href) as { streams: unknown[] };
  assert.deepEqual(sdk.streams, [], "late SDK setup cannot open the abandoned observation");
  assert.equal((await stream.next()).done, true);
  const next = transport.stream("/world", "aku/test/1", new AbortController().signal)[Symbol.asyncIterator]();
  assert.deepEqual(pulled(await next.next()), [], "the later caller can use the successfully loaded SDK");
  await next.return?.();
});

/** The sequences one pulled frame reports; a done result is never a frame. */
function pulled(result: IteratorResult<History>): number[] {
  assert.ok(!result.done, "the observation reported a frame");
  return result.value.rows.map((row) => row.sequence);
}
/** One complete bounded window, as the public stream reports each frame. */
const frame = (sequence: number): History => ({ rows: [{ kind: "said", sequence, turnSequence: 1, at, text: `frame ${sequence}` }],
  omitted: 0, hasEarlier: false, hasLater: false, historyLost: false, lowestRetained: sequence, highest: sequence });

const RECEIPT = { akuma: "aku/test/1", tell: { admission: { fact: "recorded", tellId: "tell/7" },
  row: { kind: "tell", sequence: 7, at, tellId: "tell/7", text: "change direction", state: "pending",
    deliveries: [{ route: "live", turnSequence: 7, deliveredAt: at, receipt: "required" }] },
  wake: { kind: "told" } } };

test("the transport carries typed Tell admission, Stop evidence, and status", async (t) => {
  const { transport, set } = await fakeTransport(t);
  await set({ status: { provider: "pi", model: "kimi-coding/k3-256k" }, tell: RECEIPT });
  const signal = new AbortController().signal;

  const admitted = await transport.tell("/world", "aku/test/1", signal, "change direction");
  assert.equal(admitted.row.tellId, "tell/7");
  assert.deepEqual(tellPresentation(admitted), { row: admitted.row, result: { type: "turn", turnId: "turn/7" } });
  assert.deepEqual(tellPresentation(admitted, "turn/2"),
    { row: admitted.row, result: { type: "steer", turnId: "turn/2" } }, "steering correlates the captured Turn, not delivery");

  const warned = t.mock.method(console, "warn", () => {});
  await set({ tell: { ...RECEIPT, tell: { ...RECEIPT.tell, wake: { kind: "failed", diagnostic: "no provider" } } } });
  const failedWake = await transport.tell("/world", "aku/test/1", signal, "change direction");
  assert.deepEqual(tellPresentation(failedWake), { row: failedWake.row, result: { type: "turn", turnId: "turn/7" } },
    "a recorded Tell with a failed wake stays an admitted Tell, never a retried failure");
  await set({ tell: { ...RECEIPT, tell: { ...RECEIPT.tell, row: { ...RECEIPT.tell.row, deliveries: [] },
    wake: { kind: "failed", diagnostic: "no provider" } } } });
  const undelivered = await transport.tell("/world", "aku/test/1", signal, "change direction");
  assert.deepEqual(tellPresentation(undelivered), { row: undelivered.row, result: { type: "completed" } },
    "a recorded Tell with no delivery completes its send command without manufacturing an outcome");
  assert.ok(warned.mock.callCount() >= 2, "each failed wake keeps its diagnostic");
  warned.mock.restore();

  assert.deepEqual(await transport.stop("/world", "aku/test/1", signal), { kind: "stopped" });
  await set({ evidence: "untidy" });
  assert.deepEqual(await transport.stop("/world", "aku/test/1", signal),
    { kind: "not-stopped", message: "Keiyaku reported untidy for aku/test/1" });

  await set({ status: { provider: "pi", model: "kimi-coding/k3-256k" } });
  assert.deepEqual(await transport.status("/world", "aku/test/1", signal), { provider: "pi", model: "kimi-coding/k3-256k" });
  await set({ status: {} });
  assert.deepEqual(await transport.status("/world", "aku/test/1", signal), {}, "an unknown configuration is absent, never guessed");
});

test("a Tell receipt that does not name the submitted Tell is an uncertain outcome", async (t) => {
  const { transport, set } = await fakeTransport(t);
  await set({ tellMismatch: true, tell: RECEIPT });
  await assert.rejects(transport.tell("/world", "aku/test/1", new AbortController().signal, "change direction"),
    /outcome is uncertain/u);
});

test("cancellation reaches only its own SDK request", async (t) => {
  const { transport, set, tellStarted } = await fakeTransport(t);
  await set({ tellPending: true, status: { provider: "pi" } });
  const controller = new AbortController();
  const abandoned = transport.tell("/world", "aku/test/1", controller.signal, "change direction")
    .then(() => "resolved", (error: Error) => error.message);
  const requestSignal = await tellStarted;
  controller.abort(new Error("observation closed"));
  assert.equal(requestSignal.aborted, true, "cancellation reaches the actual SDK call");
  assert.equal(await abandoned, "observation closed", "a non-cooperative operation still releases its caller");
  assert.deepEqual(await transport.status("/world", "aku/test/1", new AbortController().signal), { provider: "pi" },
    "one request's cancellation never terminates unrelated work");
});

test("close aborts every owned request and subscription and refuses new work", async (t) => {
  const { transport, set, tellStarted, streams } = await fakeTransport(t);
  await set({ tellPending: true, streamHistory: frame(1), streamDelayMs: 5_000 });
  const inFlight = transport.tell("/world", "aku/test/1", new AbortController().signal, "change direction")
    .then(() => "resolved", (error: Error) => error.message);
  const requestSignal = await tellStarted;
  const stream = transport.stream("/world", "aku/test/1", new AbortController().signal)[Symbol.asyncIterator]();
  assert.deepEqual(pulled(await stream.next()), [1]);
  const idle = transport.stream("/world", "aku/other/1", new AbortController().signal)[Symbol.asyncIterator]();
  await idle.next();
  const inFlightFrame = stream.next().then(() => "resolved", (error: Error) => error.message);
  await transport.close();
  await transport.close();
  assert.equal(requestSignal.aborted, true);
  assert.equal(streams.length, 2);
  assert.ok(streams.every((observation) => observation.signal.aborted && observation.returned),
    "close releases readers even when they have no pull in flight");
  assert.match(await inFlight, /closed while the request was in flight; its outcome is uncertain/u);
  assert.match(await inFlightFrame, /closed while the request was in flight; the observation was released/u,
    "close settles the frame in flight as a released observation, not an uncertain request");
  assert.equal((await stream.next()).done, true, "a closed transport serves no further frame");
  assert.equal((await idle.next()).done, true);
  await assert.rejects(transport.stream("/world", "aku/test/1", new AbortController().signal)[Symbol.asyncIterator]().next(),
    /transport is closed/u);
  await assert.rejects(transport.tell("/world", "aku/test/1", new AbortController().signal, "change direction"),
    /transport is closed/u);
});

test("a subscription pulls one window at a time, opens on the current frame, and releases only its own observation", async (t) => {
  const { transport, set, streams } = await fakeTransport(t);
  const released = new AbortController();
  const sibling = new AbortController();
  t.after(() => { released.abort(); sibling.abort(); });
  await set({ streamHistory: frame(1) });
  const stream = transport.stream("/world", "aku/test/1", released.signal)[Symbol.asyncIterator]();
  assert.deepEqual(pulled(await stream.next()), [1],
    "the opening pull is the current window, exactly like the public stream's initial snapshot");
  await set({ streamHistory: frame(2) });
  assert.deepEqual(pulled(await stream.next()), [2], "each pull carries one complete window");

  // One frame at a time: a second pull while a frame is in flight is refused,
  // and the frame already in flight still settles.
  await set({ streamHistory: frame(3), streamDelayMs: 300 });
  const inFlight = stream.next();
  await assert.rejects(stream.next(), /already has a frame in flight/u,
    "a second pull is refused instead of putting two frames in flight");
  assert.deepEqual(pulled(await inFlight), [3], "the frame that was already in flight still settles");

  // A second observation is independent: releasing one settles only its own pull.
  const other = transport.stream("/world", "aku/other/1", sibling.signal)[Symbol.asyncIterator]();
  await set({ streamHistory: frame(4), streamDelayMs: 20 });
  assert.deepEqual(pulled(await other.next()), [4], "an unrelated subscription opens on its own subscription");
  const pending = stream.next();
  released.abort(new Error("observation released"));
  await assert.rejects(pending, /observation released/u, "abandoning a subscription settles its own pull");
  assert.equal((await stream.next()).done, true, "a released observation serves no further frame");
  assert.equal(streams[0]?.signal.aborted, true);
  assert.equal(streams[0]?.returned, true);
  assert.equal(streams[1]?.signal.aborted, false, "the sibling SDK subscription is not cancelled");
  await set({ status: { provider: "pi" } });
  assert.deepEqual(await transport.status("/world", "aku/test/1", new AbortController().signal), { provider: "pi" },
    "ordinary requests proceed while an observation waits");
  await set({ streamHistory: frame(5) });
  assert.deepEqual(pulled(await other.next()), [5],
    "the unrelated subscription keeps pulling after its neighbour is released");
  const returning = assert.rejects(other.next(), /observation was released/u, "return releases a pull already in flight");
  await other.return?.();
  await returning;
  assert.equal(streams[1]?.signal.aborted, true);
  assert.equal(streams[1]?.returned, true);
  assert.equal((await other.next()).done, true);
});

test("ended and invalid streams release their readers without reopening", async (t) => {
  const { transport, set, streams } = await fakeTransport(t);
  const signal = new AbortController().signal;
  const completed = transport.stream("/world", "aku/test/1", signal)[Symbol.asyncIterator]();
  await completed.next();
  await set({ streamDone: true });
  assert.equal((await completed.next()).done, true);
  assert.equal((await completed.next()).done, true);
  assert.equal(streams.length, 1, "a completed observation never opens again");
  assert.ok(streams[0]?.signal.aborted && streams[0]?.returned);

  await set({ streamHistory: { rows: [] } });
  const invalid = transport.stream("/world", "aku/test/1", signal)[Symbol.asyncIterator]();
  await assert.rejects(invalid.next());
  assert.equal((await invalid.next()).done, true);
  assert.ok(streams[1]?.signal.aborted && streams[1]?.returned, "a malformed frame releases its SDK reader");
});

test("an idle frame is never bounded by the ordinary request timeout", async (t) => {
  const { transport, set } = await fakeTransport(t, { timeoutMs: 400 });
  await set({ streamHistory: frame(1) });
  const stream = transport.stream("/world", "aku/test/1", new AbortController().signal)[Symbol.asyncIterator]();
  assert.deepEqual(pulled(await stream.next()), [1], "opening the subscription is one bounded handshake");
  await set({ streamHistory: frame(2), streamDelayMs: 1_200 });
  assert.deepEqual(pulled(await stream.next()), [2],
    "waiting for the next change is the observation's job, never a bounded request");
  await set({ tellDelayMs: 1_200 });
  await assert.rejects(transport.tell("/world", "aku/test/1", new AbortController().signal, "change direction"),
    /timed out after 400ms/u,
    "an ordinary request still carries its own bound");
});

/**
 * The real plugin bundle, compiled and evaluated exactly as the plugin process
 * loads it, with one appended export so this suite can reach the transport factory
 * the plugin wires in. It runs against the public package under test through
 * production PATH discovery: the transport finds that package's own declared
 * executable, never an injected entry. `undefined` only when the consumer's own
 * plugin compiler is unavailable.
 */
async function compiledConsumer(t: TestContext): Promise<Readonly<{
  events: ProviderEvent[];
  model: Readonly<{ provider?: string; model?: string }>;
  root: string;
  akuId: string;
  paths: Parameters<typeof endTurn>[0];
  bodySequence: number;
  turnSequence: number;
}> | undefined> {
  const consumer = await consumerToolchain();
  if (consumer === undefined) return undefined;
  const { compilePlugin, evaluateBundle } = consumer;
  const copied = join(await mkdtemp(join(tmpdir(), "paseo-plugin-copy-")), "plugin");
  t.after(() => rm(copied, { recursive: true, force: true }));
  await cp(PLUGIN_DIRECTORY, copied, { recursive: true });
  await appendFile(join(copied, "index.server.ts"), "\nexport { createSdkTransport } from \"./server/sdk.js\";\n");
  const bundles = await compilePlugin({ client: null, server: join(copied, "index.server.ts") });
  assert.ok(bundles.serverBundle, "the plugin server entry compiles under Paseo's own compiler");
  const setup = evaluateBundle(bundles.serverBundle) as unknown as (server: unknown) => unknown;
  const exported = evaluate(bundles.serverBundle);
  assert.equal(typeof setup, "function");
  assert.equal(typeof exported.createSdkTransport, "function",
    "the new transport module survives Paseo's bundling, including its non-literal SDK import");

  const registrations: string[] = [];
  const handlers: number[] = [];
  const providers: ProviderRegistration[] = [];
  let cleanup: (() => Promise<void>) | undefined;
  let connection: ProviderConnection | undefined;
  t.after(async () => { await connection?.close(); await cleanup?.(); });
  cleanup = (await setup({
    registerProvider(provider: ProviderRegistration) { registrations.push(provider.id); providers.push(provider); },
    handle() { handlers.push(1); },
    registerSettings() { throw new Error("the bridge registers no settings"); },
    registerUsageSource() { throw new Error("the bridge registers no usage source"); },
  })) as (() => Promise<void>) | undefined;
  assert.deepEqual(registrations, ["keiyaku"]);
  assert.equal(handlers.length, 2, "the compiled entry keeps its two RPC handlers");
  assert.equal(typeof cleanup, "function");
  assert.equal(providers.length, 1);

  const value = await soulFixture("paseo-sdk-evaluated-");
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  t.after(() => { leash.release(); value.close(); });
  await writeFile(join(value.root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await leash.birth(value.allocated.paths, value.soul);
  const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: at });
  const started = await beginTurn(value.allocated.paths, { bodySequence: body.sequence, startedAt: at, call: "work" });
  await appendActivity(value.allocated.paths, { turnSequence: started.sequence, at,
    event: { type: "thought", text: "checking the real core" } });
  await appendActivity(value.allocated.paths, { turnSequence: started.sequence, at,
    event: { type: "tool", phase: "started", id: "shell", name: "bash", call: { kind: "run", command: "printf hello" } } });

  // Production discovery: the plugin passes no entry. The transport locates the
  // public package through the `keiyaku` executable on PATH, then through that
  // package's own declared public entry.
  const pathDirectory = await mkdtemp(join(tmpdir(), "paseo-sdk-path-"));
  const bin = join(pathDirectory, "bin");
  await mkdir(bin);
  await symlink(PUBLIC_CLI, join(bin, "keiyaku"));
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    return rm(pathDirectory, { recursive: true, force: true }); });

  connection = await providers[0]!.connect({ versions: [1], capabilities: ["session.persistence", "prompt.message"] });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send({ type: "session.open", requestId: "open", sessionId: "session", history: "replay",
    config: { cwd: value.root, env: {}, mcpServers: {}, settings: {}, persist: true,
      providerOptions: { world: value.root, akuId: value.allocated.id } } });
  return { events, model: await producerModel(value.root, value.allocated.id),
    root: await realpath(value.root), akuId: value.allocated.id, paths: value.allocated.paths,
    bodySequence: body.sequence, turnSequence: started.sequence };
}

test("the installed Paseo compiler and evaluator run the plugin and its in-process SDK transport", async (t) => {
  const consumer = await compiledConsumer(t);
  if (consumer === undefined) {
    t.skip("@getpaseo/server is not installed: the consumer's own plugin compiler is unavailable");
    return;
  }
  const { events, model } = consumer;
  assert.deepEqual(events.find((event) => event.type === "session.config")?.config, {
    ...(model.model === undefined ? {} : { model: model.model }),
    models: model.model === undefined ? []
      : [{ id: model.model, label: `${model.provider} / ${model.model}`, isSelectable: false }],
    modes: [], thinkingOptions: [], settings: [],
  }, "the evaluated bundle reports the real Akuma's own model through PATH discovery");
  assert.equal(events.some((event) => event.type === "session.notice"), false, "a reported model raises no notice");
  assert.equal(events.filter((event) => event.type === "session.ready").length, 1,
    "readiness names the first observed window or its explicit absence, and never waits for the observation to end");
});

test("the evaluated bundle mirrors a real Akuma through the public streaming surface", async (t) => {
  const consumer = await compiledConsumer(t);
  if (consumer === undefined) {
    t.skip("@getpaseo/server is not installed: the consumer's own plugin compiler is unavailable");
    return;
  }
  const { events, turnSequence } = consumer;
  type Item = { type: string; id?: string; callId?: string; status?: string; text?: string; message?: string };
  const items = (): Item[] => events.flatMap((event) => event.type === "timeline.item" ? [event.item as Item] : []);
  const until = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!predicate() && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 25));
  };

  assert.deepEqual(events.filter((event) => event.type === "session.turn").map((event) => event.state), ["started"],
    "the evaluated bundle publishes the real open Turn the real core reports, not a fixture");
  assert.ok(items().some((item) => item.type === "reasoning" && item.text === "checking the real core"),
    "a mid-turn record crosses the real transport boundary and Paseo's own bundling of it");
  assert.equal(items().some((item) => item.message !== undefined && /read surface unavailable/u.test(item.message)), false,
    "a package that declares the streaming surface mirrors through it instead of reporting it unavailable");
  assert.equal(events.filter((event) => event.type === "session.ready").length, 1);

  // The producer's own tool identity, asserted live: the open start is already
  // one native item named by that identity, and its witnessed completion updates
  // the same item instead of adding an unpaired record beside a notice.
  const callId = `tool/${turnSequence}/shell`;
  const tools = (): [string | undefined, string | undefined][] => items()
    .filter((item) => item.type === "tool_call").map((item) => [item.callId, item.status]);
  assert.deepEqual(tools(), [[callId, "running"]],
    "the open tool is one native item carrying the producer's own identity, not an observation notice");
  await appendActivity(consumer.paths, { turnSequence, at, event: { type: "tool", phase: "completed", id: "shell",
    name: "bash", call: { kind: "run", command: "printf hello" },
    result: { status: "ok", message: "hello", exitCode: 0 } } });
  await until(() => tools().some(([, status]) => status === "completed"));
  assert.deepEqual(tools(), [[callId, "running"], [callId, "completed"]],
    "the completion updates that one item rather than pairing by names, arguments or timestamps");

  // The producer's own fold identity, asserted live: the answered outcome reuses
  // the live narration's identity, so the identical final upsert stays the
  // host's to suppress instead of appearing as a second message.
  await appendActivity(consumer.paths, { turnSequence, at, event: { type: "assistant", text: "the final line" } });
  const spoken = () => items().filter((item) => item.type === "assistant_message" && item.text === "the final line");
  await until(() => spoken().length > 0);
  const live = spoken()[0];
  assert.ok(live?.id !== undefined, "intermediate speech arrives as its own native message");
  await endTurn(consumer.paths, { turnSequence, completedAt: at,
    outcome: { kind: "answered", answer: "the final line", session: { sessionId: "paseo-sdk-evaluated" } } });
  await until(() => spoken().length > 1);
  assert.deepEqual(spoken().map((item) => item.id), [live?.id, live?.id],
    "the outcome reuses the live narration's own identity, not a new message that repeats the same text");

  // One observation for the session's whole life, idle included: sealing this
  // Turn and starting a later one must arrive through that same subscription,
  // with no interval, timer or reopen.
  const later = await beginTurn(consumer.paths, { bodySequence: consumer.bodySequence, startedAt: at, call: "later" });
  const started = () => events.filter((event) => event.type === "session.turn" && event.state === "started").length;
  await until(() => started() === 2);
  assert.equal(started(), 2,
    `a later Turn (${later.sequence}) after an idle stretch arrives through the same observation, never a timer`);
});

test("the real public package admits one Tell through the transport while custody is held", async (t) => {
  const value = await soulFixture("paseo-sdk-tell-");
  const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
  let released = false;
  const release = () => { if (!released) { released = true; leash.release(); } };
  const transport = createSdkTransport({ entry: PUBLIC_ENTRY });
  t.after(async () => { await transport.close(); release(); value.close(); });
  await writeFile(join(value.root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await leash.birth(value.allocated.paths, value.soul);
  const root = await realpath(value.root);

  const admitted = await transport.tell(root, value.allocated.id, new AbortController().signal, "change direction");
  assert.equal(admitted.admission.fact, "recorded");
  assert.equal(admitted.row.text, "change direction", "the receipt names the Tell the caller submitted");
  assert.equal(admitted.row.state, "pending", "admission is never a claim of delivery");
  assert.deepEqual(admitted.row.deliveries, [], "held custody delivers nothing");
  assert.deepEqual(admitted.wake, { kind: "held" }, "a held leash is reported as held, not as a failed wake");
  assert.deepEqual(tellReceiptSchema.parse({ akuma: value.allocated.id, tell: admitted }).tell, admitted,
    "the transport's admission is the public receipt verbatim");

  const stream = transport.stream(root, value.allocated.id, new AbortController().signal)[Symbol.asyncIterator]();
  const frame = await stream.next();
  assert.ok(!frame.done, "the transport serves the real package's own bounded window");
  const recorded = frame.value.rows.find((row) => row.kind === "tell");
  await stream.return?.();
  assert.ok(recorded?.kind === "tell");
  assert.equal(recorded.tellId, admitted.row.tellId, "the admitted Tell is durably recorded, not merely acknowledged");
  assert.equal(recorded.text, "change direction");
});
