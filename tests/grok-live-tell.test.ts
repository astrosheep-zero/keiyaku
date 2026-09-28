import assert from "node:assert/strict";
import { PassThrough, Readable, Transform, Writable } from "node:stream";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import type { DriveInput, ProviderAdapter, ProviderAttempt, Session, TurnResult } from "../src/akuma/provider.js";
import type { ProviderExecution } from "../src/akuma/provider-recipe.js";
import { createGrokBuildProvider } from "../src/akuma/providers/grok-build/index.js";
import type { StdioProcess } from "../src/runtime/proc/stdio.js";
import { deferred, waitForCondition } from "./support/process.js";

/**
 * The installed Grok 1.0.13 transport spells its extension `_x.ai/interject` and
 * broadcasts admission as `_x.ai/session/interjection`. This suite drives a
 * native-shaped ACP agent over real framed streams so a regression to the older
 * `x.ai/interject` spelling, or a receipt manufactured from the RPC reply
 * alone, fails on the wire rather than on an internal stand-in.
 */
const INTERJECT_METHOD = "_x.ai/interject";
const INTERJECTION_METHOD = "_x.ai/session/interjection";
const LEGACY_INTERJECT_METHOD = "x.ai/interject";
const NATIVE_SESSION_ID = "grok-native-session";

type Interjection = Readonly<{ sessionId: string; text: string; interjectionId: string }>;
type InterjectMode = "broadcast" | "response-first" | "silent" | "rejected" | "nonqueued";

type NativeGrokProcess = Readonly<{
  process: StdioProcess;
  interjectStarted: Promise<void>;
  interjectRpcSettled: Promise<void>;
  cleanupStarted: Promise<void>;
  interjections: readonly Interjection[];
  clientFrames: readonly string[];
  serverFrames: readonly string[];
  emitInterjection(value: Interjection): Promise<void>;
  releaseInterject(): void;
  rejectInterject(error: Error): void;
  resolvePrompt(): void;
  resolveCleanup(): void;
  cancelled(): number;
  forcedCleanup(): number;
}>;

/** Passes bytes through unchanged while retaining each chunk for wire assertions. */
function recordFrames(sink: string[]): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sink.push(chunk.toString("utf8"));
      callback(null, chunk);
    },
  });
}

function nativeGrokProcess(options: Readonly<{ interject: InterjectMode; stallPrompt?: boolean }>): NativeGrokProcess {
  const toAgent = new PassThrough();
  const agentInput = new PassThrough();
  const agentOutput = new PassThrough();
  const toProvider = new PassThrough();
  const clientFrames: string[] = [];
  const serverFrames: string[] = [];
  toAgent.pipe(recordFrames(clientFrames)).pipe(agentInput);
  agentOutput.pipe(recordFrames(serverFrames)).pipe(toProvider);

  const interjectStarted = deferred<void>();
  const interjectRpcSettled = deferred<void>();
  const cleanupStarted = deferred<void>();
  const promptGate = deferred<void>();
  const rpcGate = deferred<void>();
  const cleanup = deferred<void>();
  const exited = deferred<Readonly<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>>();
  const interjections: Interjection[] = [];
  let forcedCleanup = 0;
  let cancelled = 0;
  let emitInterjection!: (value: Interjection) => Promise<void>;

  const app = acp
    .agent({ name: "native-grok" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => ({
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true },
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: NATIVE_SESSION_ID }))
    .onRequest(acp.methods.agent.session.prompt, async () => {
      if (options.stallPrompt === true) await promptGate.promise;
      return { stopReason: "end_turn" as const };
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      cancelled += 1;
    })
    .onRequest<Interjection, { status: string }>(
      INTERJECT_METHOD,
      (value) => value as Interjection,
      async ({ params, client }) => {
        interjections.push(params);
        emitInterjection = async (value) => await client.notify(INTERJECTION_METHOD, value);
        interjectStarted.resolve();
        if (options.interject === "rejected") throw new acp.RequestError(-32603, "interject rejected");
        if (options.interject === "broadcast") {
          await emitInterjection(params);
          return { status: "queued" };
        }
        if (options.interject === "nonqueued") return { status: "accepted" };
        if (options.interject === "response-first") {
          try {
            await rpcGate.promise;
          } finally {
            interjectRpcSettled.resolve();
          }
          return { status: "queued" };
        }
        return { status: "queued" };
      },
    );
  app.connect(
    acp.ndJsonStream(
      Writable.toWeb(agentOutput) as WritableStream<Uint8Array>,
      Readable.toWeb(agentInput) as ReadableStream<Uint8Array>,
    ),
  );

  return {
    process: {
      input: toAgent,
      output: toProvider,
      exited: exited.promise,
      endInputAndDrain: async () => {
        cleanupStarted.resolve();
        await cleanup.promise;
        exited.resolve({ code: 0, signal: null, stderr: "" });
      },
      close: async (force = false) => {
        if (force) {
          forcedCleanup += 1;
          cleanup.resolve();
        }
        await cleanup.promise;
        exited.resolve({ code: null, signal: force ? "SIGKILL" : null, stderr: "" });
      },
    },
    interjectStarted: interjectStarted.promise,
    interjectRpcSettled: interjectRpcSettled.promise,
    cleanupStarted: cleanupStarted.promise,
    interjections,
    clientFrames,
    serverFrames,
    emitInterjection: async (value) => await emitInterjection(value),
    releaseInterject: () => rpcGate.resolve(),
    rejectInterject: (error) => rpcGate.reject(error),
    resolvePrompt: () => promptGate.resolve(),
    resolveCleanup: () => cleanup.resolve(),
    cancelled: () => cancelled,
    forcedCleanup: () => forcedCleanup,
  };
}

