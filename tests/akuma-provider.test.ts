import { opencodeFixture } from "./support/opencode-v2.js";
import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as acp from "@agentclientprotocol/sdk";
import {
  AKUMA_REQUESTS_ENV,
  AGENT_EVENT_QUEUE_LIMIT,
  createProviderAttempt,
  boundedToolInput,
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
import { encodeActivityEvent, decodeActivityRow } from "../src/akuma/heart/rows.js";
import { decodeResumeCoordinate } from "../src/akuma/coordinate.js";
import { type ProviderExecution } from "../src/akuma/provider-recipe.js";
import { createClaudeProvider } from "../src/akuma/providers/claude/index.js";
import { createCodexAppServerProvider } from "../src/akuma/providers/codex-app-server/index.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import {
  composeHeadlessPermissionConfig,
  loadOpencode,
  OPENCODE_SDK_PROVIDER,
  type OpencodeSdkLoader,
} from "../src/akuma/providers/opencode-sdk/session.js";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import { createAcpProvider } from "../src/akuma/providers/acp/index.js";
import { createGrokBuildProvider, interpretGrokTool } from "../src/akuma/providers/grok-build/index.js";
import { decodeProviderExecution, resolveProviderExecution } from "../src/akuma/providers/index.js";
import { EMPTY_ACP_EVENT_STATE, mapAcpUpdate } from "../src/akuma/providers/acp/events.js";
import { emitClaudeMessage, type ClaudeObservationState } from "../src/akuma/providers/claude/events.js";
import {
  codexNotificationResult,
  type CodexTurnState,
} from "../src/akuma/providers/codex-app-server/events.js";
import type { LineRpcNotification } from "../src/runtime/proc/line-rpc.js";
import { translatePiEvent, piSessionModel, type PiEventState } from "../src/akuma/providers/pi/events.js";
import { createEventState, mapEvent } from "../src/akuma/providers/opencode-sdk/events.js";
import type { StdioProcess } from "../src/runtime/proc/stdio.js";
import { waitForCondition, waitForFixtureFile } from "./support/process.js";

const DRIVE_DEFAULTS = {
  signal: new AbortController().signal,
  requests: { dir: "/tmp/akuma-test-requests" },
} as const;

/** Fresh carrier objects; non-default recipe and admission inputs remain at each call site. */
function freshInput(
  body: string,
  extra: Partial<Omit<DriveInput, "session">> = {},
): DriveInput & { session: { kind: "fresh" } } {
  return { ...DRIVE_DEFAULTS, body, launchTells: [], cwd: "/tmp", options: {}, ...extra, session: { kind: "fresh" } };
}

function attemptResult<Result>(attempt: ProviderAttempt<Result>): Promise<Result> {
  return attempt.result;
}

test("generic tool input admission and event codecs preserve bounded evidence", () => {
  assert.deepEqual(otherToolCall("future", {}), {
    kind: "other",
    display: "future",
    input: { json: "{}", truncated: false },
  });
  assert.deepEqual(otherToolCall("future"), { kind: "other", display: "future" });
  const supplied = { text: "é😀", count: 2, nested: { ok: true } };
  assert.deepEqual(otherToolCall("future", supplied).input, {
    json: JSON.stringify(supplied),
    truncated: false,
  });
  const oversized = boundedToolInput({ value: "😀".repeat(20_000) });
  assert.ok(oversized);
  assert.equal(oversized.truncated, true);
  assert.ok(new TextEncoder().encode(oversized.json).length <= 16_384);
  assert.equal([...oversized.json].at(-1), "😀");

  const event: AgentEvent = {
    type: "tool",
    phase: "started",
    id: "t1",
    name: "future_tool",
    call: { kind: "other", display: "future_tool", input: { json: '{"alpha":1}', truncated: false } },
  };
  assert.deepEqual(decodeAgentEvent(encodeAgentEvent(event)), event);
  const legacy: AgentEvent = {
    type: "tool",
    phase: "started",
    id: "t2",
    name: "future_tool",
    call: { kind: "other", display: "future_tool" },
  };
  assert.deepEqual(decodeAgentEvent(encodeAgentEvent(legacy)), legacy);
  const truncated: AgentEvent = {
    type: "tool",
    phase: "started",
    id: "t3",
    name: "future_tool",
    truncated: true,
    call: { kind: "other", display: "future_tool", input: { json: '{"value":"x', truncated: true } },
  };
  assert.deepEqual(decodeAgentEvent({ type: "assistant", text: "x", extra: true }), { type: "assistant", text: "x" });
  assert.deepEqual(
    decodeAgentEvent({
      type: "tool",
      phase: "started",
      id: "extra",
      name: "future",
      call: { kind: "other", display: "future", extra: true },
      extra: true,
    }),
    { type: "tool", phase: "started", id: "extra", name: "future", call: { kind: "other", display: "future" } },
  );
  assert.throws(() =>
    decodeAgentEvent({
      type: "tool",
      phase: "completed",
      id: "missing",
      name: "future",
      call: { kind: "other", display: "future" },
    }),
  );
  assert.deepEqual(decodeAgentEvent(encodeAgentEvent(truncated)), truncated);
});

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
  } else mapEvent({ type: "session.tool.success", data: { ...data, content: [{ type: "text", text: "" }], executed: false } }, emitter, state);
}

function toolPreview(events: readonly AgentEvent[]) {
  const event = events.at(-1);
  return event?.type === "tool" && event.call.kind === "other" ? event.call.input : undefined;
}

async function claudeToolCall(input: unknown) {
  const state: ClaudeObservationState = { tools: new Map() };
  const channel = new AgentEventChannel();
  const block =
    input === undefined
      ? { type: "tool_use", id: "bash-1", name: "Bash" }
      : { type: "tool_use", id: "bash-1", name: "Bash", input };
  emitClaudeMessage(
    {
      type: "assistant",
      uuid: "assistant-1",
      session_id: "session-claude",
      parent_tool_use_id: null,
      message: { content: [block] },
    } as unknown as SDKMessage,
    channel,
    state,
  );
  const [event] = await drainChannel(channel);
  return event?.type === "tool" ? event.call : undefined;
}

test("native adapters admit structured unknown arguments into one bounded generic call", async () => {
  const piState: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
  const piArgs = { alpha: 1, nested: { ok: true } };
  const [piStart] = translatePiEvent(
    { type: "tool_execution_start", toolCallId: "pi-1", toolName: "future_tool", args: piArgs },
    piState,
  );
  const piCall = { kind: "other", display: "future_tool", input: { json: JSON.stringify(piArgs), truncated: false } };
  assert.deepEqual(piStart, { type: "tool", phase: "started", id: "pi-1", name: "future_tool", call: piCall });
  const [piEnd] = translatePiEvent(
    {
      type: "tool_execution_end",
      toolCallId: "pi-1",
      toolName: "future_tool",
      isError: false,
      result: { secret: true },
    },
    piState,
  );
  assert.deepEqual(
    piEnd,
    { type: "tool", phase: "completed", id: "pi-1", name: "future_tool", call: piCall, result: { status: "ok" } },
    "a completion reuses its correlated start and never carries result bytes",
  );

  const call = { kind: "other", display: "future_tool", input: { json: '{"alpha":1}', truncated: false } };
  const acpStart = mapAcpUpdate(acpToolUpdate("tool_call", "acp-1", { alpha: 1 }), EMPTY_ACP_EVENT_STATE);
  assert.deepEqual(acpStart.events, [{ type: "tool", phase: "started", id: "acp-1", name: "future_tool", call }]);
  const acpEnd = mapAcpUpdate(acpToolUpdate("tool_call_update", "acp-1"), acpStart.state);
  assert.deepEqual(
    acpEnd.events,
    [{ type: "tool", phase: "completed", id: "acp-1", name: "future_tool", call, result: { status: "ok" } }],
    "an acknowledging update without arguments inherits its correlated start",
  );

  const claudeState: ClaudeObservationState = { tools: new Map() };
  const claudeChannel = new AgentEventChannel();
  emitClaudeMessage(
    {
      type: "assistant",
      uuid: "assistant-1",
      session_id: "session-claude",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "claude-1", name: "future_tool", input: { alpha: 1 } }] },
    } as unknown as SDKMessage,
    claudeChannel,
    claudeState,
  );
  emitClaudeMessage(
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "claude-1", is_error: false }] },
    } as unknown as SDKMessage,
    claudeChannel,
    claudeState,
  );
  assert.deepEqual(await drainChannel(claudeChannel), [
    { type: "tool", phase: "started", id: "claude-1", name: "future_tool", call },
    { type: "tool", phase: "completed", id: "claude-1", name: "future_tool", call, result: { status: "ok" } },
  ]);

  const opencodeState = createEventState("session-1");
  const opencodeEvents: AgentEvent[] = [];
  const emitter = { emit: (mapped: AgentEvent): void => void opencodeEvents.push(mapped) };
  mapOpencodeTool("running", { alpha: 1 }, emitter, opencodeState);
  mapOpencodeTool("completed", undefined, emitter, opencodeState);
  assert.deepEqual(
    opencodeEvents,
    [
      { type: "tool", phase: "started", id: "oc-1", name: "future_tool", call },
      { type: "tool", phase: "completed", id: "oc-1", name: "future_tool", call, result: { status: "ok", output: "" } },
    ],
    "an OpenCode completion without input inherits its correlated start",
  );
});

