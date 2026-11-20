import { failDispatcherRetirement, nativeEndpoint, opencodeFixture, ownedOpenCode } from "./support/opencode-v2.js";
import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import type { Query, SDKMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";
import {
  AGENT_EVENT_QUEUE_LIMIT,
  createProviderAttempt,
  otherToolCall,
  decodeAgentEvent,
  encodeAgentEvent,
  AgentEventChannel,
  noteEvent,
  type AgentEvent,
  type AttemptCustody,
  type ProviderAttempt,
  type TurnResult,
  type DriveInput,
} from "../src/akuma/provider.js";
import { KeiyakuError } from "../src/errors.js";
import { createClaudeProvider } from "../src/akuma/providers/claude/index.js";
import { createCodexAppServerProvider } from "../src/akuma/providers/codex-app-server/index.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { composeHeadlessPermissionConfig } from "../src/akuma/providers/opencode-sdk/session.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import { createAcpProvider, decodeAcpConfig } from "../src/akuma/providers/acp/index.js";
import { createAcpEventState, emitAcpUpdate } from "../src/akuma/providers/acp/events.js";
import { emitClaudeMessage } from "../src/akuma/providers/claude/events.js";
import {
  codexNotificationResult,
  type CodexTurnState,
} from "../src/akuma/providers/codex-app-server/events.js";
import type { LineRpcNotification } from "../src/runtime/proc/line-rpc.js";
import { translatePiEvent, piSessionModel, type PiEventState } from "../src/akuma/providers/pi/events.js";
import { createEventState, mapEvent } from "../src/akuma/providers/opencode-sdk/events.js";
import { ToolObservations } from "../src/akuma/providers/tool-observations.js";
import { providerTurn } from "../src/akuma/providers/turn.js";
import { spawnStdioProcess, type StdioProcess } from "../src/runtime/proc/stdio.js";
import { processExists, waitForCondition, waitForFixtureFile } from "./support/process.js";

const DRIVE_DEFAULTS = {
  signal: new AbortController().signal,
} as const;

/** Fresh carrier objects; non-default recipe and admission inputs remain at each call site. */
function freshInput(
  text: string | readonly string[],
  extra: Partial<Omit<DriveInput, "launchTells">> = {},
): DriveInput & { session: { kind: "fresh" } } {
  const launchTells = (typeof text === "string" ? [text] : text).map((text, index) => ({ id: `launch-${index}`, text }));
  return { ...DRIVE_DEFAULTS, launchTells, cwd: "/tmp", options: {}, ...extra, session: { kind: "fresh" } };
}

function attemptResult<Result>(attempt: ProviderAttempt<Result>): Promise<Result> {
  return attempt.result;
}

function piSink() {
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent): void => void events.push(event);
  const state: PiEventState = { answer: "", assistantSeen: false, tools: new ToolObservations(emit) };
  return { events, observe: (event: Parameters<typeof translatePiEvent>[0]) => translatePiEvent(event, state, emit) };
}

function acpSink() {
  const events: AgentEvent[] = [];
  const emit = (event: AgentEvent): void => void events.push(event);
  const state = createAcpEventState(emit);
  return { events, emit, state, observe: (update: acp.SessionUpdate) => emitAcpUpdate(update, state, emit) };
}

test("observed tool output and patches stay bounded, code-point safe, and distinct from absence", () => {
  const patch = ["@@ -1,2 +1,3 @@", " keep", "-old", "+new", "+extra"].join("\n");
  const observed: AgentEvent = {
    type: "tool",
    phase: "completed",
    id: "observed",
    name: "edit",
    call: {
      kind: "fileChange",
      changes: [{ op: "update", path: "src/observed.ts", diffstat: { added: 2, removed: 1 }, patch }],
    },
    result: { status: "ok", output: "applied 2 changes" },
  };
  assert.deepEqual(decodeAgentEvent(encodeAgentEvent(observed)), observed);

  const empty: AgentEvent = {
    type: "tool",
    phase: "completed",
    id: "empty",
    name: "edit",
    call: { kind: "fileChange", changes: [{ op: "update", path: "src/empty.ts", patch: "" }] },
    result: { status: "ok", output: "" },
  };
  assert.deepEqual(
    decodeAgentEvent(encodeAgentEvent(empty)),
    empty,
    "an observed empty value stays present rather than collapsing into absence",
  );

  const silent: AgentEvent = {
    type: "tool",
    phase: "completed",
    id: "silent",
    name: "read",
    call: { kind: "read", path: "src/silent.ts" },
    result: { status: "ok" },
  };
  const decodedSilent = decodeAgentEvent(encodeAgentEvent(silent));
  assert.deepEqual(decodedSilent, silent, "a row that observed neither value stays byte-identical to today");

  const oversized: AgentEvent = {
    type: "tool",
    phase: "completed",
    id: "oversized",
    name: "edit",
    call: { kind: "fileChange", changes: [{ op: "update", path: "src/big.ts", patch: "😀".repeat(20_000) }] },
    result: { status: "ok", output: "😀".repeat(20_000) },
  };
  const bounded = encodeAgentEvent(oversized);
  assert.equal(bounded.type === "tool" && bounded.truncated, true, "the row keeps its coarse truncation flag");
  if (bounded.type !== "tool" || bounded.phase !== "completed" || bounded.call.kind !== "fileChange") {
    throw new Error("missing bounded completion");
  }
  const boundedPatch = bounded.call.changes[0]?.patch;
  const boundedOutput = bounded.result.output;
  assert.ok(boundedPatch !== undefined && boundedOutput !== undefined);
  for (const value of [boundedPatch, boundedOutput]) {
    assert.ok(value.length <= 16_384, "an observed value stays inside the narration bound");
    assert.doesNotThrow(() => encodeURIComponent(value), "the cut lands on a complete code point");
    assert.ok(value.endsWith("\n…[truncated]"), "the cut is visible where it happened");
  }
  const marker = "\n…[truncated]";
  assert.equal(boundedPatch, "😀".repeat((16_384 - marker.length) / 2) + marker);
  assert.deepEqual(encodeAgentEvent(bounded), bounded, "re-encoding an already bounded observation changes nothing");
});

/** Drain one synchronous channel's already-queued events without a live waiter. */
async function drainChannel(channel: AgentEventChannel): Promise<readonly AgentEvent[]> {
  channel.end();
  const events: AgentEvent[] = [];
  for await (const event of channel) events.push(event);
  return events;
}

/** Drain one provider attempt's event stream for later assertion. */
async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<readonly AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function acpToolUpdate(
  sessionUpdate: "tool_call" | "tool_call_update",
  toolCallId: string,
  rawInput?: unknown,
): acp.SessionUpdate {
  return {
    sessionUpdate,
    toolCallId,
    ...(sessionUpdate === "tool_call"
      ? { title: "future", name: "future_tool", kind: "other", status: "in_progress" }
      : { status: "completed" }),
    ...(rawInput === undefined ? {} : { rawInput }),
  } as acp.SessionUpdate;
}

function mapOpencodeTool(status: string, input: unknown, emitter: Parameters<typeof mapEvent>[1], state: ReturnType<typeof createEventState>) {
  const data = { sessionID: "session-1", assistantMessageID: "msg_assistant", id: "oc-1" };
  if (status === "running") {
    mapEvent({ type: "session.tool.input.started", data: { ...data, name: "future_tool" } }, emitter, state);
    if (input !== undefined) mapEvent({ type: "session.tool.called", data: { ...data, input, executed: false } }, emitter, state);
  } else mapEvent({ type: "session.tool.success", data: { ...data, ...(input === undefined ? {} : { input }), content: [{ type: "text", text: "" }], executed: false } }, emitter, state);
}

function toolPreview(events: readonly AgentEvent[]) {
  const event = events.at(-1);
  return event?.type === "tool" && event.call.kind === "other" ? event.call.input : undefined;
}

test("native tool replay cannot replace the observed invocation or emit a second completion", async () => {
  const pi = piSink();
  const start = { type: "tool_execution_start", toolCallId: "pi-replay", toolName: "future", args: undefined } as const;
  const end = { type: "tool_execution_end", toolCallId: "pi-replay", toolName: "future", isError: false, result: { content: "" } } as const;
  pi.observe(start);
  pi.observe({ ...start, args: null });
  pi.observe({ ...start, args: {} });
  pi.observe(end);
  pi.observe(end);
  pi.observe(start);
  pi.observe({ ...end, toolCallId: "pi-unmatched", toolName: "edit", result: { details: { patch: "not correlated" } } });
  assert.deepEqual(pi.events, [
    { type: "tool", phase: "started", id: "pi-replay", name: "future", call: { kind: "other", display: "future" } },
    { type: "tool", phase: "completed", id: "pi-replay", name: "future", call: otherToolCall("future", null), result: { status: "ok", output: "" } },
    { type: "tool", phase: "completed", id: "pi-unmatched", name: "edit", call: { kind: "other", display: "edit" }, result: { status: "ok" } },
  ]);

  const channel = new AgentEventChannel();
  const tools = new ToolObservations((event) => channel.emit(event));
  const claude = (type: "assistant" | "user", content: unknown[]) =>
    emitClaudeMessage({ type, message: { content } } as SDKMessage, channel, tools);
  const invocation = { type: "tool_use", id: "claude-replay", name: "Read", input: { file_path: " a.ts ", offset: 2, limit: 0 } };
  const result = { type: "tool_result", tool_use_id: "claude-replay", content: "" };
  claude("user", [{ ...result, tool_use_id: "claude-unmatched" }]);
  claude("assistant", [invocation, invocation]);
  claude("user", [result, result]);
  claude("assistant", [invocation]);
  const call = { kind: "read", path: " a.ts ", offset: 2 };
  assert.deepEqual(await drainChannel(channel), [
    { type: "tool", phase: "started", id: "claude-replay", name: "Read", call },
    { type: "tool", phase: "completed", id: "claude-replay", name: "Read", call, result: { status: "ok", output: "" } },
  ]);
});

test("Claude retains observed result text, a supplied patch, and a native hunk record", async () => {
  const patch = ["@@ -1 +1 @@", "-before", "+after"].join("\n");
  const run = async (toolUseResult: unknown, content: unknown) => {
    const channel = new AgentEventChannel();
    const state = new ToolObservations((event) => channel.emit(event));
    emitClaudeMessage(
      {
        type: "assistant",
        uuid: "assistant-edit",
        session_id: "session-claude",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_use",
              id: "edit-1",
              name: "Edit",
              input: { file_path: "src/edited.ts", old_string: "before", new_string: "after" },
            },
          ],
        },
      } as unknown as SDKMessage,
      channel,
      state,
    );
    emitClaudeMessage(
      {
        type: "user",
        session_id: "session-claude",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content }] },
        tool_use_result: toolUseResult,
      } as unknown as SDKMessage,
      channel,
      state,
    );
    return await drainChannel(channel);
  };

  const supplied = await run(
    { filePath: "src/edited.ts", gitDiff: { status: "modified", additions: 1, deletions: 1, patch } },
    [{ type: "text", text: "edited src/edited.ts" }],
  );
  assert.deepEqual(supplied.at(-1), {
    type: "tool",
    phase: "completed",
    id: "edit-1",
    name: "Edit",
    call: {
      kind: "fileChange",
      changes: [
        { op: "update", path: "src/edited.ts", diffstat: { added: 1, removed: 1 }, patch },
      ],
    },
    result: { status: "ok", output: "edited src/edited.ts" },
  });

  const hunks = await run(
    { filePath: "src/hunks.ts", structuredPatch: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 2, lines: ["-old", "+new", "+extra"] }] },
    "updated src/hunks.ts",
  );
  assert.deepEqual(hunks.at(-1), {
    type: "tool",
    phase: "completed",
    id: "edit-1",
    name: "Edit",
    call: {
      kind: "fileChange",
      changes: [
        {
          op: "update",
          path: "src/hunks.ts",
          diffstat: { added: 2, removed: 1 },
          patch: ["--- a/src/hunks.ts", "+++ b/src/hunks.ts", "@@ -4,1 +4,2 @@", "-old", "+new", "+extra"].join("\n"),
        },
      ],
    },
    result: { status: "ok", output: "updated src/hunks.ts" },
  });
});

