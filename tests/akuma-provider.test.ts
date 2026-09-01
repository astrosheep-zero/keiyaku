import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as acp from "@agentclientprotocol/sdk";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import {
  AKUMA_REQUESTS_ENV,
  AGENT_EVENT_QUEUE_LIMIT,
  createProviderAttempt,
  AgentEventChannel,
  noteEvent,
  type AgentEvent,
  type AttemptCustody,
  type ProviderAttempt,
  type TurnResult,
} from "../src/akuma/provider.js";
import { type ProviderExecution } from "../src/akuma/provider-recipe.js";
import { createClaudeProvider } from "../src/akuma/providers/claude/index.js";
import { createCodexAppServerProvider } from "../src/akuma/providers/codex-app-server/index.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import type { OpencodeSdkLoader, OpencodeSdkSession } from "../src/akuma/providers/opencode-sdk/session.js";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import { createAcpProvider } from "../src/akuma/providers/acp/index.js";
import { createGrokBuildProvider } from "../src/akuma/providers/grok-build/index.js";
import { decodeProviderExecution, resolveProviderExecution } from "../src/akuma/providers/index.js";
import { EMPTY_ACP_EVENT_STATE, mapAcpUpdate } from "../src/akuma/providers/acp/events.js";
import type { StdioProcess } from "../src/runtime/proc/stdio.js";

function attemptResult<Result>(attempt: ProviderAttempt<Result>): Promise<Result> {
  return attempt.result;
}

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

