import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { getEventListeners, once } from "node:events";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { DaemonClient, type ConnectionState, type DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type AgentSnapshotPayload,
  type AgentStreamEventPayload,
} from "@getpaseo/protocol/messages";
import type { DaemonTransport } from "@getpaseo/client/internal/daemon-client-transport-types";
import { createPaseoProvider, type PaseoDependencies } from "../src/akuma/providers/paseo/index.js";
import { resolveProviderExecution } from "../src/akuma/providers/index.js";
import { decodeProviderRecipe } from "../src/akuma/provider-recipe.js";
import { encodeAgentEvent, type DriveInput, type AgentEvent } from "../src/akuma/provider.js";
import { deferred, settlementProbe, temporaryDirectory, expectBodySettles } from "./support/process.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { World } from "../src/world.js";
import { allocatedHeart } from "./support/akuma-fixtures.js";
import { driveAkumaBody, type BodyLaunch } from "../src/akuma/body.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import {
  readHeart,
  readLatestTurnForBody,
  readTell,
  readOpenPendingTellDisposition,
} from "../src/akuma/heart/index.js";
import { executionForEnvironment, AkumaBodyRequestError } from "../src/akuma/requests.js";
import { eraseRequestCommand } from "../src/akuma/request-wire.js";
import { Tasks, tasksWithExecution } from "../src/task/index.js";
import { taskMutationRequestCommand, type TaskMutationRequestPort } from "../src/task/mutation.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";

type NativeClient = ReturnType<NonNullable<PaseoDependencies["createClient"]>>;
type TimelineHandler = Parameters<DaemonClient["subscribeAgentTimeline"]>[1];
type SendOptions = Parameters<DaemonClient["sendMessage"]>[2];

function nativeAgent(): AgentSnapshotPayload {
  return {
    id: "native-agent",
    provider: "claude",
    cwd: "/tmp/paseo-work",
    model: "original-model",
    thinkingOptionId: "low",
    effectiveThinkingOptionId: "low",
    runtimeInfo: {
      provider: "claude",
      sessionId: "provider-session",
      model: "original-model",
      thinkingOptionId: "low",
    },
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    activeTurn: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
}

class NativeFixture implements NativeClient {
  readonly calls: string[] = [];
  readonly fetched: string[] = [];
  readonly subscribed = deferred<void>();
  readonly sent = deferred<void>();
  subscriptionReady: Promise<void> = Promise.resolve();
  createInput: Parameters<DaemonClient["createAgent"]>[0] | undefined;
  sendInput: { agentId: string; text: string; options: SendOptions } | undefined;
  connectBarrier: Promise<void> | undefined;
  closeBarrier: Promise<void> | undefined;
  closeFailure: Error | undefined;
  cancelFailure: Error | undefined;
  missing = false;
  catalogError: string | undefined;
  confirmModel = true;
  confirmEffort = true;
  echo = true;
  turnId = "own-turn";
  closed = false;
  connection: ConnectionState = { status: "idle" };
  private connectionListener: ((state: ConnectionState) => void) | undefined;
  private timeline: TimelineHandler | undefined;

  constructor(readonly agent = nativeAgent()) {}

  async connect(): Promise<void> {
    this.calls.push("connect");
    await this.connectBarrier;
    this.connection = { status: "connected" };
    this.connectionListener?.(this.connection);
  }

  async createAgent(input: Parameters<DaemonClient["createAgent"]>[0]): Promise<AgentSnapshotPayload> {
    this.calls.push("create");
    this.createInput = input;
    return this.agent;
  }

  async fetchAgent(input: string | { agentId: string }): ReturnType<DaemonClient["fetchAgent"]> {
    this.calls.push("fetch");
    this.fetched.push(typeof input === "string" ? input : input.agentId);
    return this.missing ? null : { agent: this.agent, project: null };
  }

  async listProviderModels(_provider: string) {
    this.calls.push("catalog");
    return {
      provider: "claude",
      ...(this.catalogError === undefined ? {} : { error: this.catalogError }),
      models: ["original-model", "native-model"].map((id) => ({
        provider: "claude",
        id,
        label: id,
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      })),
      fetchedAt: "2026-10-13T00:00:00.000Z",
      requestId: "catalog-request",
    };
  }

  async setAgentModel(_id: string, model: string | null): Promise<void> {
    this.calls.push("model");
    if (this.confirmModel) {
      this.agent.model = model;
      this.agent.runtimeInfo!.model = model;
    }
  }

  async setAgentThinkingOption(_id: string, effort: string | null) {
    this.calls.push("effort");
    this.agent.thinkingOptionId = effort;
    if (this.confirmEffort) {
      this.agent.effectiveThinkingOptionId = effort;
      this.agent.runtimeInfo!.thinkingOptionId = effort;
    }
    return null;
  }

  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
    this.connectionListener = listener;
    listener(this.connection);
    return () => {
      this.connectionListener = undefined;
    };
  }

  subscribeAgentTimeline(_id: string, handler: TimelineHandler) {
    this.calls.push("subscribe");
    this.timeline = handler;
    this.subscribed.resolve();
    const release = async () => {
      this.timeline = undefined;
    };
    return Object.assign(
      () => {
        void release();
      },
      { ready: this.subscriptionReady, release, subscriptionId: "test-subscription" },
    );
  }

  async sendMessage(agentId: string, text: string, options?: SendOptions): Promise<void> {
    this.calls.push("send");
    this.sendInput = { agentId, text, options };
    this.sent.resolve();
    if (this.echo) this.admit();
  }

  admit(): void {
    this.event({
      type: "timeline",
      provider: "claude",
      turnId: this.turnId,
      item: { type: "user_message", text: "submitted", clientMessageId: this.sendInput!.options!.messageId! },
    });
  }

  event(event: AgentStreamEventPayload, sequence?: number): void {
    this.timeline?.({
      type: "agent_stream",
      payload: {
        agentId: this.agent.id,
        event,
        timestamp: "2026-10-13T00:00:01.000Z",
        ...(sequence === undefined ? {} : { seq: sequence, epoch: "test-epoch" }),
      },
    });
  }

  async cancelAgent(_id: string): Promise<void> {
    this.calls.push("cancel");
    if (this.cancelFailure !== undefined) throw this.cancelFailure;
    if (this.connection.status === "disconnected") throw new Error("native cancel connection unavailable");
    this.event({ type: "turn_canceled", provider: "claude", turnId: this.turnId, reason: "cancelled" });
  }

  invalidate(): void {
    this.timeline?.({ type: "agent.timeline.replacement", payload: { agentId: this.agent.id, epoch: "replacement" } });
  }

  disconnect(): void {
    this.connection = { status: "disconnected" };
    this.connectionListener?.(this.connection);
  }

  async close(): Promise<void> {
    this.calls.push("close");
    await this.closeBarrier;
    this.closed = true;
    this.timeline = undefined;
    this.connectionListener?.({ status: "disposed" });
    if (this.closeFailure !== undefined) throw this.closeFailure;
  }
}