test("a correlated start's admitted preview survives empty and conflicting completion input", () => {
  const started = { json: '{"alpha":1}', truncated: false };
  for (const [first, later, expected] of [
    [{ alpha: 1 }, {}, started],
    [null, { beta: 2 }, { json: "null", truncated: false }],
    [42, { beta: 2 }, { json: "42", truncated: false }],
    [{}, { beta: 2 }, { json: "{}", truncated: false }],
    [{ alpha: 1 }, undefined, started],
    [undefined, { gamma: 3 }, { json: '{"gamma":3}', truncated: false }],
  ] as const) {
    const sink = acpSink();
    sink.observe(acpToolUpdate("tool_call", "acp-1", first));
    sink.observe(acpToolUpdate("tool_call_update", "acp-1", later));
    assert.deepEqual(toolPreview(sink.events), expected);
  }

  const opencodePreview = (startInput: unknown, completionInput: unknown) => {
    const state = createEventState("session-1");
    const events: AgentEvent[] = [];
    const emitter = { emit: (event: AgentEvent) => void events.push(event) };
    mapOpencodeTool("running", startInput, emitter, state);
    mapOpencodeTool("completed", completionInput, emitter, state);
    return toolPreview(events);
  };
  for (const completionInput of [{}, { beta: 2 }, undefined])
    assert.deepEqual(
      opencodePreview({ alpha: 1 }, completionInput),
      started,
      "OpenCode keeps the start preview for " + JSON.stringify(completionInput),
    );
  assert.deepEqual(
    opencodePreview(undefined, { gamma: 3 }),
    undefined,
    "OpenCode v2 terminal events do not supply invocation arguments",
  );
});

test("AgentEventChannel retains the newest ordinary FIFO without narration priority", async () => {
  const channel = new AgentEventChannel();
  const narration: AgentEvent[] = [
    noteEvent("native extension failed"),
    { type: "unknown", kind: "terminal_error" },
    {
      type: "tool",
      phase: "completed",
      id: "tool-1",
      name: "shell",
      call: { kind: "run", command: "false" },
      result: { status: "error", message: "failed" },
    },
    ...Array.from({ length: AGENT_EVENT_QUEUE_LIMIT + 8 }, (_, index): AgentEvent => ({
      type: "assistant",
      text: `update-${index}`,
    })),
  ];
  for (const event of narration) channel.emit(event);
  assert.deepEqual(await drainChannel(channel), [
    ...narration.slice(11, AGENT_EVENT_QUEUE_LIMIT),
    noteEvent("Agent event queue overflow: 11 ordinary narration events dropped"),
    ...narration.slice(AGENT_EVENT_QUEUE_LIMIT),
  ]);
});

test("AgentEventChannel reserves the latest session, unknown model and cleared approvals", async () => {
  const channel = new AgentEventChannel();
  channel.emit({ type: "session", coordinate: { sessionId: "old-session" } });
  channel.emit({ type: "model", model: "old-model" });
  channel.emit({ type: "permission", requests: [{ id: "ask", action: "write", resources: ["file"] }] });
  const session: AgentEvent = { type: "session", coordinate: { sessionId: "latest-session" } };
  channel.emit(session);
  channel.emit({ type: "model" });
  channel.emit({ type: "permission", requests: [] });
  const narration = Array.from({ length: AGENT_EVENT_QUEUE_LIMIT * 3 }, (_, index) => noteEvent(`note-${index}`));
  for (const event of narration) channel.emit(event);
  assert.deepEqual(await drainChannel(channel), [
    session,
    { type: "model" },
    { type: "permission", requests: [] },
    noteEvent(`Agent event queue overflow: ${AGENT_EVENT_QUEUE_LIMIT * 2} ordinary narration events dropped`),
    ...narration.slice(-AGENT_EVENT_QUEUE_LIMIT),
  ]);
});

test("AgentEventChannel keeps a loss marker through overflow and resets it when consumed", async () => {
  const channel = new AgentEventChannel();
  const narration = Array.from({ length: AGENT_EVENT_QUEUE_LIMIT * 2 + 2 }, (_, index) => noteEvent(`note-${index}`));
  for (const event of narration) channel.emit(event);
  const iterator = channel[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: noteEvent(`Agent event queue overflow: ${AGENT_EVENT_QUEUE_LIMIT + 2} ordinary narration events dropped`),
  });
  const incoming = noteEvent("next loss");
  channel.emit(incoming);
  assert.deepEqual(await drainChannel(channel), [
    ...narration.slice(-AGENT_EVENT_QUEUE_LIMIT + 1),
    noteEvent("Agent event queue overflow: 1 ordinary narration events dropped"),
    incoming,
  ]);
});

test("ProviderAttempt preserves failed completion and physical closure after diagnostic narration is dropped", async () => {
  const retired = promiseBarrier<void>();
  const channel = new AgentEventChannel();
  const attempt = createProviderAttempt(undefined, async (custody) => {
    custody.own({ closed: retired.promise, forceDispose: async () => retired.resolve() });
    channel.emit(noteEvent("native failure diagnostic"));
    for (let index = 0; index <= AGENT_EVENT_QUEUE_LIMIT; index += 1) {
      channel.emit({ type: "assistant", text: `update-${index}` });
    }
    channel.end();
    return {
      admission: { fence: "native-turn" },
      events: channel,
      completion: Promise.resolve<TurnResult>({ kind: "failed", diagnostic: "native failure" }),
    };
  });
  const session = await attempt.result;
  assert.deepEqual(await session.completion, { kind: "failed", diagnostic: "native failure" });
  const events = await collectEvents(session.events);
  assert.equal(events.some((event) => event.type === "note" && event.text === "native failure diagnostic"), false);
  let closed = false;
  void attempt.closed.then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false, "a failed completion does not prove physical retirement");
  retired.resolve();
  await attempt.closed;
  assert.equal(closed, true);
});

test("ProviderAttempt applies only the current retirement mode to late ownership", async () => {
  const setup = deferred<void>();
  let custody!: AttemptCustody;
  let aborts = 0;
  let forces = 0;
  const attempt = createProviderAttempt(undefined, async (received) => {
    custody = received;
    await setup.promise;
    return "ready";
  });

  await Promise.resolve();
  await attempt.forceDispose();
  custody.own({
    closed: Promise.resolve(),
    abort: async () => {
      aborts += 1;
    },
    forceDispose: async () => {
      forces += 1;
    },
  });
  await Promise.resolve();
  assert.equal(aborts, 0);
  assert.equal(forces, 1);
  setup.resolve();
  await attempt.closed;
});

test("ProviderAttempt observes rejecting parent-cancellation retirement", async () => {
  const parent = new AbortController();
  const setup = deferred<void>();
  const failure = new Error("physical cleanup failed");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  let forces = 0;
  const attempt = createProviderAttempt(parent.signal, async (custody) => {
    custody.own({
      closed: Promise.resolve(),
      forceDispose: async () => {
        forces += 1;
        throw failure;
      },
    });
    setup.resolve();
    await new Promise<void>((_resolve, reject) => {
      custody.signal.addEventListener("abort", () => reject(custody.signal.reason), { once: true });
    });
    return "ready";
  });

  process.on("unhandledRejection", onUnhandled);
  try {
    await setup.promise;
    const result = assert.rejects(attempt.result, /parent cancelled/u);
    const closed = assert.rejects(attempt.closed, /physical cleanup failed/u);
    parent.abort(new Error("parent cancelled"));
    await result;
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(forces, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

function finishingOpenCode(context: TestContext) {
  const native = opencodeFixture(context);
  native.controls.onPrompt = (id) => {
    native.admitted(id);
    native.delivered(id);
    native.step();
    native.push("session.tool.input.started", { assistantMessageID: "msg_assistant", id: "tool-1", name: "shell" });
    native.push("session.tool.called", {
      assistantMessageID: "msg_assistant",
      id: "tool-1",
      input: { command: "npm test" },
      executed: false,
    });
    native.push("session.tool.success", {
      assistantMessageID: "msg_assistant",
      id: "tool-1",
      content: [{ type: "text", text: "ok" }],
      executed: false,
    });
    native.push("session.reasoning.ended", { assistantMessageID: "msg_assistant", ordinal: 0, text: "checked" });
    native.push("session.future", { secret: "drop" });
    native.complete();
  };
  return native;
}

test("a throwing terminal flush fences duplicates, ends narration, and still wins retirement", async () => {
  const events = new AgentEventChannel();
  const failure = new Error("terminal flush failed");
  const turn = providerTurn(events, () => {
    events.emit({ type: "assistant", text: "final narration" });
    throw failure;
  });
  assert.equal(turn.finish({ kind: "answered", answer: "final narration" }), true);
  assert.equal(turn.fail(new Error("late failure")), false);
  await assert.rejects(turn.completion, (error) => error === failure);
  assert.deepEqual(await drainChannel(events), [{ type: "assistant", text: "final narration" }]);
});

function fakeAcp(
  root: string,
  mode: "complete" | "cancel" | "reverse" | "prompt-error" | "config" | "config-missing" = "complete",
) {
  const executable = join(root, "fake-acp.mjs");
  const log = join(root, "acp-log.jsonl");
  const sdk = import.meta.resolve("@agentclientprotocol/sdk");
  writeFileSync(
    executable,
    `
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from ${JSON.stringify(sdk)};
const log = (event) => appendFileSync(process.env.ACP_TEST_LOG, JSON.stringify(event) + "\\n");
let selectedModel = "default";
let selectedEffort = "max";
const configOptions = () => [
  { type: "select", id: "model", name: "Model", currentValue: selectedModel, options: [{ value: "default", name: "Default" }, { value: "k28", name: "K2.8" }] },
  { type: "select", id: "thinking", name: "Thinking", currentValue: selectedEffort, options: selectedModel === "k28" ? [{ value: "low", name: "Low" }, { value: "max", name: "Max" }] : [{ value: "max", name: "Max" }] },
];
const sessionOptions = () => process.env.ACP_TEST_MODE === "config" ? { configOptions: configOptions() } : {};
const app = acp.agent({ name: "fake-acp" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    log({ kind: "initialize", params });
    if (process.env.ACP_TEST_MODE === "cancel") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      log({ kind: "descendant", pid: child.pid });
    }
    return { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true } };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    log({ kind: "new", params });
    return { sessionId: "fresh-session", ...sessionOptions() };
  })
  .onRequest(acp.methods.agent.session.load, ({ params }) => {
    log({ kind: "load", params });
    return sessionOptions();
  })
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    log({ kind: "set-config", params });
    if (process.env.ACP_TEST_MODE !== "config") throw new Error("session options unavailable");
    const option = configOptions().find((entry) => entry.id === params.configId);
    if (!option?.options.some((value) => value.value === params.value)) throw new Error("invalid session option");
    if (params.configId === "model") selectedModel = params.value;
    else selectedEffort = params.value;
    return { configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    log({ kind: "prompt", params, argv: process.argv.slice(2) });
    if (process.env.ACP_TEST_MODE === "prompt-error") throw new acp.RequestError(-32603, "Internal error", "native detail");
    if (process.env.ACP_TEST_MODE === "cancel") return await new Promise(() => {});
    if (process.env.ACP_TEST_MODE === "reverse") {
      const request = async (kind, method, request) => {
        try { log({ kind, response: await client.request(method, request) }); }
        catch (error) { log({ kind, refusal: { code: error.code, message: error.message } }); }
      };
      await request("permission", acp.methods.client.session.requestPermission, { sessionId: params.sessionId, toolCall: { toolCallId: "permission-1" }, options: [] });
      await request("fs-read", acp.methods.client.fs.readTextFile, { sessionId: params.sessionId, path: "/tmp/refused" });
      await request("fs-write", acp.methods.client.fs.writeTextFile, { sessionId: params.sessionId, path: "/tmp/refused", content: "no" });
      await request("terminal-create", acp.methods.client.terminal.create, { sessionId: params.sessionId, command: "false" });
      await request("terminal-output", acp.methods.client.terminal.output, { sessionId: params.sessionId, terminalId: "refused" });
      await request("terminal-release", acp.methods.client.terminal.release, { sessionId: params.sessionId, terminalId: "refused" });
      await request("terminal-wait", acp.methods.client.terminal.waitForExit, { sessionId: params.sessionId, terminalId: "refused" });
      await request("terminal-kill", acp.methods.client.terminal.kill, { sessionId: params.sessionId, terminalId: "refused" });
      await request("elicitation", acp.methods.client.elicitation.create, { sessionId: params.sessionId, mode: "form", message: "refused", requestedSchema: { type: "object" } });
    }
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "complete " } } });
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } });
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checked" } } });
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run tests", kind: "execute", status: "in_progress" } });
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" } });
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "plan", entries: [{ content: "Verify", priority: "high", status: "completed" }] } });
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: [] } });
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    log({ kind: "cancel", params });
  });
app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`,
  );
  return {
    log,
    execution: {
      name: "test-acp",
      kind: "acp" as const,
      executable: process.execPath,
      config: {
        argvBefore: [executable],
        argvAfter: ["stdio"],
        modelArg: "--model",
        effortArg: "--effort",
        systemPromptArg: "--system-prompt",
      },
      env: { ACP_TEST_LOG: log, ACP_TEST_MODE: mode },
    },
  };
}

function acpLog(path: string): readonly Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function processGone(pid: number): Promise<boolean> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("ACP uses stable initialization, fresh sessions, mapped profile arguments, and one prompt response", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-acp-provider-");
  const fake = fakeAcp(root);
  const provider = createAcpProvider(fake.execution);
  assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
  const drive = await provider.start(
    freshInput(["build", "then test"], {
      cwd: root,
      options: { model: "grok-4", effort: "high", systemPrompt: "Be precise." },
    }),
  ).result;
  const events = await collectEvents(drive.events);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete answer" });
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionId: "fresh-session" } },
    { type: "assistant", text: "complete answer" },
    { type: "thought", text: "checked" },
    {
      type: "tool",
      phase: "started",
      id: "tool-1",
      name: "Run tests",
      call: { kind: "other", display: "Run tests" },
    },
    {
      type: "tool",
      phase: "completed",
      id: "tool-1",
      name: "Run tests",
      call: { kind: "other", display: "Run tests" },
      result: { status: "ok" },
    },
  ]);
  const records = acpLog(fake.log);
  assert.deepEqual(
    records.map((record) => record.kind),
    ["initialize", "new", "prompt"],
  );
  assert.deepEqual((records[2]!.params as { prompt: unknown }).prompt, [
    { type: "text", text: "build\n\nthen test" },
  ]);
  assert.deepEqual((records[2]!.argv as readonly string[]).slice(-7), [
    "--model",
    "grok-4",
    "--effort",
    "high",
    "--system-prompt",
    "Be precise.",
    "stdio",
  ]);
  assert.equal("_meta" in (records[1]!.params as object), false);
  assert.equal("rules" in (records[1]!.params as object), false);
  assert.equal("systemPromptOverride" in (records[1]!.params as object), false);
  const unsupported = provider.start(freshInput("build", { runtimeInstructions: "<keiyaku>identity</keiyaku>" }));
  await assert.rejects(unsupported.result, /ACP has no verified native runtime-instruction channel/u);
  await unsupported.closed;
  assert.deepEqual(acpLog(fake.log), records, "unsupported system injection does not become a user prompt");
});