test("shared search construction keeps each adapter's predicate and omitted metadata", async () => {
  const claudeCall = async (name: string, input: unknown) => {
    const state: ClaudeObservationState = { tools: new Map() };
    const channel = new AgentEventChannel();
    emitClaudeMessage(
      {
        type: "assistant",
        uuid: "assistant-1",
        session_id: "session-claude",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "tool-1", name, input }] },
      } as unknown as SDKMessage,
      channel,
      state,
    );
    const [event] = await drainChannel(channel);
    return event?.type === "tool" ? event.call : undefined;
  };
  const piCall = (toolName: string, args: unknown) => {
    const state: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
    const [event] = translatePiEvent(
      { type: "tool_execution_start", toolCallId: "pi-1", toolName, args } as never,
      state,
    );
    return event?.type === "tool" ? event.call : undefined;
  };
  const grokCall = (name: string, rawInput: unknown) =>
    interpretGrokTool({
      sessionUpdate: "tool_call",
      toolCallId: "grok-1",
      name,
      kind: "other",
      status: "in_progress",
      rawInput,
    } as never);
  const acpCall = (rawInput: unknown) => {
    const mapped = mapAcpUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "acp-1",
        name: "search",
        kind: "search",
        status: "in_progress",
        rawInput,
      } as unknown as acp.SessionUpdate,
      EMPTY_ACP_EVENT_STATE,
    );
    const [event] = mapped.events;
    return event?.type === "tool" ? event.call : undefined;
  };

  // ACP retains supplied whitespace, drops an unrecognized scope, and omits absent bounds.
  assert.deepEqual(acpCall({ query: "  needle  ", path: " src ", glob: " *.ts ", scope: "content" }), {
    kind: "search",
    query: "  needle  ",
    scope: "content",
    path: " src ",
    glob: " *.ts ",
  });
  assert.deepEqual(acpCall({ query: "only", scope: "dialect" }), { kind: "search", query: "only" });

  // Claude trims every search scalar; Glob carries no glob and WebSearch carries no bounds.
  assert.deepEqual(await claudeCall("Grep", { pattern: "  needle  ", path: " src ", glob: " *.ts " }), {
    kind: "search",
    query: "needle",
    scope: "content",
    path: "src",
    glob: "*.ts",
  });
  assert.deepEqual(await claudeCall("Grep", { pattern: "  only  " }), {
    kind: "search",
    query: "only",
    scope: "content",
  });
  assert.deepEqual(await claudeCall("Glob", { pattern: " *.ts ", path: " src " }), {
    kind: "search",
    query: "*.ts",
    scope: "files",
    path: "src",
  });
  assert.deepEqual(await claudeCall("WebSearch", { query: " how " }), {
    kind: "search",
    query: "how",
    scope: "web",
  });

  // Pi and Grok retain supplied whitespace, and only grep carries a glob.
  assert.deepEqual(piCall("grep", { pattern: "  needle  ", path: " src ", glob: " *.ts " }), {
    kind: "search",
    query: "  needle  ",
    scope: "content",
    path: " src ",
    glob: " *.ts ",
  });
  assert.deepEqual(piCall("find", { pattern: "  needle  ", path: " src ", glob: " *.ts " }), {
    kind: "search",
    query: "  needle  ",
    scope: "files",
    path: " src ",
  });
  assert.deepEqual(grokCall("grep", { pattern: "  needle  ", path: " src ", glob: " *.ts " }), {
    kind: "search",
    query: "  needle  ",
    scope: "content",
    path: " src ",
    glob: " *.ts ",
  });
  assert.deepEqual(grokCall("hashline_grep", { pattern: "only" }), { kind: "search", query: "only", scope: "content" });
});

test("Claude keeps supplied scalar, null, empty-object, and absent Bash input distinct", async () => {
  assert.deepEqual(await claudeToolCall({ command: "npm test" }), { kind: "run", command: "npm test" });
  assert.deepEqual(await claudeToolCall({ description: "x" }), {
    kind: "other",
    display: "Bash",
    input: { json: '{"description":"x"}', truncated: false },
  });
  assert.deepEqual(await claudeToolCall({}), {
    kind: "other",
    display: "Bash",
    input: { json: "{}", truncated: false },
  });
  assert.deepEqual(await claudeToolCall(null), {
    kind: "other",
    display: "Bash",
    input: { json: "null", truncated: false },
  });
  assert.deepEqual(await claudeToolCall("run it"), {
    kind: "other",
    display: "Bash",
    input: { json: '"run it"', truncated: false },
  });
  assert.deepEqual(await claudeToolCall(42), {
    kind: "other",
    display: "Bash",
    input: { json: "42", truncated: false },
  });
  assert.deepEqual(await claudeToolCall(undefined), { kind: "other", display: "Bash" });
});