test("ProviderAttempt retires each owned resource once while allowing force escalation", async () => {
  const setup = deferred<void>();
  let custody!: AttemptCustody;
  let aborts = 0;
  let forces = 0;
  const attempt = createProviderAttempt(undefined, async (received) => {
    custody = received;
    received.own({
      closed: Promise.resolve(),
      abort: async () => {
        aborts += 1;
      },
      forceDispose: async () => {
        forces += 1;
      },
    });
    await setup.promise;
    return "ready";
  });

  await Promise.resolve();
  await Promise.all([attempt.abort(), attempt.abort()]);
  assert.equal(aborts, 1);
  await Promise.all([attempt.forceDispose(), attempt.forceDispose()]);
  assert.equal(forces, 1);
  setup.resolve();
  await attempt.closed;
  assert.equal(await attempt.result, "ready");
  assert.ok(custody.signal.aborted);
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

test("ProviderAttempt observes rejecting retirement of a late-owned resource", async () => {
  const setup = deferred<void>();
  const owned = deferred<void>();
  const failure = new Error("late physical cleanup failed");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  let custody!: AttemptCustody;
  let forces = 0;
  const attempt = createProviderAttempt(undefined, async (received) => {
    custody = received;
    owned.resolve();
    await setup.promise;
    return "ready";
  });

  process.on("unhandledRejection", onUnhandled);
  try {
    await owned.promise;
    await attempt.forceDispose();
    const closed = assert.rejects(attempt.closed, /late physical cleanup failed/u);
    custody.own({
      closed: Promise.resolve(),
      forceDispose: async () => {
        forces += 1;
        throw failure;
      },
    });
    setup.resolve();
    assert.equal(await attempt.result, "ready");
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
  let closed = 0;
  const prompts: unknown[] = [];
  const executions: ProviderExecution[] = [];
  let activeSession = "session-fresh";
  let activeMessage = "msg_unset";
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  // prettier-ignore
  const events = [
    { type: "session.status", properties: { sessionID: "session-fresh", status: { type: "busy" } } },
    { type: "message.part.updated", properties: { part: { id: "part-tool", sessionID: "session-fresh", messageID: "message-1", type: "tool", callID: "tool-1", tool: "shell", state: { status: "running", input: { command: "npm test" }, time: { start: 1 } } } } },
    { type: "message.part.updated", properties: { part: { id: "part-tool", sessionID: "session-fresh", messageID: "message-1", type: "tool", callID: "tool-1", tool: "shell", state: { status: "completed", input: { command: "npm test" }, output: "ok", title: "test", metadata: {}, time: { start: 1, end: 2 } } } } },
    { type: "message.part.updated", properties: { part: { id: "part-thought", sessionID: "session-fresh", messageID: "message-1", type: "reasoning", text: "checked", time: { start: 1, end: 2 } } } },
    { type: "message.part.updated", properties: { part: { id: "part-answer", sessionID: "session-fresh", messageID: "message-1", type: "text", text: "answer", time: { start: 1, end: 2 } } } },
    { type: "session.future", properties: { secret: "drop" } },
    { type: "session.status", properties: { sessionID: "session-fresh", status: { type: "idle" } } },
  ];
  const stream = async function* (): AsyncGenerator<unknown> {
    await admitted;
    yield {
      type: "message.updated",
      properties: { info: { id: activeMessage, sessionID: activeSession, role: "user" } },
    };
    for (const event of events) {
      yield JSON.parse(JSON.stringify(event).replaceAll("session-fresh", activeSession)) as unknown;
    }
  };
  const session = {
    async create() {
      activeSession = "session-fresh";
      return { data: { id: activeSession } };
    },
    async get() {
      activeSession = "session-resume";
      return { data: { id: activeSession } };
    },
    async promptAsync(input: unknown) {
      prompts.push(input);
      activeMessage = String((input as { body?: { messageID?: unknown } }).body?.messageID);
      admit();
      return { data: undefined };
    },
    async messages() {
      return {
        data: [
          { info: { id: activeMessage, sessionID: activeSession, role: "user", time: { created: 1 } }, parts: [] },
          {
            info: {
              id: "message-1",
              sessionID: activeSession,
              parentID: activeMessage,
              role: "assistant",
              time: { created: 2 },
            },
            parts: [
              {
                id: "part-tool",
                sessionID: "session-fresh",
                messageID: "message-1",
                type: "tool",
                callID: "tool-1",
                tool: "shell",
                state: {
                  status: "completed",
                  input: { command: "npm test" },
                  output: "ok",
                  title: "test",
                  metadata: {},
                  time: { start: 1, end: 2 },
                },
              },
              {
                id: "part-thought",
                sessionID: "session-fresh",
                messageID: "message-1",
                type: "reasoning",
                text: "checked",
                time: { start: 1, end: 2 },
              },
              {
                id: "part-answer",
                sessionID: "session-fresh",
                messageID: "message-1",
                type: "text",
                text: "answer",
                time: { start: 1, end: 2 },
              },
            ],
          },
        ],
      };
    },
    async fork() {
      return { data: { id: "session-child" } };
    },
    async abort() {
      return { data: true };
    },
  } as unknown as OpencodeSdkSession;
  const loader: OpencodeSdkLoader = async (_cwd, execution) => {
    executions.push(execution);
    return {
      client: {
        session,
        event: {
          async subscribe() {
            return { stream: stream() };
          },
        } as never,
      },
      close: () => {
        closed += 1;
      },
    };
  };
  return { loader, closed: () => closed, executions, prompts };
}

test("provider answered results may omit an exact fork point", () => {
  const result: TurnResult = { kind: "answered", answer: "complete answer" };
  assert.deepEqual(result, { kind: "answered", answer: "complete answer" });
});

function fakeAcp(root: string, mode: "complete" | "cancel" | "reverse" | "prompt-error" = "complete") {
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
    return { sessionId: "fresh-session" };
  })
  .onRequest(acp.methods.agent.session.load, ({ params }) => {
    log({ kind: "load", params });
    return {};
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

test("ACP uses stable initialization, fresh sessions, mapped profile arguments, and one prompt response", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-acp-provider-"));
  try {
    const fake = fakeAcp(root);
    const provider = createAcpProvider(fake.execution);
    assert.deepEqual(provider.admitOptions({ readonly: true }), {
      kind: "admitted",
      options: { readonly: true },
      readonly: { enforcement: "none", diagnostic: "ACP cannot remove task-surface mutation capabilities" },
    });
    assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
    const drive = await provider.start({
      body: "build",
      launchTells: [{ id: "tell-1", text: "then test" }],
      cwd: root,
      options: { model: "grok-4", effort: "high", systemPrompt: "Be precise." },
      session: { kind: "fresh" },
      requests: { dir: join(root, "requests") },
    }).result;
    const events = [];
    for await (const event of drive.events) events.push(event);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACP load retains the exact session ID without a fork or live tell capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-acp-resume-"));
  try {
    const fake = fakeAcp(root);
    const provider = createAcpProvider(fake.execution);
    assert.equal(provider.fork, undefined);
    const drive = await provider.resume!({
      body: "continue",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "resume", coordinate: { sessionId: "retained-session" } },
    }).result;
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(events[0], { type: "session", coordinate: { sessionId: "retained-session" } });
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete answer" });
    const load = acpLog(fake.log).find((record) => record.kind === "load")!;
    assert.equal((load.params as { sessionId: string }).sessionId, "retained-session");
    assert.equal("_meta" in (load.params as object), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ACP forced disposal closes its owned process tree after standard session/cancel", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-acp-cancel-"));
  try {
    const fake = fakeAcp(root, "cancel");
    const drive = await createAcpProvider(fake.execution).start({
      body: "wait",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "fresh" },
    }).result;
    await drive.forceDispose();
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(events, [{ type: "session", coordinate: { sessionId: "fresh-session" } }]);
    assert.equal((await drive.completion).kind, "failed");
    const descendant = acpLog(fake.log).find((record) => record.kind === "descendant")!;
    assert.equal(await processGone(descendant.pid as number), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  resolveCleanup(): void;
  rejectCleanup(error: Error): void;
  readonly sessionNew: unknown;
  readonly sessionLoad: unknown;
}> {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  let startCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    startCleanup = resolve;
  });
  let resolveCleanup!: () => void;
  let rejectCleanup!: (error: Error) => void;
  let forcedCleanup = 0;
  let startInitialize!: () => void;
  const initializeStarted = new Promise<void>((resolve) => {
    startInitialize = resolve;
  });
  let finishPrompt!: () => void;
  const prompt = new Promise<void>((resolve) => {
    finishPrompt = resolve;
  });
  let finishInterject!: () => void;
  const interject = new Promise<void>((resolve) => {
    finishInterject = resolve;
  });
  let startInterject!: () => void;
  const interjectStarted = new Promise<void>((resolve) => {
    startInterject = resolve;
  });
  const interjections: ControlledInterject[] = [];
  let cancelled = 0;
  let emitAssistant!: (text: string) => Promise<void>;
  let sessionNew: unknown;
  let sessionLoad: unknown;
  const cleanup = new Promise<void>((resolve, reject) => {
    resolveCleanup = resolve;
    rejectCleanup = reject;
  });
  let resolveExited!: (value: Readonly<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>) => void;
  const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>>(
    (resolve) => {
      resolveExited = resolve;
    },
  );
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
      "x.ai/interject",
      (value) => value as ControlledInterject,
      async ({ params }) => {
        interjections.push(params);
        startInterject();
        if (options.interject === "rejected") throw new acp.RequestError(-32603, "interject rejected");
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

test("Grok Build uses fixed launch arguments and admits queued interject on the live ACP connection", async () => {
  const controlled = controlledAcpProcess({ stallPrompt: true, interject: "queued" });
  let spawned: readonly string[] = [];
  const provider = createGrokBuildProvider(controlledGrokExecution, {
    spawnProcess: (input) => {
      spawned = input.argv;
      return controlled.process;
    },
  });
  assert.deepEqual(provider.admitOptions({ model: "grok-4.6", effort: "high", readonly: true }), {
    kind: "admitted",
    options: { model: "grok-4.6", effort: "high", readonly: true },
    readonly: {
      enforcement: "none",
      diagnostic: "Grok Build cannot remove task-surface mutation capabilities",
    },
  });
  const drive = await provider.start({
    body: "build",
    launchTells: [],
    cwd: "/tmp",
    options: { model: "grok-4.6", effort: "high" },
    session: { kind: "fresh" },
  }).result;
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
  const controlled = controlledAcpProcess({ stallPrompt: true, interject: "pending" });
  const drive = await createGrokBuildProvider(controlledGrokExecution, {
    spawnProcess: () => controlled.process,
  }).start({
    body: "build",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "fresh" },
  }).result;
  const submission = drive.tell!({ id: "tell-late", text: "too late" });
  await controlled.interjectStarted;
  controlled.resolvePrompt();
  await controlled.cleanupStarted;
  controlled.resolveInterject();
  assert.deepEqual(await submission, { kind: "turn-ended" });
  controlled.resolveCleanup();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "" });
});

test("ACP completion waits for owned process cleanup", async () => {
  const controlled = controlledAcpProcess();
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "fresh" },
  }).result;
  let completed = false;
  void drive.completion.then(() => {
    completed = true;
  });
  await controlled.cleanupStarted;
  assert.equal(completed, false);
  controlled.resolveCleanup();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "" });
});