test("ACP load retains the exact session ID without a fork or live tell capability", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-acp-resume-");
  const fake = fakeAcp(root);
  const provider = createAcpProvider(fake.execution);
  assert.equal(provider.fork, undefined);
  const drive = await provider.resume!({
    ...DRIVE_DEFAULTS,
    launchTells: [{ id: "launch", text: "continue" }],
    cwd: root,
    options: {},
    session: { kind: "resume", coordinate: { sessionId: "retained-session" } },
  }).result;
  const events = await collectEvents(drive.events);
  assert.deepEqual(events[0], { type: "session", coordinate: { sessionId: "retained-session" } });
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete answer" });
  const load = acpLog(fake.log).find((record) => record.kind === "load")!;
  assert.equal((load.params as { sessionId: string }).sessionId, "retained-session");
  assert.equal("_meta" in (load.params as object), false);
});

test("ACP applies model then effort session selectors before prompting on fresh and resumed sessions", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-acp-config-");
  const fake = fakeAcp(root, "config");
  const execution = {
    ...fake.execution,
    config: {
      argvBefore: [fake.execution.config.argvBefore[0]!],
      argvAfter: [],
      modelConfigId: "model",
      effortConfigId: "thinking",
    },
  };
  const provider = createAcpProvider(execution);
  assert.deepEqual(provider.admitOptions({ model: "k28", effort: "low" }), {
    kind: "admitted",
    options: { model: "k28", effort: "low" },
  });
  const run = async (resume: boolean) => {
    const attempt = resume
      ? provider.resume!({
          ...DRIVE_DEFAULTS,
          launchTells: [{ id: "launch", text: "continue" }],
          cwd: root,
          options: { model: "k28", effort: "low" },
          session: { kind: "resume", coordinate: { sessionId: "retained-session" } },
        })
      : provider.start(freshInput("build", { cwd: root, options: { model: "k28", effort: "low" } }));
    const drive = await attempt.result;
    for await (const _event of drive.events) {
      /* drain */
    }
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete answer" });
    await attempt.closed;
  };
  await run(false);
  await run(true);
  const records = acpLog(fake.log);
  assert.deepEqual(
    records.map((record) => record.kind),
    [
      "initialize",
      "new",
      "set-config",
      "set-config",
      "prompt",
      "initialize",
      "load",
      "set-config",
      "set-config",
      "prompt",
    ],
  );
  for (const record of records.filter((entry) => entry.kind === "set-config")) {
    const params = record.params as { sessionId: string; configId: string; value: string };
    assert.equal(params.sessionId, records.indexOf(record) < 5 ? "fresh-session" : "retained-session");
  }
  assert.deepEqual(
    records.filter((record) => record.kind === "set-config").map((record) => record.params),
    [
      { sessionId: "fresh-session", configId: "model", value: "k28" },
      { sessionId: "fresh-session", configId: "thinking", value: "low" },
      { sessionId: "retained-session", configId: "model", value: "k28" },
      { sessionId: "retained-session", configId: "thinking", value: "low" },
    ],
  );
  assert.deepEqual((records[4]!.params as { prompt: unknown }).prompt, [{ type: "text", text: "build" }]);
});

test("ACP admits one strict configuration declaration and refuses invalid or conflicting configurations", (context) => {
  assert.deepEqual(
    decodeAcpConfig({ argvBefore: ["--mode", "fast"], argvAfter: [], modelArg: "--model", effortArg: "--effort" }),
    { argvBefore: ["--mode", "fast"], argvAfter: [], modelArg: "--model", effortArg: "--effort" },
  );
  assert.deepEqual(
    decodeAcpConfig({ argvBefore: ["serve"], argvAfter: ["stdio"], modelConfigId: "model", effortConfigId: "thinking" }),
    { argvBefore: ["serve"], argvAfter: ["stdio"], modelConfigId: "model", effortConfigId: "thinking" },
  );
  assert.deepEqual(
    decodeAcpConfig({ argvBefore: [], argvAfter: [], systemPromptArg: "--prompt", systemPromptMode: "replace" }),
    { argvBefore: [], argvAfter: [], systemPromptArg: "--prompt", systemPromptMode: "replace" },
  );

  const admitted = decodeAcpConfig({ argvBefore: [" probe "], argvAfter: [], modelArg: " --model " });
  assert.deepEqual(admitted, { argvBefore: [" probe "], argvAfter: [], modelArg: " --model " }, "bytes stay as supplied");
  assert.equal("effortArg" in admitted, false, "absent members are not fabricated");
  assert.equal(Object.isFrozen(admitted), true);
  assert.equal(Object.isFrozen(admitted.argvBefore), true);
  assert.equal(Object.isFrozen(admitted.argvAfter), true);
  assert.throws(() => (admitted.argvBefore as string[]).push("--late"), TypeError);

  const callerArgs = ["--kept"];
  const copied = decodeAcpConfig({ argvBefore: callerArgs, argvAfter: [] });
  assert.notEqual(copied.argvBefore, callerArgs, "admission freezes its own array, never the caller's");
  assert.equal(Object.isFrozen(callerArgs), false);

  const explicitUndefined = decodeAcpConfig({ argvBefore: [], argvAfter: [], modelArg: undefined });
  assert.deepEqual(
    Object.keys(explicitUndefined),
    ["argvBefore", "argvAfter"],
    "an explicit undefined is absence, not an own key",
  );

  const refusals: readonly (readonly [unknown, RegExp])[] = [
    [null, /object/u],
    [{ argvBefore: [], argvAfter: [], unexpected: true }, /unexpected/u],
    [{ argvAfter: [] }, /argvBefore/u],
    [{ argvBefore: ["  "], argvAfter: [] }, /argvBefore\.0/u],
    [{ argvBefore: [], argvAfter: [], systemPromptMode: "merge" }, /systemPromptMode must be append or replace/u],
    [{ argvBefore: [], argvAfter: [], systemPromptMode: "append" }, /systemPromptMode requires systemPromptArg/u],
    [
      { argvBefore: [], argvAfter: [], modelArg: "--model", modelConfigId: "model" },
      /modelConfigId conflicts with modelArg/u,
    ],
    [
      { argvBefore: [], argvAfter: [], effortArg: "--effort", effortConfigId: "thinking" },
      /effortConfigId conflicts with effortArg/u,
    ],
    [
      { argvBefore: [], argvAfter: [], modelConfigId: "model", effortConfigId: "model" },
      /effortConfigId must differ from modelConfigId/u,
    ],
  ];
  for (const [config, expected] of refusals) {
    assert.throws(
      () => decodeAcpConfig(config),
      (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.category, "invalid-input");
        assert.match(error.message, expected);
        assert.ok(error.cause instanceof z.ZodError);
        return true;
      },
    );
  }

  const root = temporaryDirectory(context, "keiyaku-acp-admission-");
  const fake = fakeAcp(root);
  for (const config of [
    { argvBefore: [], argvAfter: [], unexpected: true },
    { argvBefore: [], argvAfter: [], modelArg: "--model", modelConfigId: "model" },
  ]) {
    assert.throws(() => createAcpProvider({ ...fake.execution, config }), KeiyakuError);
  }
  assert.equal(existsSync(fake.log), false, "refused configuration starts no native execution");
});

test("ACP forced disposal closes its owned process tree after standard session/cancel", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-acp-cancel-");
  const fake = fakeAcp(root, "cancel");
  const attempt = createAcpProvider(fake.execution).start(freshInput("wait", { cwd: root }));
  const drive = await attempt.result;
  await attempt.forceDispose();
  const events = await collectEvents(drive.events);
  assert.deepEqual(events, [{ type: "session", coordinate: { sessionId: "fresh-session" } }]);
  assert.equal((await drive.completion).kind, "failed");
  const descendant = acpLog(fake.log).find((record) => record.kind === "descendant")!;
  assert.equal(await processGone(descendant.pid as number), true);
});

function controlledAcpProcess(): Readonly<{
  process: StdioProcess;
  resolvePrompt(): void;
  resolveCleanup(): void;
}> {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const { promise: cleanup, resolve: resolveCleanup } = promiseBarrier<void>();
  const { promise: prompt, resolve: finishPrompt } = promiseBarrier<void>();
  const { promise: exited, resolve: resolveExited } =
    promiseBarrier<Readonly<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>>();
  const app = acp
    .agent({ name: "controlled-acp" })
    .onRequest(acp.methods.agent.initialize, ({ params }) => ({
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true },
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "controlled-session" }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } },
      });
      await prompt;
      return { stopReason: "end_turn" };
    });
  app.connect(
    acp.ndJsonStream(
      Writable.toWeb(outbound) as WritableStream<Uint8Array>,
      Readable.toWeb(inbound) as ReadableStream<Uint8Array>,
    ),
  );
  return {
    process: {
      input: inbound,
      output: outbound,
      exited,
      endInputAndDrain: async () => {
        await cleanup;
        resolveExited({ code: 0, signal: null, stderr: "" });
      },
      close: async (force) => {
        if (force) resolveCleanup();
        await cleanup;
        resolveExited({ code: null, signal: force ? "SIGKILL" : null, stderr: "" });
      },
    },
    resolvePrompt: finishPrompt,
    resolveCleanup,
  };
}

const controlledAcpExecution = {
  name: "controlled-acp",
  kind: "acp" as const,
  executable: "controlled",
  config: { argvBefore: [], argvAfter: [] },
};

test("ACP retains an answered Turn and a drain failure even after its child exits", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-acp-drain-failure-");
  const drain = deferred<void>();
  const error = new Error("drain failed");
  let child!: StdioProcess;
  const attempt = createAcpProvider(fakeAcp(root).execution, {
    spawnProcess(input) {
      child = spawnStdioProcess(input);
      return {
        ...child,
        async endInputAndDrain() {
          await drain.promise;
          await child.endInputAndDrain();
          throw error;
        },
      };
    },
  }).start(freshInput("build", { cwd: root }));
  try {
    const drive = await attempt.result;
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete answer" });
  } finally {
    drain.resolve();
    await assert.rejects(attempt.closed, (actual) => actual === error);
  }
  assert.equal((await child.exited).code, 0);
});

test("ACP retains a failed cancel write in custody when a native answer wins", { timeout: 5_000 }, async () => {
  const controlled = controlledAcpProcess();
  const cancelWrite = deferred<(error: Error) => void>();
  const error = new Error("ACP cancel transport rejected the write");
  const input = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      const message = JSON.parse(chunk.toString()) as { method?: string };
      if (message.method === "session/cancel") cancelWrite.resolve(done);
      else controlled.process.input.write(chunk, done);
    },
  });
  const attempt = createAcpProvider(controlledAcpExecution, {
    spawnProcess: () => ({ ...controlled.process, input }),
  }).start(freshInput("build"));
  const drive = await attempt.result;
  const abort = attempt.abort();
  void abort.catch(() => undefined);
  const failWrite = await cancelWrite.promise;
  const answer = { kind: "answered", answer: "answer" };
  try {
    controlled.resolvePrompt();
    assert.deepEqual(await drive.completion, answer);
    failWrite(error);
    const original = (actual: unknown) => actual === error;
    await assert.rejects(abort, original);
    await assert.rejects(attempt.closed, original);
    await controlled.process.exited;
  } finally {
    controlled.resolveCleanup();
    await attempt.forceDispose().catch(() => undefined);
  }
});