function drive(signal = new AbortController().signal): DriveInput {
  return {
    body: "task",
    launchTells: [{ id: "tell", text: "launch input" }],
    cwd: "/tmp/paseo-work",
    options: {},
    signal,
    requests: { dir: "/tmp/disposable/1", entry: "/tmp/parent/request-entry.json" },
  };
}

function provider(fake: NativeFixture, configurations: DaemonClientConfig[] = []) {
  return createPaseoProvider(
    {
      name: "paseo",
      kind: "paseo",
      env: {
        PASEO_AGENT_ID: "parent",
        AKUMA_REQUESTS: "/parent/requests",
        AKUMA_REQUESTS_ENTRY: "/parent/entry",
        PASEO_PASSWORD: "local-password",
        API_TOKEN: "native-token",
      },
    },
    {
      createClient: (config) => {
        configurations.push(config);
        return fake;
      },
    },
  );
}

async function narration(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const found: AgentEvent[] = [];
  for await (const event of events) found.push(encodeAgentEvent(event));
  return found;
}

function assistant(
  fake: NativeFixture,
  text: string,
  messageId = "answer-a",
  turnId = fake.turnId,
  sequence?: number,
): void {
  fake.event(
    { type: "timeline", provider: "claude", turnId, item: { type: "assistant_message", text, messageId } },
    sequence,
  );
}

function complete(fake: NativeFixture, turnId = fake.turnId): void {
  fake.event({ type: "turn_completed", provider: "claude", turnId });
}

test("Paseo reports the runtime model its own confirmation names and stays unknown without one", async () => {
  const named = new NativeFixture();
  const attempt = provider(named).start({ ...drive(), options: {}, session: { kind: "fresh" } });
  const session = await attempt.result;
  assistant(named, "done");
  complete(named);
  assert.deepEqual(await session.completion, { kind: "answered", answer: "done", historyId: "own-turn" });
  await attempt.closed;
  assert.deepEqual(
    (await narration(session.events)).filter((event) => event.type === "model"),
    [{ type: "model", model: "original-model" }],
  );

  const unnamed = new NativeFixture();
  unnamed.agent.model = null;
  unnamed.agent.runtimeInfo!.model = null;
  const second = provider(unnamed).start({ ...drive(), options: {}, session: { kind: "fresh" } });
  const plain = await second.result;
  assistant(unnamed, "done");
  complete(unnamed);
  await plain.completion;
  await second.closed;
  assert.deepEqual(
    (await narration(plain.events)).filter((event) => event.type === "model"),
    [],
    "an unnamed runtime model is unknown, never inferred",
  );

  // A snapshot's top-level model can be a configured fallback rather than what
  // the runtime loaded, so it is not evidence. An observation would have to be
  // unnamed to say "not confirmed" here, and that would clear the current
  // selection; no evidence must leave it alone.
  const configured = new NativeFixture();
  configured.agent.runtimeInfo!.model = null;
  assert.equal(configured.agent.model, "original-model");
  const third = provider(configured).start({ ...drive(), options: {}, session: { kind: "fresh" } });
  const fallback = await third.result;
  assistant(configured, "done");
  complete(configured);
  await fallback.completion;
  await third.closed;
  assert.deepEqual(
    (await narration(fallback.events)).filter((event) => event.type === "model"),
    [],
    "a configured fallback is not native evidence",
  );
});