const GROK_EXECUTION: ProviderExecution = { name: "grok-build", kind: "grok-build", executable: "grok" };

function grokProvider(controlled: NativeGrokProcess): ProviderAdapter {
  return createGrokBuildProvider(GROK_EXECUTION, { spawnProcess: () => controlled.process });
}

function freshInput(): DriveInput & { session: { kind: "fresh" } } {
  return {
    body: "native grok work",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    signal: new AbortController().signal,
    requests: { dir: "/tmp/akuma-test-requests" },
    session: { kind: "fresh" },
  };
}

async function startSession(
  controlled: NativeGrokProcess,
): Promise<Readonly<{ attempt: ProviderAttempt<Session>; session: Session }>> {
  const attempt = grokProvider(controlled).start(freshInput());
  return { attempt, session: await attempt.result };
}

async function finishTurn(
  controlled: NativeGrokProcess,
  attempt: ProviderAttempt<Session>,
  session: Session,
): Promise<TurnResult> {
  controlled.resolvePrompt();
  await controlled.cleanupStarted;
  controlled.resolveCleanup();
  const completion = await session.completion;
  await attempt.closed;
  return completion;
}

function microtasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Bounded wait so a production hang fails the assertion instead of the suite. */
function bounded<Value>(promise: Promise<Value>, ms = 2_000): Promise<Value | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parsedFrames(frames: readonly string[]): readonly Readonly<Record<string, unknown>>[] {
  return frames
    .join("")
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return [];
      const parsed: unknown = JSON.parse(trimmed);
      return parsed !== null && typeof parsed === "object" ? [parsed as Readonly<Record<string, unknown>>] : [];
    });
}

function wireMethods(frames: readonly string[]): readonly string[] {
  return parsedFrames(frames).flatMap((frame) => (typeof frame["method"] === "string" ? [frame["method"]] : []));
}

function interjectRequestIds(controlled: NativeGrokProcess): ReadonlySet<unknown> {
  return new Set(
    parsedFrames(controlled.clientFrames)
      .filter((frame) => frame["method"] === INTERJECT_METHOD)
      .map((frame) => frame["id"]),
  );
}

function hasInterjectReply(controlled: NativeGrokProcess, status: string): boolean {
  const ids = interjectRequestIds(controlled);
  return parsedFrames(controlled.serverFrames).some((frame) => {
    const result = frame["result"];
    return (
      ids.has(frame["id"]) &&
      result !== null &&
      typeof result === "object" &&
      (result as { status?: unknown }).status === status
    );
  });
}

/** Waits until the native agent has answered the interject RPC, observing ordering instead of assuming it. */
async function awaitInterjectReply(controlled: NativeGrokProcess, status: string): Promise<void> {
  await waitForCondition(`native interject reply ${status}`, () => hasInterjectReply(controlled, status));
}