test("ACP cleanup failure settles a typed failed Turn", async () => {
  const controlled = controlledAcpProcess();
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "fresh" },
  }).result;
  await controlled.cleanupStarted;
  controlled.rejectCleanup(new Error("drain failed"));
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "ACP cleanup failed: drain failed" });
});

test("ACP setup abort closes a child stalled during initialization", async () => {
  const controlled = controlledAcpProcess({ stallInitialize: true });
  const controller = new AbortController();
  const setup = createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "fresh" },
    signal: controller.signal,
  });
  assert.equal("result" in setup && "closed" in setup, true);
  await controlled.initializeStarted;
  controller.abort(new Error("controlled setup cancellation"));
  await assert.rejects(setup.result, /controlled setup cancellation/);
  await setup.closed;
  assert.equal(controlled.forcedCleanup(), 1);
});

test("ACP ignores assistant updates after terminal prompt evidence", async () => {
  const controlled = controlledAcpProcess({ assistant: "before" });
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "fresh" },
  }).result;
  const events = (async () => {
    const observed = [];
    for await (const event of drive.events) observed.push(event);
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

function fakePiSdk(
  input: {
    events?: readonly Record<string, unknown>[];
    fail?: Error;
    historyId?: string | null;
    waitForAbort?: boolean;
    promptNeverSettles?: boolean;
    abortNeverSettles?: boolean;
  } = {},
): {
  sdk: PiSdk;
  seen: { options?: Record<string, unknown>; opened?: string; branched?: string; aborted: number; disposed: number };
} {
  const seen = { aborted: 0, disposed: 0 } as {
    options?: Record<string, unknown>;
    loader?: Record<string, unknown>;
    opened?: string;
    branched?: string;
    aborted: number;
    disposed: number;
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
    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listener = listener;
      return () => {
        this.listener = undefined;
      };
    },
    listener: undefined as ((event: Record<string, unknown>) => void) | undefined,
    async prompt() {
      if (input.fail !== undefined) throw input.fail;
      if (input.promptNeverSettles === true) await new Promise<void>(() => undefined);
      if (input.waitForAbort === true)
        await new Promise<void>((resolve) => {
          this.resolveAbort = resolve;
        });
      for (const event of input.events ?? []) this.listener?.(event);
    },
    resolveAbort: undefined as (() => void) | undefined,
    async abort() {
      seen.aborted += 1;
      if (input.abortNeverSettles === true) await new Promise<void>(() => undefined);
      this.resolveAbort?.();
    },
    dispose() {
      seen.disposed += 1;
    },
  };
  class ResourceLoader {
    constructor(options?: Record<string, unknown>) {
      seen.loader = options;
    }
    async reload() {}
  }
  return {
    seen,
    sdk: {
      createAgentSession: async (options) => {
        seen.options = options as Record<string, unknown>;
        return { session } as never;
      },
      DefaultResourceLoader: ResourceLoader as never,
      getAgentDir: () => "/agent",
      ModelRuntime: { create: async () => ({ getModel: () => ({ id: "model" }) }) } as never,
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

test("OpenCode V1 adapter admits with promptAsync and completes from terminal events", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
  const drive = await provider.start({
    body: "build",
    launchTells: [{ id: "tell-1", text: "also check" }],
    cwd: "/tmp",
    options: {},
    session: { kind: "fresh" },
    requests: { dir: "/tmp/requests" },
  }).result;
  assert.equal(drive.admission.fence, "session-fresh");
  const observed = [];
  for await (const event of drive.events) observed.push(event);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "answer", historyId: "message-1" });
  assert.deepEqual(
    observed.map((event) => event.type),
    ["session", "tool", "tool", "thought", "assistant", "unknown"],
  );
  assert.equal(JSON.stringify(observed).includes("secret"), false);
  assert.equal(fake.closed(), 1);
  assert.equal(fake.executions[0]!.env?.[AKUMA_REQUESTS_ENV], "/tmp/requests");
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
        ? provider.start({ body: "wait", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } })
        : provider.resume!({
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

test("OpenCode V1 adapter resumes the supplied coordinate and forks the exact point", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  const drive = await provider.resume!({
    body: "continue",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "resume", coordinate: { sessionId: "session-resume" } },
  }).result;
  assert.equal((await drive.completion).kind, "answered");
  assert.deepEqual(
    await provider.fork!({ session: { sessionId: "session-resume" }, at: "message-1", cwd: "/tmp" }).result,
    {
      session: { sessionId: "session-child" },
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

test("OpenCode V1 refuses a Pi coordinate before loading its native runtime", async () => {
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

test("OpenCode V1 rejects failed prompt admission and cleans up", async () => {
  let closed = 0;
  const session = {
    async create() {
      return { data: { id: "session-rejected" } };
    },
    async promptAsync() {
      throw new Error("prompt rejected");
    },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({
    loader: async () => ({
      client: {
        session,
        event: {
          async subscribe() {
            return {
              stream: (async function* () {
                yield { type: "session.status", properties: { sessionID: "session-empty", status: { type: "busy" } } };
                yield { type: "session.status", properties: { sessionID: "session-empty", status: { type: "idle" } } };
              })(),
            };
          },
        } as never,
      },
      close: () => {
        closed += 1;
      },
    }),
  });
  await assert.rejects(
    attemptResult(
      provider.start({ body: "fail", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } }),
    ),
    /prompt rejected/u,
  );
  assert.equal(closed, 1);
});

test("OpenCode V1 fails terminal observation without native assistant evidence", async () => {
  let closed = 0;
  let messageID = "msg_unset";
  let prompt!: () => void;
  const prompted = new Promise<void>((resolve) => {
    prompt = resolve;
  });
  const session = {
    async create() {
      return { data: { id: "session-empty" } };
    },
    async promptAsync(input: unknown) {
      messageID = String((input as { body?: { messageID?: unknown } }).body?.messageID);
      prompt();
      return { data: undefined };
    },
    async messages() {
      return {
        data: [{ info: { id: messageID, sessionID: "session-empty", role: "user", time: { created: 1 } }, parts: [] }],
      };
    },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({
    loader: async () => ({
      client: {
        session,
        event: {
          async subscribe() {
            return {
              stream: (async function* () {
                await prompted;
                yield {
                  type: "message.updated",
                  properties: { info: { id: messageID, sessionID: "session-empty", role: "user" } },
                };
                yield { type: "session.status", properties: { sessionID: "session-empty", status: { type: "busy" } } };
                yield { type: "session.status", properties: { sessionID: "session-empty", status: { type: "idle" } } };
              })(),
            };
          },
        } as never,
      },
      close: () => {
        closed += 1;
      },
    }),
  });
  const drive = await provider.start({
    body: "idle",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "fresh" },
  }).result;
  assert.deepEqual(await drive.completion, {
    kind: "failed",
    diagnostic: "OpenCode completed without a native assistant answer",
  });
  assert.equal(closed, 1);
});

test("OpenCode V1 isolates other sessions and accepts the current Turn error", async () => {
  let messageID = "msg_unset";
  let prompt!: () => void;
  const prompted = new Promise<void>((resolve) => {
    prompt = resolve;
  });
  const session = {
    async create() {
      return { data: { id: "session-error" } };
    },
    async promptAsync(input: unknown) {
      messageID = String((input as { body?: { messageID?: unknown } }).body?.messageID);
      prompt();
      return { data: undefined };
    },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({
    loader: async () => ({
      client: {
        session,
        event: {
          async subscribe() {
            return {
              stream: (async function* () {
                await prompted;
                yield {
                  type: "message.updated",
                  properties: { info: { id: messageID, sessionID: "session-error", role: "user" } },
                };
                yield { type: "session.status", properties: { sessionID: "session-other", status: { type: "busy" } } };
                yield { type: "session.status", properties: { sessionID: "session-other", status: { type: "idle" } } };
                yield {
                  type: "session.error",
                  properties: { sessionID: "session-error", error: { message: "native failed" } },
                };
              })(),
            };
          },
        } as never,
      },
    }),
  });
  const drive = await provider.start({
    body: "fail",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "fresh" },
  }).result;
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
  const attempt = provider.start({
    body: "work",
    launchTells: [{ id: "tell-1", text: "also" }],
    cwd: tmpdir(),
    options: {},
    session: { kind: "fresh" },
    requests: { dir: "/work/requests" },
  });
  const drive = await attempt.result;
  assert.equal(drive.tell, undefined);
  const events = [];
  for await (const event of drive.events) events.push(event);
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
  const customTools = fake.seen.options?.customTools as NonNullable<CreateAgentSessionOptions["customTools"]>;
  const result = await customTools[0]!.execute(
    "request-env",
    { command: `printf %s "$${AKUMA_REQUESTS_ENV}"` },
    new AbortController().signal,
    undefined,
    {} as never,
  );
  assert.deepEqual(result.content, [{ type: "text", text: "/work/requests" }]);
  assert.equal(fake.seen.disposed, 1);
  await attempt.closed;
});

test("Pi attempt disposal closes events and completion before its sole closed proof", async () => {
  for (const dispose of ["abort", "forceDispose"] as const) {
    const fake = fakePiSdk({ promptNeverSettles: true });
    const attempt = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start({
      body: "wait",
      launchTells: [],
      cwd: "/work",
      options: {},
      session: { kind: "fresh" },
    });
    const drive = await attempt.result;
    const events: AgentEvent[] = [];
    const draining = (async () => {
      for await (const event of drive.events) events.push(event);
    })();

    await attempt[dispose]();
    assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "Pi session force-disposed" });
    await draining;
    await attempt.closed;
    assert.deepEqual(events, [{ type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } }]);
    assert.equal(fake.seen.disposed, 1);
  }
});

test("Pi keeps abort pending when native cleanup refuses to settle", async () => {
  const fake = fakePiSdk({ promptNeverSettles: true, abortNeverSettles: true });
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start({
    body: "wait",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "fresh" },
  }).result;
  let settled = false;
  void drive.abort().then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(settled, false);
  assert.equal(fake.seen.aborted, 1);
  assert.equal(fake.seen.disposed, 0);
});

test("Pi preserves thinking-only and explicit empty assistant answers", async () => {
  const fake = fakePiSdk({
    events: [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "earlier" }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "consider" }] } },
    ],
  });
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start({
    body: "wait",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "fresh" },
  }).result;
  const events = [];
  for await (const event of drive.events) events.push(event);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "assistant", text: "earlier" },
    { type: "thought", text: "consider" },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "entry-final" });

  const empty = fakePiSdk({
    events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } }],
  });
  const emptyDrive = await createPiProvider({ name: "pi", kind: "pi" }, async () => empty.sdk).start({
    body: "wait",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "fresh" },
  }).result;
  const emptyEvents = [];
  for await (const event of emptyDrive.events) emptyEvents.push(event);
  assert.deepEqual(emptyEvents, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "assistant", text: "" },
  ]);
  assert.deepEqual(await emptyDrive.completion, { kind: "answered", answer: "", historyId: "entry-final" });
});