test("Claude retains observed result text, a supplied patch, and a native hunk record", async () => {
  const patch = ["@@ -1 +1 @@", "-before", "+after"].join("\n");
  const run = async (toolUseResult: unknown, content: unknown) => {
    const state: ClaudeObservationState = { tools: new Map() };
    const channel = new AgentEventChannel();
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
  const acpStart = mapAcpUpdate(acpToolUpdate("tool_call", "acp-1", { alpha: 1 }), EMPTY_ACP_EVENT_STATE);
  const started = { json: '{"alpha":1}', truncated: false };
  for (const rawInput of [{}, { beta: 2 }, null])
    assert.deepEqual(
      toolPreview(mapAcpUpdate(acpToolUpdate("tool_call_update", "acp-1", rawInput), acpStart.state).events),
      started,
      "ACP keeps the start preview for " + JSON.stringify(rawInput),
    );
  assert.deepEqual(
    toolPreview(mapAcpUpdate(acpToolUpdate("tool_call_update", "acp-1"), acpStart.state).events),
    started,
    "ACP keeps the start preview when the update omits input",
  );
  const acpBare = mapAcpUpdate(acpToolUpdate("tool_call", "acp-2"), EMPTY_ACP_EVENT_STATE);
  assert.deepEqual(
    toolPreview(mapAcpUpdate(acpToolUpdate("tool_call_update", "acp-2", { gamma: 3 }), acpBare.state).events),
    { json: '{"gamma":3}', truncated: false },
    "ACP adopts the first supplied evidence",
  );

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

test("AgentEventChannel bounds reconstructible activity while retaining session and error events", async () => {
  const channel = new AgentEventChannel();
  const session: AgentEvent = { type: "session", coordinate: { sessionId: "session-1" } };
  channel.emit(session);
  for (let index = 0; index < AGENT_EVENT_QUEUE_LIMIT + 8; index += 1)
    channel.emit({ type: "assistant", text: `update-${index}` });
  const error = {
    type: "tool",
    phase: "completed",
    id: "tool-1",
    name: "shell",
    call: { kind: "run", command: "false" },
    result: { status: "error", message: "failed" },
  } satisfies AgentEvent;
  channel.emit(error);
  channel.end();

  const events: AgentEvent[] = [];
  for await (const event of channel) events.push(event);
  assert.equal(events.length, AGENT_EVENT_QUEUE_LIMIT);
  assert.deepEqual(events[0], session);
  assert.deepEqual(events.at(-1), error);
  assert.equal(
    events.some((event) => event.type === "assistant" && event.text === "update-0"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "assistant" && event.text === "update-7"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "assistant" && event.text === `update-${AGENT_EVENT_QUEUE_LIMIT + 7}`),
    true,
  );
});

test("AgentEventChannel ignores post-end events before queue mutation", async () => {
  const channel = new AgentEventChannel();
  channel.end();
  for (let index = 0; index < AGENT_EVENT_QUEUE_LIMIT + 1; index += 1)
    assert.doesNotThrow(() => channel.emit(noteEvent(`late-${index}`)));
  const iterator = channel[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("AgentEventChannel coalesces protected overflow without throwing", async () => {
  const channel = new AgentEventChannel();
  for (let index = 0; index < AGENT_EVENT_QUEUE_LIMIT + 1; index += 1)
    assert.doesNotThrow(() => channel.emit(noteEvent(`error-${index}`)));
  channel.end();

  const events: AgentEvent[] = [];
  for await (const event of channel) events.push(event);
  const markers = events.filter(
    (event): event is Extract<AgentEvent, { type: "note" }> =>
      event.type === "note" && event.text.startsWith("Agent event queue overflow"),
  );
  assert.equal(events.length, AGENT_EVENT_QUEUE_LIMIT);
  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.text, "Agent event queue overflow: 2 terminal/error events coalesced");
});

test("AgentEventChannel keeps the runtime model observation narration overflow would drop", async () => {
  const channel = new AgentEventChannel();
  channel.emit({ type: "session", coordinate: { sessionId: "session-1" } });
  channel.emit({ type: "model", model: "claude-native" });
  for (let index = 0; index < AGENT_EVENT_QUEUE_LIMIT + 8; index += 1)
    channel.emit({ type: "assistant", text: `update-${index}` });
  channel.end();

  const events: AgentEvent[] = [];
  for await (const event of channel) events.push(event);
  assert.deepEqual(
    events.filter((event) => event.type === "model"),
    [{ type: "model", model: "claude-native" }],
    "the model the adapter proved it ran is not narration to discard",
  );
  assert.equal(events.length, AGENT_EVENT_QUEUE_LIMIT + 1);
  assert.equal(events.some((event) => event.type === "assistant" && event.text === "update-0"), false);
  assert.equal(
    events.some((event) => event.type === "assistant" && event.text === `update-${AGENT_EVENT_QUEUE_LIMIT + 7}`),
    true,
  );
});

test("AgentEventChannel keeps the latest model observation above a saturated protected queue", async () => {
  const channel = new AgentEventChannel();
  for (let index = 0; index < AGENT_EVENT_QUEUE_LIMIT; index += 1) channel.emit(noteEvent(`error-${index}`));
  channel.emit({ type: "model", model: "claude-native" });
  channel.emit({ type: "model" });
  channel.emit(noteEvent("error-late-1"));
  channel.emit(noteEvent("error-late-2"));
  channel.end();

  const events: AgentEvent[] = [];
  for await (const event of channel) events.push(event);
  assert.deepEqual(
    events.filter((event) => event.type === "model"),
    [{ type: "model" }],
    "one coalesced observation holds the newest fact, an unnamed one clearing the named one",
  );
  assert.equal(events.length, AGENT_EVENT_QUEUE_LIMIT + 1);
  const markers = events.filter(
    (event): event is Extract<AgentEvent, { type: "note" }> =>
      event.type === "note" && event.text.startsWith("Agent event queue overflow"),
  );
  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.text, "Agent event queue overflow: 3 terminal/error events coalesced");
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

test("ProviderAttempt rejects ownership after establishment settles", async () => {
  let custody!: AttemptCustody;
  const attempt = createProviderAttempt(undefined, async (received) => {
    custody = received;
    return "ready";
  });

  assert.equal(await attempt.result, "ready");
  assert.throws(
    () => custody.own({ closed: Promise.resolve(), forceDispose: async () => undefined }),
    /after provider establishment settles/u,
  );
  await attempt.closed;
});

function fakeOpencode() {
  const native = opencodeFixture();
  const executions: ProviderExecution[] = [];
  const prompt = native.session.prompt;
  const loader: OpencodeSdkLoader = async (cwd, execution, signal) => {
    executions.push(execution);
    const loaded = await native.loader(cwd, execution, signal);
    return {
      ...loaded,
      client: {
        ...loaded.client,
        session: { ...loaded.client.session, async prompt(input) {
          const response = await prompt(input);
          native.admitted(input.body.id);
          native.delivered(input.body.id);
          native.step();
          native.push("session.tool.input.started", { assistantMessageID: "msg_assistant", id: "tool-1", name: "shell" });
          native.push("session.tool.called", { assistantMessageID: "msg_assistant", id: "tool-1", input: { command: "npm test" }, executed: false });
          native.push("session.tool.success", { assistantMessageID: "msg_assistant", id: "tool-1", content: [{ type: "text", text: "ok" }], executed: false });
          native.push("session.reasoning.ended", { assistantMessageID: "msg_assistant", ordinal: 0, text: "checked" });
          native.push("session.future", { secret: "drop" });
          native.complete();
          return response;
        } },
      },
    };
  };
  return { loader, closed: native.closed, executions, prompts: native.prompts };
}

test("provider answered results may omit an exact fork point", () => {
  const result: TurnResult = { kind: "answered", answer: "complete answer" };
  assert.deepEqual(result, { kind: "answered", answer: "complete answer" });
});

function fakeAcp(
  root: string,
  mode: "complete" | "cancel" | "reverse" | "prompt-error" | "config" | "config-missing" = "complete",
) {
  const executable = join(root, "fake-acp.mjs");
  const log = join(root, "acp-log.jsonl");
  const sdk = join(process.cwd(), "node_modules/@agentclientprotocol/sdk/dist/acp.js");
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
    log({ kind: "prompt", params, argv: process.argv.slice(2), requests: process.env.AKUMA_REQUESTS });
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
    freshInput("build", {
      launchTells: [{ id: "tell-1", text: "then test" }],
      cwd: root,
      options: { model: "grok-4", effort: "high", systemPrompt: "Be precise." },
      requests: { dir: join(root, "requests") },
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
    { type: "note", text: "Plan updated: Verify" },
    { type: "note", text: "ACP configuration updated" },
  ]);
  const records = acpLog(fake.log);
  assert.deepEqual(
    records.map((record) => record.kind),
    ["initialize", "new", "prompt"],
  );
  assert.deepEqual((records[2]!.params as { prompt: unknown }).prompt, [
    { type: "text", text: "build" },
    { type: "text", text: "then test" },
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
  assert.equal(records[2]!.requests, join(root, "requests"));
  assert.equal("_meta" in (records[1]!.params as object), false);
  assert.equal("rules" in (records[1]!.params as object), false);
  assert.equal("systemPromptOverride" in (records[1]!.params as object), false);
});

test("ACP load retains the exact session ID without a fork or live tell capability", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-acp-resume-");
  const fake = fakeAcp(root);
  const provider = createAcpProvider(fake.execution);
  assert.equal(provider.fork, undefined);
  const drive = await provider.resume!({
    ...DRIVE_DEFAULTS,
    body: "continue",
    launchTells: [],
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
          body: "continue",
          launchTells: [],
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

test("ACP refuses unavailable model and effort choices before sending a prompt", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-acp-unavailable-");
  const fake = fakeAcp(root, "config");
  const provider = createAcpProvider({
    ...fake.execution,
    config: {
      argvBefore: [fake.execution.config.argvBefore[0]!],
      argvAfter: [],
      modelConfigId: "model",
      effortConfigId: "thinking",
    },
  });
  const invalid = provider.start(freshInput("build", { cwd: root, options: { model: "k28", effort: "medium" } }));
  await assert.rejects(invalid.result, /ACP effort value 'medium' is unavailable/u);
  await invalid.closed;
  assert.deepEqual(
    acpLog(fake.log).map((record) => record.kind),
    ["initialize", "new", "set-config"],
  );

  const missing = fakeAcp(temporaryDirectory(context, "keiyaku-acp-missing-"), "config-missing");
  const missingProvider = createAcpProvider({
    ...missing.execution,
    config: { argvBefore: [missing.execution.config.argvBefore[0]!], argvAfter: [], modelConfigId: "model" },
  });
  const attempt = missingProvider.start(freshInput("build", { cwd: root, options: { model: "k28" } }));
  await assert.rejects(attempt.result, /ACP model option 'model' is unavailable/u);
  await attempt.closed;
  assert.deepEqual(
    acpLog(missing.log).map((record) => record.kind),
    ["initialize", "new"],
  );
  assert.throws(
    () =>
      createAcpProvider({
        ...fake.execution,
        config: { argvBefore: [], argvAfter: [], modelArg: "--model", modelConfigId: "model" },
      }),
    /cannot map model to both/u,
  );
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

type ControlledInterject = Readonly<{
  sessionId: string;
  text: string;
  interjectionId: string;
}>;

function controlledAcpProcess(
  options: Readonly<{
    stallInitialize?: boolean;
    stallPrompt?: boolean;
    assistant?: string;
    interject?: "queued" | "rejected" | "pending";
    broadcast?: boolean;
  }> = {},
): Readonly<{
  process: StdioProcess;
  initializeStarted: Promise<void>;
  cleanupStarted: Promise<void>;
  interjectStarted: Promise<void>;
  interjections: readonly ControlledInterject[];
  cancelled(): number;
  forcedCleanup(): number;
  emitAssistant(text: string): Promise<void>;
  resolvePrompt(): void;
  resolveInterject(): void;
  emitInterjection(value: ControlledInterject): Promise<void>;
  resolveCleanup(): void;
  rejectCleanup(error: Error): void;
  readonly sessionNew: unknown;
  readonly sessionLoad: unknown;
}> {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const { promise: cleanupStarted, resolve: startCleanup } = promiseBarrier<void>();
  let resolveCleanup!: () => void;
  let rejectCleanup!: (error: Error) => void;
  let forcedCleanup = 0;
  const { promise: initializeStarted, resolve: startInitialize } = promiseBarrier<void>();
  const { promise: prompt, resolve: finishPrompt } = promiseBarrier<void>();
  const { promise: interject, resolve: finishInterject } = promiseBarrier<void>();
  const { promise: interjectStarted, resolve: startInterject } = promiseBarrier<void>();
  const interjections: ControlledInterject[] = [];
  let cancelled = 0;
  let emitAssistant!: (text: string) => Promise<void>;
  let emitInterjection!: (value: ControlledInterject) => Promise<void>;
  let sessionNew: unknown;
  let sessionLoad: unknown;
  const cleanup = new Promise<void>((resolve, reject) => {
    resolveCleanup = resolve;
    rejectCleanup = reject;
  });
  const { promise: exited, resolve: resolveExited } =
    promiseBarrier<Readonly<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>>();
  const app = acp
    .agent({ name: "controlled-acp" })
    .onRequest(acp.methods.agent.initialize, async ({ params }) => {
      startInitialize();
      if (options.stallInitialize === true) await new Promise(() => undefined);
      return { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true } };
    })
    .onRequest(acp.methods.agent.session.new, ({ params }) => {
      sessionNew = params;
      return { sessionId: "controlled-session" };
    })
    .onRequest(acp.methods.agent.session.load, ({ params }) => {
      sessionLoad = params;
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      emitAssistant = async (text) =>
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
      if (options.assistant !== undefined) await emitAssistant(options.assistant);
      if (options.stallPrompt === true) await prompt;
      return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      cancelled += 1;
    });
  if (options.interject !== undefined) {
    app.onRequest<ControlledInterject, { status: "queued" }>(
      "_x.ai/interject",
      (value) => value as ControlledInterject,
      async ({ params, client }) => {
        interjections.push(params);
        startInterject();
        emitInterjection = async (value) => await client.notify("_x.ai/session/interjection", value);
        if (options.interject === "rejected") throw new acp.RequestError(-32603, "interject rejected");
        if (options.broadcast !== false) await emitInterjection(params);
        if (options.interject === "pending") await interject;
        return { status: "queued" };
      },
    );
  }
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
        startCleanup();
        await cleanup;
        resolveExited({ code: 0, signal: null, stderr: "" });
      },
      close: async (force) => {
        if (force) {
          forcedCleanup += 1;
          resolveCleanup();
        }
        await cleanup;
        resolveExited({ code: null, signal: force ? "SIGKILL" : null, stderr: "" });
      },
    },
    initializeStarted,
    cleanupStarted,
    interjectStarted,
    interjections,
    cancelled: () => cancelled,
    forcedCleanup: () => forcedCleanup,
    emitAssistant: async (text) => await emitAssistant(text),
    resolvePrompt: finishPrompt,
    resolveInterject: finishInterject,
    emitInterjection: async (value) => await emitInterjection(value),
    resolveCleanup,
    rejectCleanup,
    get sessionNew() {
      return sessionNew;
    },
    get sessionLoad() {
      return sessionLoad;
    },
  };
}

const controlledAcpExecution = {
  name: "controlled-acp",
  kind: "acp" as const,
  executable: "controlled",
  config: { argvBefore: [], argvAfter: [] },
};

const controlledGrokExecution = {
  name: "grok-build",
  kind: "grok-build" as const,
  executable: "grok",
};

test("Grok Build uses fixed launch arguments and admits broadcast interject on the live ACP connection", async () => {
  const controlled = controlledAcpProcess({ stallPrompt: true, interject: "queued" });
  let spawned: readonly string[] = [];
  const provider = createGrokBuildProvider(controlledGrokExecution, {
    freshSessionMeta: { custom: "preserved" },
    spawnProcess: (input) => {
      spawned = input.argv;
      return controlled.process;
    },
  });
  assert.deepEqual(provider.admitOptions({ model: "grok-4.6", effort: "high" }), {
    kind: "admitted",
    options: { model: "grok-4.6", effort: "high" },
  });
  const drive = await provider.start(freshInput("build", { options: { model: "grok-4.6", effort: "high" } })).result;
  assert.deepEqual((controlled.sessionNew as { _meta?: Readonly<Record<string, unknown>> })._meta, {
    custom: "preserved",
    askUserQuestion: false,
  });
  assert.equal(drive.receipts, undefined);
  assert.ok(drive.tell);
  assert.deepEqual(await drive.tell({ id: "tell-123", text: "change direction" }), {
    kind: "accepted",
    fence: "tell-123",
  });
  assert.deepEqual(controlled.interjections, [
    {
      sessionId: "controlled-session",
      text: "change direction",
      interjectionId: "tell-123",
    },
  ]);
  assert.deepEqual(spawned, [
    "grok",
    "agent",
    "--always-approve",
    "--model",
    "grok-4.6",
    "--reasoning-effort",
    "high",
    "stdio",
  ]);
  controlled.resolvePrompt();
  await controlled.cleanupStarted;
  controlled.resolveCleanup();
  await drive.completion;
});

test("Grok Build returns turn-ended when completion wins before interject acknowledgement", async () => {
  const controlled = controlledAcpProcess({ stallPrompt: true, interject: "pending", broadcast: false });
  const drive = await createGrokBuildProvider(controlledGrokExecution, {
    spawnProcess: () => controlled.process,
  }).start(freshInput("build")).result;
  const submission = drive.tell!({ id: "tell-late", text: "too late" });
  await controlled.interjectStarted;
  controlled.resolvePrompt();
  await controlled.cleanupStarted;
  controlled.resolveInterject();
  assert.deepEqual(await submission, { kind: "turn-ended" });
  controlled.resolveCleanup();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "" });
});

test("ACP cleanup failure settles a typed failed Turn", async () => {
  const controlled = controlledAcpProcess();
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start(
    freshInput("build"),
  ).result;
  await controlled.cleanupStarted;
  controlled.rejectCleanup(new Error("drain failed"));
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "ACP cleanup failed: drain failed" });
});

test("ACP setup abort closes a child stalled during initialization", async () => {
  const controlled = controlledAcpProcess({ stallInitialize: true });
  const controller = new AbortController();
  const setup = createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start(
    freshInput("build", { signal: controller.signal }),
  );
  assert.equal("result" in setup && "closed" in setup, true);
  await controlled.initializeStarted;
  controller.abort(new Error("controlled setup cancellation"));
  await assert.rejects(setup.result, /controlled setup cancellation/);
  await setup.closed;
  assert.equal(controlled.forcedCleanup(), 1);
});

test("ACP ignores assistant updates after terminal prompt evidence", async () => {
  const controlled = controlledAcpProcess({ assistant: "before" });
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start(
    freshInput("build"),
  ).result;
  const events = (async () => {
    const observed = await collectEvents(drive.events);
    return observed;
  })();
  await controlled.cleanupStarted;
  await controlled.emitAssistant(" after");
  controlled.resolveCleanup();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "before" });
  assert.deepEqual(await events, [
    { type: "session", coordinate: { sessionId: "controlled-session" } },
    { type: "assistant", text: "before" },
  ]);
});

test("ACP mapper preserves buffered state for an unknown runtime update discriminant", () => {
  const previous = {
    ...EMPTY_ACP_EVENT_STATE,
    answer: "retained",
    open: { type: "assistant" as const, text: "partial" },
  };
  const mapped = mapAcpUpdate({ sessionUpdate: "future_update" } as never, previous);
  assert.deepEqual(mapped, {
    events: [{ type: "unknown", kind: "future_update" }],
    state: previous,
  });
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
          resourceLoader: { getExtensions: () => ({ runtime: { invalidate: () => { seen.invalidated += 1; } } }) },
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

test("OpenCode v2 adapter admits and completes from native execution evidence", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
  const drive = await provider.start(
    freshInput("build", { launchTells: [{ id: "tell-1", text: "also check" }], requests: { dir: "/tmp/requests" } }),
  ).result;
  assert.equal(drive.admission.fence, fake.prompts[0]!.body.id);
  const observed = await collectEvents(drive.events);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "answer", historyId: "msg_terminal" });
  assert.deepEqual(
    observed.map((event) => event.type),
    ["session", "model", "tool", "tool", "thought", "unknown", "assistant"],
  );
  assert.equal(JSON.stringify(observed).includes("secret"), false);
  const completedTool = observed[3];
  assert.ok(completedTool?.type === "tool" && completedTool.phase === "completed");
  assert.deepEqual(completedTool.call, { kind: "run", command: "npm test" });
  assert.deepEqual(completedTool.result, { status: "ok", output: "ok" }, "the completed state's output survives");
  assert.equal(fake.closed(), 1);
  assert.equal(fake.executions[0]!.env?.[AKUMA_REQUESTS_ENV], "/tmp/requests");
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

test("OpenCode always carries the headless permission base layer into the spawned server environment", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-opencode-headless-");
  const recorded = join(root, "environment.json");
  const executable = join(root, "opencode");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.env));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  const spawnedEnvironment = async (env?: Readonly<Record<string, string>>) => {
    rmSync(recorded, { force: true });
    const controller = new AbortController();
    const loading = loadOpencode({
      execution: {
        name: OPENCODE_SDK_PROVIDER,
        kind: "opencode-sdk",
        executable,
        ...(env === undefined ? {} : { env }),
      },
      cwd: root,
      signal: controller.signal,
    });
    await waitForFixtureFile(recorded);
    controller.abort();
    await assert.rejects(loading, /aborted/u);
    return JSON.parse(readFileSync(recorded, "utf8")) as Record<string, string>;
  };

  const base = await spawnedEnvironment();
  assert.deepEqual(JSON.parse(base.OPENCODE_CONFIG_CONTENT ?? "null"), composeHeadlessPermissionConfig());
  const literal = '{"permissions":[{"action":"question","resource":"*","effect":"allow"}]}';
  const overridden = await spawnedEnvironment({ OPENCODE_CONFIG_CONTENT: literal });
  assert.equal(overridden.OPENCODE_CONFIG_CONTENT, literal);
});