type FakePiObservation = {
  options?: Record<string, unknown>;
  loader?: Record<string, unknown>;
  opened?: string;
  branched?: string;
  aborted: number;
  disposed: number;
  binds: number;
  calls: string[];
  servicesCreated: number;
  sessionsCreated: number;
  invalidated: number;
  modelLookups: string[];
  services?: Record<string, unknown>;
  prompt?: string;
  steered: Record<string, unknown>[];
  readonly steeringMode: string;
  emitNative(event: Record<string, unknown>): void;
  finishPrompt(): void;
  agentListeners: number;
  sessionListeners: number;
  bash?: {
    cwd: string;
    options: Parameters<PiSdk["createBashToolDefinition"]>[1];
    tool: ReturnType<PiSdk["createBashToolDefinition"]>;
  };
};

function fakePiSdk(
  input: {
    events?: readonly Record<string, unknown>[];
    fail?: Error;
    historyId?: string | null;
    waitForAbort?: boolean;
    promptNeverSettles?: boolean;
    abortNeverSettles?: boolean;
    waitForRelease?: boolean;
    subscriptionFailure?: boolean;
    missingModel?: boolean;
    sessionCreationFailure?: boolean;
    bindFailure?: Error;
    bindGate?: Promise<void>;
  } = {},
): { sdk: PiSdk; seen: FakePiObservation } {
  const nativeListeners = new Set<(event: Record<string, unknown>) => void>();
  let emitSession = (_event: Record<string, unknown>) => {};
  let releasePrompt = () => {};
  const promptReleased = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  const seen: FakePiObservation = {
    aborted: 0,
    disposed: 0,
    binds: 0,
    calls: [],
    servicesCreated: 0,
    sessionsCreated: 0,
    invalidated: 0,
    modelLookups: [],
    steered: [],
    emitNative: (event) => {
      if (event.type === "agent_end") emitSession({ ...event, messages: [], willRetry: event.willRetry === true });
      for (const listener of nativeListeners) listener(event);
    },
    finishPrompt: () => releasePrompt(),
    get agentListeners() {
      return nativeListeners.size;
    },
    get steeringMode() {
      return session.agent.steeringMode;
    },
    get sessionListeners() {
      return session.listener === undefined ? 0 : 1;
    },
  };
  const manager = {
    getLeafId: () => (input.historyId === undefined ? "entry-final" : input.historyId),
    createBranchedSession: (id: string) => {
      seen.branched = id;
      return "/sessions/child.jsonl";
    },
  };
  const session = {
    sessionFile: "/sessions/pi.jsonl",
    sessionId: "pi-session",
    sessionManager: manager,
    agent: {
      steeringMode: "one-at-a-time",
      subscribe(listener: (event: Record<string, unknown>) => void) {
        seen.calls.push("agent-subscribe");
        nativeListeners.add(listener);
        return () => {
          nativeListeners.delete(listener);
        };
      },
      steer(message: Record<string, unknown>) {
        seen.steered.push(message);
      },
    },
    subscribe(listener: (event: Record<string, unknown>) => void) {
      seen.calls.push("subscribe");
      if (input.subscriptionFailure === true) throw new Error("Pi subscription failed");
      this.listener = listener;
      return () => {
        this.listener = undefined;
      };
    },
    listener: undefined as ((event: Record<string, unknown>) => void) | undefined,
    async bindExtensions() {
      seen.binds += 1;
      seen.calls.push("bind");
      if (input.bindFailure !== undefined) throw input.bindFailure;
      if (input.bindGate !== undefined) await input.bindGate;
    },
    async prompt(text?: string) {
      seen.calls.push("prompt");
      if (typeof text === "string") seen.prompt = text;
      if (input.fail !== undefined) throw input.fail;
      if (input.promptNeverSettles === true) await new Promise<void>(() => undefined);
      if (input.waitForAbort === true)
        await new Promise<void>((resolve) => {
          this.resolveAbort = resolve;
        });
      if (input.waitForRelease === true) await promptReleased;
      for (const event of input.events ?? []) this.listener?.(event);
    },
    resolveAbort: undefined as (() => void) | undefined,
    async abort() {
      seen.aborted += 1;
      if (input.abortNeverSettles === true) await new Promise<void>(() => undefined);
      this.resolveAbort?.();
    },
    extensionRunner: { emit: async () => {}, onError: () => () => {} },
    dispose() {
      seen.disposed += 1;
    },
  };
  emitSession = (event) => session.listener?.(event);
  return {
    seen,
    sdk: {
      createEventBus,
      createBashToolDefinition: (cwd, options) => {
        // Opaque SDK value: the adapter must forward it, not execute or reconstruct it.
        const tool = Object.freeze({ name: "fixture-bash" }) as ReturnType<PiSdk["createBashToolDefinition"]>;
        seen.bash = { cwd, options, tool };
        return tool;
      },
      createAgentSessionFromServices: async (options) => {
        seen.sessionsCreated += 1;
        if (input.sessionCreationFailure) throw new Error("Pi session creation failed");
        seen.options = options as unknown as Record<string, unknown>;
        return { session } as never;
      },
      createAgentSessionServices: async (options) => {
        seen.servicesCreated += 1;
        if (options.resourceLoaderOptions !== undefined) seen.loader = options.resourceLoaderOptions;
        const services = {
          modelRuntime: {
            getModel: (provider: string, id: string) => {
              seen.modelLookups.push(`${provider}/${id}`);
              return input.missingModel ? undefined : { provider, id };
            },
          },
          resourceLoader: { getExtensions: () => ({ errors: [], runtime: { invalidate: () => { seen.invalidated += 1; } } }) },
        };
        seen.services = services;
        return services as never;
      },
      getAgentDir: () => "/agent",
      SessionManager: {
        create: () => manager,
        open: (path: string) => {
          seen.opened = path;
          return manager;
        },
      } as never,
    },
  };
}

test("OpenCode v2 adapter admits and completes from native execution evidence", async (t) => {
  const native = finishingOpenCode(t);
  const provider = createOpencodeProvider(undefined, native.open);
  assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
  const drive = await provider.start(
    freshInput(["build", "also check"]),
  ).result;
  assert.equal(drive.admission.fence, native.prompts[0]!.body.id);
  assert.equal(native.prompts[0]!.body.text, "build\n\nalso check");
  const observed = await collectEvents(drive.events);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "answer", historyId: "msg_terminal" });
  assert.deepEqual(
    observed.map((event) => event.type),
    ["session", "model", "tool", "tool", "thought", "assistant"],
  );
  assert.equal(JSON.stringify(observed).includes("secret"), false);
  const completedTool = observed[3];
  assert.ok(completedTool?.type === "tool" && completedTool.phase === "completed");
  assert.deepEqual(completedTool.call, { kind: "run", command: "npm test" });
  assert.deepEqual(completedTool.result, { status: "ok", output: "ok" }, "the completed state's output survives");
  await native.retired();
});

test("OpenCode v2 composes headless permission rules below caller actions", () => {
  const base = composeHeadlessPermissionConfig();
  assert.deepEqual(base, { permissions: [
    { action: "external_directory", resource: "*", effect: "allow" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "deny" },
  ] });
  const caller = { model: "vendor/model", permissions: [{ action: "question", resource: "*", effect: "allow" }] };
  assert.deepEqual(composeHeadlessPermissionConfig(caller), {
    model: "vendor/model", permissions: [
      { action: "external_directory", resource: "*", effect: "allow" },
      { action: "read", resource: "*", effect: "allow" },
      ...caller.permissions,
    ],
  });
  assert.equal(caller.permissions.length, 1);
  assert.throws(() => composeHeadlessPermissionConfig({ permissions: "allow" }), /ruleset/u);
});

test("OpenCode composes the spawned environment and proves child exit when cancelled before readiness", async (t) => {
  const world = temporaryDirectory(t, "keiyaku-opencode-world-");
  const spawnedEnvironment = async (
    env?: Readonly<Record<string, string>>,
    executionCoordinate?: { akumaId: string; world: string },
  ) => {
    const root = temporaryDirectory(t, "keiyaku-opencode-headless-");
    const owned = ownedOpenCode(t, root);
    const controller = new AbortController();
    const attempt = createOpencodeProvider({
      name: "opencode-sdk",
      kind: "opencode-sdk",
      executable: owned.executable,
      env: { OPEN_CODE_FIXTURE_STALL: "readiness", ...env },
    }).start(
      freshInput("never submit", {
        cwd: root,
        signal: controller.signal,
        ...(executionCoordinate === undefined ? {} : { execution: executionCoordinate }),
      }),
    );
    const refused = assert.rejects(attempt.result, /aborted/u);
    const child = await owned.child();
    controller.abort();
    await refused;
    await attempt.closed;
    assert.equal(processExists(child.pid), false, "closure proves actual child exit");
    return child.env;
  };

  const base = await spawnedEnvironment();
  assert.deepEqual(JSON.parse(base.OPENCODE_CONFIG_CONTENT ?? "null"), composeHeadlessPermissionConfig());
  const literal = '{"mcp":{"square":{"type":"local","command":["square","mcp-server"]}}}';
  const overridden = await spawnedEnvironment({
    OPENCODE_CONFIG_CONTENT: literal,
    KEIYAKU_ACTOR_WORLD: "/wrong",
    KEIYAKU_ACTOR_ID: "aku/parent/1234abcd",
  }, { akumaId: "aku/worker/4321abcd", world });
  assert.equal(overridden.OPENCODE_CONFIG_CONTENT, literal);
  assert.equal(overridden.KEIYAKU_ACTOR_WORLD, world);
  assert.equal(overridden.KEIYAKU_ACTOR_ID, "aku/worker/4321abcd");
});

test("OpenCode start and resume reject closed when readiness cleanup fails", async (t) => {
  for (const mode of ["start", "resume"] as const) {
    await t.test(mode, async (context) => {
      const waiting = promiseBarrier<void>();
      const requests: string[] = [];
      const native = nativeEndpoint(context, (request) => {
        requests.push(request.url!);
        waiting.resolve();
      });
      const destroyed = failDispatcherRetirement(context, "OpenCode dispatcher close failed");
      const provider = createOpencodeProvider(undefined, native.open);
      const input = freshInput("wait");
      const attempt =
        mode === "start"
          ? provider.start(input)
          : provider.resume!({
              ...input,
              session: { kind: "resume", coordinate: { sessionId: "session-resume" } },
            });
      const refused = assert.rejects(attempt.result, /OpenCode dispatcher close failed/u);
      await waiting.promise;
      await assert.rejects(attempt.forceDispose(), /OpenCode dispatcher close failed/u);
      await refused;
      await assert.rejects(attempt.closed, /OpenCode dispatcher close failed/u);
      await native.retired();
      assert.equal(destroyed.mock.callCount(), 1);
      assert.deepEqual(requests, ["/api/info"]);
    });
  }
});

test("OpenCode fork force-disposes a runtime held at readiness before publishing a result", async (t) => {
  const waiting = promiseBarrier<void>();
  const requests: string[] = [];
  const native = nativeEndpoint(t, (request) => {
    requests.push(request.url!);
    waiting.resolve();
  });
  const provider = createOpencodeProvider(undefined, native.open);
  const attempt = provider.fork!({ session: { sessionId: "session-source" }, at: "message-1", cwd: "/tmp" });
  const refused = assert.rejects(attempt.result, /provider attempt retired/u);
  await waiting.promise;
  await attempt.forceDispose();
  await refused;
  await attempt.closed;
  await native.retired();
  assert.deepEqual(requests, ["/api/info"]);
});

test("Pi adapter maps completed native evidence and disposes after answer", async () => {
  const fake = fakePiSdk({
    events: [
      { type: "message_update", secret: "delta" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "consider" },
            { type: "future_content", secret: "hidden content" },
            { type: "text", text: "done" },
          ],
        },
      },
      { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "npm test" } },
      { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { secret: true } },
      { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { secret: true }, isError: false },
      { type: "future_event", secret: "hidden" },
    ],
  });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const attempt = provider.start(
    freshInput(["work", "also"], {
      cwd: tmpdir(),
      execution: { akumaId: "aku/pi/1234abcd", world: "/work" },
    }),
  );
  const drive = await attempt.result;
  assert.equal(typeof drive.tell, "function");
  const events = await collectEvents(drive.events);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "thought", text: "consider" },
    { type: "assistant", text: "done" },
    { type: "tool", phase: "started", id: "tool-1", name: "bash", call: { kind: "run", command: "npm test" } },
    {
      type: "tool",
      phase: "completed",
      id: "tool-1",
      name: "bash",
      call: { kind: "run", command: "npm test" },
      result: { status: "ok" },
    },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
  const bash = fake.seen.bash;
  assert.ok(bash);
  assert.equal(bash.cwd, tmpdir());
  assert.deepEqual(fake.seen.options?.customTools, [bash.tool]);
  assert.ok(bash.options?.spawnHook);
  const context = {
    cwd: tmpdir(),
    command: "echo native identity",
    env: Object.freeze({
      SAFE: "keep",
      PI_SESSION_ID: "native-session",
      PI_SESSION_FILE: "native-session-file",
      CODEX_THREAD_ID: "ancestor-codex",
      KEIYAKU_BODY_SEQUENCE: "1",
      KEIYAKU_TURN_SEQUENCE: "2",
    }),
  };
  assert.deepEqual(bash.options.spawnHook(context), {
    ...context,
    env: {
      SAFE: "keep",
      KEIYAKU_ACTOR_ID: "aku/pi/1234abcd",
      KEIYAKU_ACTOR_WORLD: "/work",
      KEIYAKU_BODY_SEQUENCE: "1",
      KEIYAKU_TURN_SEQUENCE: "2",
      PI_SESSION_ID: "native-session",
      PI_SESSION_FILE: "native-session-file",
    },
  });
  assert.equal(fake.seen.disposed, 1);
  await attempt.closed;
});