test("Pi adapter resumes and forks only exact sessionFile coordinates", async () => {
  const fake = fakePiSdk({
    events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "resumed" }] } }],
  });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const drive = await provider.resume!({
    body: "continue",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "resume", coordinate: { sessionFile: "/sessions/source.jsonl" } },
  }).result;
  for await (const _event of drive.events) {
    /* drain */
  }
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

test("Pi readonly admits native enforcement and removes every task-surface mutation tool", async () => {
  const fake = fakePiSdk({
    events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }],
  });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const drive = await provider.start({
    body: "inspect",
    launchTells: [],
    cwd: "/work",
    options: { readonly: true },
    session: { kind: "fresh" },
    requests: { dir: "/work/requests" },
  }).result;
  for await (const _event of drive.events) {
    /* drain */
  }
  await drive.completion;
  assert.deepEqual(fake.seen.options?.tools, ["read", "grep", "find", "ls"]);
  assert.equal(fake.seen.options?.customTools, undefined);
  assert.deepEqual(provider.admitOptions({ readonly: true }), {
    kind: "admitted",
    options: { readonly: true },
    readonly: { enforcement: "native" },
  });
});

test("provider recipe preserves opaque config until adapter construction", async () => {
  assert.deepEqual(
    decodeProviderExecution({
      name: "claude",
      kind: "claude-agent-sdk",
      config: { unexpected: true },
    }),
    {
      name: "claude",
      kind: "claude-agent-sdk",
      config: { unexpected: true },
    },
  );
  assert.doesNotThrow(() =>
    createClaudeProvider({
      name: "claude",
      kind: "claude-agent-sdk",
      config: { unexpected: true },
    }),
  );
  const claudeResolved = await resolveProviderExecution({
    name: "claude",
    kind: "claude-agent-sdk",
    config: { unexpected: true },
  });
  assert.equal(claudeResolved.execution.config?.unexpected, true);
  assert.deepEqual(
    decodeProviderExecution({
      name: "opencode-sdk",
      kind: "opencode-sdk",
      config: { unexpected: true },
    }),
    {
      name: "opencode-sdk",
      kind: "opencode-sdk",
      config: { unexpected: true },
    },
  );
  assert.doesNotThrow(() =>
    createOpencodeProvider({
      name: "opencode-sdk",
      kind: "opencode-sdk",
      config: { unexpected: true },
    }),
  );
  assert.deepEqual(
    decodeProviderExecution({
      name: "pi",
      kind: "pi",
      config: { tools: ["bash"] },
    }),
    {
      name: "pi",
      kind: "pi",
      config: { tools: ["bash"] },
    },
  );
  assert.doesNotThrow(() =>
    createPiProvider({
      name: "pi",
      kind: "pi",
      config: { tools: ["bash"] },
    }),
  );
  assert.deepEqual(
    decodeProviderExecution({
      name: "grok-build",
      kind: "grok-build",
      executable: "grok",
      config: { extension: true },
    }),
    {
      name: "grok-build",
      kind: "grok-build",
      executable: "grok",
      config: { extension: true },
    },
  );
  assert.doesNotThrow(() =>
    createGrokBuildProvider({
      name: "grok-build",
      kind: "grok-build",
      executable: "grok",
      config: { extension: true },
    }),
  );
  assert.deepEqual(
    decodeProviderExecution({
      name: "acp",
      kind: "acp",
      executable: "agent",
      config: { argvBefore: ["x"], argvAfter: [], unexpected: true },
    }),
    {
      name: "acp",
      kind: "acp",
      executable: "agent",
      config: { argvBefore: ["x"], argvAfter: [], unexpected: true },
    },
  );
  assert.throws(
    () =>
      createAcpProvider({
        name: "acp",
        kind: "acp",
        executable: "agent",
        config: { argvBefore: ["x"], argvAfter: [], unexpected: true },
      }),
    /unknown field unexpected/u,
  );
  assert.deepEqual(
    decodeProviderExecution({
      name: "acp",
      kind: "acp",
      executable: "agent",
      config: { argvBefore: ["--prompt"], argvAfter: ["--json"], modelArg: "--model" },
    }),
    {
      name: "acp",
      kind: "acp",
      executable: "agent",
      config: { argvBefore: ["--prompt"], argvAfter: ["--json"], modelArg: "--model" },
    },
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
    | "steer-hung-terminal" = "complete",
): Readonly<{
  executable: string;
  requests(): readonly Readonly<Record<string, unknown>>[];
  requestEnvironment(): Readonly<{ requests: string; literal: string; actor: string }>;
}> {
  const executable = join(root, "codex");
  const log = join(root, "requests.jsonl");
  const environment = join(root, "request-environment.txt");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');",
      "const readline=require('node:readline');",
      `const log=${JSON.stringify(log)};`,
      `fs.writeFileSync(${JSON.stringify(environment)},JSON.stringify({requests:process.env.AKUMA_REQUESTS||'',literal:process.env.SETTINGS_LITERAL||'',actor:process.env.KEIYAKU_ACTOR_ID||''}));`,
      `const mode=${JSON.stringify(mode)};`,
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
      "  if(message.method==='thread/start') return reply(message,{thread:{id:'thread-fresh'}});",
      "  if(message.method==='thread/resume') return reply(message,{thread:{id:message.params.threadId}});",
      "  if(message.method==='thread/fork') return reply(message,{thread:{id:'thread-child'}});",
      "  if(message.method==='turn/start'){",
      "    reply(message,{turn:{id:'turn-1'}});",
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
    requestEnvironment: () => JSON.parse(readFileSync(environment, "utf8")),
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
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
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
      while (pendingInput === undefined) await new Promise((resolve) => setImmediate(resolve));
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
  const drive = await provider.start({
    body: "observe",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "fresh" },
  }).result;
  assert.equal(typeof drive.tell, "function");
  const events = [];
  for await (const event of drive.events) events.push(event);

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
      result: { status: "ok" },
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
  assert.equal(JSON.stringify(events).includes("secret result body"), false);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "assistant-events" });
});