test("OpenCode start and resume reject closed when readiness cleanup fails", async () => {
  for (const mode of ["start", "resume"] as const) {
    const ready = deferred<void>();
    let closed = 0;
    const provider = createOpencodeProvider({
      loader: async () => ({
        client: { session: {} as never, event: {} as never },
        close: async () => {
          closed += 1;
          throw new Error("OpenCode runtime close failed");
        },
        ready: ready.promise,
      }),
    });
    const attempt =
      mode === "start"
        ? provider.start(freshInput("wait"))
        : provider.resume!({
            ...DRIVE_DEFAULTS,
            body: "wait",
            launchTells: [],
            cwd: "/tmp",
            options: {},
            session: { kind: "resume", coordinate: { sessionId: "session-resume" } },
          });

    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(attempt.forceDispose(), /OpenCode runtime close failed/u);
    await assert.rejects(attempt.result, /OpenCode runtime close failed/u);
    await assert.rejects(attempt.closed, /OpenCode runtime close failed/u);
    assert.equal(closed, 1);
  }
});

test("OpenCode v2 adapter resumes the supplied coordinate and forks the exact point", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  const drive = await provider.resume!({
    ...DRIVE_DEFAULTS,
    body: "continue",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "resume", coordinate: { sessionId: "ses_fixture" } },
  }).result;
  assert.equal((await drive.completion).kind, "answered");
  assert.deepEqual(
    await provider.fork!({ session: { sessionId: "ses_fixture" }, at: "msg_terminal", cwd: "/tmp" }).result,
    {
      session: { sessionId: "ses_child" },
    },
  );
});