test("Pi resolves explicit virtual and physical models from one extension-aware service runtime", async () => {
  for (const model of ["dot-router/dots-dot", "openrouter/vendor/model"]) {
    const fake = fakePiSdk({
      events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }],
    });
    const provider = createPiProvider(undefined, async () => fake.sdk);
    const attempt = provider.start(freshInput("work", { options: { model, effort: "high" } }));
    const drive = await attempt.result;
    assert.equal((await drive.completion).kind, "answered");
    await attempt.closed;
    assert.equal(fake.seen.servicesCreated, 1);
    assert.equal(fake.seen.sessionsCreated, 1);
    assert.equal(fake.seen.options?.services, fake.seen.services);
    assert.deepEqual(fake.seen.modelLookups, [model]);
    assert.deepEqual(fake.seen.options?.model, {
      provider: model.slice(0, model.indexOf("/")), id: model.slice(model.indexOf("/") + 1),
    });
    assert.equal(fake.seen.options?.thinkingLevel, "high");
    assert.equal(fake.seen.disposed, 1);
    assert.equal(fake.seen.invalidated, 0);
  }
});

test("Pi retires loaded services when selection or session construction fails before native ownership", async () => {
  for (const missingModel of [true, false]) {
    const fake = fakePiSdk({ missingModel, sessionCreationFailure: !missingModel });
    const provider = createPiProvider(undefined, async () => fake.sdk);
    const attempt = provider.start(freshInput("work", { options: { model: "dot-router/dots-dot" } }));
    await assert.rejects(attempt.result, missingModel ? /Pi model .* is unavailable/u : /Pi session creation failed/u);
    await attempt.closed;
    assert.equal(fake.seen.servicesCreated, 1);
    assert.equal(fake.seen.sessionsCreated, missingModel ? 0 : 1);
    assert.equal(fake.seen.invalidated, 1);
    assert.equal(fake.seen.prompt, undefined);
    assert.equal(fake.seen.disposed, 0);
  }
});

test("Pi retires a session whose host extension binding is cancelled before the prompt", async () => {
  const { promise: binding, resolve: finishBinding } = promiseBarrier<void>();
  const fake = fakePiSdk({ bindGate: binding });
  const provider = createPiProvider(undefined, async () => fake.sdk);
  const attempt = provider.start(freshInput("work"));
  await waitForCondition("Pi host extension binding to begin", () => fake.seen.binds === 1);
  const abort = attempt.abort();
  await assert.rejects(attempt.result, /provider attempt retired/u);
  assert.equal(fake.seen.disposed, 0);
  // The late binding must retire before closure, without starting a prompt.
  finishBinding();
  await abort;
  await attempt.closed;
  assert.equal(fake.seen.agentListeners, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.seen.prompt, undefined);
  assert.equal(fake.seen.disposed, 1);
});

test("Pi live tells require exact native message evidence, not queue acknowledgement", async () => {
  const fake = fakePiSdk({
    waitForRelease: true,
    events: [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "after steering" }] } },
    ],
  });
  const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("work", { cwd: tmpdir() }),
  );
  const drive = await attempt.result;
  assert.equal(fake.seen.steeringMode, "all", "tells drain together, not the interactive setting");
  let firstResult: unknown;
  let secondResult: unknown;
  const first = drive.tell!({ id: "first", text: "same text" }).then((result) => {
    firstResult = result;
    return result;
  });
  const second = drive.tell!({ id: "second", text: "same text" }).then((result) => {
    secondResult = result;
    return result;
  });
  assert.equal(fake.seen.steered.length, 2);
  assert.notEqual(fake.seen.steered[0], fake.seen.steered[1]);
  assert.deepEqual(
    fake.seen.steered.map((message) => message.content),
    [[{ type: "text", text: "same text" }], [{ type: "text", text: "same text" }]],
  );
  fake.seen.emitNative({ type: "message_end", message: { ...fake.seen.steered[0] } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResult, undefined);
  assert.equal(secondResult, undefined);
  fake.seen.emitNative({ type: "message_end", message: fake.seen.steered[1] });
  assert.deepEqual(await second, { kind: "accepted", fence: "pi-session:second" });
  assert.equal(firstResult, undefined);
  fake.seen.emitNative({ type: "agent_end", willRetry: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResult, undefined);
  fake.seen.emitNative({ type: "agent_end", messages: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstResult, undefined, "a non-retry agent_end can still continue within the native prompt");
  fake.seen.emitNative({ type: "message_end", message: fake.seen.steered[0] });
  assert.deepEqual(await first, { kind: "accepted", fence: "pi-session:first" });
  fake.seen.finishPrompt();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "after steering", historyId: "entry-final" });
  await attempt.closed;
  assert.equal(fake.seen.agentListeners, 0);
  assert.deepEqual(await drive.tell!({ id: "late", text: "later" }), { kind: "turn-ended" });
  assert.equal(fake.seen.steered.length, 2);
});

test("Pi returns turn-ended for an unmatched steer only after native prompt settlement", async () => {
  const fake = fakePiSdk({
    waitForRelease: true,
    events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }],
  });
  const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("work", { cwd: tmpdir() }),
  );
  const drive = await attempt.result;
  let result: unknown;
  const pending = drive.tell!({ id: "late", text: "unobserved" }).then((value) => {
    result = value;
    return value;
  });
  fake.seen.emitNative({ type: "agent_end", messages: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result, undefined);
  fake.seen.finishPrompt();
  assert.deepEqual(await pending, { kind: "turn-ended" });
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
  await attempt.closed;
  assert.equal(fake.seen.agentListeners, 0);
});

test("Pi disposal releases live tell waiters but closure still waits for the native prompt", async () => {
  const fake = fakePiSdk({ waitForRelease: true });
  const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("work", { cwd: tmpdir() }),
  );
  const drive = await attempt.result;
  const pending = drive.tell!({ id: "pending", text: "steer" });
  const disposing = attempt.forceDispose();
  assert.deepEqual(await pending, { kind: "turn-ended" });
  let closed = false;
  void attempt.closed.then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.seen.disposed, 1);
  assert.equal(closed, false, "logical dispose is not native execution retirement");
  fake.seen.finishPrompt();
  await disposing;
  await attempt.closed;
  assert.equal(fake.seen.agentListeners, 0);
});

test("Pi retains observed tool text and edit patches as conservative file changes", async () => {
  const patch = ["@@ -1,2 +1,3 @@", " keep", "-old", "+new", "+extra", "@@ -10,1 +11,1 @@", "-x", "+y"].join("\n");
  const nativeCalls = [
    {
      id: "write-create",
      name: "write",
      args: { path: "src/created.ts", content: "a\n" },
      error: false,
      result: { content: [{ type: "text", text: "Successfully wrote to src/created.ts" }] },
    },
    {
      id: "write-overwrite",
      name: "write",
      args: { path: "src/overwritten.ts", content: "b\n" },
      error: false,
      result: { content: [{ type: "text", text: "Successfully wrote to src/overwritten.ts" }] },
    },
    {
      id: "write-failed",
      name: "write",
      args: { path: "src/failed.ts", content: "c\n" },
      error: true,
      result: { content: [{ type: "text", text: "EPERM: operation not permitted" }] },
    },
    {
      id: "edit-one",
      name: "edit",
      args: { path: "src/edited.ts", edits: [{ oldText: "old", newText: "new" }] },
      error: false,
      result: { details: { patch } },
    },
  ];
  const fake = fakePiSdk({
    events: [
      ...nativeCalls.flatMap(({ id, name, args, error, result }) => [
        { type: "tool_execution_start", toolCallId: id, toolName: name, args },
        { type: "tool_execution_end", toolCallId: id, toolName: name, isError: error, result },
      ]),
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ],
  });
  const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("work", { cwd: tmpdir() }),
  );
  const drive = await attempt.result;
  const events: AgentEvent[] = [];
  for await (const event of drive.events) events.push(event);
  const write = (path: string) => ({ kind: "fileChange" as const, changes: [{ op: "update" as const, path }] });
  assert.deepEqual(
    events.filter((event) => event.type === "tool"),
    [
      { type: "tool", phase: "started", id: "write-create", name: "write", call: write("src/created.ts") },
      {
        type: "tool",
        phase: "completed",
        id: "write-create",
        name: "write",
        call: write("src/created.ts"),
        result: { status: "ok", output: "Successfully wrote to src/created.ts" },
      },
      { type: "tool", phase: "started", id: "write-overwrite", name: "write", call: write("src/overwritten.ts") },
      {
        type: "tool",
        phase: "completed",
        id: "write-overwrite",
        name: "write",
        call: write("src/overwritten.ts"),
        result: { status: "ok", output: "Successfully wrote to src/overwritten.ts" },
      },
      { type: "tool", phase: "started", id: "write-failed", name: "write", call: write("src/failed.ts") },
      {
        type: "tool",
        phase: "completed",
        id: "write-failed",
        name: "write",
        call: write("src/failed.ts"),
        result: { status: "error", output: "EPERM: operation not permitted" },
      },
      { type: "tool", phase: "started", id: "edit-one", name: "edit", call: write("src/edited.ts") },
      {
        type: "tool",
        phase: "completed",
        id: "edit-one",
        name: "edit",
        call: {
          kind: "fileChange",
          changes: [{ op: "update", path: "src/edited.ts", diffstat: { added: 3, removed: 2 }, patch }],
        },
        result: { status: "ok" },
      },
    ],
  );
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
  await attempt.closed;
  assert.equal(fake.seen.disposed, 1);
});

test("Pi retains retry diagnostics and completed compaction without progress prose or premature failure", async () => {
  const fake = fakePiSdk({
    events: [
      {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: "temporarily unavailable",
      },
      { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "upstream overloaded" },
      { type: "compaction_end", result: undefined, aborted: false, errorMessage: "summary failed", willRetry: true },
      { type: "compaction_end", result: { summary: "private summary" }, aborted: false, willRetry: false },
      { type: "compaction_end", result: undefined, aborted: true, willRetry: false },
      { type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" },
      { type: "summarization_retry_attempt_start", source: "branchSummary" },
      { type: "summarization_retry_finished" },
      { type: "bash_execution_update", id: "bash-1", delta: "private partial output" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ],
  });
  const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("work", { cwd: "/work" }),
  );
  const drive = await attempt.result;
  const events: AgentEvent[] = [];
  for await (const event of drive.events) events.push(event);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "note", text: "temporarily unavailable" },
    { type: "note", text: "upstream overloaded" },
    { type: "note", text: "summary failed" },
    { type: "note", text: "Context compacted" },
    { type: "assistant", text: "done" },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
  await attempt.closed;
  assert.equal(fake.seen.disposed, 1);
});

test("Pi does not treat a tool-use message as the final answer", async () => {
  const fake = fakePiSdk({
    events: [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "inspect" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "SOUL.md" } },
            { type: "text", text: "" },
          ],
          stopReason: "toolUse",
        },
      },
    ],
  });
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("wait", { cwd: "/work" }),
  ).result;
  const events = await collectEvents(drive.events);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "thought", text: "inspect" },
  ]);
  assert.deepEqual(await drive.completion, {
    kind: "failed",
    diagnostic: "Pi completed without a native assistant answer",
  });
});