test("Paseo start and resume retain native id, pin stable entry, and complete only admitted turn", async () => {
  const fake = new NativeFixture();
  fake.echo = false;
  const readiness = deferred<void>();
  fake.subscriptionReady = readiness.promise;
  const configs: DaemonClientConfig[] = [];
  const adapter = provider(fake, configs);
  const attempt = adapter.start({
    ...drive(),
    options: { model: "native-model", effort: "high", systemPrompt: "Work precisely.", systemPromptMode: "append" },
    session: { kind: "fresh" },
  });
  let admitted = false;
  void attempt.result.then(() => {
    admitted = true;
  });
  await fake.subscribed.promise;
  assert.equal(fake.sendInput, undefined, "timeline must be ready before native send");
  readiness.resolve();
  await fake.sent.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admitted, false, "a send acknowledgement is not native admission");
  fake.admit();
  const session = await attempt.result;
  assert.equal(session.admission.fence, "own-turn");
  assert.equal(session.tell, undefined);
  assert.equal(adapter.fork, undefined);
  assert.deepEqual(fake.calls.slice(0, 8), [
    "connect",
    "create",
    "catalog",
    "model",
    "effort",
    "fetch",
    "subscribe",
    "send",
  ]);
  assert.equal(fake.sendInput!.text, "task\n\nlaunch input");
  assert.equal(fake.sendInput!.options!.activeTurnBehavior, "steer");
  assert.equal(fake.createInput!.initialPrompt, undefined);
  assert.equal(fake.createInput!.autoArchive, false);
  assert.equal(fake.createInput!.systemPrompt, "Work precisely.");
  assert.equal(fake.createInput!.env!.AKUMA_REQUESTS_ENTRY, drive().requests.entry);
  assert.equal(fake.createInput!.env!.AKUMA_REQUESTS, undefined);
  assert.equal(fake.createInput!.env!.PASEO_AGENT_ID, undefined);
  assert.equal(fake.createInput!.env!.API_TOKEN, "native-token");
  assert.equal(configs[0]!.password, "local-password");
  assert.deepEqual(configs[0]!.reconnect, { enabled: false });
  let finished = false;
  void session.completion.then(() => {
    finished = true;
  });
  assistant(fake, "unrelated human response", "human-answer", "human-turn");
  complete(fake, "human-turn");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  assistant(fake, "hello ");
  assistant(fake, "second", "answer-b");
  assistant(fake, "world", "answer-a");
  const closing = deferred<void>();
  fake.closeBarrier = closing.promise;
  complete(fake);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(finished, false, "completion waits for owned client closure");
  complete(fake, "later-human-turn");
  const aborting = attempt.abort();
  assert.equal(fake.calls.includes("cancel"), false, "normal completion must not cancel later human work");
  closing.resolve();
  await aborting;
  assert.deepEqual(await session.completion, {
    kind: "answered",
    answer: "hello secondworld",
    historyId: "own-turn",
  });
  await attempt.closed;
  assert.deepEqual(await narration(session.events), [
    { type: "session", coordinate: { sessionId: "native-agent" } },
    { type: "model", model: "native-model" },
    { type: "assistant", text: "hello world" },
    { type: "assistant", text: "second" },
  ]);
  const resumed = new NativeFixture(fake.agent);
  const resumeAttempt = provider(resumed).resume!({
    ...drive(),
    options: { model: "native-model", effort: "high" },
    schemaJson: '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
    requests: { dir: "/tmp/disposable/2", entry: drive().requests.entry! },
    session: { kind: "resume", coordinate: { sessionId: "native-agent" } },
  });
  const next = await resumeAttempt.result;
  assert.equal(resumed.createInput, undefined);
  assert.equal(resumed.sendInput!.agentId, "native-agent");
  assert.deepEqual(resumed.fetched, ["native-agent", "native-agent"]);
  assert.deepEqual(resumed.calls.slice(0, 8), [
    "connect",
    "fetch",
    "catalog",
    "model",
    "effort",
    "fetch",
    "subscribe",
    "send",
  ]);
  assert.match(resumed.sendInput!.text, /Respond with JSON matching this JSON Schema and no other text:/u);
  assert.ok(resumed.sendInput!.text.endsWith('{"type":"object","properties":{"ok":{"type":"boolean"}}}'));
  assistant(resumed, "I will inspect the result first.", "commentary");
  resumed.event({
    type: "timeline",
    provider: "claude",
    turnId: "own-turn",
    item: {
      type: "tool_call",
      callId: "inspect",
      name: "bash",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "pwd" },
    },
  });
  assistant(resumed, '{"ok":true}', "final-json");
  complete(resumed);
  assert.deepEqual(await next.completion, { kind: "answered", answer: '{"ok":true}', historyId: "own-turn" });
  await resumeAttempt.closed;
  assert.deepEqual(
    (await narration(next.events)).filter((event) => event.type === "assistant"),
    [
      { type: "assistant", text: "I will inspect the result first." },
      { type: "assistant", text: '{"ok":true}' },
    ],
  );
});

test("Paseo refuses observed human execution and unconfirmed native selectors before prompt", async () => {
  const busy = new NativeFixture();
  busy.agent.status = "running";
  busy.agent.activeTurn = { turnId: "human-turn", startedAt: null };
  const blocked = provider(busy).resume!({
    ...drive(),
    options: { model: "new-model" },
    session: { kind: "resume", coordinate: { sessionId: busy.agent.id } },
  });
  await assert.rejects(blocked.result, /busy.*another native execution/u);
  await blocked.closed;
  assert.deepEqual(busy.calls, ["connect", "fetch", "close"]);
  const missing = new NativeFixture();
  const unavailable = provider(missing).start({
    ...drive(),
    options: { model: "not-offered" },
    session: { kind: "fresh" },
  });
  await assert.rejects(unavailable.result, /model is not available/u);
  await unavailable.closed;
  assert.equal(missing.calls.includes("model"), false);
  assert.equal(missing.sendInput, undefined);
  const unconfirmed = new NativeFixture();
  unconfirmed.confirmEffort = false;
  const rejected = provider(unconfirmed).start({ ...drive(), options: { effort: "high" }, session: { kind: "fresh" } });
  await assert.rejects(rejected.result, /effort selection was not confirmed/u);
  await rejected.closed;
  assert.equal(unconfirmed.sendInput, undefined);
  assert.equal(unconfirmed.calls.includes("cancel"), false);
});