test("OpenCode fork force-disposes a runtime held at readiness before publishing a result", async () => {
  const ready = deferred<void>();
  let closed = 0;
  let forked = 0;
  const provider = createOpencodeProvider({
    loader: async () => ({
      client: {
        session: {
          async fork() {
            forked += 1;
            return { data: { id: "session-child" } };
          },
        } as never,
        event: {} as never,
      },
      close: async () => {
        closed += 1;
      },
      ready: ready.promise,
    }),
  });
  const attempt = provider.fork!({ session: { sessionId: "session-source" }, at: "message-1", cwd: "/tmp" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await attempt.forceDispose();
  await assert.rejects(attempt.result, /provider attempt retired/u);
  await attempt.closed;
  assert.equal(closed, 1);
  assert.equal(forked, 0);
});

test("OpenCode v2 refuses a Pi coordinate before loading its native runtime", async () => {
  let loaded = false;
  const provider = createOpencodeProvider({
    loader: async () => {
      loaded = true;
      throw new Error("must not load");
    },
  });
  await assert.rejects(
    attemptResult(
      provider.resume!({
        ...DRIVE_DEFAULTS,
        body: "continue",
        launchTells: [],
        cwd: "/tmp",
        options: {},
        session: { kind: "resume", coordinate: { sessionFile: "/sessions/pi.jsonl" } },
      }),
    ),
    /OpenCode resume requires sessionId/u,
  );
  await assert.rejects(
    attemptResult(provider.fork!({ session: { sessionFile: "/sessions/pi.jsonl" }, at: "message-1", cwd: "/tmp" })),
    /OpenCode resume requires sessionId/u,
  );
  assert.equal(loaded, false);
});

test("OpenCode v2 rejects failed prompt admission and cleans up", async () => {
  const native = opencodeFixture();
  native.rejectPrompt(new Error("prompt rejected"));
  const attempt = createOpencodeProvider({ loader: native.loader }).start(freshInput("fail"));
  await assert.rejects(attempt.result, /prompt rejected/u);
  await attempt.closed;
  assert.equal(native.closed(), 1);
});

test("OpenCode v2 fails terminal observation without native assistant evidence", async () => {
  const native = opencodeFixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(freshInput("idle")).result;
  native.admitted(native.prompts[0]!.body.id);
  native.delivered(native.prompts[0]!.body.id);
  native.push("session.execution.succeeded");
  assert.deepEqual(await drive.completion, {
    kind: "failed", diagnostic: "OpenCode completed without an assistant for the admitted input",
  });
  assert.equal(native.closed(), 1);
});

test("OpenCode v2 isolates other sessions and accepts the current execution error", async () => {
  const native = opencodeFixture();
  const drive = await createOpencodeProvider({ loader: native.loader }).start(freshInput("fail")).result;
  native.push("session.execution.failed", { sessionID: "ses_other", error: { message: "unrelated" } });
  native.push("session.execution.failed", { error: { message: "native failed" } });
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "native failed" });
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
    freshInput("work", {
      launchTells: [{ id: "tell-1", text: "also" }],
      cwd: tmpdir(),
      requests: { dir: "/work/requests" },
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
    { type: "unknown", kind: "future_event" },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
  const bash = fake.seen.bash;
  assert.ok(bash);
  assert.equal(bash.cwd, tmpdir());
  assert.deepEqual(fake.seen.options?.customTools, [bash.tool]);
  assert.ok(bash.options?.spawnHook);
  const context = {
    cwd: tmpdir(),
    command: "echo native request",
    env: Object.freeze({
      SAFE: "keep",
      AKUMA_REQUESTS: "ancestor-requests",
      PI_SESSION_ID: "native-session",
      PI_SESSION_FILE: "native-session-file",
      CODEX_THREAD_ID: "ancestor-codex",
    }),
  };
  assert.deepEqual(bash.options.spawnHook(context), {
    ...context,
    env: {
      SAFE: "keep",
      AKUMA_REQUESTS: "/work/requests",
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

test("Pi leaves default model selection to its services and preserves prompt overrides", async () => {
  for (const mode of ["append", "replace"] as const) {
    const fake = fakePiSdk();
    const provider = createPiProvider(undefined, async () => fake.sdk);
    const attempt = provider.start(freshInput("work", {
      options: { systemPrompt: "instructions", systemPromptMode: mode },
    }));
    await (await attempt.result).completion;
    await attempt.closed;
    assert.equal(fake.seen.options?.model, undefined);
    assert.deepEqual(fake.seen.modelLookups, []);
    assert.equal(fake.seen.servicesCreated, 1);
    if (mode === "append") {
      const append = fake.seen.loader?.appendSystemPromptOverride as (base: string[]) => string[];
      assert.deepEqual(append(["base"]), ["base", "instructions"]);
    } else {
      const replace = fake.seen.loader?.systemPromptOverride as () => string;
      assert.equal(replace(), "instructions");
    }
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

test("Pi binds host extensions once before the first prompt on fresh and resumed sessions", async () => {
  for (const resumed of [false, true]) {
    const fake = fakePiSdk({
      events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }],
    });
    const provider = createPiProvider(undefined, async () => fake.sdk);
    const input = freshInput("work", { launchTells: [{ id: "tell-1", text: "also check" }], cwd: tmpdir() });
    const attempt = resumed
      ? provider.resume!({
          ...input,
          session: { kind: "resume", coordinate: { sessionFile: "/sessions/pi.jsonl" } },
        })
      : provider.start(input);
    const drive = await attempt.result;
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
    await attempt.closed;
    assert.deepEqual(fake.seen.calls, ["agent-subscribe", "subscribe", "bind", "prompt"]);
    assert.equal(fake.seen.binds, 1);
    assert.equal(fake.seen.prompt, "work\n\nalso check");
    assert.equal(fake.seen.opened, resumed ? "/sessions/pi.jsonl" : undefined);
    assert.equal(fake.seen.disposed, 1);
  }
});

test("Pi retires the bound session without prompting when host extension binding fails", async () => {
  const fake = fakePiSdk({ bindFailure: new Error("Pi host extension binding failed") });
  const provider = createPiProvider(undefined, async () => fake.sdk);
  const attempt = provider.start(freshInput("work"));
  await assert.rejects(attempt.result, /Pi host extension binding failed/u);
  await attempt.closed;
  assert.equal(fake.seen.binds, 1);
  assert.equal(fake.seen.prompt, undefined);
  assert.equal(fake.seen.disposed, 1);
  assert.equal(fake.seen.agentListeners, 0);
  assert.equal(fake.seen.sessionListeners, 0);
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

test("Pi cancellation after binding settles still prevents the first prompt", async () => {
  const binding = promiseBarrier<void>();
  const controller = new AbortController();
  const fake = fakePiSdk({ bindGate: binding.promise });
  const provider = createPiProvider(undefined, async () => fake.sdk);
  const attempt = provider.start(freshInput("work", { signal: controller.signal }));
  const rejected = assert.rejects(attempt.result, /cancel before prompt/u);
  await waitForCondition("Pi host extension binding to begin", () => fake.seen.binds === 1);
  binding.resolve();
  queueMicrotask(() => controller.abort(new Error("cancel before prompt")));
  await rejected;
  await attempt.closed;
  assert.equal(fake.seen.prompt, undefined);
  assert.equal(fake.seen.disposed, 1);
  assert.equal(fake.seen.agentListeners, 0);
  assert.equal(fake.seen.sessionListeners, 0);
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

test("Pi disposal releases native live tell waiters", async () => {
  const fake = fakePiSdk({ promptNeverSettles: true });
  const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("work", { cwd: tmpdir() }),
  );
  const drive = await attempt.result;
  const pending = drive.tell!({ id: "pending", text: "steer" });
  await attempt.forceDispose();
  assert.deepEqual(await pending, { kind: "turn-ended" });
  await attempt.closed;
  assert.equal(fake.seen.agentListeners, 0);
});

test("Pi retires its native subscription when session setup fails", async () => {
  const fake = fakePiSdk({ subscriptionFailure: true });
  const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("work", { cwd: tmpdir() }),
  );
  await assert.rejects(attempt.result, /Pi subscription failed/u);
  await attempt.closed;
  assert.equal(fake.seen.agentListeners, 0);
  assert.equal(fake.seen.disposed, 1);
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

test("Pi retains summarization retry evidence without progress deltas or premature failure", async () => {
  const fake = fakePiSdk({
    events: [
      {
        type: "summarization_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: "temporarily unavailable",
      },
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
    { type: "note", text: "Retrying summarization 1/3: temporarily unavailable" },
    { type: "assistant", text: "done" },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
  await attempt.closed;
  assert.equal(fake.seen.disposed, 1);
});

test("Pi appends JSON Schema text when native structured output is unavailable", async () => {
  const fake = fakePiSdk({
    events: [
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }] },
      },
    ],
  });
  const schemaJson = '{"type":"object","properties":{"ok":{"type":"boolean"}}}';
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("work", { cwd: tmpdir(), schemaJson }),
  ).result;
  await drive.completion;
  assert.match(fake.seen.prompt ?? "", /Respond with JSON matching this JSON Schema/u);
  assert.match(fake.seen.prompt ?? "", /"ok"/u);
});

test("Pi attempt disposal closes events and completion before its sole closed proof", async () => {
  for (const dispose of ["abort", "forceDispose"] as const) {
    const fake = fakePiSdk({ promptNeverSettles: true });
    const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
      freshInput("wait", { cwd: "/work" }),
    );
    const drive = await attempt.result;
    const events: AgentEvent[] = [];
    const draining = (async () => {
      for await (const event of drive.events) events.push(event);
    })();

    await attempt[dispose]();
    assert.deepEqual(await drive.completion, {
      kind: "failed",
      diagnostic: dispose === "abort" ? "Pi session aborted" : "Pi session force-disposed",
    });
    await draining;
    await attempt.closed;
    assert.deepEqual(events, [
      { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    ]);
    assert.equal(fake.seen.disposed, 1);
  }
});

test("Pi keeps abort pending when native cleanup refuses to settle", async () => {
  const fake = fakePiSdk({ promptNeverSettles: true, abortNeverSettles: true });
  const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("wait", { cwd: "/work" }),
  );
  await attempt.result;
  let settled = 0;
  const observe = (pending: Promise<void>) => {
    void pending.then(() => {
      settled += 1;
    });
  };
  // Attempt owns abort memoization: a repeated request reuses one native abort.
  observe(attempt.abort());
  observe(attempt.abort());
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(settled, 0);
  assert.equal(fake.seen.aborted, 1);
  assert.equal(fake.seen.disposed, 0);
});

test("Pi omits blank tool-use text placeholders from narration", async () => {
  const fake = fakePiSdk({
    events: [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "inspect" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "SOUL.md" } },
            { type: "text", text: " " },
          ],
          stopReason: "toolUse",
        },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-2", name: "read", arguments: { path: "docs/akuma-provider.md" } },
            { type: "text", text: "  " },
          ],
          stopReason: "toolUse",
        },
      },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ],
  });
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("wait", { cwd: "/work" }),
  ).result;
  const events = await collectEvents(drive.events);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "thought", text: "inspect" },
    { type: "assistant", text: "done" },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
});