test("Pi adapter resumes and forks only exact sessionFile coordinates", async () => {
  const fake = fakePiSdk({
    events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "resumed" }] } }],
  });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const drive = await provider.resume!({
    ...DRIVE_DEFAULTS,
    launchTells: [{ id: "launch", text: "continue" }],
    cwd: "/work",
    options: {},
    session: { kind: "resume", coordinate: { sessionFile: "/sessions/source.jsonl" } },
  }).result;
  await collectEvents(drive.events);
  await drive.completion;
  assert.equal(fake.seen.opened, "/sessions/source.jsonl");
  assert.deepEqual(
    await provider.fork!({ session: { sessionFile: "/sessions/source.jsonl" }, at: "entry-exact", cwd: "/work" })
      .result,
    { session: { sessionFile: "/sessions/child.jsonl" } },
  );
  assert.equal(fake.seen.branched, "entry-exact");
  await assert.rejects(
    attemptResult(
      provider.resume!({
        ...DRIVE_DEFAULTS,
        launchTells: [{ id: "launch", text: "bad" }],
        cwd: "/work",
        options: {},
        session: { kind: "resume", coordinate: { sessionId: "wrong" } },
      }),
    ),
    /requires sessionFile/u,
  );
  await assert.rejects(
    attemptResult(provider.fork!({ session: { sessionId: "wrong" }, at: "entry", cwd: "/work" })),
    /requires sessionFile/u,
  );
});

function fakeCodex(
  root: string,
  mode:
    | "complete"
    | "interrupt"
    | "observations"
    | "terminal-drain"
    | "terminal-hang"
    | "exit-before-completion"
    | "exit-before-admit"
    | "foreign-thread"
    | "model-evidence"
    | "rpc-reject"
    | "missing-turn-id"
    | "steer-hung-terminal" = "complete",
  mcpServers: Record<string, unknown> = {},
): Readonly<{
  executable: string;
  requests(): readonly Readonly<Record<string, unknown>>[];
  environment(): NodeJS.ProcessEnv;
  pid(): number;
  /** Creating this file releases the fixture's model reroute. */
  rerouteRelease: string;
}> {
  const executable = join(root, "codex");
  const log = join(root, "requests.jsonl");
  const environment = join(root, "request-environment.txt");
  const pid = join(root, "codex.pid");
  const rerouteRelease = join(root, "model-reroute-release");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      "const readline=require('node:readline');",
      `const log=${JSON.stringify(log)};`,
      `fs.writeFileSync(${JSON.stringify(environment)},JSON.stringify(process.env));`,
      `fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));`,
      `const mode=${JSON.stringify(mode)};`,
      `const rerouteRelease=${JSON.stringify(rerouteRelease)};`,
      `const terminalEof=${JSON.stringify(join(root, "terminal-eof"))};`,
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "const reply=(message,result)=>send({id:message.id,result});",
      "const hang=mode==='terminal-hang'?setInterval(()=>{},1000):null;",
      "const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});",
      "lines.on('close',()=>{",
      "  if(mode==='terminal-drain') return setTimeout(()=>{",
      "    send({method:'item/completed',params:{item:{id:'command-terminal',type:'commandExecution',command:'npm test',status:'completed',exitCode:0}}});",
      "    process.exit(0);",
      "  },350);",
      "  if(mode==='terminal-hang') return fs.writeFileSync(terminalEof,'');",
      "  process.exit(0);",
      "});",
      "lines.on('line',(line)=>{",
      "  const message=JSON.parse(line); fs.appendFileSync(log,JSON.stringify(message)+'\\n');",
      "  if(message.method==='initialize') return reply(message,{userAgent:'codex-cli/0.146.0'});",
      "  if(message.method==='initialized') return;",
      `  if(message.method==='config/read') return reply(message,{config:{mcp_servers:${JSON.stringify(mcpServers)}}});`,
      "  if(message.method==='thread/start'){",
      "    if(mode==='exit-before-admit') process.exit(7);",
      "    return reply(message,{thread:{id:'thread-fresh'},...(mode==='model-evidence'?{model:'gpt-5-codex'}:{})});",
      "  }",
      "  if(message.method==='thread/resume') return reply(message,{thread:{id:message.params.threadId}});",
      "  if(message.method==='thread/fork') return reply(message,{thread:{id:'thread-child'}});",
      "  if(message.method==='turn/start'){",
      "    if(mode==='rpc-reject') return send({id:message.id,error:{message:'turn start refused'}});",
      "    if(mode==='missing-turn-id') return reply(message,{turn:{}});",
      "    reply(message,{turn:{id:'turn-1'}});",
      "    if(mode==='model-evidence'){",
      "      const released=setInterval(()=>{",
      "        if(!fs.existsSync(rerouteRelease)) return;",
      "        clearInterval(released);",
      "        send({method:'model/rerouted',params:{threadId:message.params.threadId,turnId:'turn-1',fromModel:'gpt-5-codex',toModel:'gpt-5-codex-mini',reason:'capacity'}});",
      "        send({method:'item/completed',params:{item:{id:'item-1',type:'agentMessage',text:'codex answer'}}});",
      "        send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'completed'}}});",
      "      },5);",
      "      return;",
      "    }",
      "    if(mode==='complete'){",
      "      send({method:'item/completed',params:{item:{id:'item-1',type:'agentMessage',text:'codex answer'}}});",
      "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'completed'}}});",
      "    }",
      "    if(mode==='terminal-drain'||mode==='terminal-hang'){",
      "      send({method:'item/started',params:{item:{id:'command-terminal',type:'commandExecution',command:'npm test'}}});",
      "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'completed'}}});",
      "    }",
      "    if(mode==='exit-before-completion') process.exit(7);",
      "    if(mode==='observations'){",
      "      send({method:'item/started',params:{item:{id:'command-1',type:'commandExecution',command:'npm test'}}});",
      "      send({method:'item/commandExecution/outputDelta',params:{delta:'secret output'}});",
      "      send({method:'item/completed',params:{item:{id:'command-1',type:'commandExecution',command:'npm test',status:'completed',exitCode:0,aggregatedOutput:'secret output'}}});",
      "      send({method:'turn/moderationMetadata',params:{threadId:message.params.threadId,turnId:'turn-1'}});",
      "      send({method:'turn/plan/updated',params:{explanation:'Verify the adapter',plan:[{step:'test'}]}});",
      "      send({method:'error',params:{error:{message:'temporary outage',additionalDetails:null},willRetry:true}});",
      "      send({method:'item/completed',params:{item:{id:'answer-1',type:'agentMessage',text:'first answer'}}});",
      "      send({method:'future/native-event',params:{secret:'must not escape'}});",
      "      send({method:'item/completed',params:{item:{id:'answer-2',type:'agentMessage',text:'second answer'}}});",
      "      send({method:'thread/tokenUsage/updated',params:{tokens:999}});",
      "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'completed'}}});",
      "    }",
      "    if(mode==='foreign-thread'){",
      "      send({method:'item/started',params:{threadId:'thread-child',turnId:'turn-child',item:{id:'child-command',type:'commandExecution',command:'child command'}}});",
      "      send({method:'item/completed',params:{threadId:'thread-child',turnId:'turn-child',item:{id:'child-answer',type:'agentMessage',text:'child answer'}}});",
      "      send({method:'error',params:{threadId:'thread-child',turnId:'turn-child',error:{message:'child error'},willRetry:false}});",
      "      send({method:'future/child-event',params:{threadId:'thread-child',turnId:'turn-child'}});",
      "      send({method:'turn/completed',params:{threadId:'thread-child',turn:{id:'turn-child',status:'completed'}}});",
      "      send({method:'item/completed',params:{threadId:message.params.threadId,turnId:'turn-1',item:{id:'parent-answer',type:'agentMessage',text:'parent answer'}}});",
      "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'completed'}}});",
      "    }",
      "    return;",
      "  }",
      "  if(message.method==='turn/steer'){",
      "    if(mode==='steer-hung-terminal'){",
      "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.expectedTurnId,status:'completed'}}});",
      "      return;",
      "    }",
      "    reply(message,{turnId:message.params.expectedTurnId});",
      "    return;",
      "  }",
      "  if(message.method==='turn/interrupt'){",
      "    reply(message,{});",
      "    send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.turnId,status:'interrupted'}}});",
      "  }",
      "});",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return {
    executable,
    requests: () => {
      try {
        return readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    environment: () => JSON.parse(readFileSync(environment, "utf8")) as NodeJS.ProcessEnv,
    pid: () => Number(readFileSync(pid, "utf8")),
    rerouteRelease,
  };
}

function fakeQuery(messages: readonly SDKMessage[], prompt?: AsyncIterable<unknown>): Query {
  return (async function* () {
    if (prompt !== undefined) {
      void (async () => {
        for await (const _message of prompt) {
          /* pull the streaming input concurrently */
        }
      })();
    }
    for (const message of messages) yield message;
  })() as unknown as Query;
}

function deferred<T>() {
  const { promise: promise, resolve, reject } = promiseBarrier<T>();
  return { promise, resolve, reject };
}

function claudeResult(index: number): readonly [SDKMessage, SDKMessage] {
  return [
    {
      type: "assistant",
      uuid: `assistant-live-${index}`,
      session_id: "session-live",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: `answer ${index}` }] },
    } as unknown as SDKMessage,
    {
      type: "result",
      subtype: "success",
      session_id: "session-live",
      result: `done ${index}`,
    } as unknown as SDKMessage,
  ];
}

function controlledClaude() {
  const outputs: SDKMessage[] = [
    { type: "system", subtype: "init", session_id: "session-live" } as unknown as SDKMessage,
  ];
  let outputWaiter: ReturnType<typeof deferred<IteratorResult<SDKMessage>>> | undefined;
  let inputIterator: AsyncIterator<SDKUserMessage> | undefined;
  let pendingInput: Promise<IteratorResult<SDKUserMessage>> | undefined;
  let ended = false;
  let queries = 0;
  const end = () => {
    ended = true;
    outputWaiter?.resolve({ done: true, value: undefined });
    outputWaiter = undefined;
  };
  const pullInput = () => {
    if (inputIterator === undefined) throw new Error("Claude input is not attached");
    pendingInput = inputIterator.next();
    void pendingInput.then(
      (next) => {
        if (next.done) end();
      },
      () => {},
    );
  };
  const provider = createClaudeProvider(async () => ({
    query({ prompt }) {
      queries += 1;
      assert.notEqual(typeof prompt, "string");
      inputIterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      void inputIterator.next().then(pullInput);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          const message = outputs.shift();
          if (message !== undefined) return Promise.resolve({ done: false, value: message });
          if (ended) return Promise.resolve({ done: true, value: undefined });
          outputWaiter = deferred<IteratorResult<SDKMessage>>();
          return outputWaiter.promise;
        },
        close: end,
      } as unknown as Query;
    },
  }));
  return {
    start: () => provider.start(freshInput("initial", { cwd: "/work" })).result,
    get queries() {
      return queries;
    },
    async receiveInput() {
      await waitForCondition("the provider input iterator to pull its first message", () => pendingInput !== undefined);
      if (pendingInput === undefined) throw new Error("provider input iterator never pulled its first message");
      return await pendingInput;
    },
    acknowledgeInput() {
      pullInput();
    },
    output(first: SDKMessage, ...rest: SDKMessage[]) {
      assert.ok(outputWaiter, "Query is waiting directly on the next native message");
      outputs.push(...rest);
      outputWaiter.resolve({ done: false, value: first });
      outputWaiter = undefined;
    },
    fail(error: unknown) {
      assert.ok(outputWaiter);
      outputWaiter.reject(error);
      outputWaiter = undefined;
    },
    end,
  };
}

test("Claude maps provider-neutral schema JSON to outputFormat json_schema", async () => {
  let seen: Record<string, unknown> | undefined;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      seen = input.options as Record<string, unknown> | undefined;
      return fakeQuery(
        [
          { type: "system", subtype: "init", session_id: "session-schema" } as unknown as SDKMessage,
          {
            type: "assistant",
            uuid: "assistant-schema",
            session_id: "session-schema",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: '{"ok":true}' }] },
          } as unknown as SDKMessage,
          {
            type: "result",
            subtype: "success",
            session_id: "session-schema",
            result: '{"ok":true}',
          } as unknown as SDKMessage,
        ],
        input.prompt as AsyncIterable<unknown>,
      );
    },
  }));
  const schemaJson = '{"type":"object","properties":{"ok":{"type":"boolean"}}}';
  const drive = await provider.start(freshInput("structured", { cwd: "/work", schemaJson })).result;
  await drive.completion;
  assert.deepEqual(seen?.outputFormat, {
    type: "json_schema",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  });
});

test("Claude settles the Turn before its Query tail fails retirement", { timeout: 5_000 }, async (context) => {
  const late = deferred<void>();
  const failure = new Error("native query tail failed during retirement");
  let closeRequested = false;
  context.after(() => late.resolve());
  const provider = createClaudeProvider(async () => ({
    query({ prompt }) {
      void (async () => {
        for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
          /* pull the streaming input */
        }
      })();
      const query = (async function* () {
        yield { type: "system", subtype: "init", session_id: "session-live" } as unknown as SDKMessage;
        yield* claudeResult(1);
        await late.promise;
        yield claudeResult(2)[0];
        throw failure;
      })() as unknown as Query;
      query.close = () => { closeRequested = true; };
      return query;
    },
  }));
  const attempt = provider.start(freshInput("initial", { cwd: "/work" }));
  const drive = await attempt.result;
  let closed = false;
  void attempt.closed.finally(() => { closed = true; }).catch(() => undefined);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done 1", historyId: "assistant-live-1" });
  assert.deepEqual(await collectEvents(drive.events), [
    { type: "session", coordinate: { sessionId: "session-live" } },
    { type: "assistant", text: "answer 1" },
  ]);
  assert.deepEqual(await drive.tell!({ id: "late", text: "too late" }), { kind: "turn-ended" });
  assert.equal(closeRequested, true);
  assert.equal(closed, false, "logical Query close is not retirement of its consumer");
  late.resolve();
  await assert.rejects(attempt.closed, (error) => error === failure);
});