test("Paseo cancellation retires setup and cancels current native execution without destroying runtime", async () => {
  const setup = new NativeFixture();
  const connecting = deferred<void>();
  setup.connectBarrier = connecting.promise;
  const setupController = new AbortController();
  const pending = provider(setup).start({ ...drive(setupController.signal), session: { kind: "fresh" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  setupController.abort(new Error("stop during connect"));
  await assert.rejects(pending.result, /stop during connect/u);
  await pending.closed;
  connecting.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(setup.calls, ["connect", "close"]);
  assert.equal(setup.sendInput, undefined, "late setup cannot send after client retirement");
  const active = new NativeFixture();
  const attempt = provider(active).start({ ...drive(), session: { kind: "fresh" } });
  const session = await attempt.result;
  await attempt.abort();
  await attempt.closed;
  assert.equal(active.calls.filter((call) => call === "cancel").length, 1);
  assert.equal(active.closed, true);
  assert.equal((await session.completion).kind, "failed");
  assert.equal(active.agent.archivedAt, undefined);
  const retiring = new NativeFixture();
  retiring.closeFailure = new Error("native client retirement failed");
  const broken = provider(retiring).start({ ...drive(), session: { kind: "fresh" } });
  const brokenSession = await broken.result;
  complete(retiring);
  await assert.rejects(brokenSession.completion, /native client retirement failed/u);
  await assert.rejects(broken.closed, /native client retirement failed/u);
});

test("Paseo loses incomplete observation honestly and normalizes observed tool output", async () => {
  const fake = new NativeFixture();
  const attempt = provider(fake).start({ ...drive(), session: { kind: "fresh" } });
  const session = await attempt.result;
  fake.event(
    {
      type: "timeline",
      provider: "claude",
      turnId: "own-turn",
      item: {
        type: "tool_call",
        callId: "shell",
        name: "bash",
        status: "running",
        error: null,
        detail: { type: "shell", command: "pwd", output: "secret-output" },
      },
    },
    10,
  );
  fake.event(
    {
      type: "timeline",
      provider: "claude",
      turnId: "own-turn",
      item: {
        type: "tool_call",
        callId: "shell",
        name: "bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "changed-native-summary", output: "secret-output" },
      },
    },
    11,
  );
  assistant(fake, "incomplete", "answer-a", "own-turn", 13);
  await assert.rejects(session.completion, /timeline delivery gap/u);
  await attempt.closed;
  const events = await narration(session.events);
  assert.deepEqual(
    events.filter((event) => event.type === "tool"),
    [
      { type: "tool", phase: "started", id: "shell", name: "bash", call: { kind: "run", command: "pwd" } },
      {
        type: "tool",
        phase: "completed",
        id: "shell",
        name: "bash",
        call: { kind: "run", command: "pwd" },
        result: { status: "ok", output: "secret-output" },
      },
    ],
  );
  assert.equal(
    events.some((event) => event.type === "assistant"),
    false,
  );
  const lost = new NativeFixture();
  const lostAttempt = provider(lost).start({ ...drive(), session: { kind: "fresh" } });
  const lostSession = await lostAttempt.result;
  lost.disconnect();
  await assert.rejects(lostSession.completion, /Paseo connection lost/u);
  await assert.rejects(lostAttempt.closed, /native cancel connection unavailable/u);
  assert.equal(lost.closed, true);
});

test("Paseo carries a completed edit's unified patch and never treats write content as a patch", async () => {
  const fake = new NativeFixture();
  const attempt = provider(fake).start({ ...drive(), session: { kind: "fresh" } });
  const session = await attempt.result;
  const patch = ["@@ -1 +1 @@", "-before", "+after"].join("\n");
  fake.event(
    {
      type: "timeline",
      provider: "claude",
      turnId: "own-turn",
      item: {
        type: "tool_call",
        callId: "edit-1",
        name: "edit",
        status: "running",
        error: null,
        detail: { type: "edit", filePath: "src/edited.ts" },
      },
    },
    10,
  );
  fake.event(
    {
      type: "timeline",
      provider: "claude",
      turnId: "own-turn",
      item: {
        type: "tool_call",
        callId: "edit-1",
        name: "edit",
        status: "completed",
        error: null,
        detail: { type: "edit", filePath: "src/edited.ts", unifiedDiff: patch },
      },
    },
    11,
  );
  fake.event(
    {
      type: "timeline",
      provider: "claude",
      turnId: "own-turn",
      item: {
        type: "tool_call",
        callId: "write-1",
        name: "write",
        status: "completed",
        error: null,
        detail: { type: "write", filePath: "src/written.ts", content: "written file body" },
      },
    },
    12,
  );
  assistant(fake, "done", "answer-b", fake.turnId, 13);
  complete(fake);
  assert.deepEqual(await session.completion, { kind: "answered", answer: "done", historyId: "own-turn" });
  await attempt.closed;

  const events = await narration(session.events);
  const edit = { kind: "fileChange" as const, changes: [{ op: "unspecified" as const, path: "src/edited.ts" }] };
  assert.deepEqual(
    events.filter((event) => event.type === "tool"),
    [
      { type: "tool", phase: "started", id: "edit-1", name: "edit", call: edit },
      {
        type: "tool",
        phase: "completed",
        id: "edit-1",
        name: "edit",
        call: { kind: "fileChange", changes: [{ op: "unspecified", path: "src/edited.ts", patch }] },
        result: { status: "ok" },
      },
      {
        type: "tool",
        phase: "completed",
        id: "write-1",
        name: "write",
        call: { kind: "other", display: "write" },
        result: { status: "ok" },
      },
    ],
  );
  assert.equal(JSON.stringify(events).includes("written file body"), false, "a write body is not a patch");
});

test("Paseo registration stays local and refuses unsupported execution shapes", async () => {
  const recipe = decodeProviderRecipe({ name: "paseo", kind: "paseo" });
  const resolved = await resolveProviderExecution(recipe);
  assert.equal(resolved.execution.kind, "paseo");
  assert.equal(resolved.adapter.admitOptions({ network: "disabled" }).kind, "refused");
  assert.equal(
    resolved.adapter.admitOptions({ systemPrompt: "override", systemPromptMode: "replace" }).kind,
    "refused",
  );
  assert.throws(() => createPaseoProvider({ ...recipe, config: { url: "wss://remote.example/ws" } }), /loopback/u);
  assert.throws(() => createPaseoProvider({ ...recipe, config: { extra: true } }), /configuration/u);
  assert.throws(() => createPaseoProvider({ ...recipe, executable: "paseo" }), /not an executable/u);
  assert.throws(() => createPaseoProvider({ ...recipe, config: { provider: "claude/opus" } }), /bare native provider/u);
  assert.throws(
    () => createPaseoProvider({ ...recipe, config: { url: "ws://localhost/ws?route=other" } }),
    /loopback/u,
  );
});

test("Paseo refuses missing resume and unavailable or unconfirmed selectors without send", async () => {
  const missing = new NativeFixture();
  missing.missing = true;
  const resume = provider(missing).resume!({
    ...drive(),
    session: { kind: "resume", coordinate: { sessionId: "missing" } },
  });
  await assert.rejects(resume.result, /unavailable/u);
  await resume.closed;
  assert.deepEqual(missing.calls, ["connect", "fetch", "close"]);
  const catalog = new NativeFixture();
  catalog.catalogError = "provider offline";
  const unavailable = provider(catalog).start({
    ...drive(),
    options: { model: "native-model" },
    session: { kind: "fresh" },
  });
  await assert.rejects(unavailable.result, /catalog unavailable.*provider offline/u);
  await unavailable.closed;
  assert.equal(catalog.sendInput, undefined);
  const model = new NativeFixture();
  model.confirmModel = false;
  const unconfirmed = provider(model).start({
    ...drive(),
    options: { model: "native-model" },
    session: { kind: "fresh" },
  });
  await assert.rejects(unconfirmed.result, /model selection was not confirmed/u);
  await unconfirmed.closed;
  assert.equal(model.sendInput, undefined);
});

test("Paseo matching failure and cancellation are outcomes, unrelated terminals and duplicate deliveries are not", async () => {
  const fake = new NativeFixture();
  fake.echo = false;
  const attempt = fresh(provider(fake));
  const admission = settlementProbe(attempt.result, () => "admitted");
  await fake.sent.promise;
  fake.event({
    type: "timeline",
    provider: "claude",
    turnId: "human",
    item: { type: "user_message", text: "human", clientMessageId: "other-id" },
  });
  fake.event({ type: "turn_failed", provider: "claude", turnId: "human", error: "other failure" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(admission(), null, "ack/idle agent and unrelated user input are not admission");
  fake.admit();
  const session = await attempt.result;
  assistant(fake, "kept", "a", "own-turn", 1);
  assistant(fake, "duplicated", "a", "own-turn", 1);
  fake.event({ type: "turn_failed", provider: "claude", turnId: "own-turn", error: "native own failure" }, 2);
  complete(fake);
  assert.deepEqual(await session.completion, { kind: "failed", diagnostic: "native own failure" });
  await attempt.closed;
  assert.equal(fake.calls.includes("cancel"), false);
  assert.deepEqual(
    (await narration(session.events)).filter((event) => event.type === "assistant"),
    [{ type: "assistant", text: "kept" }],
  );
  const canceled = new NativeFixture();
  const canceledAttempt = fresh(provider(canceled));
  const canceledSession = await canceledAttempt.result;
  canceled.event({ type: "turn_canceled", provider: "claude", turnId: "own-turn", reason: "native cancellation" });
  assert.deepEqual(await canceledSession.completion, { kind: "failed", diagnostic: "native cancellation" });
  await canceledAttempt.closed;
  assert.equal(canceled.calls.includes("cancel"), false);
});

test("Paseo observation invalidation fails honestly and control failure survives client cleanup failure", async () => {
  const invalidated = new NativeFixture();
  const attempt = fresh(provider(invalidated));
  const session = await attempt.result;
  invalidated.event(
    {
      type: "timeline",
      provider: "claude",
      turnId: "own-turn",
      item: { type: "assistant_message", text: "not complete" },
    },
    1,
  );
  // A new epoch is not an alternate history source to consult or resend into.
  invalidated.invalidate();
  await assert.rejects(session.completion, /timeline was invalidated/u);
  await attempt.closed;
  const broken = new NativeFixture();
  const cancelError = new Error("native current-execution cancellation failed");
  const closeError = new Error("native client close failed");
  broken.cancelFailure = cancelError;
  broken.closeFailure = closeError;
  const brokenAttempt = fresh(provider(broken));
  const brokenSession = await brokenAttempt.result;
  const outcome = assert.rejects(brokenSession.completion, /client retired/u);
  await assert.rejects(
    brokenAttempt.abort(),
    (error: unknown) =>
      error instanceof AggregateError && error.errors.includes(cancelError) && error.errors.includes(closeError),
  );
  await assert.rejects(
    brokenAttempt.closed,
    (error: unknown) =>
      error instanceof AggregateError && error.errors.includes(cancelError) && error.errors.includes(closeError),
  );
  await outcome;
  assert.equal(broken.closed, true);
});

test(
  "retained native creation env serves real request succession through ordinary wake and pending-Tell handoff",
  { timeout: 15_000 },
  async (context) => {
    const root = await World.at(temporaryDirectory(context, "keiyaku-paseo-retained-"));
    await mkdir(join(root, ".keiyaku"), { recursive: true });
    await writeFile(
      join(root, ".keiyaku", "settings.json"),
      JSON.stringify({ plugins: { square: { enabled: false } } }),
    );
    const allocated = await allocatedHeart(root, "paseo", "1234abcd");
    const native = nativeAgent();
    native.cwd = root;
    const launched = [deferred<NativeFixture>(), deferred<NativeFixture>(), deferred<NativeFixture>()];
    const clients: NativeFixture[] = [];
    const bodies: Array<Promise<unknown>> = [];
    let cleaning = false;
    const adapter = createPaseoProvider(
      { name: "paseo", kind: "paseo", env: { KEIYAKU_EXTERNAL_CALLER: "never inherited" } },
      {
        createClient: () => {
          const fake = new NativeFixture(native);
          const index = clients.push(fake) - 1;
          fake.turnId = `native-turn-${index + 1}`;
          void fake.sent.promise.then(() => {
            launched[index]?.resolve(fake);
            if (cleaning) complete(fake);
          });
          return fake;
        },
      },
    );
    const serviced: number[] = [];
    const unused = async (): Promise<never> => {
      throw new Error("unexpected Task action");
    };
    const port: TaskMutationRequestPort = {
      add: async ({ world, options }) => {
        serviced.push((await readHeart(allocated.paths)).latestBody!.sequence);
        return await Tasks.of(world).add(options);
      },
      addDocument: unused,
      compose: unused,
      update: unused,
      lifecycle: unused,
      batch: unused,
    };
    const externalCommands = { "task.add": eraseRequestCommand(taskMutationRequestCommand("task.add", port)) };
    const owned = (body: Promise<unknown>): OwnedProcess => ({
      pid: 0,
      exited: body.then(
        () => ({ code: 0, signal: null, log: { path: allocated.paths.log, from: 0, to: 0 } }),
        () => ({ code: 1, signal: null, log: { path: allocated.paths.log, from: 0, to: 0 } }),
      ),
      terminate: async () => undefined,
      release: () => undefined,
    });
    const startBody = (launch: BodyLaunch): Promise<unknown> => {
      const body = driveAkumaBody(launch, adapter, {
        world: root,
        externalCommands,
        spawnBody: async (next) => owned(startBody(next)),
      });
      bodies.push(body);
      return body;
    };
    const wake = { spawn: async () => owned(startBody({ paths: allocated.paths })) };
    const owner = new AkumaOwner(allocated.id, root);
    try {
      const firstBody = startBody({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: "paseo",
          provider: { name: "paseo", kind: "paseo" },
          options: {},
          cwd: root,
          origin: { kind: "direct" },
          allowed: ["task.add"],
        },
        initialBody: "first native turn",
      });
      const first = await launched[0]!.promise;
      const retained = first.createInput!.env!;
      assert.equal(retained.AKUMA_REQUESTS, undefined);
      assert.equal(retained.KEIYAKU_EXTERNAL_CALLER, undefined);
      const old = tasksWithExecution(root, await executionForEnvironment(retained));
      assert.equal((await old.add({ title: "First Body service" })).kind, "accepted");
      assistant(first, "first answer");
      complete(first);
      await expectBodySettles(firstBody, "first Paseo Body did not complete");
      assert.equal((await readLatestTurnForBody(allocated.paths, 1))?.end?.outcome.kind, "answered");
      assert.equal(first.calls.includes("cancel"), false);
      assert.equal(first.closed, true);
      await assert.rejects(executionForEnvironment(retained), /no current request channel/u);

      // Ordinary Tell wake resumes the exact retained native id with its original
      // creation environment; no replacement agent is created or environment rewritten.
      const receipt = owner.tell("successor work", "ordinary-wake", undefined, wake);
      const second = await launched[1]!.promise;
      await receipt;
      assert.equal(second.createInput, undefined);
      assert.equal(second.sendInput!.agentId, first.agent.id);
      const fresh = tasksWithExecution(root, await executionForEnvironment(retained));
      assert.equal((await fresh.add({ title: "Successor Body service" })).kind, "accepted");
      await assert.rejects(
        old.add({ title: "Must not execute locally or replay" }),
        (error: unknown) => error instanceof AkumaBodyRequestError && error.outcome === "unknown",
      );
      assert.deepEqual(serviced, [1, 2]);

      // A live session without native tell takes the existing Heart-owned handoff,
      // not a provider emulation. Native cancel is explicit control for that work.
      const pending = owner.tell("pending continuation", "pending-handoff", undefined, wake);
      const third = await launched[2]!.promise;
      await pending;
      assert.equal(second.calls.filter((call) => call === "cancel").length, 1);
      assert.equal(third.sendInput!.agentId, first.agent.id);
      assert.equal(third.createInput, undefined);
      assert.match(third.sendInput!.text, /pending continuation/u);
      const thirdContext = tasksWithExecution(root, await executionForEnvironment(retained));
      assert.equal((await thirdContext.add({ title: "Handoff Body service" })).kind, "accepted");
      assistant(third, "successor answer");
      complete(third);
      await expectBodySettles(Promise.all(bodies), "retained Paseo successor did not settle");
      assert.equal((await readHeart(allocated.paths)).latestBody?.sequence, 3);
      assert.equal((await readLatestTurnForBody(allocated.paths, 3))?.end?.outcome.kind, "answered");
      assert.equal((await readTell(allocated.paths, "pending-handoff"))?.state, "told");
      assert.equal(await readOpenPendingTellDisposition(allocated.paths), null);
      assert.equal(clients.filter((client) => client.createInput !== undefined).length, 1);
      assert.deepEqual(serviced, [1, 2, 3]);
      const board = await Tasks.of(root).list({ selection: "all", scope: "world" });
      assert.equal(board.kind, "accepted");
      if (board.kind === "accepted")
        assert.deepEqual(board.value.rows.map((row) => row.title).sort(), [
          "First Body service",
          "Handoff Body service",
          "Successor Body service",
        ]);
      assert.ok(clients.every((client) => client.closed));
    } finally {
      cleaning = true;
      for (const client of clients) complete(client);
      await Promise.allSettled(bodies);
    }
  },
);

// A typed in-process protocol endpoint exercises the ACTUAL pinned client RPC,
// selector, canonical admission and timeline implementation, without any model.
class PinnedProtocolFixture {
  readonly requests: SessionInboundMessage[] = [];
  readonly sent = deferred<void>();
  readonly agent = nativeAgent();
  readonly messages = new Set<Parameters<DaemonTransport["onMessage"]>[0]>();
  readonly opens = new Set<() => void>();
  readonly closes = new Set<Parameters<DaemonTransport["onClose"]>[0]>();
  readonly errors = new Set<Parameters<DaemonTransport["onError"]>[0]>();
  cancelError: string | null = null;
  closed = false;
  private sequence = 0;
  private submitted: Extract<SessionInboundMessage, { type: "send_agent_message_request" }> | undefined;

  createClient(config: DaemonClientConfig): DaemonClient {
    const bind = <T>(set: Set<T>, handler: T) => {
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    };
    const transport: DaemonTransport = {
      send: (frame) => {
        assert.equal(typeof frame, "string");
        const envelope = JSON.parse(frame as string) as { type: string; message?: unknown };
        if (envelope.type === "hello") {
          this.reply({
            type: "status",
            payload: {
              status: "server_info",
              serverId: "isolated-fixture",
              features: { ownedSubscriptions: true, creationLifecycle: true },
            },
          });
        } else {
          assert.equal(envelope.type, "session");
          const message = SessionInboundMessageSchema.parse(envelope.message);
          this.requests.push(message);
          this.request(message);
        }
      },
      close: () => {
        this.closed = true;
      },
      onMessage: (handler) => bind(this.messages, handler),
      onOpen: (handler) => bind(this.opens, handler),
      onClose: (handler) => bind(this.closes, handler),
      onError: (handler) => bind(this.errors, handler),
    };
    return new DaemonClient({
      ...config,
      transportFactory: () => {
        queueMicrotask(() => {
          for (const handler of this.opens) handler();
        });
        return transport;
      },
    });
  }

  private reply(message: SessionOutboundMessage): void {
    const admitted = SessionOutboundMessageSchema.parse(message);
    for (const handler of this.messages) handler(JSON.stringify({ type: "session", message: admitted }), false);
  }

  private request(message: SessionInboundMessage): void {
    switch (message.type) {
      case "agent.create.request":
        this.reply({
          type: "agent.create.response",
          payload: { requestId: message.requestId, agent: this.agent, error: null },
        });
        return;
      case "fetch_agent_request":
        this.reply({
          type: "fetch_agent_response",
          payload: { requestId: message.requestId, agent: this.agent, project: null, error: null },
        });
        return;
      case "list_provider_models_request":
        this.reply({
          type: "list_provider_models_response",
          payload: {
            provider: "claude",
            requestId: message.requestId,
            fetchedAt: "2026-10-15T00:00:00.000Z",
            models: [
              {
                provider: "claude",
                id: "native-model",
                label: "Native model",
                thinkingOptions: [{ id: "high", label: "High" }],
              },
            ],
          },
        });
        return;
      case "set_agent_model_request":
        this.agent.model = message.modelId;
        this.agent.runtimeInfo!.model = message.modelId;
        this.reply({
          type: "set_agent_model_response",
          payload: { requestId: message.requestId, agentId: this.agent.id, accepted: true, error: null },
        });
        return;
      case "set_agent_thinking_request":
        this.agent.effectiveThinkingOptionId = message.thinkingOptionId;
        this.reply({
          type: "set_agent_thinking_response",
          payload: { requestId: message.requestId, agentId: this.agent.id, accepted: true, error: null },
        });
        return;
      case "agent.timeline.set_subscription.request":
        this.reply({
          type: "agent.timeline.set_subscription.response",
          payload: { requestId: message.requestId, subscriptionId: "own-timeline", agentIds: message.agentIds },
        });
        return;
      case "send_agent_message_request":
        this.submitted = message;
        this.reply({
          type: "send_agent_message_response",
          payload: { requestId: message.requestId, agentId: this.agent.id, accepted: true, error: null },
        });
        this.sent.resolve();
        return;
      case "cancel_agent_request":
        assert.ok(message.requestId !== undefined);
        this.reply({
          type: "cancel_agent_response",
          payload: {
            requestId: message.requestId,
            agentId: message.agentId,
            agent: this.agent,
            error: this.cancelError,
          },
        });
        return;
      default:
        throw new Error(`unexpected pinned-client fixture request: ${message.type}`);
    }
  }

  admit(): void {
    this.event({
      type: "timeline",
      provider: "claude",
      turnId: "wire-own-turn",
      item: { type: "user_message", text: this.submitted!.text, clientMessageId: this.submitted!.messageId! },
    });
  }
  event(event: AgentStreamEventPayload): void {
    this.reply({
      type: "agent_stream",
      payload: {
        subscriptionId: "own-timeline",
        agentId: this.agent.id,
        timestamp: "2026-10-15T00:00:01.000Z",
        seq: ++this.sequence,
        epoch: "wire-epoch",
        event,
      },
    });
  }
  listenerCount(): number {
    return this.messages.size + this.opens.size + this.closes.size + this.errors.size;
  }
}

test(
  "actual pinned RPC and timeline client applies selectors but admits only its canonical own turn",
  { timeout: 10_000 },
  async () => {
    const wire = new PinnedProtocolFixture();
    const adapter = createPaseoProvider(
      { name: "paseo", kind: "paseo" },
      { createClient: (config) => wire.createClient(config) },
    );
    const attempt = adapter.start({
      ...drive(),
      options: { model: "native-model", effort: "high" },
      session: { kind: "fresh" },
    });
    const admitted = settlementProbe(attempt.result, () => "admitted");
    await wire.sent.promise;
    wire.event({
      type: "timeline",
      provider: "claude",
      turnId: "other-writer",
      item: { type: "user_message", text: "human", clientMessageId: "unrelated" },
    });
    wire.event({ type: "turn_completed", provider: "claude", turnId: "other-writer" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(admitted(), null);
    wire.admit();
    const session = await attempt.result;
    assert.equal(session.admission.fence, "wire-own-turn");
    assert.deepEqual(
      wire.requests.map((request) => request.type),
      [
        "agent.create.request",
        "list_provider_models_request",
        "set_agent_model_request",
        "set_agent_thinking_request",
        "fetch_agent_request",
        "agent.timeline.set_subscription.request",
        "send_agent_message_request",
      ],
    );
    const creation = wire.requests[0]!;
    assert.equal(creation.type, "agent.create.request");
    if (creation.type === "agent.create.request") {
      assert.equal(creation.initialPrompt, undefined);
      assert.equal(creation.autoArchive, false);
      assert.equal(creation.env?.AKUMA_REQUESTS, undefined);
      assert.equal(creation.env?.AKUMA_REQUESTS_ENTRY, drive().requests.entry);
    }
    wire.event({
      type: "timeline",
      provider: "claude",
      turnId: "wire-own-turn",
      item: { type: "assistant_message", messageId: "answer", text: "wire answer" },
    });
    wire.event({ type: "turn_completed", provider: "claude", turnId: "wire-own-turn" });
    assert.deepEqual(await session.completion, { kind: "answered", answer: "wire answer", historyId: "wire-own-turn" });
    await attempt.closed;
    assert.equal(
      wire.requests.some((request) => request.type === "cancel_agent_request"),
      false,
    );
    assert.equal(wire.closed, true);
    assert.equal(wire.listenerCount(), 0);
  },
);

test(
  "actual pinned native cancellation failure remains distinct from successful client cleanup",
  { timeout: 10_000 },
  async () => {
    const wire = new PinnedProtocolFixture();
    wire.cancelError = "native session-wide cancel refused";
    const adapter = createPaseoProvider(
      { name: "paseo", kind: "paseo" },
      { createClient: (config) => wire.createClient(config) },
    );
    const attempt = fresh(adapter);
    await wire.sent.promise;
    wire.admit();
    const session = await attempt.result;
    const outcome = assert.rejects(session.completion, /client retired/u);
    await assert.rejects(attempt.abort(), /native session-wide cancel refused/u);
    await assert.rejects(attempt.closed, /native session-wide cancel refused/u);
    await outcome;
    const cancel = wire.requests.find((request) => request.type === "cancel_agent_request");
    assert.ok(cancel !== undefined);
    assert.deepEqual(Object.keys(cancel).sort(), ["agentId", "requestId", "type"]);
    assert.equal(wire.closed, true);
    assert.equal(wire.listenerCount(), 0);
  },
);

// An actual local socket endpoint, not a Paseo daemon. It either holds the
// upgrade open or establishes a WebSocket whose close handshake the test gates.
async function socketEndpoint(context: TestContext, handshake: boolean) {
  const server = createServer();
  const accepted = deferred<Duplex>();
  const peers = new Set<Duplex>();
  let bytes = 0;
  server.on("upgrade", (request, peer) => {
    peers.add(peer);
    peer.on("error", () => undefined);
    peer.on("end", () => peer.end());
    peer.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    if (handshake) {
      const key = request.headers["sec-websocket-key"]!;
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      peer.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
    }
    accepted.resolve(peer);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { url: `ws://127.0.0.1:${address.port}/ws`, accepted: accepted.promise, bytes: () => bytes };
}

// Observe the real runtime socket used by the actual pinned client without
// changing production injection APIs or depending on a transitive WS package.
function observeSockets(context: TestContext) {
  const NativeWebSocket = globalThis.WebSocket;
  const opened = deferred<void>();
  const sockets: WebSocket[] = [];
  const closeErrors: unknown[] = [];
  const closeCodes: Array<number | undefined> = [];
  class ObservedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
      const onOpen = () => opened.resolve();
      this.addEventListener("open", onOpen, { once: true });
      this.addEventListener("close", () => this.removeEventListener("open", onOpen), { once: true });
    }
    override close(code?: number, reason?: string): void {
      closeCodes.push(code);
      try {
        super.close(code, reason);
      } catch (error) {
        closeErrors.push(error);
        throw error;
      }
    }
  }
  globalThis.WebSocket = ObservedWebSocket;
  context.after(() => {
    globalThis.WebSocket = NativeWebSocket;
  });
  return { sockets, opened: opened.promise, closeErrors, closeCodes };
}

function socketListeners(socket: WebSocket) {
  return Object.fromEntries(
    ["open", "close", "error", "message"].map((kind) => [kind, getEventListeners(socket, kind).length]),
  );
}

function actualSocketProvider(url: string, connectTimeoutMs = 10_000, credential?: () => Promise<string | undefined>) {
  const logicalClosed = deferred<void>();
  let connectSettled = false;
  let prompts = 0;
  const adapter = createPaseoProvider(
    { name: "paseo", kind: "paseo", config: { url } },
    {
      createClient: (config) => {
        const client = new DaemonClient({
          ...config,
          connectTimeoutMs,
          ...(credential === undefined ? {} : { localCredential: credential }),
        });
        const connect = client.connect.bind(client);
        client.connect = () => {
          const raw = connect();
          void raw.then(
            () => {
              connectSettled = true;
            },
            () => {
              connectSettled = true;
            },
          );
          return raw;
        };
        const close = client.close.bind(client);
        client.close = async () => {
          await close();
          logicalClosed.resolve();
        };
        const send = client.sendMessage.bind(client);
        client.sendMessage = async (...args) => {
          prompts += 1;
          await send(...args);
        };
        return client;
      },
    },
  );
  return {
    adapter,
    logicalClosed: logicalClosed.promise,
    connectSettled: () => connectSettled,
    prompts: () => prompts,
  };
}

function fresh(adapter: ReturnType<typeof createPaseoProvider>) {
  return adapter.start({ ...drive(), session: { kind: "fresh" } });
}

// These native regressions exercise the adapter's real socket owner, not merely
// a fake close promise. Each endpoint is isolated, bounded by the test watchdog.
test(
  "pinned client closure waits for actual socket close after logical disposal",
  { timeout: 10_000 },
  async (context) => {
    const observed = observeSockets(context);
    const endpoint = await socketEndpoint(context, true);
    const real = actualSocketProvider(endpoint.url);
    const attempt = fresh(real.adapter);
    const rejected = assert.rejects(attempt.result, /provider attempt retired/u);
    const peer = await endpoint.accepted;
    await observed.opened;
    const closing = attempt.abort();
    await rejected;
    await real.logicalClosed;
    const closure = settlementProbe(attempt.closed, () => "closed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closure(), null, "native logical disposal must not prove physical closure");
    peer.destroy();
    await closing;
    await attempt.closed;
    assert.equal(real.connectSettled(), false, "raw pending connect is inert, not live custody");
    assert.equal(real.prompts(), 0);
    // The fixture's one-shot open observer has fired; every socket listener retires.
    assert.deepEqual(socketListeners(observed.sockets[0]!), { open: 0, close: 0, error: 0, message: 0 });
  },
);

test(
  "pinned connecting cancellation leaves no prompt, socket listener or live connect custody",
  { timeout: 10_000 },
  async (context) => {
    const observed = observeSockets(context);
    const endpoint = await socketEndpoint(context, false);
    const real = actualSocketProvider(endpoint.url);
    const attempt = fresh(real.adapter);
    const rejected = assert.rejects(attempt.result, /provider attempt retired/u);
    await endpoint.accepted;
    await attempt.abort();
    await rejected;
    await attempt.closed;
    assert.equal(real.connectSettled(), false);
    assert.equal(real.prompts(), 0);
    assert.equal(endpoint.bytes(), 0);
    // Native/adapter observers and the test's never-fired open observer are gone,
    // including the native temporary early-close handlers.
    const socket = observed.sockets[0]!;
    assert.deepEqual(socketListeners(socket), { open: 0, close: 0, error: 0, message: 0 });
  },
);

test(
  "pinned native invalid timeout-close error survives independent saved-socket retirement",
  { timeout: 10_000 },
  async (context) => {
    const observed = observeSockets(context);
    const endpoint = await socketEndpoint(context, false);
    const real = actualSocketProvider(endpoint.url, 100);
    const attempt = fresh(real.adapter);
    await assert.rejects(attempt.result, /Connection timed out/u);
    assert.ok(observed.closeErrors[0] instanceof DOMException);
    assert.equal(observed.closeErrors[0].name, "InvalidAccessError");
    await assert.rejects(attempt.closed, (error: unknown) => error === observed.closeErrors[0]);
    assert.ok(observed.closeCodes.includes(1001));
    assert.ok(observed.closeCodes.includes(1000), "owner must close socket that native timeout forgot");
    assert.equal(real.prompts(), 0);
    assert.deepEqual(socketListeners(observed.sockets[0]!), { open: 0, close: 0, error: 0, message: 0 });
  },
);

test(
  "pinned late async authentication cannot create an escaped socket after cancellation",
  { timeout: 10_000 },
  async (context) => {
    const observed = observeSockets(context);
    const credential = deferred<string | undefined>();
    const endpoint = await socketEndpoint(context, false);
    const real = actualSocketProvider(endpoint.url, 10_000, () => credential.promise);
    const attempt = fresh(real.adapter);
    const rejected = assert.rejects(attempt.result, /provider attempt retired/u);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await attempt.abort();
    await rejected;
    await attempt.closed;
    credential.resolve("fixture-only-token");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(observed.sockets.length, 0);
    assert.equal(real.prompts(), 0);
    assert.equal(real.connectSettled(), false);
  },
);