test("Pi keeps a terminal whitespace answer as public evidence", async () => {
  const fake = fakePiSdk({
    events: [
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: " " }], stopReason: "stop" },
      },
    ],
  });
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start(
    freshInput("wait", { cwd: "/work" }),
  ).result;
  const events = await collectEvents(drive.events);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "assistant", text: " " },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: " ", historyId: "entry-final" });
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
    body: "continue",
    launchTells: [],
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
        body: "bad",
        launchTells: [],
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

test("Pi installs the request-scoped Bash tool without changing the default toolset", async () => {
  const fake = fakePiSdk({
    events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }],
  });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const drive = await provider.start(
    freshInput("inspect", {
      cwd: "/work",
      requests: { dir: "/work/requests" },
    }),
  ).result;
  await collectEvents(drive.events);
  await drive.completion;
  assert.equal(fake.seen.options?.tools, undefined);
  const customTools = fake.seen.options?.customTools;
  assert.ok(Array.isArray(customTools));
  assert.equal(customTools.length, 1);
});

test("provider recipe preserves opaque config until adapter construction", async () => {
  const recipes = [
    { name: "claude", kind: "claude-agent-sdk", config: { unexpected: true } },
    { name: "opencode-sdk", kind: "opencode-sdk", config: { unexpected: true } },
    { name: "pi", kind: "pi", config: { tools: ["bash"] } },
    { name: "grok-build", kind: "grok-build", executable: "grok", config: { extension: true } },
    { name: "acp", kind: "acp", executable: "agent", config: { argvBefore: ["x"], argvAfter: [], unexpected: true } },
    {
      name: "acp",
      kind: "acp",
      executable: "agent",
      config: { argvBefore: ["--prompt"], argvAfter: ["--json"], modelArg: "--model" },
    },
  ] as const;
  for (const recipe of recipes) {
    // Compare to a detached value: mutation of the input cannot change this oracle.
    const expected = structuredClone(recipe);
    assert.deepEqual(decodeProviderExecution(recipe), expected, recipe.name);
  }
  assert.doesNotThrow(() => createClaudeProvider({ config: { unexpected: true } }));
  assert.doesNotThrow(() => createOpencodeProvider(recipes[1]));
  assert.doesNotThrow(() => createPiProvider(recipes[2]));
  assert.doesNotThrow(() => createGrokBuildProvider(recipes[3]));
  assert.throws(() => createAcpProvider(recipes[4]), /unknown field unexpected/u);
  const resolved = await resolveProviderExecution(recipes[0]);
  assert.equal(resolved.execution.config?.unexpected, true);
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
): Readonly<{
  executable: string;
  requests(): readonly Readonly<Record<string, unknown>>[];
  requestEnvironment(): Readonly<{ requests: string; literal: string; actor: string }>;
  environment(): NodeJS.ProcessEnv;
  /** Creating this file releases the fixture's model reroute. */
  rerouteRelease: string;
}> {
  const executable = join(root, "codex");
  const log = join(root, "requests.jsonl");
  const environment = join(root, "request-environment.txt");
  const rerouteRelease = join(root, "model-reroute-release");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      "const readline=require('node:readline');",
      `const log=${JSON.stringify(log)};`,
      `fs.writeFileSync(${JSON.stringify(environment)},JSON.stringify(process.env));`,
      `const mode=${JSON.stringify(mode)};`,
      `const rerouteRelease=${JSON.stringify(rerouteRelease)};`,
      "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
      "const reply=(message,result)=>send({id:message.id,result});",
      "const hang=mode==='terminal-hang'?setInterval(()=>{},1000):null;",
      "const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});",
      "lines.on('close',()=>{",
      "  if(mode==='terminal-drain') return setTimeout(()=>{",
      "    send({method:'item/completed',params:{item:{id:'command-terminal',type:'commandExecution',command:'npm test',status:'completed',exitCode:0}}});",
      "    process.exit(0);",
      "  },350);",
      "  if(mode==='terminal-hang') return;",
      "  process.exit(0);",
      "});",
      "lines.on('line',(line)=>{",
      "  const message=JSON.parse(line); fs.appendFileSync(log,JSON.stringify(message)+'\\n');",
      "  if(message.method==='initialize') return reply(message,{userAgent:'codex-cli/0.146.0'});",
      "  if(message.method==='initialized') return;",
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
    requestEnvironment: () => {
      const value = JSON.parse(readFileSync(environment, "utf8")) as NodeJS.ProcessEnv;
      return {
        requests: value.AKUMA_REQUESTS ?? "",
        literal: value.SETTINGS_LITERAL ?? "",
        actor: value.KEIYAKU_ACTOR_ID ?? "",
      };
    },
    environment: () => JSON.parse(readFileSync(environment, "utf8")) as NodeJS.ProcessEnv,
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

function claudeResult(index: number): readonly SDKMessage[] {
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
  const outputWaiters: Array<() => void> = [];
  let inputIterator: AsyncIterator<SDKUserMessage> | undefined;
  let pendingInput: Promise<IteratorResult<SDKUserMessage>> | undefined;
  let failure: unknown;
  let ended = false;
  const wakeOutput = () => outputWaiters.shift()?.();
  const pullInput = () => {
    if (inputIterator === undefined) throw new Error("Claude input is not attached");
    pendingInput = inputIterator.next();
    void pendingInput.then(
      (next) => {
        if (!next.done) return;
        ended = true;
        wakeOutput();
      },
      () => {},
    );
  };
  return {
    sdk: {
      query({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage> }) {
        inputIterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        void inputIterator.next().then(() => {
          pullInput();
        });
        const query = (async function* () {
          try {
            for (;;) {
              if (failure !== undefined) throw failure;
              const message = outputs.shift();
              if (message !== undefined) yield message;
              else if (ended) return;
              else await new Promise<void>((resolve) => outputWaiters.push(resolve));
            }
          } catch (error) {
            throw error;
          }
        })() as unknown as Query;
        query.close = () => {
          ended = true;
          wakeOutput();
        };
        return query;
      },
    },
    async receiveInput() {
      await waitForCondition("the provider input iterator to pull its first message", () => pendingInput !== undefined);
      if (pendingInput === undefined) throw new Error("provider input iterator never pulled its first message");
      return await pendingInput;
    },
    acknowledgeInput() {
      pullInput();
    },
    output(...messages: SDKMessage[]) {
      outputs.push(...messages);
      wakeOutput();
    },
    fail(error: unknown) {
      failure = error;
      wakeOutput();
    },
    end() {
      ended = true;
      wakeOutput();
    },
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

test("Claude maps narration, drops native streams, and contains runtime skew", async () => {
  const longNotice = `line one\n${"x".repeat(220)}`;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      return fakeQuery(
        [
          { type: "system", subtype: "init", session_id: "session-events" } as unknown as SDKMessage,
          {
            type: "assistant",
            uuid: "assistant-events",
            session_id: "session-events",
            parent_tool_use_id: null,
            message: {
              content: [
                { type: "text", text: "working" },
                { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "secret" } },
              ],
            },
          } as unknown as SDKMessage,
          {
            type: "user",
            session_id: "session-events",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "secret result body" }] },
          } as unknown as SDKMessage,
          {
            type: "stream_event",
            event: { delta: { text: "partial" } },
            session_id: "session-events",
          } as unknown as SDKMessage,
          {
            type: "rate_limit_event",
            rate_limit_info: { used: 1 },
            session_id: "session-events",
          } as unknown as SDKMessage,
          {
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 4,
            session_id: "session-events",
          } as unknown as SDKMessage,
          {
            type: "system",
            subtype: "informational",
            content: longNotice,
            session_id: "session-events",
          } as unknown as SDKMessage,
          { type: "future_type", secret: "must not escape", session_id: "session-events" } as unknown as SDKMessage,
          {
            type: "system",
            subtype: "future_subtype",
            secret: "must not escape",
            session_id: "session-events",
          } as unknown as SDKMessage,
          { type: "result", subtype: "success", result: "done", session_id: "session-events" } as unknown as SDKMessage,
        ],
        input.prompt as AsyncIterable<unknown>,
      );
    },
  }));
  const drive = await provider.start(freshInput("observe", { cwd: "/work" })).result;
  assert.equal(typeof drive.tell, "function");
  const events = await collectEvents(drive.events);

  assert.deepEqual(events.slice(0, 5), [
    { type: "session", coordinate: { sessionId: "session-events" } },
    { type: "assistant", text: "working" },
    { type: "tool", phase: "started", id: "tool-1", name: "Bash", call: { kind: "run", command: "secret" } },
    {
      type: "tool",
      phase: "completed",
      id: "tool-1",
      name: "Bash",
      call: { kind: "run", command: "secret" },
      result: { status: "ok", output: "secret result body" },
    },
    { type: "note", text: "Retrying request 2/4" },
  ]);
  assert.equal(events[5]?.type, "note");
  if (events[5]?.type === "note") {
    assert.deepEqual(events[5], noteEvent(longNotice));
  }
  assert.deepEqual(events.slice(6), [
    { type: "unknown", kind: "future_type" },
    { type: "unknown", kind: "future_subtype" },
  ]);
  assert.equal(JSON.stringify(events).includes("partial"), false, "a native stream delta never escapes");
  assert.equal(JSON.stringify(events).includes("must not escape"), false);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "assistant-events" });
});