test("Claude owns the hook's spawned process after result and Query retirement", { timeout: 10_000 }, async (context) => {
  const cwd = temporaryDirectory(context, "keiyaku-claude-child-");
  const diagnostic = deferred<string>();
  let child!: SpawnedProcess;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      child = input.options!.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: ["-e", "console.error(process.env.NATIVE_DIAGNOSTIC); process.stdin.resume()"],
        cwd,
        env: { ...process.env, NATIVE_DIAGNOSTIC: "native stderr" },
        signal: new AbortController().signal,
      });
      return fakeQuery(claudeResult(1), input.prompt as AsyncIterable<SDKUserMessage>);
    },
  }), { config: { stderr: diagnostic.resolve } });
  const attempt = provider.start(freshInput("work", { cwd }));
  try {
    const drive = await attempt.result;
    assert.equal(await diagnostic.promise, "native stderr\n");
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "done 1", historyId: "assistant-live-1" });
    let closed = false;
    void attempt.closed.then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "the process still holds its stdio independently of Query");
    assert.equal(child.exitCode, null);
  } finally {
    await attempt.forceDispose();
    await attempt.closed;
  }
  assert.equal(child.signalCode, "SIGKILL");
});

test("Claude retains a delegated native spawn that arrives after setup cancellation", { timeout: 10_000 }, async (context) => {
  const cwd = temporaryDirectory(context, "keiyaku-claude-late-child-");
  const started = deferred<void>();
  const closing = deferred<void>();
  const request = {
    command: process.execPath,
    args: ["-e", "process.stdin.resume()"],
    cwd,
    env: { ...process.env },
    signal: new AbortController().signal,
  };
  let child: SpawnedProcess | undefined;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      const query = (async function* () {
        started.resolve();
        await closing.promise;
        const handedBack = input.options!.spawnClaudeCodeProcess!(request);
        assert.equal(handedBack, child, "the SDK gets the original delegated process handle");
      })() as unknown as Query;
      query.close = closing.resolve;
      return query;
    },
  }), { config: { spawnClaudeCodeProcess: (actual: typeof request) => {
    assert.equal(actual, request, "the hook receives the SDK's unchanged spawn request");
    child = spawn(actual.command, actual.args, { cwd: actual.cwd, env: actual.env, stdio: "pipe" });
    return child;
  } } });
  const attempt = provider.start(freshInput("work", { cwd }));
  const rejected = assert.rejects(attempt.result, /provider attempt retired/u);
  await started.promise;
  await attempt.forceDispose();
  await rejected;
  await attempt.closed;
  assert.equal(child?.signalCode, "SIGKILL");
});

test("Claude live tell waits for a post-yield source pull and shares one Query", async (context) => {
  const harness = controlledClaude();
  context.after(harness.end);
  const drive = await harness.start();
  assert.equal(harness.queries, 1);
  let resolved = false;
  const submission = drive.tell!({ id: "tell-live-1", text: "steer now" }).then((value) => {
    resolved = true;
    return value;
  });
  const yielded = await harness.receiveInput();
  assert.equal(yielded.done, false);
  assert.equal(yielded.value.message.content as string, "steer now");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  harness.acknowledgeInput();
  assert.equal((await submission).kind, "accepted");
  assert.equal(drive.receipts, undefined);
  assert.equal(harness.queries, 1);
  const [assistant, result] = claudeResult(1);
  harness.output(assistant, result);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done 1", historyId: "assistant-live-1" });
  assert.equal((await harness.receiveInput()).done, true);
});

test("Claude preserves an acknowledged Tell when native terminal handling wins the continuation race", async (context) => {
  const harness = controlledClaude();
  context.after(harness.end);
  const drive = await harness.start();
  const submission = drive.tell!({ id: "tell-live-1", text: "steer now" });
  assert.equal((await harness.receiveInput()).done, false);
  // Queue the observer's continuation first, then witness the pull synchronously.
  // The result fences input before the Tell continuation can report the witnessed admission.
  harness.output(claudeResult(1)[1]);
  harness.acknowledgeInput();
  assert.equal((await submission).kind, "accepted");
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done 1" });
});

test("Claude ends unacknowledged input at a failed native result and fences later Tells", async (context) => {
  const harness = controlledClaude();
  context.after(harness.end);
  const drive = await harness.start();
  const yielded = drive.tell!({ id: "tell-live-1", text: "unacknowledged" });
  assert.equal((await harness.receiveInput()).done, false);
  const queued = drive.tell!({ id: "tell-live-2", text: "still queued" });
  harness.output({
    type: "result",
    subtype: "error_during_execution",
    session_id: "session-live",
    errors: ["native result failure"],
  } as SDKMessage);
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "native result failure" });
  assert.deepEqual(await yielded, { kind: "turn-ended" });
  assert.deepEqual(await queued, { kind: "turn-ended" });
  assert.deepEqual(await drive.tell!({ id: "tell-live-3", text: "too late" }), { kind: "turn-ended" });
  harness.acknowledgeInput();
  assert.equal((await harness.receiveInput()).done, true);
});

test("Claude rejects unacknowledged input with the original transport failure", async (context) => {
  const harness = controlledClaude();
  context.after(harness.end);
  const drive = await harness.start();
  const submission = drive.tell!({ id: "tell-live-1", text: "unacknowledged" });
  assert.equal((await harness.receiveInput()).done, false);
  const nativeError = new Error("SDK stream broke");
  const rejection = assert.rejects(submission, (error) => error === nativeError);
  harness.fail(nativeError);
  await rejection;
  await assert.rejects(drive.completion, (error) => error === nativeError);
});

test("Codex app-server maps admitted options, native session, answer, and exact turn history", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-provider-");
  const fake = fakeCodex(root);
  const config = {
    service_tier: "priority",
    sandbox_mode: "workspace-write",
    sandbox_workspace_write: { writable_roots: [root, "/native/extra"], network_access: false },
  };
  const provider = createCodexAppServerProvider({
    name: "configured",
    kind: "codex-app-server",
    executable: fake.executable,
    config,
    env: { SETTINGS_LITERAL: "from-settings", KEIYAKU_ACTOR_ID: "" },
  });
  const options = {
    model: "gpt-test",
    effort: "high",
    network: "enabled" as const,
    systemPrompt: "Work precisely.",
  };
  assert.deepEqual(provider.admitOptions(options), { kind: "admitted", options });

  const drive = await provider.start({
    ...DRIVE_DEFAULTS,
    launchTells: [{ id: "launch", text: "build" }],
    cwd: root,
    options,
    runtimeInstructions: "<keiyaku>current</keiyaku>",
    session: { kind: "fresh" },
  }).result;
  const events = await collectEvents(drive.events);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "codex answer", historyId: "turn-1" });
  assert.deepEqual(events[0], { type: "session", coordinate: { sessionId: "thread-fresh" } });
  assert.ok(events.some((event) => event.type === "assistant" && event.text === "codex answer"));

  const requests = fake.requests();
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize", "initialized", "thread/start", "turn/start"],
  );
  const thread = requests[2]!.params as Record<string, unknown>;
  assert.deepEqual(thread, {
    cwd: root,
    config,
    model: "gpt-test",
    developerInstructions: "Work precisely.",
  });
  const turn = requests[3]!.params as Record<string, unknown>;
  assert.deepEqual(turn, {
    threadId: "thread-fresh",
    input: [{ type: "text", text: "build" }],
    additionalContext: { keiyaku_execution: { kind: "application", value: "<keiyaku>current</keiyaku>" } },
    model: "gpt-test",
    effort: "high",
    approvalPolicy: "never",
  });
  assert.equal(fake.environment().SETTINGS_LITERAL, "from-settings");
  assert.equal(fake.environment().KEIYAKU_ACTOR_ID, "");

  const resumed = provider.resume!({
    ...freshInput("continue", { cwd: root, options }),
    session: { kind: "resume", coordinate: { sessionId: "thread-fresh" } },
  });
  await (await resumed.result).completion;
  await resumed.closed;
  assert.deepEqual(fake.requests().slice(4).map((request) => request.method),
    ["initialize", "initialized", "thread/resume", "turn/start"]);
  assert.deepEqual(fake.requests()[6]?.params, { threadId: "thread-fresh", ...thread });
});

test("native adapters report only the runtime model their own payloads name", { timeout: 30_000 }, async (context) => {
  const pi = piSink();
  pi.observe({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-x",
      api: "anthropic-messages",
      content: [],
      stopReason: "stop",
      timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  });
  assert.deepEqual(
    pi.events.filter((event) => event.type === "model"),
    [{ type: "model", model: "anthropic/claude-x" }],
  );
  assert.equal(piSessionModel({ provider: "anthropic", id: "claude-x" }), "anthropic/claude-x");
  assert.equal(piSessionModel({ id: "claude-x" }), undefined, "a half-named selection is not evidence");

  // Each message is observed through its own channel: the channel keeps one
  // unconsumed model observation, so adapter evidence is what one message emits.
  const claudeModels = async (message: unknown): Promise<readonly AgentEvent[]> => {
    const channel = new AgentEventChannel();
    const state = new ToolObservations((event) => channel.emit(event));
    emitClaudeMessage(message as never, channel, state);
    return (await drainChannel(channel)).filter((event) => event.type === "model");
  };
  assert.deepEqual(await claudeModels({ type: "system", subtype: "init", model: "claude-startup" }), [
    { type: "model", model: "claude-startup" },
  ]);
  assert.deepEqual(await claudeModels({ type: "assistant", message: { model: "claude-response", content: [] } }), [
    { type: "model", model: "claude-response" },
  ]);
  assert.deepEqual(
    await claudeModels({
      type: "system",
      subtype: "model_refusal_fallback",
      scope: "local",
      direction: "retry",
      original_model: "claude-startup",
      fallback_model: "claude-local-only",
    }),
    [],
    "a local fallback leaves the session model unchanged",
  );
  assert.deepEqual(
    await claudeModels({
      type: "system",
      subtype: "model_refusal_fallback",
      scope: "session",
      direction: "retry",
      original_model: "claude-response",
      fallback_model: "claude-fallback",
    }),
    [{ type: "model", model: "claude-fallback" }],
    "a session fallback names the model the attempt is now running",
  );
  assert.deepEqual(
    await claudeModels({ type: "system", subtype: "model_refusal_fallback", scope: "session", direction: "retry" }),
    [{ type: "model" }],
    "an explicit unnamed fallback clears the previous confirmation",
  );

  const opencodeEvents: AgentEvent[] = [];
  mapEvent(
    {
      type: "session.step.started",
      data: { sessionID: "session-1", assistantMessageID: "msg_assistant", model: { providerID: "anthropic", id: "claude-y" } },
    },
    { emit: (event) => opencodeEvents.push(event) },
    createEventState("session-1"),
  );
  mapEvent(
    {
      type: "session.model.selected",
      data: { sessionID: "session-1", model: { providerID: "anthropic", id: "requested" } },
    },
    { emit: (event) => opencodeEvents.push(event) },
    createEventState("session-1"),
  );
  assert.deepEqual(
    opencodeEvents.filter((event) => event.type === "model"),
    [{ type: "model", model: "anthropic/claude-y" }],
    "a requested model is not evidence of what ran",
  );

  const codexChannel = new AgentEventChannel();
  const codexState: CodexTurnState = { settled: false, tools: new ToolObservations((event) => codexChannel.emit(event)) };
  codexNotificationResult(
    {
      method: "model/rerouted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        fromModel: "gpt-5-codex",
        toModel: "gpt-5-codex-mini",
        reason: "capacity",
      },
    },
    codexState,
    codexChannel,
  );
  const codexEvents = await drainChannel(codexChannel);
  assert.deepEqual(codexEvents, [{ type: "model", model: "gpt-5-codex-mini" }]);
  const unnamedChannel = new AgentEventChannel();
  codexNotificationResult({ method: "model/rerouted", params: { reason: "unnamed replacement" } }, codexState, unnamedChannel);
  assert.deepEqual(await drainChannel(unnamedChannel), [{ type: "model" }]);

  const root = temporaryDirectory(context, "keiyaku-codex-model-");
  const fake = fakeCodex(root, "model-evidence");
  const drive = await createCodexAppServerProvider({
    name: "configured",
    kind: "codex-app-server",
    executable: fake.executable,
  }).start({
    ...DRIVE_DEFAULTS,
    launchTells: [{ id: "launch", text: "build" }],
    cwd: root,
    options: {},
    session: { kind: "fresh" },
  }).result;
  // The channel keeps one unconsumed model observation, so the fixture reroutes
  // only once a reader has seen the admitted model: the two observations below
  // are ordered by that handshake, never by elapsed time.
  const observed: AgentEvent[] = [];
  const collecting = (async () => {
    for await (const event of drive.events) {
      observed.push(event);
      if (event.type === "model") writeFileSync(fake.rerouteRelease, "");
    }
  })();
  await drive.completion;
  await collecting;
  assert.deepEqual(
    observed.filter((event) => event.type === "model"),
    [
      { type: "model", model: "gpt-5-codex" },
      { type: "model", model: "gpt-5-codex-mini" },
    ],
    "thread admission names the loaded model; a reroute names its replacement",
  );
});