test("Claude adapter admits the native session before returning its answer", async () => {
  const seenOptions: unknown[] = [];
  const provider = createClaudeProvider(async () => ({
    query(input) {
      seenOptions.push(input.options);
      return fakeQuery(
        [
          { type: "system", subtype: "init", session_id: "session-1" } as unknown as SDKMessage,
          {
            type: "assistant",
            uuid: "assistant-history-1",
            session_id: "session-1",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "working" }] },
          } as unknown as SDKMessage,
          {
            type: "result",
            subtype: "success",
            session_id: "session-1",
            uuid: "result-history-1",
            result: "done",
          } as unknown as SDKMessage,
        ],
        input.prompt as AsyncIterable<unknown>,
      );
    },
  }));
  const drive = await provider.start({
    body: "build it",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "fresh" },
  }).result;
  const events = [];
  for await (const event of drive.events) events.push(event);

  assert.deepEqual(events[0], { type: "session", coordinate: { sessionId: "session-1" } });
  assert.ok(events.some((event) => event.type === "assistant" && event.text === "working"));
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "assistant-history-1" });
  assert.deepEqual(seenOptions, [
    {
      cwd: "/work",
      abortController:
        seenOptions.length === 0 ? undefined : (seenOptions[0] as { abortController: unknown }).abortController,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
    },
  ]);
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
  const drive = await provider.start({
    body: "initial",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "fresh" },
  }).result;

  const completion = await Promise.race([
    drive.completion,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Claude completion waited for Query tail")), 500),
    ),
  ]);
  assert.deepEqual(completion, { kind: "answered", answer: "done", historyId: "assistant-before-terminal" });
  const events = [];
  for await (const event of drive.events) events.push(event);
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
  const drive = await provider.start({
    body: "initial",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "fresh" },
  }).result;
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