test("Claude preserves execution config and uses its ordinary permission mode", async () => {
  let seen: Record<string, unknown> | undefined;
  const provider = createClaudeProvider(
    async () => ({
      query(input) {
        seen = input.options as Record<string, unknown> | undefined;
        return fakeQuery(
          [
            { type: "system", subtype: "init", session_id: "session-readonly-config" } as unknown as SDKMessage,
            {
              type: "result",
              subtype: "success",
              session_id: "session-readonly-config",
              result: "done",
            } as unknown as SDKMessage,
          ],
          input.prompt as AsyncIterable<unknown>,
        );
      },
    }),
    { config: { sandbox: { enabled: true } } },
  );
  const drive = await provider.start(freshInput("inspect", { cwd: "/work" })).result;
  await drive.completion;

  assert.deepEqual(seen?.sandbox, { enabled: true });
  assert.equal(seen?.permissionMode, "bypassPermissions");
  assert.equal(seen?.allowDangerouslySkipPermissions, true);
});

test("Claude refuses an unsupported network option", () => {
  const provider = createClaudeProvider(async () => {
    throw new Error("native Claude query must not start");
  });
  assert.deepEqual(provider.admitOptions({ network: "enabled" }), {
    kind: "refused",
    diagnostic: "Claude provider does not support the network option",
  });
});

test("Claude closes the terminal gate before a delayed Query iterator tail", async () => {
  const late = deferred<void>();
  const iteratorEnded = deferred<void>();
  const provider = createClaudeProvider(async () => ({
    query({ prompt }) {
      void (async () => {
        for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
          /* pull the streaming input */
        }
      })();
      return (async function* () {
        try {
          yield { type: "system", subtype: "init", session_id: "session-terminal-gate" } as unknown as SDKMessage;
          yield {
            type: "assistant",
            uuid: "assistant-before-terminal",
            session_id: "session-terminal-gate",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "before" }] },
          } as unknown as SDKMessage;
          yield {
            type: "result",
            subtype: "success",
            session_id: "session-terminal-gate",
            result: "done",
          } as unknown as SDKMessage;
          await late.promise;
          yield {
            type: "assistant",
            uuid: "assistant-after-terminal",
            session_id: "session-terminal-gate",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "late-tool", name: "Bash", input: { command: "late" } }] },
          } as unknown as SDKMessage;
          yield {
            type: "user",
            session_id: "session-terminal-gate",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_result", tool_use_id: "late-tool", content: "late result" }] },
          } as unknown as SDKMessage;
        } finally {
          iteratorEnded.resolve();
        }
      })() as unknown as Query;
    },
  }));
  const drive = await provider.start(freshInput("initial", { cwd: "/work" })).result;

  const completion = await Promise.race([
    drive.completion,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Claude completion waited for Query tail")), 500),
    ),
  ]);
  assert.deepEqual(completion, { kind: "answered", answer: "done", historyId: "assistant-before-terminal" });
  const events = await collectEvents(drive.events);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionId: "session-terminal-gate" } },
    { type: "assistant", text: "before" },
  ]);

  late.resolve();
  await iteratorEnded.promise;
});

test("Claude live tell waits for a post-yield source pull and shares one Query", async () => {
  const harness = controlledClaude();
  let queries = 0;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      queries += 1;
      return harness.sdk.query(input);
    },
  }));
  const drive = await provider.start(freshInput("initial", { cwd: "/work" })).result;
  assert.equal(queries, 1);
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
  const accepted = await submission;
  assert.equal(accepted.kind, "accepted");
  assert.equal(queries, 1);
  harness.output(...claudeResult(1));
  const receipt = await drive.receipts![Symbol.asyncIterator]().next();
  assert.deepEqual(receipt, { done: false, value: { evidence: "exact", tellId: "tell-live-1", kind: "consumed" } });
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done 1", historyId: "assistant-live-1" });
});

test("Codex app-server maps admitted options, native session, answer, and exact turn history", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-provider-");
  const fake = fakeCodex(root);
  const provider = createCodexAppServerProvider({
    name: "configured",
    kind: "codex-app-server",
    executable: fake.executable,
    config: { service_tier: "priority" },
    env: { SETTINGS_LITERAL: "from-settings", KEIYAKU_ACTOR_ID: "" },
  });
  const options = {
    model: "gpt-test",
    effort: "high",
    network: "enabled" as const,
    systemPrompt: "Work precisely.",
  };
  assert.deepEqual(provider.admitOptions(options), { kind: "admitted", options });

  const requestDirectory = join(root, "body-requests");
  mkdirSync(requestDirectory);
  const drive = await provider.start({
    ...DRIVE_DEFAULTS,
    body: "build",
    launchTells: [],
    cwd: root,
    options,
    requests: { dir: requestDirectory },
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
    config: { service_tier: "priority" },
    model: "gpt-test",
    developerInstructions: "Work precisely.",
  });
  const turn = requests[3]!.params as Record<string, unknown>;
  assert.deepEqual(turn, {
    threadId: "thread-fresh",
    input: [{ type: "text", text: "build" }],
    model: "gpt-test",
    effort: "high",
    approvalPolicy: "never",
  });
  assert.deepEqual(fake.requestEnvironment(), { requests: requestDirectory, literal: "from-settings", actor: "" });
});

test("native adapters report only the runtime model their own payloads name", { timeout: 30_000 }, async (context) => {
  const piState: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
  assert.deepEqual(
    translatePiEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-x",
          content: [],
          stopReason: "endTurn",
        },
      } as never,
      piState,
    ).filter((event) => event.type === "model"),
    [{ type: "model", model: "anthropic/claude-x" }],
  );
  assert.equal(piSessionModel({ provider: "anthropic", id: "claude-x" }), "anthropic/claude-x");
  assert.equal(piSessionModel({ id: "claude-x" }), undefined, "a half-named selection is not evidence");

  // Each message is observed through its own channel: the channel keeps one
  // unconsumed model observation, so adapter evidence is what one message emits.
  const claudeState: ClaudeObservationState = { tools: new Map() };
  const claudeModels = async (message: unknown): Promise<readonly AgentEvent[]> => {
    const channel = new AgentEventChannel();
    emitClaudeMessage(message as never, channel, claudeState);
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
  const codexState: CodexTurnState = { settled: false, tools: new Map() };
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
  assert.deepEqual(
    codexEvents.filter((event) => event.type === "model"),
    [{ type: "model", model: "gpt-5-codex-mini" }],
  );

  const root = temporaryDirectory(context, "keiyaku-codex-model-");
  const fake = fakeCodex(root, "model-evidence");
  const drive = await createCodexAppServerProvider({
    name: "configured",
    kind: "codex-app-server",
    executable: fake.executable,
  }).start({
    ...DRIVE_DEFAULTS,
    body: "build",
    launchTells: [],
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

test("Codex native fork receives an isolated child environment", async () => {
  const parentHarness = {
    CLAUDE_CODE_SESSION_ID: "parent-claude",
    CLAUDE_CODE_CHILD_SESSION: "parent-claude-child",
    CLAUDECODE: "parent-claude-code",
    CODEX_THREAD_ID: "parent-codex",
    OPENCODE_SESSION_ID: "parent-opencode",
    PI_SESSION_ID: "parent-pi",
    PI_SESSION_FILE: "/parent/pi.jsonl",
    PASEO_AGENT_ID: "parent-paseo",
    SQUARE_PARTICIPANT_NAME: "Parent",
    AKUMA_REQUESTS: "/parent/requests",
    AKUMA_REQUESTS_ENTRY: "/parent/request-entry.json",
  } as const;
  const parentKeys = Object.keys(parentHarness) as Array<keyof typeof parentHarness>;
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-fork-environment-"));
  const previous = Object.fromEntries(parentKeys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, parentHarness);
    const fake = fakeCodex(root);
    const attempt = createCodexAppServerProvider({
      name: "configured",
      kind: "codex-app-server",
      executable: fake.executable,
      env: { ...parentHarness, API_TOKEN: "provider-credential", SQUARE_LOCATION: "configured-location" },
    }).fork!({ session: { sessionId: "thread-parent" }, at: "turn-parent", cwd: root });
    assert.deepEqual(await attempt.result, { session: { sessionId: "thread-child" } });
    await attempt.closed;
    const environment = fake.environment();
    for (const key of parentKeys) assert.equal(environment[key], undefined);
    assert.equal(environment.API_TOKEN, "provider-credential");
    assert.equal(environment.SQUARE_LOCATION, "configured-location");
    assert.equal(process.env.CODEX_THREAD_ID, "parent-codex");
  } finally {
    for (const key of parentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex maps provider-neutral schema JSON to turn/start outputSchema", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-schema-");
  const fake = fakeCodex(root, "complete");
  const provider = createCodexAppServerProvider(fake.executable);
  const schemaJson = '{"type":"object","properties":{"ok":{"type":"boolean"}}}';
  const drive = await provider.start(freshInput("build", { cwd: root, schemaJson })).result;
  await drive.completion;
  const turn = fake.requests().find((request) => request.method === "turn/start")?.params as Record<string, unknown>;
  assert.deepEqual(turn.outputSchema, { type: "object", properties: { ok: { type: "boolean" } } });
});

test("Codex leaves sandbox policy to native configuration", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-policy-");
  const fake = fakeCodex(root, "complete");
  const provider = createCodexAppServerProvider(fake.executable);
  const drive = await provider.start(freshInput("write", { cwd: root })).result;
  await drive.completion;
  const turn = fake.requests().find((request) => request.method === "turn/start")?.params as Record<string, unknown>;
  assert.equal(Object.hasOwn(turn, "sandboxPolicy"), false);
});

test("Codex maps observations preserving aggregated output without leaking deltas or unknown payloads", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-observations-");
  const provider = createCodexAppServerProvider(fakeCodex(root, "observations").executable);
  const drive = await provider.start(freshInput("observe", { cwd: root })).result;
  const events = await collectEvents(drive.events);

  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionId: "thread-fresh" } },
    {
      type: "tool",
      phase: "started",
      id: "command-1",
      name: "commandExecution",
      call: { kind: "run", command: "npm test" },
    },
    {
      type: "tool",
      phase: "completed",
      id: "command-1",
      name: "commandExecution",
      call: { kind: "run", command: "npm test" },
      result: { status: "ok", exitCode: 0, output: "secret output" },
    },
    { type: "note", text: "Plan updated: Verify the adapter" },
    { type: "note", text: "Retrying after error: temporary outage" },
    { type: "assistant", text: "first answer" },
    { type: "unknown", kind: "future/native-event" },
    { type: "assistant", text: "second answer" },
  ]);
  assert.deepEqual(await drive.completion, {
    kind: "answered",
    answer: "second answer",
    historyId: "turn-1",
  });
  assert.equal(JSON.stringify(events).includes("must not escape"), false);
  assert.equal(JSON.stringify(events).includes("999"), false);
});