test("Codex current developer context reaches start, fork resume, and ordinary resume without changing personality", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-runtime-context-");
  const fake = fakeCodex(root);
  const provider = createCodexAppServerProvider(fake.executable);
  const input = freshInput("work", { cwd: root, options: { systemPrompt: "Personality", systemPromptMode: "append" } });
  const finish = async (attempt: ReturnType<typeof provider.start>) => {
    await (await attempt.result).completion;
    await attempt.closed;
  };
  await finish(provider.start({ ...input, runtimeInstructions: "<keiyaku>source</keiyaku>" }));
  const fork = provider.fork!({ session: { sessionId: "thread-fresh" }, at: "turn-1", cwd: root });
  const child = await fork.result;
  await fork.closed;
  await finish(provider.resume!({ ...input, runtimeInstructions: "<keiyaku>child</keiyaku>",
    session: { kind: "resume", coordinate: child.session } }));
  const clearInherited = "Any inherited Keiyaku execution context is inactive for this execution.";
  await finish(provider.resume!({ ...input, runtimeInstructions: clearInherited,
    session: { kind: "resume", coordinate: child.session } }));
  await finish(provider.start(input));
  const turns = fake.requests().filter((request) => request.method === "turn/start");
  assert.deepEqual(turns.map((turn) => (turn.params as Record<string, unknown>).additionalContext), [
    { keiyaku_execution: { kind: "application", value: "<keiyaku>source</keiyaku>" } },
    { keiyaku_execution: { kind: "application", value: "<keiyaku>child</keiyaku>" } },
    { keiyaku_execution: { kind: "application", value: clearInherited } },
    undefined,
  ]);
  const threads = fake.requests().filter((request) => request.method === "thread/start" || request.method === "thread/resume");
  assert.ok(threads.every((thread) => (thread.params as Record<string, unknown>).developerInstructions === "Personality"));
  assert.ok(turns.every((turn) => JSON.stringify((turn.params as Record<string, unknown>).input) === JSON.stringify([{ type: "text", text: "work" }])));
});

test("Codex forwards the Body pair through native env_vars without rewriting explicit MCP environment", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-codex-mcp-actor-");
  const fake = fakeCodex(root, "complete", {
    square: { command: "square", args: ["mcp-server"], env: { HOME_FLAG: "kept by native" }, env_vars: ["EXISTING"] },
    remote: { url: "https://example.com/mcp" },
    workspace: { command: "tools", environment_id: "workspace" },
    disabled: { command: "disabled", enabled: false },
  });
  const config = { mcp_servers: { square: { env: {
    CUSTOM: "kept",
    KEIYAKU_ACTOR_ID: "aku/authored/author",
  } } }, approval_policy: "never" };
  const provider = createCodexAppServerProvider({
    name: "configured", kind: "codex-app-server", executable: fake.executable, config,
  });
  const attempt = provider.start(freshInput("work", { cwd: root, execution: { akumaId: "aku/worker/1234abcd", world: "/world" } }));
  assert.equal((await (await attempt.result).completion).kind, "answered");
  await attempt.closed;
  assert.equal(fake.environment().KEIYAKU_ACTOR_ID, "aku/worker/1234abcd");
  assert.equal(fake.environment().KEIYAKU_ACTOR_WORLD, "/world");
  const request = fake.requests().find((entry) => entry.method === "thread/start");
  assert.deepEqual(request?.params, {
    cwd: root,
    config: { ...config, mcp_servers: { square: {
      env: { CUSTOM: "kept", KEIYAKU_ACTOR_ID: "aku/authored/author" },
      env_vars: ["EXISTING", "KEIYAKU_ACTOR_ID", "KEIYAKU_ACTOR_WORLD"],
    } } },
  });
});

test("Codex retains a command's aggregated output and every file change's patch", async () => {
  const events = new AgentEventChannel();
  const state: CodexTurnState = { settled: false, tools: new ToolObservations((event) => events.emit(event)) };
  const completed = (item: unknown) =>
    ({
      method: "item/completed",
      params: { item },
    }) as unknown as LineRpcNotification;
  const patchA = ["@@ -1 +1 @@", "-a", "+A"].join("\n");
  const patchB = ["@@ -0,0 +1 @@", "+b"].join("\n");

  codexNotificationResult(
    completed({
      id: "command-1",
      type: "commandExecution",
      command: "npm test",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: "1 failing",
    }),
    state,
    events,
  );
  const filesStarted = {
    method: "item/started",
    params: { item: { id: "files-1", type: "fileChange", changes: [] } },
  };
  codexNotificationResult(filesStarted, state, events);
  codexNotificationResult(filesStarted, state, events);
  codexNotificationResult(
    completed({
      id: "files-1",
      type: "fileChange",
      changes: [
        { path: "src/a.ts", kind: { type: "update" }, diff: patchA },
        { path: "src/b.ts", kind: { type: "add" }, diff: patchB },
      ],
    }),
    state,
    events,
  );

  codexNotificationResult(completed({ id: "files-1", type: "fileChange", changes: [] }), state, events);
  codexNotificationResult(filesStarted, state, events);
  assert.deepEqual(await drainChannel(events), [
    {
      type: "tool",
      phase: "completed",
      id: "command-1",
      name: "commandExecution",
      call: { kind: "run", command: "npm test" },
      result: { status: "error", output: "1 failing", exitCode: 1 },
    },
    { type: "tool", phase: "started", id: "files-1", name: "fileChange", call: { kind: "other", display: "fileChange" } },
    {
      type: "tool",
      phase: "completed",
      id: "files-1",
      name: "fileChange",
      call: {
        kind: "fileChange",
        changes: [
          { op: "update", path: "src/a.ts", diffstat: { added: 1, removed: 1 }, patch: patchA },
          { op: "add", path: "src/b.ts", diffstat: { added: 1, removed: 0 }, patch: patchB },
        ],
      },
      result: { status: "ok" },
    },
  ]);
});

test("Codex replaces a file observation atomically when completion supplies an empty patch", async () => {
  const events = new AgentEventChannel();
  const state: CodexTurnState = { settled: false, tools: new ToolObservations((event) => events.emit(event)) };
  const patch = "@@ -1 +1 @@\n-old\n+new";
  const item = { id: "file-1", type: "fileChange" };
  for (const [method, diff] of [["item/started", patch], ["item/completed", ""]] as const) {
    codexNotificationResult({
      method,
      params: { item: { ...item, changes: [{ path: "a.ts", kind: { type: "update" }, diff }] } },
    }, state, events);
  }
  assert.deepEqual(await drainChannel(events), [
    {
      type: "tool", phase: "started", id: "file-1", name: "fileChange",
      call: { kind: "fileChange", changes: [{ op: "update", path: "a.ts", patch, diffstat: { added: 1, removed: 1 } }] },
    },
    {
      type: "tool", phase: "completed", id: "file-1", name: "fileChange",
      call: { kind: "fileChange", changes: [{ op: "update", path: "a.ts", patch: "" }] },
      result: { status: "ok" },
    },
  ]);
});

test("Codex MCP argument previews come from the invocation, not the result", async () => {
  const events = new AgentEventChannel();
  const state: CodexTurnState = { settled: false, tools: new ToolObservations((event) => events.emit(event)) };
  const item = { id: "call-1", type: "mcpToolCall", server: "files", tool: "metadata" };
  codexNotificationResult({ method: "item/started", params: { item: { ...item, arguments: null } } }, state, events);
  codexNotificationResult({ method: "item/completed", params: { item: {
    ...item, status: "completed", arguments: { path: "conflicting" }, result: { content: [{ type: "text", text: "result body" }] },
  } } }, state, events);
  codexNotificationResult({ method: "item/completed", params: { item: {
    ...item, id: "call-2", status: "completed", result: { content: [{ type: "text", text: "not an invocation" }] },
  } } }, state, events);
  codexNotificationResult({ method: "item/completed", params: { item: {
    id: "call-3", type: "dynamicToolCall", namespace: "files", tool: "list", arguments: {}, status: "completed",
  } } }, state, events);
  const call = { kind: "other", display: "files/metadata", input: { json: "null", truncated: false } };
  assert.deepEqual(await drainChannel(events), [
    { type: "tool", phase: "started", id: "call-1", name: "files/metadata", call },
    { type: "tool", phase: "completed", id: "call-1", name: "files/metadata", call, result: { status: "ok" } },
    { type: "tool", phase: "completed", id: "call-2", name: "files/metadata",
      call: { kind: "other", display: "files/metadata" }, result: { status: "ok" } },
    { type: "tool", phase: "completed", id: "call-3", name: "files/list",
      call: { kind: "other", display: "files/list", input: { json: "{}", truncated: false } }, result: { status: "ok" } },
  ]);
});

test("OpenCode v2 records only producer-verified completed file patches", () => {
  const state = createEventState("session-1");
  const events: AgentEvent[] = [];
  const emitter = { emit: (event: AgentEvent) => void events.push(event) };
  const data = { sessionID: "session-1", assistantMessageID: "msg_assistant", id: "edit-1" };
  mapEvent({ type: "session.tool.input.started", data: { ...data, name: "edit" } }, emitter, state);
  mapEvent({ type: "session.tool.called", data: { ...data, input: { path: "a.ts", oldString: "before", newString: "after" }, executed: false } }, emitter, state);
  const patch = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-before\n+after\n";
  mapEvent({ type: "session.tool.success", data: {
    ...data, content: [{ type: "text", text: "Edited a.ts" }], executed: false,
    metadata: { files: [{ file: "a.ts", status: "modified", additions: 1, deletions: 1, patch }] },
  } }, emitter, state);
  assert.deepEqual(events.at(-1), {
    type: "tool", phase: "completed", id: "edit-1", name: "edit",
    call: { kind: "fileChange", changes: [{ op: "update", path: "a.ts", diffstat: { added: 1, removed: 1 }, patch }] },
    result: { status: "ok", output: "Edited a.ts" },
  });
});

test("Codex ignores notifications from a spawned child thread", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-foreign-thread-");
  const provider = createCodexAppServerProvider(fakeCodex(root, "foreign-thread").executable);
  const drive = await provider.start(freshInput("delegate", { cwd: root })).result;
  const events = await collectEvents(drive.events);

  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionId: "thread-fresh" } },
    { type: "assistant", text: "parent answer" },
  ]);
  assert.deepEqual(await drive.completion, {
    kind: "answered",
    answer: "parent answer",
    historyId: "turn-1",
  });
});

test("Codex force disposal retires a hung producer during terminal drain", { timeout: 10_000 }, async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-force-during-drain-");
  const fake = fakeCodex(root, "terminal-hang");
  const attempt = createCodexAppServerProvider(fake.executable).start(freshInput("observe", { cwd: root }));
  const drive = await attempt.result;
  const result = { kind: "answered", answer: "", historyId: "turn-1" };
  const nativePid = fake.pid();
  const deadline = new AbortController();
  try {
    await Promise.race([
      (async () => {
        assert.deepEqual(await drive.completion, result);
        await collectEvents(drive.events);
        await waitForFixtureFile(join(root, "terminal-eof"), 750);
        assert.equal(processExists(nativePid), true, "the child is still alive after stdin EOF");
        await attempt.forceDispose();
        await attempt.closed;
        assert.equal(await processGone(nativePid), true);
      })(),
      new Promise<void>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("force disposal waited for the terminal drain fallback")), 750);
        deadline.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      }),
    ]);
  } finally {
    deadline.abort();
    await attempt.forceDispose();
    await attempt.closed;
  }
  assert.deepEqual(await drive.completion, result);
});

test("Codex terminal closure fails a hung steer acknowledgement without waiting", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-steer-hung-terminal-");
  const drive = await createCodexAppServerProvider(fakeCodex(root, "steer-hung-terminal").executable).start(
    freshInput("work", { cwd: root }),
  ).result;
  await assert.rejects(
    drive.tell!({ id: "tell-live-hung", text: "never acknowledged" }),
    /line RPC process is closed/u,
  );
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
});