test("Codex app-server maps admitted options, native session, answer, and exact turn history", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-provider-"));
  try {
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
    assert.deepEqual(provider.admitOptions({ readonly: true }), {
      kind: "admitted",
      options: { readonly: true },
      readonly: { enforcement: "native" },
    });

    const requestDirectory = join(root, "body-requests");
    mkdirSync(requestDirectory);
    const drive = await provider.start({
      body: "build",
      launchTells: [],
      cwd: root,
      options,
      requests: { dir: requestDirectory },
      session: { kind: "fresh" },
    }).result;
    const events = [];
    for await (const event of drive.events) events.push(event);
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
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [root, requestDirectory],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    assert.deepEqual(fake.requestEnvironment(), { requests: requestDirectory, literal: "from-settings", actor: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex maps observations without leaking output or unknown payloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-observations-"));
  try {
    const provider = createCodexAppServerProvider(fakeCodex(root, "observations").executable);
    const drive = await provider.start({
      body: "observe",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "fresh" },
    }).result;
    const events = [];
    for await (const event of drive.events) events.push(event);

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
        result: { status: "ok", exitCode: 0 },
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
    assert.equal(JSON.stringify(events).includes("secret output"), false);
    assert.equal(JSON.stringify(events).includes("must not escape"), false);
    assert.equal(JSON.stringify(events).includes("999"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex drains admitted native completion narration before terminal closure", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-terminal-drain-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "terminal-drain").executable).start({
      body: "drain",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "fresh" },
    }).result;
    let completionSettled = false;
    void drive.completion.then(() => {
      completionSettled = true;
    });
    const events = [];
    for await (const event of drive.events) {
      events.push(event);
      if (event.type === "tool" && event.phase === "completed") assert.equal(completionSettled, false);
    }

    assert.deepEqual(events.slice(1), [
      {
        type: "tool",
        phase: "started",
        id: "command-terminal",
        name: "commandExecution",
        call: { kind: "run", command: "npm test" },
      },
      {
        type: "tool",
        phase: "completed",
        id: "command-terminal",
        name: "commandExecution",
        call: { kind: "run", command: "npm test" },
        result: { status: "ok", exitCode: 0 },
      },
    ]);
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex terminal drain has a bounded fallback for a hung producer", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-terminal-hang-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "terminal-hang").executable).start({
      body: "observe",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "fresh" },
    }).result;
    const started = performance.now();
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
    assert.ok(performance.now() - started < 2_000);
    for await (const _event of drive.events) {
      /* drain */
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex settles when the native process exits without turn completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-exit-before-completion-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "exit-before-completion").executable).start({
      body: "exit",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "fresh" },
    }).result;
    for await (const _event of drive.events) {
      /* drain */
    }
    assert.deepEqual(await drive.completion, {
      kind: "failed",
      diagnostic: "codex app-server exited before completion (7)",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("Codex app-server abort interrupts and releases its owned child", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-abort-"));
  try {
    const fake = fakeCodex(root, "interrupt");
    const provider = createCodexAppServerProvider(fake.executable);
    const drive = await provider.start({
      body: "wait",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "fresh" },
    }).result;
    await drive.abort();
    for await (const _event of drive.events) {
      /* drain */
    }
    assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "codex app-server interrupted" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex terminal closure fails a hung steer acknowledgement without waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-steer-hung-terminal-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "steer-hung-terminal").executable).start({
      body: "work",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "fresh" },
    }).result;
    await assert.rejects(
      drive.tell!({ id: "tell-live-hung", text: "never acknowledged" }),
      /line RPC process is closed/u,
    );
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