test("Grok Build admits a live tell on the exact native broadcast before the interject RPC reply", async () => {
  const controlled = nativeGrokProcess({ interject: "response-first", stallPrompt: true });
  const { attempt, session } = await startSession(controlled);
  const receipt = session.tell!({ id: "tell-1", text: "change direction" });
  await controlled.interjectStarted;

  await controlled.emitInterjection({
    sessionId: NATIVE_SESSION_ID,
    interjectionId: "tell-1",
    text: "change direction",
  });
  assert.deepEqual(await receipt, { kind: "accepted", fence: "tell-1" });
  assert.equal(hasInterjectReply(controlled, "queued"), false);

  controlled.releaseInterject();
  await controlled.interjectRpcSettled;
  await awaitInterjectReply(controlled, "queued");
  assert.ok(wireMethods(controlled.clientFrames).includes(INTERJECT_METHOD));
  assert.ok(wireMethods(controlled.serverFrames).includes(INTERJECTION_METHOD));
  assert.equal(wireMethods(controlled.clientFrames).includes(LEGACY_INTERJECT_METHOD), false);
  assert.deepEqual(controlled.interjections, [
    { sessionId: NATIVE_SESSION_ID, text: "change direction", interjectionId: "tell-1" },
  ]);
  assert.deepEqual(await finishTurn(controlled, attempt, session), { kind: "answered", answer: "" });
});

test("Grok Build waits for the native broadcast when the interject RPC already answered queued", async () => {
  const controlled = nativeGrokProcess({ interject: "silent", stallPrompt: true });
  const { attempt, session } = await startSession(controlled);
  const receipt = session.tell!({ id: "one", text: "same text" });
  await controlled.interjectStarted;
  await awaitInterjectReply(controlled, "queued");
  let settled = false;
  void receipt.then(() => {
    settled = true;
  });
  await microtasks();
  assert.equal(settled, false);

  await controlled.emitInterjection({ sessionId: NATIVE_SESSION_ID, interjectionId: "one", text: "same text" });
  assert.deepEqual(await receipt, { kind: "accepted", fence: "one" });
  assert.deepEqual(await finishTurn(controlled, attempt, session), { kind: "answered", answer: "" });
});

test("Grok Build correlates by exact session and interjection id and ignores duplicates", async () => {
  const controlled = nativeGrokProcess({ interject: "silent", stallPrompt: true });
  const { attempt, session } = await startSession(controlled);
  const receipt = session.tell!({ id: "exact", text: "same text" });
  await controlled.interjectStarted;
  let outcome: unknown;
  void receipt.then((value) => {
    outcome = value;
  });

  await controlled.emitInterjection({ sessionId: "other-session", interjectionId: "exact", text: "same text" });
  await controlled.emitInterjection({ sessionId: NATIVE_SESSION_ID, interjectionId: "other-id", text: "same text" });
  const probe = session.tell!({ id: "probe", text: "same text" });
  await controlled.emitInterjection({ sessionId: NATIVE_SESSION_ID, interjectionId: "probe", text: "same text" });
  assert.deepEqual(await probe, { kind: "accepted", fence: "probe" });
  await microtasks();
  assert.equal(outcome, undefined);

  await controlled.emitInterjection({ sessionId: NATIVE_SESSION_ID, interjectionId: "exact", text: "same text" });
  assert.deepEqual(await receipt, { kind: "accepted", fence: "exact" });
  await controlled.emitInterjection({ sessionId: NATIVE_SESSION_ID, interjectionId: "exact", text: "same text" });
  await microtasks();
  assert.deepEqual(outcome, { kind: "accepted", fence: "exact" });
  assert.deepEqual(await finishTurn(controlled, attempt, session), { kind: "answered", answer: "" });
});

test("Grok Build keeps transport failure honest and never manufactures admission", async () => {
  const rejected = nativeGrokProcess({ interject: "rejected", stallPrompt: true });
  const rejectedRun = await startSession(rejected);
  await assert.rejects(rejectedRun.session.tell!({ id: "native-failure", text: "change" }), /interject rejected/u);
  assert.deepEqual(await finishTurn(rejected, rejectedRun.attempt, rejectedRun.session), {
    kind: "answered",
    answer: "",
  });

  const nonqueued = nativeGrokProcess({ interject: "nonqueued", stallPrompt: true });
  const nonqueuedRun = await startSession(nonqueued);
  await assert.rejects(nonqueuedRun.session.tell!({ id: "status-failure", text: "change" }), /did not return queued/u);
  assert.deepEqual(await finishTurn(nonqueued, nonqueuedRun.attempt, nonqueuedRun.session), {
    kind: "answered",
    answer: "",
  });
});