test("Codex retains a command's aggregated output and every file change's patch", async () => {
  const events = new AgentEventChannel();
  const state: CodexTurnState = { settled: false, tools: new Map() };
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

  assert.deepEqual(await drainChannel(events), [
    {
      type: "tool",
      phase: "completed",
      id: "command-1",
      name: "commandExecution",
      call: { kind: "run", command: "npm test" },
      result: { status: "error", output: "1 failing", exitCode: 1 },
    },
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

test("OpenCode keeps observed tool output and never claims an unverified filediff patch", () => {
  const state = createEventState("session-1");
  const events: AgentEvent[] = [];
  const emitter = { emit: (event: AgentEvent) => void events.push(event) };
  const data = { sessionID: "session-1", assistantMessageID: "msg_assistant", id: "oc-edit" };
  mapEvent({ type: "session.tool.input.started", data: { ...data, name: "edit" } }, emitter, state);
  mapEvent({ type: "session.tool.called", data: { ...data, input: { path: "src/edited.ts" }, executed: false } }, emitter, state);
  mapEvent({ type: "session.tool.success", data: {
    ...data, content: [{ type: "text", text: "edited src/edited.ts" }], executed: false,
    metadata: { filediff: { additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-before\n+after" } },
  } }, emitter, state);
  const call = {
    kind: "fileChange" as const,
    changes: [{ op: "update" as const, path: "src/edited.ts" }],
  };
  assert.deepEqual(events, [
    { type: "tool", phase: "started", id: "oc-edit", name: "edit", call },
    {
      type: "tool",
      phase: "completed",
      id: "oc-edit",
      name: "edit",
      call,
      result: { status: "ok", output: "edited src/edited.ts" },
    },
  ]);
  assert.equal(JSON.stringify(events).includes("patch"), false, "filediff.patch is not claimed without producer evidence");
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

test("ACP retains verified text output and leaves an unverified raw output absent", async () => {
  const start = mapAcpUpdate(acpToolUpdate("tool_call", "acp-1"), EMPTY_ACP_EVENT_STATE);
  const completed = (update: Partial<acp.ToolCallUpdate>) =>
    mapAcpUpdate(
      { sessionUpdate: "tool_call_update", toolCallId: "acp-1", status: "completed", ...update } as acp.SessionUpdate,
      start.state,
    ).events.at(-1);

  assert.deepEqual(
    completed({
      content: [
        { type: "content", content: { type: "text", text: "line one " } },
        { type: "diff", path: "src/a.ts", newText: "proposed" },
        { type: "content", content: { type: "text", text: "line two" } },
      ],
    }),
    {
      type: "tool",
      phase: "completed",
      id: "acp-1",
      name: "future_tool",
      call: { kind: "other", display: "future_tool" },
      result: { status: "ok", output: "line one line two" },
    },
    "the verified text blocks join in native order and a proposed diff is never an applied patch",
  );
  assert.deepEqual(completed({ rawOutput: "raw text" }), {
    type: "tool",
    phase: "completed",
    id: "acp-1",
    name: "future_tool",
    call: { kind: "other", display: "future_tool" },
    result: { status: "ok", output: "raw text" },
  });
  assert.deepEqual(completed({ rawOutput: { text: "must not be stringified" } }), {
    type: "tool",
    phase: "completed",
    id: "acp-1",
    name: "future_tool",
    call: { kind: "other", display: "future_tool" },
    result: { status: "ok" },
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

test("Codex terminal drain has a bounded fallback for a hung producer", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-terminal-hang-");
  const drive = await createCodexAppServerProvider(fakeCodex(root, "terminal-hang").executable).start(
    freshInput("observe", { cwd: root }),
  ).result;
  const started = performance.now();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
  assert.ok(performance.now() - started < 2_000);
  await collectEvents(drive.events);
});

test("Codex admission failures preserve the original diagnostic", async () => {
  const cases = [
    { mode: "rpc-reject", diagnostic: "turn start refused" },
    { mode: "missing-turn-id", diagnostic: "codex app-server did not return a turn id" },
    { mode: "exit-before-admit", diagnostic: "line RPC process exited with code 7" },
  ] as const;
  for (const fixture of cases) {
    const root = mkdtempSync(join(tmpdir(), `keiyaku-codex-admission-${fixture.mode}-`));
    try {
      await assert.rejects(
        attemptResult(
          createCodexAppServerProvider(fakeCodex(root, fixture.mode).executable).start(
            freshInput("build", { cwd: root }),
          ),
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.message === fixture.diagnostic &&
          !error.message.includes("codex app-server did not admit a turn"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Codex app-server abort interrupts and releases its owned child", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-codex-abort-");
  const fake = fakeCodex(root, "interrupt");
  const attempt = createCodexAppServerProvider(fake.executable).start(freshInput("wait", { cwd: root }));
  const drive = await attempt.result;
  await attempt.abort();
  await collectEvents(drive.events);
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "codex app-server interrupted" });
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


test("Heart activity write and read share historical shape acceptance and exact file coordinates", () => {
  const coordinate = { sessionFile: "/native/session.jsonl", sessionId: "native-id" };
  assert.deepEqual(decodeResumeCoordinate(coordinate), coordinate);
  assert.equal(decodeResumeCoordinate({ sessionId: "native-id", sessionFile: undefined }), null);
  assert.equal(decodeResumeCoordinate({ ...coordinate, foreign: undefined }), null);
  const event = { type: "session", coordinate, extra: "historically ignored" };
  const row = { sequence: 2, turn_sequence: 1, at: "at", event_json: JSON.stringify(event) };
  assert.deepEqual(JSON.parse(encodeActivityEvent(event)), { type: "session", coordinate });
  assert.deepEqual(decodeActivityRow(row).event, { type: "session", coordinate });
  const completed = { type: "tool", phase: "completed", id: "tool", name: "future", call: { kind: "other", display: "future", extra: true }, result: { status: "ok", extra: true }, extra: true };
  const decoded = decodeActivityRow({ ...row, event_json: encodeActivityEvent(completed) }).event;
  if (decoded.type !== "tool" || decoded.phase !== "completed") throw new Error("missing completion");
  const status: "ok" | "error" = decoded.result.status;
  assert.equal(status, "ok");
  assert.deepEqual(decoded.call, { kind: "other", display: "future" });
  assert.deepEqual(
    decoded.result,
    { status: "ok" },
    "a row stored before the observed fields keeps its exact former meaning",
  );
  const observed = {
    type: "tool",
    phase: "completed",
    id: "edit",
    name: "edit",
    call: {
      kind: "fileChange",
      changes: [
        { op: "update", path: "src/a.ts", diffstat: { added: 1, removed: 1 }, patch: "@@ -1 +1 @@\n-a\n+A" },
      ],
    },
    result: { status: "ok", output: "applied" },
  };
  assert.deepEqual(
    decodeActivityRow({ ...row, event_json: JSON.stringify(observed) }).event,
    observed,
    "a stored observed output and patch decode without migration",
  );
  const corrupt = { ...completed, result: undefined };
  assert.throws(() => encodeActivityEvent(corrupt));
  assert.throws(() => decodeActivityRow({ ...row, event_json: JSON.stringify(corrupt) }));
  assert.throws(() => decodeActivityRow({ ...row, event_json: JSON.stringify({ ...event, coordinate: { ...coordinate, foreign: true } }) }));
});