test("Grok Build settles a pending tell turn-ended on native completion before cleanup finishes", async () => {
  const controlled = nativeGrokProcess({ interject: "silent", stallPrompt: true });
  const { attempt, session } = await startSession(controlled);
  const submission = session.tell!({ id: "pending", text: "too late" });
  await controlled.interjectStarted;

  controlled.resolvePrompt();
  assert.deepEqual(await bounded(submission), { kind: "turn-ended" });
  await controlled.cleanupStarted;
  controlled.resolveCleanup();
  assert.deepEqual(await session.completion, { kind: "answered", answer: "" });
  await attempt.closed;
});

test("Grok Build settles a pending tell turn-ended on graceful abort or forced disposal", async () => {
  const aborted = nativeGrokProcess({ interject: "silent", stallPrompt: true });
  const abortedRun = await startSession(aborted);
  const abortSubmission = abortedRun.session.tell!({ id: "abort-pending", text: "stop" });
  await aborted.interjectStarted;
  const aborting = abortedRun.session.abort();
  assert.deepEqual(await bounded(abortSubmission), { kind: "turn-ended" });
  await aborting;
  assert.equal(aborted.cancelled(), 1);
  assert.equal(aborted.forcedCleanup(), 1);
  assert.deepEqual(await abortedRun.session.completion, { kind: "failed", diagnostic: "ACP turn cancelled" });
  await abortedRun.attempt.closed;

  const disposed = nativeGrokProcess({ interject: "silent", stallPrompt: true });
  const disposedRun = await startSession(disposed);
  const disposeSubmission = disposedRun.session.tell!({ id: "dispose-pending", text: "stop" });
  await disposed.interjectStarted;
  const disposing = disposedRun.session.forceDispose();
  assert.deepEqual(await bounded(disposeSubmission), { kind: "turn-ended" });
  await disposing;
  assert.equal(disposed.forcedCleanup(), 1);
  assert.deepEqual(await disposedRun.session.completion, { kind: "failed", diagnostic: "ACP turn force-disposed" });
  await disposedRun.attempt.closed;
});

test("Grok Build keeps winning broadcast evidence across a late terminal and RPC error", async () => {
  const controlled = nativeGrokProcess({ interject: "response-first", stallPrompt: true });
  const { attempt, session } = await startSession(controlled);
  const receipt = session.tell!({ id: "winner", text: "change" });
  await controlled.interjectStarted;

  await controlled.emitInterjection({ sessionId: NATIVE_SESSION_ID, interjectionId: "winner", text: "change" });
  assert.deepEqual(await receipt, { kind: "accepted", fence: "winner" });

  controlled.rejectInterject(new acp.RequestError(-32603, "late native failure"));
  await controlled.interjectRpcSettled;
  assert.deepEqual(await finishTurn(controlled, attempt, session), { kind: "answered", answer: "" });
  assert.deepEqual(await receipt, { kind: "accepted", fence: "winner" });
});

test("Grok Build refuses further submissions once the native turn closed", async () => {
  const controlled = nativeGrokProcess({ interject: "silent", stallPrompt: true });
  const { attempt, session } = await startSession(controlled);
  const first = session.tell!({ id: "first", text: "one" });
  await controlled.interjectStarted;
  await controlled.emitInterjection({ sessionId: NATIVE_SESSION_ID, interjectionId: "first", text: "one" });
  assert.deepEqual(await first, { kind: "accepted", fence: "first" });

  controlled.resolvePrompt();
  await controlled.cleanupStarted;
  assert.deepEqual(await session.tell!({ id: "after-close", text: "two" }), { kind: "turn-ended" });
  assert.equal(wireMethods(controlled.clientFrames).filter((method) => method === INTERJECT_METHOD).length, 1);
  controlled.resolveCleanup();
  assert.deepEqual(await session.completion, { kind: "answered", answer: "" });
  await attempt.closed;
});
