import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as acp from "@agentclientprotocol/sdk";
import {
  AGENT_EVENT_TEXT_LIMIT,
  AgentEventChannel,
  decodeAgentEvent,
  encodeAgentEvent,
  noteEvent,
  type AgentEvent,
  type TurnResult,
} from "../src/akuma/provider.js";
import { decodeReadonlyRestraint } from "../src/akuma/provider-recipe.js";
import {
  CLAUDE_MESSAGE_DISPOSITIONS,
  CLAUDE_SYSTEM_DISPOSITIONS,
  createClaudeProvider,
} from "../src/akuma/providers/claude/index.js";
import { emitClaudeMessage } from "../src/akuma/providers/claude/events.js";
import {
  CODEX_ITEM_DISPOSITIONS,
  CODEX_NOTIFICATION_DISPOSITIONS,
  createCodexAppServerProvider,
} from "../src/akuma/providers/codex-app-server/index.js";
import { codexNotificationResult } from "../src/akuma/providers/codex-app-server/events.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { createEventState, mapEvent } from "../src/akuma/providers/opencode-sdk/events.js";
import type { OpencodeSdkLoader, OpencodeSdkSession } from "../src/akuma/providers/opencode-sdk/session.js";
import { createPiProvider, type PiSdk } from "../src/akuma/providers/pi/index.js";
import { translatePiEvent } from "../src/akuma/providers/pi/events.js";
import { createAcpProvider } from "../src/akuma/providers/acp/index.js";
import { createGrokBuildProvider, interpretGrokTool } from "../src/akuma/providers/grok-build/index.js";
import { resolveProviderExecution } from "../src/akuma/providers/index.js";
import { EMPTY_ACP_EVENT_STATE, mapAcpUpdate } from "../src/akuma/providers/acp/events.js";
import { projectTurns } from "../src/akuma/projection.js";
import type { StdioProcess } from "../src/runtime/proc/stdio.js";

function fakeOpencode() {
  let closed = 0;
  const prompts: unknown[] = [];
  let activeSession = "session-fresh";
  let activeMessage = "msg_unset";
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => { admit = resolve; });
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
    yield { type: "message.updated", properties: { info: { id: activeMessage, sessionID: activeSession, role: "user" } } };
    for (const event of events) {
      yield JSON.parse(JSON.stringify(event).replaceAll("session-fresh", activeSession)) as unknown;
    }
  };
  const session = {
    async create() { activeSession = "session-fresh"; return { data: { id: activeSession } }; },
    async get() { activeSession = "session-resume"; return { data: { id: activeSession } }; },
    async promptAsync(input: unknown) {
      prompts.push(input);
      activeMessage = String((input as { body?: { messageID?: unknown } }).body?.messageID);
      admit();
      return { data: undefined };
    },
    async messages() {
      return { data: [
        { info: { id: activeMessage, sessionID: activeSession, role: "user", time: { created: 1 } }, parts: [] },
        { info: { id: "message-1", sessionID: activeSession, parentID: activeMessage, role: "assistant", time: { created: 2 } }, parts: [
        { id: "part-tool", sessionID: "session-fresh", messageID: "message-1", type: "tool", callID: "tool-1", tool: "shell", state: { status: "completed", input: { command: "npm test" }, output: "ok", title: "test", metadata: {}, time: { start: 1, end: 2 } } },
        { id: "part-thought", sessionID: "session-fresh", messageID: "message-1", type: "reasoning", text: "checked", time: { start: 1, end: 2 } },
        { id: "part-answer", sessionID: "session-fresh", messageID: "message-1", type: "text", text: "answer", time: { start: 1, end: 2 } },
        ] },
      ] };
    },
    async fork() { return { data: { id: "session-child" } }; },
    async abort() { return { data: true }; },
  } as unknown as OpencodeSdkSession;
  const loader: OpencodeSdkLoader = async () => ({
    client: { session, event: { async subscribe() { return { stream: stream() }; } } as never },
    close: () => { closed += 1; },
  });
  return { loader, closed: () => closed, prompts };
}

test("provider answered results may omit an exact fork point", () => {
  const result: TurnResult = { kind: "answered", answer: "complete answer" };
  assert.deepEqual(result, { kind: "answered", answer: "complete answer" });
});

function fakeAcp(root: string, mode: "complete" | "cancel" | "reverse" | "prompt-error" = "complete") {
  const executable = join(root, "fake-acp.mjs");
  const log = join(root, "acp-log.jsonl");
  const sdk = join(process.cwd(), "node_modules/@agentclientprotocol/sdk/dist/acp.js");
  writeFileSync(executable, `
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
`);
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
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function processGone(pid: number): Promise<boolean> {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("ACP uses stable initialization, fresh sessions, mapped profile arguments, and one prompt response", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-acp-provider-"));
  try {
    const fake = fakeAcp(root);
    const provider = createAcpProvider(fake.execution);
    assert.deepEqual(provider.confinement({ cwd: root, options: {} }), { kind: "unconfined" });
    assert.deepEqual(provider.admitOptions({ readonly: true }), {
      kind: "admitted",
      options: { readonly: true },
      readonly: { enforcement: "none", diagnostic: "ACP cannot remove task-surface mutation capabilities" },
    });
    assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
    const drive = await provider.start({
      body: "build", launchTells: [{ id: "tell-1", text: "then test" }], cwd: root,
      options: { model: "grok-4", effort: "high", systemPrompt: "Be precise." }, session: { kind: "fresh" },
    });
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete answer" });
    assert.deepEqual(events, [
      { type: "session", coordinate: { sessionId: "fresh-session" } },
      { type: "assistant", text: "complete answer" },
      { type: "thought", text: "checked" },
      { type: "tool", phase: "started", id: "tool-1", name: "Run tests", call: { kind: "other", display: "Run tests" } },
      { type: "tool", phase: "completed", id: "tool-1", name: "Run tests", call: { kind: "other", display: "Run tests" }, result: { status: "ok" } },
      { type: "note", text: "Plan updated: Verify" },
      { type: "note", text: "ACP configuration updated" },
    ]);
    const records = acpLog(fake.log);
    assert.deepEqual(records.map((record) => record.kind), ["initialize", "new", "prompt"]);
    assert.deepEqual((records[2]!.params as { prompt: unknown }).prompt, [
      { type: "text", text: "build" },
      { type: "text", text: "then test" },
    ]);
    assert.deepEqual((records[2]!.argv as readonly string[]).slice(-7), ["--model", "grok-4", "--effort", "high", "--system-prompt", "Be precise.", "stdio"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ACP exposes no client-side coding capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-acp-reverse-"));
  try {
    const fake = fakeAcp(root, "reverse");
    const drive = await createAcpProvider(fake.execution).start({
      body: "build", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete answer" });
    const records = acpLog(fake.log);
    const refused = records.filter((record) => record.refusal !== undefined);
    assert.deepEqual(refused.map((record) => [record.kind, (record.refusal as { code: number }).code]), [
      ["permission", -32601],
      ["fs-read", -32601],
      ["fs-write", -32601],
      ["terminal-create", -32601],
      ["terminal-output", -32601],
      ["terminal-release", -32601],
      ["terminal-wait", -32601],
      ["terminal-kill", -32601],
      ["elicitation", -32601],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ACP preserves native request error code and data", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-acp-error-"));
  try {
    const fake = fakeAcp(root, "prompt-error");
    const drive = await createAcpProvider(fake.execution).start({
      body: "build", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "Internal error [-32603]: native detail" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ACP load retains the exact session ID without a fork or live tell capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-acp-resume-"));
  try {
    const fake = fakeAcp(root);
    const provider = createAcpProvider(fake.execution);
    assert.equal(provider.fork, undefined);
    const drive = await provider.resume!({
      body: "continue", launchTells: [], cwd: root, options: {}, session: { kind: "resume", coordinate: { sessionId: "retained-session" } },
    });
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(events[0], { type: "session", coordinate: { sessionId: "retained-session" } });
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete answer" });
    const load = acpLog(fake.log).find((record) => record.kind === "load")!;
    assert.equal((load.params as { sessionId: string }).sessionId, "retained-session");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ACP cancellation closes its owned process tree after standard session/cancel", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-acp-cancel-"));
  try {
    const fake = fakeAcp(root, "cancel");
    const drive = await createAcpProvider(fake.execution).start({
      body: "wait", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    await drive.abort();
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(events, [{ type: "session", coordinate: { sessionId: "fresh-session" } }]);
    assert.equal((await drive.completion).kind, "failed");
    const descendant = acpLog(fake.log).find((record) => record.kind === "descendant")!;
    assert.equal(await processGone(descendant.pid as number), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

type ControlledInterject = Readonly<{
  sessionId: string;
  text: string;
  interjectionId: string;
}>;

function controlledAcpProcess(options: Readonly<{
  stallInitialize?: boolean;
  stallPrompt?: boolean;
  assistant?: string;
  interject?: "queued" | "rejected" | "pending";
}> = {}): Readonly<{
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
}> {
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  let startCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => { startCleanup = resolve; });
  let resolveCleanup!: () => void;
  let rejectCleanup!: (error: Error) => void;
  let forcedCleanup = 0;
  let startInitialize!: () => void;
  const initializeStarted = new Promise<void>((resolve) => { startInitialize = resolve; });
  let finishPrompt!: () => void;
  const prompt = new Promise<void>((resolve) => { finishPrompt = resolve; });
  let finishInterject!: () => void;
  const interject = new Promise<void>((resolve) => { finishInterject = resolve; });
  let startInterject!: () => void;
  const interjectStarted = new Promise<void>((resolve) => { startInterject = resolve; });
  const interjections: ControlledInterject[] = [];
  let cancelled = 0;
  let emitAssistant!: (text: string) => Promise<void>;
  const cleanup = new Promise<void>((resolve, reject) => {
    resolveCleanup = resolve;
    rejectCleanup = reject;
  });
  const app = acp.agent({ name: "controlled-acp" })
    .onRequest(acp.methods.agent.initialize, async ({ params }) => {
      startInitialize();
      if (options.stallInitialize === true) await new Promise(() => undefined);
      return { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true } };
    })
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "controlled-session" }))
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      emitAssistant = async (text) => await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      if (options.assistant !== undefined) await emitAssistant(options.assistant);
      if (options.stallPrompt === true) await prompt;
      return { stopReason: "end_turn" };
    })
    .onNotification(acp.methods.agent.session.cancel, () => { cancelled += 1; });
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
  app.connect(acp.ndJsonStream(
      Writable.toWeb(outbound) as WritableStream<Uint8Array>,
      Readable.toWeb(inbound) as ReadableStream<Uint8Array>,
    ));
  return {
    process: {
      input: inbound,
      output: outbound,
      exited: new Promise(() => undefined),
      endInputAndDrain: async () => {
        startCleanup();
        await cleanup;
      },
      close: async (force) => {
        if (force) {
          forcedCleanup += 1;
          resolveCleanup();
        }
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

test("an ACP execution named grok-build remains standard ACP without live tell", async () => {
  const controlled = controlledAcpProcess();
  const drive = await createAcpProvider({
    ...controlledAcpExecution,
    name: "grok-build",
  }, { spawnProcess: () => controlled.process }).start({
    body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
  });
  assert.equal(drive.tell, undefined);
  await controlled.cleanupStarted;
  controlled.resolveCleanup();
  await drive.completion;
});

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
    body: "build", launchTells: [], cwd: "/tmp", options: { model: "grok-4.6", effort: "high" }, session: { kind: "fresh" },
  });
  assert.equal(drive.receipts, undefined);
  assert.ok(drive.tell);
  assert.deepEqual(await drive.tell({ id: "tell-123", text: "change direction" }), {
    kind: "accepted",
    fence: "tell-123",
  });
  assert.deepEqual(controlled.interjections, [{
    sessionId: "controlled-session",
    text: "change direction",
    interjectionId: "tell-123",
  }]);
  assert.deepEqual(spawned, [
    "grok", "agent", "--always-approve", "--model", "grok-4.6",
    "--reasoning-effort", "high", "stdio",
  ]);
  controlled.resolvePrompt();
  await controlled.cleanupStarted;
  controlled.resolveCleanup();
  await drive.completion;
});

test("Grok Build rejects failed and unknown interject requests without admission", async () => {
  for (const interject of ["rejected", undefined] as const) {
    const controlled = controlledAcpProcess({ stallPrompt: true, ...(interject === undefined ? {} : { interject }) });
    const drive = await createGrokBuildProvider(controlledGrokExecution, {
      spawnProcess: () => controlled.process,
    }).start({
      body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
    });
    await assert.rejects(drive.tell!({ id: "tell-failed", text: "steer" }),
      interject === undefined ? /Method not found/u : /interject rejected/u);
    await drive.abort();
    assert.equal(controlled.cancelled(), 1);
    assert.equal(controlled.forcedCleanup(), 1);
  }
});

test("Grok Build returns turn-ended when completion wins before interject acknowledgement", async () => {
  const controlled = controlledAcpProcess({ stallPrompt: true, interject: "pending" });
  const drive = await createGrokBuildProvider(controlledGrokExecution, {
    spawnProcess: () => controlled.process,
  }).start({
    body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
  });
  const submission = drive.tell!({ id: "tell-late", text: "too late" });
  await controlled.interjectStarted;
  controlled.resolvePrompt();
  await controlled.cleanupStarted;
  controlled.resolveInterject();
  assert.deepEqual(await submission, { kind: "turn-ended" });
  controlled.resolveCleanup();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "" });
});

test("Grok Build abort uses standard ACP cancellation and closes owned process custody", async () => {
  const controlled = controlledAcpProcess({ stallPrompt: true, interject: "queued" });
  const drive = await createGrokBuildProvider(controlledGrokExecution, {
    spawnProcess: () => controlled.process,
  }).start({
    body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
  });
  await drive.abort();
  assert.equal(controlled.cancelled(), 1);
  assert.equal(controlled.forcedCleanup(), 1);
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "ACP turn cancelled" });
});

test("ACP completion waits for owned process cleanup", async () => {
  const controlled = controlledAcpProcess();
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
  });
  let completed = false;
  void drive.completion.then(() => { completed = true; });
  await controlled.cleanupStarted;
  assert.equal(completed, false);
  controlled.resolveCleanup();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "" });
});

test("ACP cleanup failure settles a typed failed Turn", async () => {
  const controlled = controlledAcpProcess();
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
  });
  await controlled.cleanupStarted;
  controlled.rejectCleanup(new Error("drain failed"));
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "ACP cleanup failed: drain failed" });
});

test("ACP abort upgrades an in-flight graceful drain to forced cleanup", async () => {
  const controlled = controlledAcpProcess();
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
  });
  await controlled.cleanupStarted;
  await drive.abort();
  assert.equal(controlled.forcedCleanup(), 1);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "" });
});

test("ACP setup abort closes a child stalled during initialization", async () => {
  const controlled = controlledAcpProcess({ stallInitialize: true });
  const controller = new AbortController();
  const setup = createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" }, signal: controller.signal,
  });
  await controlled.initializeStarted;
  controller.abort(new Error("controlled setup cancellation"));
  await assert.rejects(setup, /controlled setup cancellation/);
  assert.equal(controlled.forcedCleanup(), 1);
});

test("ACP ignores assistant updates after terminal prompt evidence", async () => {
  const controlled = controlledAcpProcess({ assistant: "before" });
  const drive = await createAcpProvider(controlledAcpExecution, { spawnProcess: () => controlled.process }).start({
    body: "build", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
  });
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
  const previous = { ...EMPTY_ACP_EVENT_STATE, answer: "retained", open: { type: "assistant" as const, text: "partial" } };
  const mapped = mapAcpUpdate({ sessionUpdate: "future_update" } as never, previous);
  assert.deepEqual(mapped, {
    events: [{ type: "unknown", kind: "future_update" }],
    state: previous,
  });
});

test("ACP mapper returns the final identified assistant message as the answer", () => {
  const progress = mapAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "progress",
    content: { type: "text", text: "I will inspect the repository." },
  }, EMPTY_ACP_EVENT_STATE);
  const finalStart = mapAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "final",
    content: { type: "text", text: "The audit " },
  }, progress.state);
  const finalEnd = mapAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "final",
    content: { type: "text", text: "passed." },
  }, finalStart.state);

  assert.deepEqual(finalStart.events, [{ type: "assistant", text: "I will inspect the repository." }]);
  assert.equal(finalEnd.state.answer, "The audit passed.");
});

test("ACP mapper treats unidentified v1 assistant chunks as one message", () => {
  const first = mapAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "complete " },
  }, EMPTY_ACP_EVENT_STATE);
  const second = mapAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "answer" },
  }, first.state);

  assert.equal(second.state.answer, "complete answer");
});

test("ACP mapper collapses tool progress into one lifecycle per stable id", () => {
  const updates = [
    { sessionUpdate: "tool_call", toolCallId: "tool-a", title: "read_file", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-a", title: "Read `/tmp/a`", status: "in_progress" },
    { sessionUpdate: "tool_call", toolCallId: "tool-b", title: "run_terminal_command", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-b", title: "Execute `npm test`", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-a", status: "completed" },
    { sessionUpdate: "tool_call_update", toolCallId: "tool-b", status: "failed" },
    { sessionUpdate: "tool_call", toolCallId: "tool-a", title: "read_file", status: "in_progress" },
  ] as const;
  let state = EMPTY_ACP_EVENT_STATE;
  const events: AgentEvent[] = [];
  for (const update of updates) {
    const mapped = mapAcpUpdate(update, state);
    events.push(...mapped.events);
    state = mapped.state;
  }

  assert.deepEqual(events, [
    { type: "tool", phase: "started", id: "tool-a", name: "read_file", call: { kind: "other", display: "read_file" } },
    { type: "tool", phase: "started", id: "tool-b", name: "run_terminal_command", call: { kind: "other", display: "run_terminal_command" } },
    { type: "tool", phase: "completed", id: "tool-a", name: "Read `/tmp/a`", call: { kind: "other", display: "Read `/tmp/a`" }, result: { status: "ok" } },
    { type: "tool", phase: "completed", id: "tool-b", name: "Execute `npm test`", call: { kind: "other", display: "Execute `npm test`" }, result: { status: "error" } },
    { type: "tool", phase: "started", id: "tool-a", name: "read_file", call: { kind: "other", display: "read_file" } },
  ]);

  const ledger = projectTurns([
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: "2026-08-15T00:00:00.000Z" },
    ...events.map((event, index) => ({
      kind: "activity" as const,
      sequence: index + 2,
      turnSequence: 1,
      at: `2026-08-15T00:00:0${index + 1}.000Z`,
      event,
    })),
  ]);
  assert.deepEqual(ledger.openTurn?.rows.map((row) => row.kind === "tool" ? [row.name, row.state] : row.kind), [
    ["Read `/tmp/a`", { status: "ok" }],
    ["Execute `npm test`", { status: "error" }],
    ["read_file", "active"],
  ]);
});

test("ACP tool progress retains narration boundaries without another start", () => {
  const started = mapAcpUpdate({
    sessionUpdate: "tool_call", toolCallId: "tool-a", title: "read_file", status: "in_progress",
  }, EMPTY_ACP_EVENT_STATE);
  const first = mapAcpUpdate({
    sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "first block" },
  }, started.state);
  const progress = mapAcpUpdate({
    sessionUpdate: "tool_call_update", toolCallId: "tool-a", title: "Read `/tmp/a`", status: "in_progress",
  }, first.state);
  const second = mapAcpUpdate({
    sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "second block" },
  }, progress.state);
  const completed = mapAcpUpdate({
    sessionUpdate: "tool_call_update", toolCallId: "tool-a", status: "completed",
  }, second.state);

  assert.deepEqual(progress.events, [{ type: "thought", text: "first block" }]);
  assert.deepEqual(completed.events, [
    { type: "thought", text: "second block" },
    { type: "tool", phase: "completed", id: "tool-a", name: "Read `/tmp/a`", call: { kind: "other", display: "Read `/tmp/a`" }, result: { status: "ok" } },
  ]);
});

function mapAcpSeries(
  updates: readonly Parameters<typeof mapAcpUpdate>[0][],
  interpret?: Parameters<typeof mapAcpUpdate>[2],
): readonly AgentEvent[] {
  let state = EMPTY_ACP_EVENT_STATE;
  const events: AgentEvent[] = [];
  for (const update of updates) {
    const mapped = mapAcpUpdate(update, state, interpret);
    events.push(...mapped.events);
    state = mapped.state;
  }
  return events;
}

test("Grok maps only payloads backed by pinned emitters", () => {
  type GrokUpdate = Parameters<typeof interpretGrokTool>[0];
  const cases: readonly Readonly<{ update: GrokUpdate; call: ReturnType<typeof interpretGrokTool> }>[] = [
    {
      // reference/grok-build@eb267feff13129e568df38fb6fdf0ceb65f735d6
      // grok_build/read_file/mod.rs:117
      update: { sessionUpdate: "tool_call", toolCallId: "read", name: "read_file", rawInput: { target_file: "src/a.ts" } },
      call: { kind: "read", path: "src/a.ts" },
    },
    {
      // Captured Grok Build 1.0.3 transcript: byte offset 105746100, length 2200.
      update: { sessionUpdate: "tool_call", toolCallId: "captured-read", toolName: "read_file", rawInput: { path: "src/main.rs" } } as GrokUpdate,
      call: { kind: "read", path: "src/main.rs" },
    },
    {
      // reference/grok-build@eb267feff13129e568df38fb6fdf0ceb65f735d6
      // grok_build_hashline/read_file.rs:108
      update: { sessionUpdate: "tool_call", toolCallId: "hash-read", name: "hashline_read", rawInput: { target_file: "src/b.ts" } },
      call: { kind: "read", path: "src/b.ts" },
    },
    {
      // reference/grok-build@eb267feff13129e568df38fb6fdf0ceb65f735d6
      // grok_build/grep/mod.rs:48
      update: { sessionUpdate: "tool_call", toolCallId: "grep", name: "grep", rawInput: { pattern: "TODO", path: "src", glob: "*.ts" } },
      call: { kind: "search", query: "TODO", scope: "content", path: "src", glob: "*.ts" },
    },
    {
      // reference/grok-build@eb267feff13129e568df38fb6fdf0ceb65f735d6
      // grok_build_hashline/grep.rs:163
      update: { sessionUpdate: "tool_call", toolCallId: "hash-grep", name: "hashline_grep", rawInput: { pattern: "FIXME" } },
      call: { kind: "search", query: "FIXME", scope: "content" },
    },
    {
      // reference/grok-build@eb267feff13129e568df38fb6fdf0ceb65f735d6
      // grok_build/bash/mod.rs:261
      update: { sessionUpdate: "tool_call", toolCallId: "run", name: "run_terminal_cmd", rawInput: { command: "npm test" } },
      call: { kind: "run", command: "npm test" },
    },
    {
      // reference/grok-build@eb267feff13129e568df38fb6fdf0ceb65f735d6
      // grok_build/web_search/mod.rs:17
      update: { sessionUpdate: "tool_call", toolCallId: "web", name: "web_search", rawInput: { query: "Keiyaku" } },
      call: { kind: "search", query: "Keiyaku", scope: "web" },
    },
    {
      // reference/grok-build@eb267feff13129e568df38fb6fdf0ceb65f735d6
      // grok_build/search_replace/mod.rs:74
      update: { sessionUpdate: "tool_call", toolCallId: "edit", name: "search_replace", rawInput: { file_path: "src/a.ts" } },
      call: { kind: "fileChange", changes: [{ op: "unspecified", path: "src/a.ts" }] },
    },
  ];
  for (const { update, call } of cases) assert.deepEqual(interpretGrokTool(update), call);
  assert.equal(interpretGrokTool({
    sessionUpdate: "tool_call",
    toolCallId: "future",
    name: "future_tool",
    rawInput: { path: "src/unknown.ts" },
  }), undefined);
});

test("Grok evidence-backed calls survive sparse completion without duplicate lifecycle rows", () => {
  const events = mapAcpSeries([
    {
      sessionUpdate: "tool_call",
      toolCallId: "replace-1",
      title: "Search and replace",
      name: "search_replace",
      kind: "edit",
      status: "in_progress",
      rawInput: { file_path: "src/a.ts" },
    },
    { sessionUpdate: "tool_call_update", toolCallId: "replace-1", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "replace-1", status: "completed" },
    {
      sessionUpdate: "tool_call",
      toolCallId: "future-1",
      title: "Future tool",
      name: "future_tool",
      status: "in_progress",
      rawInput: { path: "src/unknown.ts" },
    },
    { sessionUpdate: "tool_call_update", toolCallId: "future-1", status: "completed" },
  ], interpretGrokTool);
  assert.deepEqual(events, [
    {
      type: "tool",
      phase: "started",
      id: "replace-1",
      name: "search_replace",
      call: { kind: "fileChange", changes: [{ op: "unspecified", path: "src/a.ts" }] },
    },
    {
      type: "tool",
      phase: "completed",
      id: "replace-1",
      name: "search_replace",
      call: { kind: "fileChange", changes: [{ op: "unspecified", path: "src/a.ts" }] },
      result: { status: "ok" },
    },
    {
      type: "tool",
      phase: "started",
      id: "future-1",
      name: "future_tool",
      call: { kind: "other", display: "future_tool" },
    },
    {
      type: "tool",
      phase: "completed",
      id: "future-1",
      name: "future_tool",
      call: { kind: "other", display: "future_tool" },
      result: { status: "ok" },
    },
  ]);
  for (const event of events) assert.deepEqual(decodeAgentEvent(encodeAgentEvent(event)), event);
});

function fakePiSdk(input: {
  events?: readonly Record<string, unknown>[];
  fail?: Error;
  historyId?: string | null;
  waitForAbort?: boolean;
  promptNeverSettles?: boolean;
  abortNeverSettles?: boolean;
} = {}): {
  sdk: PiSdk;
  seen: { options?: Record<string, unknown>; opened?: string; branched?: string; aborted: number; disposed: number };
} {
  const seen = { aborted: 0, disposed: 0 } as {
    options?: Record<string, unknown>;
    opened?: string;
    branched?: string;
    aborted: number;
    disposed: number;
  };
  const manager = {
    getLeafId: () => input.historyId === undefined ? "entry-final" : input.historyId,
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
      return () => { this.listener = undefined; };
    },
    listener: undefined as ((event: Record<string, unknown>) => void) | undefined,
    async prompt() {
      if (input.fail !== undefined) throw input.fail;
      if (input.promptNeverSettles === true) await new Promise<void>(() => undefined);
      if (input.waitForAbort === true) await new Promise<void>((resolve) => { this.resolveAbort = resolve; });
      for (const event of input.events ?? []) this.listener?.(event);
    },
    resolveAbort: undefined as (() => void) | undefined,
    async abort() {
      seen.aborted += 1;
      if (input.abortNeverSettles === true) await new Promise<void>(() => undefined);
      this.resolveAbort?.();
    },
    dispose() { seen.disposed += 1; },
  };
  class ResourceLoader { async reload() {} }
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
  const drive = await provider.start({ body: "build", launchTells: [{ id: "tell-1", text: "also check" }], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  assert.equal(drive.admission.fence, "session-fresh");
  const observed = [];
  for await (const event of drive.events) observed.push(event);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "answer", historyId: "message-1" });
  assert.deepEqual(observed.map((event) => event.type), ["session", "tool", "tool", "thought", "assistant", "unknown"]);
  assert.equal(JSON.stringify(observed).includes("secret"), false);
  assert.equal(fake.closed(), 1);
});

test("OpenCode V1 start waits for native prompt admission", async () => {
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => { admit = resolve; });
  const session = {
    async create() { return { data: { id: "session-admission" } }; },
    async promptAsync() { await admitted; return { data: undefined }; },
    async abort() { return { data: true }; },
  } as unknown as OpencodeSdkSession;
  let closeStream!: () => void;
  const streamClosed = new Promise<void>((resolve) => { closeStream = resolve; });
  const provider = createOpencodeProvider({ loader: async () => ({
    client: { session, event: { async subscribe() { return { stream: (async function* () { await streamClosed; })() }; } } as never },
    close: () => { closeStream(); },
  }) });
  let returned = false;
  const starting = provider.start({ body: "wait", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } })
    .then((drive) => { returned = true; return drive; });
  await Promise.resolve();
  assert.equal(returned, false);
  admit();
  const drive = await starting;
  await drive.abort();
});

test("OpenCode V1 adapter resumes the supplied coordinate and forks the exact point", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  const drive = await provider.resume!({ body: "continue", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "resume", coordinate: { sessionId: "session-resume" } } });
  assert.equal((await drive.completion).kind, "answered");
  assert.deepEqual(await provider.fork!({ session: { sessionId: "session-resume" }, at: "message-1", cwd: "/tmp" }), { session: { sessionId: "session-child" } });
});

test("OpenCode V1 refuses a Pi coordinate before loading its native runtime", async () => {
  let loaded = false;
  const provider = createOpencodeProvider({ loader: async () => {
    loaded = true;
    throw new Error("must not load");
  } });
  await assert.rejects(provider.resume!({
    body: "continue",
    launchTells: [],
    cwd: "/tmp",
    options: {},
    session: { kind: "resume", coordinate: { sessionFile: "/sessions/pi.jsonl" } },
  }), /OpenCode resume requires sessionId/u);
  await assert.rejects(
    provider.fork!({ session: { sessionFile: "/sessions/pi.jsonl" }, at: "message-1", cwd: "/tmp" }),
    /OpenCode resume requires sessionId/u,
  );
  assert.equal(loaded, false);
});

test("OpenCode V1 abort cleanup does not await an uncooperative native abort", async () => {
  let closed = 0;
  let closeStream!: () => void;
  const streamClosed = new Promise<void>((resolve) => { closeStream = resolve; });
  const session = {
    async create() { return { data: { id: "session-stuck-abort" } }; },
    async promptAsync() { return { data: undefined }; },
    async abort() { await new Promise<void>(() => undefined); },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { session, event: { async subscribe() { return { stream: (async function* () { await streamClosed; })() }; } } as never }, close: () => { closed += 1; closeStream(); } }) });
  const drive = await provider.start({ body: "interrupt", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  await drive.abort();
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "OpenCode session interrupted" });
  assert.equal(closed, 1);
});

test("OpenCode abort releases native custody without waiting for its event iterator", async () => {
  const session = {
    async create() { return { data: { id: "session-stuck-stream" } }; },
    async promptAsync() { return { data: undefined }; },
    async abort() { return { data: true }; },
  } as unknown as OpencodeSdkSession;
  const iterator = {
    next: async () => await new Promise<IteratorResult<unknown>>(() => undefined),
    return: async () => await new Promise<IteratorResult<unknown>>(() => undefined),
  };
  const provider = createOpencodeProvider({ loader: async () => ({
    client: { session, event: { async subscribe() { return { stream: { [Symbol.asyncIterator]: () => iterator } }; } } as never },
    close() {},
  }) });
  const drive = await provider.start({
    body: "interrupt", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" },
  });
  await drive.abort();
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "OpenCode session interrupted" });
});

test("OpenCode V1 rejects failed prompt admission and cleans up", async () => {
  let closed = 0;
  const session = {
    async create() { return { data: { id: "session-rejected" } }; },
    async promptAsync() { throw new Error("prompt rejected"); },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { session, event: { async subscribe() {
    return { stream: (async function* () {
      yield { type: "session.status", properties: { sessionID: "session-empty", status: { type: "busy" } } };
      yield { type: "session.status", properties: { sessionID: "session-empty", status: { type: "idle" } } };
    })() };
  } } as never }, close: () => { closed += 1; } }) });
  await assert.rejects(provider.start({ body: "fail", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } }), /prompt rejected/u);
  assert.equal(closed, 1);
});

test("OpenCode V1 admits native prompt options and maps archetype effort to a model variant", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  assert.equal(provider.admitOptions({ systemPrompt: "must enforce" }).kind, "admitted");
  assert.equal(provider.admitOptions({ effort: "high" }).kind, "admitted");
  assert.equal(provider.admitOptions({ model: "not-a-provider-model" }).kind, "refused");
  assert.equal(provider.admitOptions({ model: "provider/model" }).kind, "admitted");
  assert.deepEqual(provider.admitOptions({ readonly: true }), {
    kind: "admitted",
    options: { readonly: true },
    readonly: { enforcement: "none", diagnostic: "OpenCode V1 cannot remove task-surface mutation capabilities" },
  });
  const drive = await provider.resume!({ body: "continue", launchTells: [], cwd: "/tmp", options: { model: "provider/model", effort: "high", systemPrompt: "must enforce" }, session: { kind: "resume", coordinate: { sessionId: "session-resume" } } });
  assert.equal((await drive.completion).kind, "answered");
  const prompt = fake.prompts[0] as { body: { messageID: string } };
  assert.match(prompt.body.messageID, /^msg_[0-9a-f]{32}$/u);
  assert.deepEqual(prompt, {
    path: { id: "session-resume" },
    query: { directory: "/tmp" },
    body: { messageID: prompt.body.messageID, model: { providerID: "provider", modelID: "model" }, variant: "high", system: "must enforce", parts: [{ type: "text", text: "continue" }] },
    throwOnError: true,
  });
});

test("OpenCode V1 event translation drops known control events and retains a future fallback", () => {
  const observed: AgentEvent[] = [];
  const emitter = { emit(event: AgentEvent) { observed.push(event); } };
  mapEvent({ type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } }, emitter, createEventState());
  mapEvent({ type: "session.future", properties: {} }, emitter, createEventState());
  assert.deepEqual(observed, [{ type: "unknown", kind: "session.future" }]);
  const scoped = createEventState("session-1");
  mapEvent({ type: "message.updated", properties: { info: { sessionID: "other", role: "assistant", error: { message: "wrong session" } } } }, emitter, scoped);
  assert.equal(scoped.failure, undefined);
});

test("OpenCode V1 fails terminal observation without native assistant evidence", async () => {
  let closed = 0;
  let messageID = "msg_unset";
  let prompt!: () => void;
  const prompted = new Promise<void>((resolve) => { prompt = resolve; });
  const session = {
    async create() { return { data: { id: "session-empty" } }; },
    async promptAsync(input: unknown) {
      messageID = String((input as { body?: { messageID?: unknown } }).body?.messageID);
      prompt();
      return { data: undefined };
    },
    async messages() {
      return { data: [{ info: { id: messageID, sessionID: "session-empty", role: "user", time: { created: 1 } }, parts: [] }] };
    },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { session, event: { async subscribe() {
    return { stream: (async function* () {
      await prompted;
      yield { type: "message.updated", properties: { info: { id: messageID, sessionID: "session-empty", role: "user" } } };
      yield { type: "session.status", properties: { sessionID: "session-empty", status: { type: "busy" } } };
      yield { type: "session.status", properties: { sessionID: "session-empty", status: { type: "idle" } } };
    })() };
  } } as never }, close: () => { closed += 1; } }) });
  const drive = await provider.start({ body: "idle", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "OpenCode completed without a native assistant answer" });
  assert.equal(closed, 1);
});

test("OpenCode V1 keeps an assistant answer without a usable message ID", async () => {
  let messageID = "msg_unset";
  let prompt!: () => void;
  const prompted = new Promise<void>((resolve) => { prompt = resolve; });
  const session = {
    async create() { return { data: { id: "session-no-point" } }; },
    async promptAsync(input: unknown) {
      messageID = String((input as { body?: { messageID?: unknown } }).body?.messageID);
      prompt();
      return { data: undefined };
    },
    async messages() {
      return {
        data: [
          { info: { id: messageID, sessionID: "session-no-point", role: "user", time: { created: 1 } }, parts: [] },
          { info: { id: "", parentID: messageID, sessionID: "session-no-point", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "complete" }] },
        ],
      };
    },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { session, event: { async subscribe() {
    return { stream: (async function* () {
      await prompted;
      yield { type: "message.updated", properties: { info: { id: messageID, sessionID: "session-no-point", role: "user" } } };
      yield { type: "session.status", properties: { sessionID: "session-no-point", status: { type: "busy" } } };
      yield { type: "session.status", properties: { sessionID: "session-no-point", status: { type: "idle" } } };
    })() };
  } } as never }, close() {} }) });
  const drive = await provider.start({ body: "answer", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "complete" });
});

test("OpenCode V1 ignores a prior terminal pair before this prompt is admitted", async () => {
  let admit!: () => void;
  let finish!: () => void;
  let messageID = "msg_unset";
  const admitted = new Promise<void>((resolve) => { admit = resolve; });
  const terminal = new Promise<void>((resolve) => { finish = resolve; });
  const session = {
    async create() { return { data: { id: "session-race" } }; },
    async promptAsync(input: unknown) {
      messageID = String((input as { body?: { messageID?: unknown } }).body?.messageID);
      await admitted;
      return { data: undefined };
    },
    async messages() {
      return { data: [
        { info: { id: messageID, sessionID: "session-race", role: "user", time: { created: 2 } }, parts: [] },
        { info: { id: "assistant-race", sessionID: "session-race", parentID: messageID, role: "assistant", time: { created: 3 } }, parts: [
          { id: "answer-race", sessionID: "session-race", messageID: "assistant-race", type: "text", text: "current", time: { start: 2, end: 3 } },
        ] },
      ] };
    },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { session, event: { async subscribe() {
    return { stream: (async function* () {
      yield { type: "session.status", properties: { sessionID: "session-race", status: { type: "busy" } } };
      yield { type: "session.status", properties: { sessionID: "session-race", status: { type: "idle" } } };
      await admitted;
      yield { type: "message.updated", properties: { info: { id: messageID, sessionID: "session-race", role: "user" } } };
      yield { type: "session.status", properties: { sessionID: "session-race", status: { type: "busy" } } };
      await terminal;
      yield { type: "session.status", properties: { sessionID: "session-race", status: { type: "idle" } } };
    })() };
  } } as never } }) });
  let returned = false;
  const starting = provider.start({ body: "current", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } })
    .then((drive) => { returned = true; return drive; });
  await Promise.resolve();
  assert.equal(returned, false);
  admit();
  const drive = await starting;
  let completed = false;
  void drive.completion.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  finish();
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "current", historyId: "assistant-race" });
  const observed = [];
  for await (const event of drive.events) observed.push(event);
  assert.deepEqual(observed.map((event) => event.type), ["session"]);
});

test("OpenCode V1 isolates other sessions and accepts the current Turn error", async () => {
  let messageID = "msg_unset";
  let prompt!: () => void;
  const prompted = new Promise<void>((resolve) => { prompt = resolve; });
  const session = {
    async create() { return { data: { id: "session-error" } }; },
    async promptAsync(input: unknown) {
      messageID = String((input as { body?: { messageID?: unknown } }).body?.messageID);
      prompt();
      return { data: undefined };
    },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { session, event: { async subscribe() {
    return { stream: (async function* () {
      await prompted;
      yield { type: "message.updated", properties: { info: { id: messageID, sessionID: "session-error", role: "user" } } };
      yield { type: "session.status", properties: { sessionID: "session-other", status: { type: "busy" } } };
      yield { type: "session.status", properties: { sessionID: "session-other", status: { type: "idle" } } };
      yield { type: "session.error", properties: { sessionID: "session-error", error: { message: "native failed" } } };
    })() };
  } } as never } }) });
  const drive = await provider.start({ body: "fail", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "native failed" });
});

test("OpenCode V1 retains a setup error emitted before the user identity", async () => {
  let begin!: () => void;
  let admit!: () => void;
  const begun = new Promise<void>((resolve) => { begin = resolve; });
  const admitted = new Promise<void>((resolve) => { admit = resolve; });
  const session = {
    async create() { return { data: { id: "session-setup-error" } }; },
    async promptAsync() { begin(); await admitted; return { data: undefined }; },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { session, event: { async subscribe() {
    return { stream: (async function* () {
      await begun;
      yield { type: "session.error", properties: { sessionID: "session-setup-error", error: { message: "setup failed" } } };
    })() };
  } } as never } }) });
  const starting = provider.start({ body: "fail", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  await begun;
  await Promise.resolve();
  admit();
  const drive = await starting;
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "setup failed" });
});

test("Pi adapter maps completed native evidence and disposes after answer", async () => {
  const fake = fakePiSdk({ events: [
    { type: "message_update", secret: "delta" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "consider" }, { type: "text", text: "done" }] } },
    { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "npm test" } },
    { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", partialResult: { secret: true } },
    { type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { secret: true }, isError: false },
    { type: "future_event", secret: "hidden" },
  ] });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const drive = await provider.start({
    body: "work",
    launchTells: [{ id: "tell-1", text: "also" }],
    cwd: "/work",
    options: {},
    session: { kind: "fresh" },
  });
  assert.equal(drive.tell, undefined);
  const events = [];
  for await (const event of drive.events) events.push(event);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "thought", text: "consider" },
    { type: "assistant", text: "done" },
    { type: "tool", phase: "started", id: "tool-1", name: "bash", call: { kind: "run", command: "npm test" } },
    { type: "tool", phase: "completed", id: "tool-1", name: "bash", call: { kind: "run", command: "npm test" }, result: { status: "ok" } },
    { type: "unknown", kind: "future_event" },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "entry-final" });
  assert.equal(fake.seen.disposed, 1);
});

test("Pi keeps a completed answer when no exact fork point exists", async () => {
  const fake = fakePiSdk({
    historyId: null,
    events: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }],
  });
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start({
    body: "work", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done" });
});

test("Pi rejects wrong coordinates before loading its native SDK", async () => {
  let loaded = false;
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => {
    loaded = true;
    throw new Error("must not load");
  });
  await assert.rejects(provider.resume!({
    body: "bad", launchTells: [], cwd: "/work", options: {},
    session: { kind: "resume", coordinate: { sessionId: "wrong" } },
  }), /requires sessionFile/u);
  await assert.rejects(provider.fork!({ session: { sessionId: "wrong" }, at: "entry", cwd: "/work" }), /requires sessionFile/u);
  assert.equal(loaded, false);
});

test("Pi adapter disposes once on failure and repeated abort", async () => {
  const failed = fakePiSdk({ fail: new Error("native failure") });
  const failedDrive = await createPiProvider({ name: "pi", kind: "pi" }, async () => failed.sdk).start({
    body: "fail", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  for await (const _event of failedDrive.events) { /* drain */ }
  assert.deepEqual(await failedDrive.completion, { kind: "failed", diagnostic: "native failure" });
  assert.equal(failed.seen.disposed, 1);

  const aborted = fakePiSdk({ waitForAbort: true });
  const abortedDrive = await createPiProvider({ name: "pi", kind: "pi" }, async () => aborted.sdk).start({
    body: "wait", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  await Promise.all([abortedDrive.abort(), abortedDrive.abort()]);
  for await (const _event of abortedDrive.events) { /* drain */ }
  assert.equal(aborted.seen.aborted, 1);
  assert.equal(aborted.seen.disposed, 1);
  assert.deepEqual(await abortedDrive.completion, { kind: "failed", diagnostic: "Pi session aborted" });
});

test("Pi keeps abort pending when native cleanup refuses to settle", async () => {
  const fake = fakePiSdk({ promptNeverSettles: true, abortNeverSettles: true });
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start({
    body: "wait", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  let settled = false;
  void drive.abort().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(settled, false);
  assert.equal(fake.seen.aborted, 1);
  assert.equal(fake.seen.disposed, 0);
});

test("Pi and Claude setup loading observe the Body AbortSignal", async () => {
  for (const provider of [
    createPiProvider({ name: "pi", kind: "pi" }, async () => await new Promise<PiSdk>(() => undefined)),
    createClaudeProvider(async () => await new Promise(() => undefined)),
  ]) {
    const controller = new AbortController();
    const starting = provider.start({
      body: "wait", launchTells: [], cwd: "/work", options: {}, signal: controller.signal,
      session: { kind: "fresh" },
    });
    controller.abort(new Error("cancelled setup"));
    await Promise.race([
      assert.rejects(starting, /cancelled setup/u),
      new Promise((_, reject) => setTimeout(() => reject(new Error("setup ignored abort")), 500)),
    ]);
  }
});

test("Pi fails a prompt without assistant evidence", async () => {
  const fake = fakePiSdk();
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start({
    body: "wait", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "Pi completed without a native assistant answer" });
});

test("Pi preserves thinking-only and explicit empty assistant answers", async () => {
  const fake = fakePiSdk({ events: [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "earlier" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "consider" }] } },
  ] });
  const drive = await createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk).start({
    body: "wait", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  const events = [];
  for await (const event of drive.events) events.push(event);
  assert.deepEqual(events, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "assistant", text: "earlier" },
    { type: "thought", text: "consider" },
  ]);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "entry-final" });

  const empty = fakePiSdk({ events: [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
  ] });
  const emptyDrive = await createPiProvider({ name: "pi", kind: "pi" }, async () => empty.sdk).start({
    body: "wait", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  const emptyEvents = [];
  for await (const event of emptyDrive.events) emptyEvents.push(event);
  assert.deepEqual(emptyEvents, [
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-session" } },
    { type: "assistant", text: "" },
  ]);
  assert.deepEqual(await emptyDrive.completion, { kind: "answered", answer: "", historyId: "entry-final" });
});

test("Pi adapter resumes and forks only exact sessionFile coordinates", async () => {
  const fake = fakePiSdk({ events: [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "resumed" }] } },
  ] });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const drive = await provider.resume!({
    body: "continue",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "resume", coordinate: { sessionFile: "/sessions/source.jsonl" } },
  });
  for await (const _event of drive.events) { /* drain */ }
  await drive.completion;
  assert.equal(fake.seen.opened, "/sessions/source.jsonl");
  assert.deepEqual(
    await provider.fork!({ session: { sessionFile: "/sessions/source.jsonl" }, at: "entry-exact", cwd: "/work" }),
    { session: { sessionFile: "/sessions/child.jsonl" } },
  );
  assert.equal(fake.seen.branched, "entry-exact");
  await assert.rejects(provider.resume!({
    body: "bad",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "resume", coordinate: { sessionId: "wrong" } },
  }), /requires sessionFile/u);
  await assert.rejects(
    provider.fork!({ session: { sessionId: "wrong" }, at: "entry", cwd: "/work" }),
    /requires sessionFile/u,
  );
});

test("Pi option admission maps native terms and refuses unsupported policy", async () => {
  const fake = fakePiSdk({ events: [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ] });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  assert.deepEqual(provider.admitOptions({ readonly: true }), {
    kind: "admitted",
    options: { readonly: true },
    readonly: { enforcement: "native" },
  });
  assert.equal(provider.admitOptions({ network: "enabled" }).kind, "refused");
  assert.equal(provider.admitOptions({ model: "bad" }).kind, "refused");
  assert.equal(provider.admitOptions({ effort: "extreme" }).kind, "refused");
  const drive = await provider.start({
    body: "work",
    launchTells: [],
    cwd: "/work",
    options: { model: "openai/gpt", effort: "high", systemPrompt: "System" },
    session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  await drive.completion;
  assert.equal(fake.seen.options?.thinkingLevel, "high");
  assert.ok(fake.seen.options?.model);
  assert.ok(fake.seen.options?.resourceLoader);
  assert.throws(
    () => createPiProvider({ name: "pi", kind: "pi", env: { A: "x" } }),
    /env injection not supported/u,
  );
});

test("Pi readonly admits native enforcement and removes every task-surface mutation tool", async () => {
  const fake = fakePiSdk({ events: [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ] });
  const provider = createPiProvider({ name: "pi", kind: "pi" }, async () => fake.sdk);
  const drive = await provider.start({
    body: "inspect",
    launchTells: [],
    cwd: "/work",
    options: { readonly: true },
    session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  await drive.completion;
  assert.deepEqual(fake.seen.options?.tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(provider.admitOptions({ readonly: true }), {
    kind: "admitted",
    options: { readonly: true },
    readonly: { enforcement: "native" },
  });
  assert.throws(
    () => createPiProvider({ name: "pi", kind: "pi", config: { tools: ["bash"] } }),
    /does not support executable or config/u,
  );
});

test("readonly restraint codec admits only native or none with a concrete diagnostic", () => {
  assert.deepEqual(decodeReadonlyRestraint({ enforcement: "native" }), { enforcement: "native" });
  assert.deepEqual(decodeReadonlyRestraint({ enforcement: "none", diagnostic: "enforcement gap" }), {
    enforcement: "none",
    diagnostic: "enforcement gap",
  });
  assert.throws(() => decodeReadonlyRestraint({ enforcement: "none" }), /native or none with a diagnostic/u);
  assert.throws(() => decodeReadonlyRestraint({ enforcement: "none", diagnostic: "  " }), /native or none with a diagnostic/u);
  assert.throws(() => decodeReadonlyRestraint({ enforcement: "native", diagnostic: "extra" }), /native or none with a diagnostic/u);
  assert.throws(() => decodeReadonlyRestraint({ enforcement: "magic" }), /native or none with a diagnostic/u);
});

test("provider resolution validates kind config before constructing an adapter", () => {
  assert.throws(() => resolveProviderExecution({
    name: "claude",
    kind: "claude-agent-sdk",
    config: { unexpected: true },
  }), /config is unsupported by claude-agent-sdk/u);
  assert.throws(() => resolveProviderExecution({
    name: "opencode-sdk",
    kind: "opencode-sdk",
    config: { unexpected: true },
  }), /config is unsupported by opencode-sdk/u);
  assert.throws(() => resolveProviderExecution({
    name: "pi",
    kind: "pi",
    config: { tools: ["bash"] },
  }), /does not support executable or config/u);
  assert.throws(() => resolveProviderExecution({
    name: "grok-build",
    kind: "grok-build",
    executable: "grok",
    config: { extension: true },
  }), /does not support execution config/u);
});

test("provider activity codec round trips every closed event and tool-call arm", () => {
  const events: readonly AgentEvent[] = [
    { type: "session", coordinate: { sessionId: "native-1" } },
    { type: "session", coordinate: { sessionFile: "/sessions/pi.jsonl", sessionId: "pi-1" } },
    { type: "assistant", text: "complete answer" },
    { type: "note", text: "Retrying" },
    { type: "unknown", kind: "future/event" },
    { type: "tool", phase: "started", id: "run", name: "Bash", call: { kind: "run", command: "npm test" } },
    { type: "tool", phase: "completed", id: "read", name: "Read", call: { kind: "read", path: "README.md" }, result: { status: "error", message: "missing" } },
    { type: "tool", phase: "started", id: "ranged", name: "Read", call: { kind: "read", path: "src/a.ts", offset: 10, limit: 20 } },
    { type: "tool", phase: "started", id: "search", name: "Search", call: { kind: "search", query: "TODO" } },
    {
      type: "tool", phase: "started", id: "scoped", name: "Grep",
      call: { kind: "search", query: "TODO", scope: "content", path: "src", glob: "*.ts" },
    },
    { type: "tool", phase: "completed", id: "change", name: "Edit", call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] }, result: { status: "ok" } },
    { type: "tool", phase: "started", id: "unspecified", name: "Edit", call: { kind: "fileChange", changes: [{ op: "unspecified", path: "src/b.ts" }] } },
    { type: "tool", phase: "started", id: "other", name: "MCP", call: { kind: "other", display: "server/tool" } },
  ];
  for (const event of events) assert.deepEqual(decodeAgentEvent(encodeAgentEvent(event)), event);
  const truncated = decodeAgentEvent(encodeAgentEvent({ type: "assistant", text: "x".repeat(AGENT_EVENT_TEXT_LIMIT + 1) }));
  assert.deepEqual(truncated, { type: "assistant", text: "x".repeat(AGENT_EVENT_TEXT_LIMIT), truncated: true });
  const truncatedNote = decodeAgentEvent(encodeAgentEvent(noteEvent("x".repeat(AGENT_EVENT_TEXT_LIMIT + 1))));
  assert.deepEqual(truncatedNote, { type: "note", text: "x".repeat(AGENT_EVENT_TEXT_LIMIT), truncated: true });
  assert.throws(
    () => decodeAgentEvent({ type: "tool", phase: "completed", id: "bad", name: "Bash", call: { kind: "run", command: "x" } }),
    /invalid event shape/u,
  );
  assert.throws(
    () => decodeAgentEvent({ type: "tool", phase: "started", id: "bad", name: "Bash", call: { kind: "run", command: "x" }, result: { status: "ok" } }),
    /invalid event shape/u,
  );
  assert.throws(
    () => decodeAgentEvent({ type: "session", coordinate: { sessionFile: "/x", extra: true } }),
    /invalid event shape/u,
  );
  assert.deepEqual(
    decodeAgentEvent({
      type: "tool", phase: "started", id: "old-read", name: "Read",
      call: { kind: "read", path: "README.md" },
    }),
    { type: "tool", phase: "started", id: "old-read", name: "Read", call: { kind: "read", path: "README.md" } },
  );
  assert.deepEqual(
    decodeAgentEvent({
      type: "tool", phase: "started", id: "old-search", name: "Search",
      call: { kind: "search", query: "TODO" },
    }),
    { type: "tool", phase: "started", id: "old-search", name: "Search", call: { kind: "search", query: "TODO" } },
  );
  assert.throws(
    () => decodeAgentEvent({
      type: "tool", phase: "started", id: "bad-offset", name: "Read",
      call: { kind: "read", path: "README.md", offset: 0 },
    }),
    /invalid event shape/u,
  );
  assert.throws(
    () => decodeAgentEvent({
      type: "tool", phase: "started", id: "bad-scope", name: "Search",
      call: { kind: "search", query: "TODO", scope: "workspace" },
    }),
    /invalid event shape/u,
  );
});

test("provider activity codec rejects malformed tool-call optionals and unknown kinds", () => {
  const started = (
    id: string,
    name: string,
    call: unknown,
  ): Readonly<Record<string, unknown>> => ({ type: "tool", phase: "started", id, name, call });
  const accepted: readonly Readonly<{
    call: unknown;
    decoded: Extract<AgentEvent, { type: "tool" }>["call"];
  }>[] = [
    { call: { kind: "run", command: "npm test" }, decoded: { kind: "run", command: "npm test" } },
    { call: { kind: "read", path: "src/a.ts", limit: 8 }, decoded: { kind: "read", path: "src/a.ts", limit: 8 } },
    { call: { kind: "search", query: "TODO", path: "src" }, decoded: { kind: "search", query: "TODO", path: "src" } },
    {
      call: { kind: "fileChange", changes: [] },
      decoded: { kind: "fileChange", changes: [] },
    },
    {
      call: {
        kind: "fileChange",
        changes: [{ op: "delete", path: "gone.ts", diffstat: { added: 0, removed: 4 } }],
      },
      decoded: {
        kind: "fileChange",
        changes: [{ op: "delete", path: "gone.ts", diffstat: { added: 0, removed: 4 } }],
      },
    },
    {
      call: { kind: "fileChange", changes: [{ op: "unspecified", path: "edited.ts" }] },
      decoded: { kind: "fileChange", changes: [{ op: "unspecified", path: "edited.ts" }] },
    },
    { call: { kind: "other", display: "mcp/tool" }, decoded: { kind: "other", display: "mcp/tool" } },
  ];
  const rejected: readonly unknown[] = [
    { kind: "mystery", display: "no" },
    { kind: "run" },
    { kind: "read", path: "README.md", limit: 0 },
    { kind: "search", query: "TODO", path: 1 },
    { kind: "search", query: "TODO", glob: 1 },
    { kind: "fileChange", changes: { op: "add", path: "a.ts" } },
    { kind: "fileChange", changes: [{ op: "patch", path: "a.ts" }] },
    { kind: "fileChange", changes: [{ op: "add" }] },
    { kind: "fileChange", changes: [{ op: "add", path: "a.ts", diffstat: { added: -1, removed: 0 } }] },
    { kind: "fileChange", changes: [{ op: "add", path: "a.ts", diffstat: "1,0" }] },
    { kind: "other" },
    null,
  ];
  for (const { call, decoded } of accepted) {
    assert.deepEqual(
      decodeAgentEvent(started("ok", "Tool", call)),
      { type: "tool", phase: "started", id: "ok", name: "Tool", call: decoded },
    );
  }
  for (const call of rejected) {
    assert.throws(() => decodeAgentEvent(started("bad", "Tool", call)), /invalid event shape/u);
  }
  assert.throws(
    () => decodeAgentEvent({ type: "tool", phase: "started", id: "bad", name: "Tool" }),
    /invalid event shape/u,
  );
});

class CollectingChannel extends AgentEventChannel {
  readonly collected: AgentEvent[] = [];
  override emit(event: AgentEvent): void {
    this.collected.push(event);
  }
}

function claudeToolCall(name: string, input: unknown): Extract<AgentEvent, { type: "tool" }>["call"] {
  const events = new CollectingChannel();
  emitClaudeMessage({
    type: "assistant",
    uuid: "assistant-tools",
    session_id: "session-tools",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "tool-1", name, input }] },
  } as unknown as SDKMessage, events, { tools: new Map() });
  const event = events.collected[0];
  assert.equal(event?.type, "tool");
  return event.type === "tool" ? event.call : { kind: "other", display: "missing" };
}

function claudeToolLifecycle(
  name: string,
  input: unknown,
  result: Readonly<{
    is_error?: boolean;
    tool_use_id?: string;
    tool_use_result?: unknown;
  }> = {},
): readonly Extract<AgentEvent, { type: "tool" }>[] {
  const events = new CollectingChannel();
  const state = { tools: new Map() };
  emitClaudeMessage({
    type: "assistant",
    uuid: "assistant-tools",
    session_id: "session-tools",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "tool-1", name, input }] },
  } as unknown as SDKMessage, events, state);
  emitClaudeMessage({
    type: "user",
    session_id: "session-tools",
    parent_tool_use_id: null,
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: result.tool_use_id ?? "tool-1",
        is_error: result.is_error,
      }],
    },
    ...(result.tool_use_result === undefined ? {} : { tool_use_result: result.tool_use_result }),
  } as unknown as SDKMessage, events, state);
  return events.collected.flatMap((event) => event.type === "tool" ? [event] : []);
}

function piToolCall(name: string, args: unknown): Extract<AgentEvent, { type: "tool" }>["call"] {
  const [event] = translatePiEvent({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: name,
    args,
  } as never, { answer: "", assistantSeen: false, tools: new Map() });
  assert.equal(event?.type, "tool");
  return event.type === "tool" ? event.call : { kind: "other", display: "missing" };
}

function translatePiTools(events: readonly unknown[]): readonly Extract<AgentEvent, { type: "tool" }>[] {
  const state = { answer: "", assistantSeen: false, tools: new Map() };
  return events.flatMap((event) => translatePiEvent(event as never, state)).flatMap((event) => (
    event.type === "tool" ? [event] : []
  ));
}

function piEditPatch(path: string, body: string): string {
  return `--- a/${path}\n+++ b/${path}\n${body}`;
}

function opencodeToolEvent(name: string, input: unknown): Extract<AgentEvent, { type: "tool" }> | undefined {
  const observed: AgentEvent[] = [];
  mapEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-1", sessionID: "session-1", type: "tool", callID: "tool-1", tool: name,
        state: { status: "running", input },
      },
    },
  }, { emit(event) { observed.push(event); } }, createEventState("session-1"));
  return observed[0]?.type === "tool" ? observed[0] : undefined;
}

function opencodeToolCall(name: string, input: unknown): Extract<AgentEvent, { type: "tool" }>["call"] {
  const event = opencodeToolEvent(name, input);
  assert.equal(event?.type, "tool");
  return event?.type === "tool" ? event.call : { kind: "other", display: "missing" };
}

function opencodeToolParts(
  name: string,
  states: readonly Readonly<Record<string, unknown>>[],
  extras: readonly unknown[] = [],
): AgentEvent[] {
  const observed: AgentEvent[] = [];
  const state = createEventState("session-1");
  const emitter = { emit(event: AgentEvent) { observed.push(event); } };
  for (const toolState of states) {
    mapEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1", sessionID: "session-1", type: "tool", callID: "tool-1", tool: name,
          state: toolState,
        },
      },
    }, emitter, state);
  }
  for (const extra of extras) mapEvent(extra, emitter, state);
  return observed;
}

function collectCodexTools(...items: readonly Readonly<Record<string, unknown>>[]): readonly Extract<AgentEvent, { type: "tool" }>[] {
  const events = new CollectingChannel();
  const state = { settled: false, tools: new Map() };
  for (const item of items) {
    codexNotificationResult({ method: "item/started", params: { item } }, state, events);
  }
  return events.collected.flatMap((event) => event.type === "tool" ? [event] : []);
}

test("Claude, Pi, OpenCode, and Codex keep distinct native read ranges and search facts", () => {
  const claudeNear = claudeToolCall("Read", { file_path: "src/a.ts", offset: 10, limit: 20 });
  const claudeFar = claudeToolCall("Read", { file_path: "src/a.ts", offset: 80, limit: 5 });
  assert.deepEqual(claudeNear, { kind: "read", path: "src/a.ts", offset: 10, limit: 20 });
  assert.deepEqual(claudeFar, { kind: "read", path: "src/a.ts", offset: 80, limit: 5 });
  assert.notDeepEqual(claudeNear, claudeFar);
  assert.deepEqual(
    claudeToolCall("Read", { file_path: "src/a.ts", offset: 0, limit: -3 }),
    { kind: "read", path: "src/a.ts" },
  );
  assert.deepEqual(
    claudeToolCall("Grep", { pattern: "TODO", path: "src", glob: "*.ts" }),
    { kind: "search", query: "TODO", scope: "content", path: "src", glob: "*.ts" },
  );
  assert.deepEqual(
    claudeToolCall("Glob", { pattern: "*.md", path: "docs", glob: "ignored" }),
    { kind: "search", query: "*.md", scope: "files", path: "docs" },
  );
  assert.deepEqual(
    claudeToolCall("WebSearch", { query: "keiyaku", path: "ignored" }),
    { kind: "search", query: "keiyaku", scope: "web" },
  );
  assert.deepEqual(
    claudeToolCall("DatabaseSearch", { query: "TODO", path: "src" }),
    { kind: "other", display: "DatabaseSearch" },
  );

  assert.deepEqual(
    piToolCall("read", { path: "src/a.ts", offset: 4, limit: 8 }),
    { kind: "read", path: "src/a.ts", offset: 4, limit: 8 },
  );
  assert.deepEqual(
    piToolCall("grep", { pattern: "TODO", path: "src", glob: "*.ts" }),
    { kind: "search", query: "TODO", scope: "content", path: "src", glob: "*.ts" },
  );
  assert.deepEqual(
    piToolCall("find", { pattern: "*.md", path: "docs", glob: "ignored" }),
    { kind: "search", query: "*.md", scope: "files", path: "docs" },
  );

  const opencodeNear = opencodeToolCall("read", { filePath: "src/a.ts", offset: 2, limit: 3 });
  const opencodeFar = opencodeToolCall("read", { path: "src/a.ts", offset: 40 });
  assert.deepEqual(opencodeNear, { kind: "read", path: "src/a.ts", offset: 2, limit: 3 });
  assert.deepEqual(opencodeFar, { kind: "read", path: "src/a.ts", offset: 40 });
  assert.notDeepEqual(opencodeNear, opencodeFar);
  assert.deepEqual(
    opencodeToolCall("grep", { pattern: "TODO", path: "src", glob: "*.ts" }),
    { kind: "search", query: "TODO", scope: "content", path: "src", glob: "*.ts" },
  );
  assert.deepEqual(
    opencodeToolCall("glob", { pattern: "*.md", path: "docs", glob: "ignored" }),
    { kind: "search", query: "*.md", scope: "files", path: "docs" },
  );
  assert.deepEqual(
    opencodeToolCall("search", { query: "TODO" }),
    { kind: "search", query: "TODO", scope: "content" },
  );
  assert.equal(opencodeToolEvent("read", {}), undefined);
  assert.equal(opencodeToolEvent("grep", {}), undefined);
  assert.equal(opencodeToolEvent("search", { path: "src" }), undefined);

  const [web, missing, fuzzy] = collectCodexTools(
    { id: "web-1", type: "webSearch", query: "keiyaku docs" },
    { id: "web-2", type: "webSearch" },
    { id: "fuzzy-1", type: "fuzzyFileSearch", query: "src" },
  );
  assert.deepEqual(web?.call, { kind: "search", query: "keiyaku docs", scope: "web" });
  assert.deepEqual(missing?.call, { kind: "other", display: "web search" });
  assert.equal(fuzzy, undefined);

  const content = { type: "tool" as const, phase: "started" as const, id: "s1", name: "Grep",
    call: { kind: "search" as const, query: "TODO", scope: "content" as const, path: "src", glob: "*.ts" } };
  const files = { type: "tool" as const, phase: "started" as const, id: "s2", name: "Glob",
    call: { kind: "search" as const, query: "*.md", scope: "files" as const, path: "docs" } };
  const webSearch = { type: "tool" as const, phase: "started" as const, id: "s3", name: "WebSearch",
    call: { kind: "search" as const, query: "keiyaku", scope: "web" as const } };
  assert.notDeepEqual(content.call, files.call);
  assert.notDeepEqual(files.call, webSearch.call);
  for (const event of [content, files, webSearch]) {
    assert.deepEqual(decodeAgentEvent(encodeAgentEvent(event)), event);
  }
});

test("Claude, Pi, and OpenCode keep native fallbacks and name precedence", () => {
  const claude: readonly Readonly<{ name: string; input: unknown; call: Extract<AgentEvent, { type: "tool" }>["call"] }>[] = [
    { name: "Bash", input: { command: "npm test" }, call: { kind: "run", command: "npm test" } },
    { name: "Bash", input: { command: "   " }, call: { kind: "other", display: "Bash" } },
    { name: "Read", input: { path: "src/a.ts" }, call: { kind: "read", path: "src/a.ts" } },
    { name: "Read", input: { file_path: "   " }, call: { kind: "other", display: "Read" } },
    { name: "Grep", input: { query: "TODO" }, call: { kind: "search", query: "TODO", scope: "content" } },
    { name: "Grep", input: { path: "src" }, call: { kind: "other", display: "Grep" } },
    { name: "Glob", input: { path: "docs" }, call: { kind: "other", display: "Glob" } },
    { name: "WebSearch", input: { path: "ignored" }, call: { kind: "other", display: "WebSearch" } },
    { name: "Write", input: { file_path: "src/a.ts" }, call: { kind: "fileChange", changes: [{ op: "add", path: "src/a.ts" }] } },
    { name: "Edit", input: { file_path: "src/a.ts" }, call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] } },
    {
      name: "NotebookEdit",
      input: { notebook_path: "n.ipynb" },
      call: { kind: "fileChange", changes: [{ op: "update", path: "n.ipynb" }] },
    },
    { name: "NotebookEdit", input: { file_path: "n.ipynb" }, call: { kind: "other", display: "NotebookEdit" } },
    { name: "Write", input: {}, call: { kind: "other", display: "Write" } },
  ];
  for (const { name, input, call } of claude) assert.deepEqual(claudeToolCall(name, input), call);

  const pi: readonly Readonly<{ name: string; args: unknown; call: Extract<AgentEvent, { type: "tool" }>["call"] }>[] = [
    { name: "bash", args: { command: "npm test" }, call: { kind: "run", command: "npm test" } },
    { name: "bash", args: { command: 1 }, call: { kind: "other", display: "bash" } },
    { name: "grep", args: { query: "TODO", path: "src" }, call: { kind: "search", query: "TODO", scope: "content", path: "src" } },
    { name: "find", args: { query: "*.md" }, call: { kind: "search", query: "*.md", scope: "files" } },
    { name: "write", args: { path: "src/a.ts" }, call: { kind: "other", display: "write" } },
    { name: "edit", args: { path: "src/a.ts" }, call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] } },
    { name: "edit", args: {}, call: { kind: "other", display: "edit" } },
  ];
  for (const { name, args, call } of pi) assert.deepEqual(piToolCall(name, args), call);

  const opencode: readonly Readonly<{
    name: string;
    input: unknown;
    call?: Extract<AgentEvent, { type: "tool" }>["call"];
  }>[] = [
    { name: "Bash", input: { command: "npm test" }, call: { kind: "run", command: "npm test" } },
    { name: "SHELL", input: {}, call: { kind: "run", command: "shell" } },
    { name: "read", input: { filePath: "src/a.ts" }, call: { kind: "read", path: "src/a.ts" } },
    { name: "search", input: { query: "TODO", filePath: "src", glob: "*.ts" },
      call: { kind: "search", query: "TODO", scope: "content", path: "src", glob: "*.ts" } },
    { name: "Glob", input: { pattern: "*.md", filePath: "docs", glob: "ignored" },
      call: { kind: "search", query: "*.md", scope: "files", path: "docs" } },
    { name: "DatabaseSearch", input: { query: "TODO" }, call: { kind: "other", display: "DatabaseSearch" } },
    { name: "read", input: {} },
    { name: "grep", input: { glob: "*.ts" } },
  ];
  for (const { name, input, call } of opencode) {
    if (call === undefined) assert.equal(opencodeToolEvent(name, input), undefined);
    else assert.deepEqual(opencodeToolCall(name, input), call);
  }
});

test("Claude file tools preserve native start paths and structured results", () => {
  const started = claudeToolLifecycle("Write", { file_path: "src/a.ts" })[0];
  assert.deepEqual(started, {
    type: "tool",
    phase: "started",
    id: "tool-1",
    name: "Write",
    call: { kind: "fileChange", changes: [{ op: "add", path: "src/a.ts" }] },
  });

  const create = claudeToolLifecycle("Write", { file_path: "src/a.ts" }, {
    tool_use_result: {
      type: "create",
      filePath: "src/created.ts",
      gitDiff: { additions: 3, deletions: 0 },
    },
  });
  assert.deepEqual(create[1], {
    type: "tool",
    phase: "completed",
    id: "tool-1",
    name: "Write",
    call: {
      kind: "fileChange",
      changes: [{ op: "add", path: "src/created.ts", diffstat: { added: 3, removed: 0 } }],
    },
    result: { status: "ok" },
  });

  const writeUpdate = claudeToolLifecycle("Write", { file_path: "src/a.ts" }, {
    tool_use_result: { type: "update", filePath: "src/updated.ts" },
  });
  assert.deepEqual(writeUpdate[1]?.call, {
    kind: "fileChange",
    changes: [{ op: "update", path: "src/updated.ts" }],
  });

  const invalidCounts = claudeToolLifecycle("Write", { file_path: "src/a.ts" }, {
    tool_use_result: {
      type: "update",
      filePath: "src/a.ts",
      gitDiff: { additions: 1.5, deletions: 2 },
    },
  });
  assert.deepEqual(invalidCounts[1]?.call, {
    kind: "fileChange",
    changes: [{ op: "update", path: "src/a.ts" }],
  });

  const addedEdit = claudeToolLifecycle("Edit", { file_path: "src/a.ts" }, {
    tool_use_result: {
      filePath: "src/new.ts",
      gitDiff: { status: "added", additions: 4, deletions: 0 },
    },
  });
  assert.deepEqual(addedEdit[1]?.call, {
    kind: "fileChange",
    changes: [{ op: "add", path: "src/new.ts", diffstat: { added: 4, removed: 0 } }],
  });

  const modifiedEdit = claudeToolLifecycle("Edit", { file_path: "src/a.ts" }, {
    tool_use_result: {
      filePath: "src/a.ts",
      gitDiff: { status: "modified", additions: 1, deletions: 2 },
    },
  });
  assert.deepEqual(modifiedEdit[1]?.call, {
    kind: "fileChange",
    changes: [{ op: "update", path: "src/a.ts", diffstat: { added: 1, removed: 2 } }],
  });

  const notebook = claudeToolLifecycle("NotebookEdit", { notebook_path: "n.ipynb" }, {
    tool_use_result: { notebook_path: "renamed.ipynb" },
  });
  assert.deepEqual(notebook[0]?.call, {
    kind: "fileChange",
    changes: [{ op: "update", path: "n.ipynb" }],
  });
  assert.deepEqual(notebook[1]?.call, {
    kind: "fileChange",
    changes: [{ op: "update", path: "renamed.ipynb" }],
  });

  const failed = claudeToolLifecycle("Write", { file_path: "src/a.ts" }, {
    is_error: true,
    tool_use_result: {
      type: "create",
      filePath: "src/created.ts",
      gitDiff: { additions: 9, deletions: 0 },
    },
  });
  assert.deepEqual(failed[1], {
    type: "tool",
    phase: "completed",
    id: "tool-1",
    name: "Write",
    call: { kind: "fileChange", changes: [{ op: "add", path: "src/a.ts" }] },
    result: { status: "error" },
  });

  const missing = claudeToolLifecycle("Write", { file_path: "src/a.ts" });
  assert.deepEqual(missing[1]?.call, {
    kind: "fileChange",
    changes: [{ op: "add", path: "src/a.ts" }],
  });
  assert.equal(missing[1]?.result?.status, "ok");

  const mismatched = claudeToolLifecycle("Write", { file_path: "src/a.ts" }, {
    tool_use_id: "other-tool",
    tool_use_result: { type: "create", filePath: "src/created.ts" },
  });
  assert.equal(mismatched.length, 1);
  assert.equal(mismatched[0]?.phase, "started");

  const malformed = claudeToolLifecycle("Edit", { file_path: "src/a.ts" }, {
    tool_use_result: { type: "create", filePath: "src/created.ts", gitDiff: { additions: 1, deletions: 0 } },
  });
  assert.deepEqual(malformed[1], {
    type: "tool",
    phase: "completed",
    id: "tool-1",
    name: "Edit",
    call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] },
    result: { status: "ok" },
  });
});

test("Pi edit keeps native update plus patch diffstat and write stays other", () => {
  const hunk = piEditPatch("src/a.ts", "@@ -1,1 +1,2 @@\n line\n+added\n");
  const noHunk = piEditPatch("src/a.ts", "");
  const editStart = {
    type: "tool_execution_start", toolCallId: "edit-1", toolName: "edit", args: { path: "src/a.ts" },
  };
  const [begun, done] = translatePiTools([
    editStart,
    { type: "tool_execution_update", toolCallId: "edit-1", toolName: "edit", partialResult: "Edited" },
    {
      type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: false,
      result: { details: { patch: hunk }, content: [{ type: "text", text: "+added" }] },
    },
  ]);
  assert.deepEqual(begun, {
    type: "tool", phase: "started", id: "edit-1", name: "edit",
    call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] },
  });
  assert.deepEqual(done, {
    type: "tool", phase: "completed", id: "edit-1", name: "edit",
    call: { kind: "fileChange", changes: [{
      op: "update", path: "src/a.ts", diffstat: { added: 1, removed: 0 },
    }] },
    result: { status: "ok" },
  });
  for (const patch of [noHunk, "not a unified patch"]) {
    const [completed] = translatePiTools([
      editStart,
      { type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: false,
        result: { details: { patch } } },
    ]).filter((event) => event.phase === "completed");
    assert.deepEqual(completed?.call, { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] });
  }
  const [failed] = translatePiTools([
    editStart,
    { type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit", isError: true,
      result: { details: { patch: hunk } } },
  ]).filter((event) => event.phase === "completed");
  assert.deepEqual(failed, {
    type: "tool", phase: "completed", id: "edit-1", name: "edit",
    call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] },
    result: { status: "error" },
  });
  const write = translatePiTools([
    { type: "tool_execution_start", toolCallId: "write-1", toolName: "write", args: { path: "src/b.ts" } },
    { type: "tool_execution_end", toolCallId: "write-1", toolName: "write", isError: false,
      result: { content: [{ type: "text", text: "Wrote src/b.ts" }] } },
  ]);
  assert.deepEqual(write, [
    { type: "tool", phase: "started", id: "write-1", name: "write", call: { kind: "other", display: "write" } },
    {
      type: "tool", phase: "completed", id: "write-1", name: "write",
      call: { kind: "other", display: "write" }, result: { status: "ok" },
    },
  ]);
  const concurrent = translatePiTools([
    { type: "tool_execution_start", toolCallId: "left", toolName: "edit", args: { path: "left.ts" } },
    { type: "tool_execution_start", toolCallId: "right", toolName: "edit", args: { path: "right.ts" } },
    {
      type: "tool_execution_end", toolCallId: "right", toolName: "edit", isError: false,
      result: { details: { patch: piEditPatch("right.ts", "@@ -1,1 +1,1 @@\n-old\n+new\n") } },
    },
    {
      type: "tool_execution_end", toolCallId: "left", toolName: "edit", isError: false,
      result: { details: { patch: piEditPatch("left.ts", "@@ -1,0 +1,1 @@\n+left\n") } },
    },
  ]);
  assert.deepEqual(concurrent.map((event) => [event.phase, event.id, event.call]), [
    ["started", "left", { kind: "fileChange", changes: [{ op: "update", path: "left.ts" }] }],
    ["started", "right", { kind: "fileChange", changes: [{ op: "update", path: "right.ts" }] }],
    ["completed", "right", { kind: "fileChange",
      changes: [{ op: "update", path: "right.ts", diffstat: { added: 1, removed: 1 } }] }],
    ["completed", "left", { kind: "fileChange",
      changes: [{ op: "update", path: "left.ts", diffstat: { added: 1, removed: 0 } }] }],
  ]);
  assert.equal(concurrent.filter((event) => event.id === "left").length, 2);
  assert.equal(concurrent.filter((event) => event.id === "right").length, 2);
});

test("OpenCode edit, write, and apply_patch preserve native file-change facts", () => {
  const edited = opencodeToolParts("edit", [
    { status: "running", input: { filePath: "src/a.ts" } },
    {
      status: "completed", input: { filePath: "src/a.ts" }, output: "ok", title: "a.ts",
      metadata: { filediff: { file: "src/a.ts", additions: 3, deletions: 1 } },
      time: { start: 1, end: 2 },
    },
  ]);
  assert.deepEqual(edited[0], {
    type: "tool", phase: "started", id: "tool-1", name: "edit",
    call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] },
  });
  assert.deepEqual(edited[1], {
    type: "tool", phase: "completed", id: "tool-1", name: "edit",
    call: {
      kind: "fileChange",
      changes: [{ op: "update", path: "src/a.ts", diffstat: { added: 3, removed: 1 } }],
    },
    result: { status: "ok" },
  });
  const omitted = opencodeToolParts("EDIT", [
    { status: "running", input: { filePath: "src/a.ts" } },
    {
      status: "completed", input: { filePath: "src/a.ts" }, output: "ok", title: "a.ts",
      metadata: { filediff: { additions: -1, deletions: 1 } }, time: { start: 1, end: 2 },
    },
  ]);
  assert.deepEqual(
    omitted[1]?.type === "tool" ? omitted[1].call : undefined,
    { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] },
  );
  const kept = opencodeToolParts("edit", [
    { status: "running", input: { filePath: "src/a.ts" } },
    {
      status: "completed", input: {}, output: "ok", title: "a.ts", metadata: { filediff: "no" },
      time: { start: 1, end: 2 },
    },
  ]);
  assert.deepEqual(
    kept[1]?.type === "tool" ? kept[1].call : undefined,
    { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] },
  );

  const created = opencodeToolParts("write", [
    { status: "running", input: { filePath: "src/a.ts" } },
    {
      status: "completed", input: { filePath: "src/a.ts" }, output: "ok", title: "a.ts",
      metadata: { filepath: "src/a.ts", exists: false }, time: { start: 1, end: 2 },
    },
  ]);
  assert.deepEqual(created[0]?.type === "tool" ? created[0].call : undefined, {
    kind: "other", display: "write",
  });
  assert.deepEqual(created[1]?.type === "tool" ? created[1].call : undefined, {
    kind: "fileChange", changes: [{ op: "add", path: "src/a.ts" }],
  });
  const overwritten = opencodeToolParts("WRITE", [
    { status: "running", input: { filePath: "src/a.ts" } },
    {
      status: "completed", input: { filePath: "src/a.ts" }, output: "ok", title: "a.ts",
      metadata: { filepath: "src/a.ts", exists: true }, time: { start: 1, end: 2 },
    },
  ]);
  assert.deepEqual(overwritten[1]?.type === "tool" ? overwritten[1].call : undefined, {
    kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }],
  });
  const unknownWrite = opencodeToolParts("write", [
    { status: "running", input: { filePath: "src/a.ts" } },
    {
      status: "completed", input: { filePath: "src/a.ts" }, output: "ok", title: "a.ts",
      metadata: { filepath: "src/a.ts" }, time: { start: 1, end: 2 },
    },
  ]);
  assert.deepEqual(unknownWrite[1]?.type === "tool" ? unknownWrite[1].call : undefined, {
    kind: "other", display: "write",
  });

  const patched = opencodeToolParts("apply_patch", [
    { status: "running", input: { patchText: "*** Begin Patch" } },
    {
      status: "completed", input: { patchText: "*** Begin Patch" }, output: "ok", title: "patch",
      metadata: {
        files: [
          { filePath: "src/new.ts", type: "add", additions: 2, deletions: 0 },
          { filePath: "src/a.ts", type: "update", additions: 1, deletions: 1 },
          { filePath: "src/gone.ts", type: "delete", additions: 0, deletions: 3 },
          {
            filePath: "src/old.ts", type: "move", movePath: "src/renamed.ts",
            additions: 4, deletions: 1,
          },
        ],
      },
      time: { start: 1, end: 2 },
    },
  ]);
  assert.deepEqual(patched[0]?.type === "tool" ? patched[0].call : undefined, {
    kind: "other", display: "apply_patch",
  });
  assert.deepEqual(patched[1]?.type === "tool" ? patched[1].call : undefined, {
    kind: "fileChange",
    changes: [
      { op: "add", path: "src/new.ts", diffstat: { added: 2, removed: 0 } },
      { op: "update", path: "src/a.ts", diffstat: { added: 1, removed: 1 } },
      { op: "delete", path: "src/gone.ts", diffstat: { added: 0, removed: 3 } },
      { op: "update", path: "src/renamed.ts", diffstat: { added: 4, removed: 1 } },
    ],
  });

  const observed = opencodeToolParts("write_file", [
    { status: "running", input: { filePath: "src/a.ts" } },
    {
      status: "completed", input: { filePath: "src/a.ts" }, output: "ok", title: "a.ts",
      metadata: { filepath: "src/a.ts", exists: false, files: [{ filePath: "x", type: "add" }] },
      time: { start: 1, end: 2 },
    },
  ], [
    { type: "session.diff", properties: { diffs: [{ file: "src/a.ts", additions: 1, deletions: 0 }] } },
    { type: "file.edited", properties: { file: "src/a.ts" } },
    { type: "file.watcher.updated", properties: { file: "src/a.ts", event: "add" } },
  ]);
  assert.deepEqual(observed.map((event) => event.type === "tool" ? event.call : event), [
    { kind: "other", display: "write_file" },
    { kind: "other", display: "write_file" },
  ]);
  assert.deepEqual(opencodeToolCall("applyPatch", { patchText: "x" }), {
    kind: "other", display: "applyPatch",
  });
});

function fakeCodex(
  root: string,
  mode: "complete" | "empty-final" | "interrupt" | "observations" | "failed-notification" | "failed-turn"
    | "terminal-drain" | "terminal-unmatched" | "terminal-hang" | "exit-before-completion" | "steer" | "steer-complete-first"
    | "steer-hung-terminal" | "steer-error-after-complete" | "steer-mismatch" | "steer-missing" = "complete",
): Readonly<{
  executable: string;
  requests(): readonly Readonly<Record<string, unknown>>[];
  requestEnvironment(): Readonly<{ requests: string; literal: string; actor: string }>;
}> {
  const executable = join(root, "codex");
  const log = join(root, "requests.jsonl");
  const environment = join(root, "request-environment.txt");
  writeFileSync(executable, [
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
    "    if(mode==='terminal-drain'||mode==='terminal-unmatched'||mode==='terminal-hang'){",
    "      send({method:'item/started',params:{item:{id:'command-terminal',type:'commandExecution',command:'npm test'}}});",
    "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'completed'}}});",
    "    }",
    "    if(mode==='exit-before-completion') process.exit(7);",
    "    if(mode==='empty-final'){",
    "      send({method:'item/completed',params:{item:{id:'answer-1',type:'agentMessage',text:'first answer'}}});",
    "      send({method:'item/completed',params:{item:{id:'answer-2',type:'agentMessage',text:''}}});",
    "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'completed'}}});",
    "    }",
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
    "    if(mode==='failed-notification'){",
    "      send({method:'error',params:{error:{message:'native request exploded',additionalDetails:'provider detail'},willRetry:false}});",
    "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'failed',error:null}}});",
    "    }",
    "    if(mode==='failed-turn'){",
    "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'turn-1',status:'failed',error:{message:'native turn failed',additionalDetails:'turn detail'}}}});",
    "    }",
    "    return;",
    "  }",
    "  if(message.method==='turn/steer'){",
    "    if(mode==='steer-hung-terminal'){",
    "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.expectedTurnId,status:'completed'}}});",
    "      return;",
    "    }",
    "    if(mode==='steer-complete-first'){",
    "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.expectedTurnId,status:'completed'}}});",
    "      return setTimeout(()=>reply(message,{turnId:message.params.expectedTurnId}),10);",
    "    }",
    "    if(mode==='steer-error-after-complete'){",
    "      send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.expectedTurnId,status:'completed'}}});",
    "      return setTimeout(()=>send({id:message.id,error:{code:-32000,message:'native steer rejected'}}),10);",
    "    }",
    "    reply(message,mode==='steer-missing'?{}:{turnId:mode==='steer-mismatch'?'turn-other':message.params.expectedTurnId});",
    "    if(mode==='steer') send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.expectedTurnId,status:'completed'}}});",
    "    return;",
    "  }",
    "  if(message.method==='turn/interrupt'){",
    "    reply(message,{});",
    "    send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:message.params.turnId,status:'interrupted'}}});",
    "  }",
    "});",
  ].join("\n"));
  chmodSync(executable, 0o755);
  return {
    executable,
    requests: () => {
      try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
    requestEnvironment: () => JSON.parse(readFileSync(environment, "utf8")),
  };
}

function fakeQuery(messages: readonly SDKMessage[], prompt?: AsyncIterable<unknown>): Query {
  return (async function* () {
    if (prompt !== undefined) {
      void (async () => {
        for await (const _message of prompt) { /* pull the streaming input concurrently */ }
      })();
    }
    for (const message of messages) yield message;
  })() as unknown as Query;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
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
  const outputs: SDKMessage[] = [{ type: "system", subtype: "init", session_id: "session-live" } as unknown as SDKMessage];
  const outputWaiters: Array<() => void> = [];
  let inputIterator: AsyncIterator<SDKUserMessage> | undefined;
  let pendingInput: Promise<IteratorResult<SDKUserMessage>> | undefined;
  let failure: unknown;
  let ended = false;
  const wakeOutput = () => outputWaiters.shift()?.();
  const pullInput = () => {
    if (inputIterator === undefined) throw new Error("Claude input is not attached");
    pendingInput = inputIterator.next();
    void pendingInput.then((next) => {
      if (!next.done) return;
      ended = true;
      wakeOutput();
    }, () => {});
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
          } catch (error) { throw error; }
        })() as unknown as Query;
        query.close = () => { ended = true; wakeOutput(); };
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
    end() { ended = true; wakeOutput(); },
  };
}

test("Claude observation dispositions are closed over the installed SDK union", () => {
  assert.deepEqual(CLAUDE_MESSAGE_DISPOSITIONS, {
    assistant: "assistant",
    auth_status: "auth",
    conversation_reset: "note",
    prompt_suggestion: "drop",
    rate_limit_event: "drop",
    result: "terminal",
    stream_event: "drop",
    system: "system",
    tool_progress: "drop",
    tool_use_summary: "drop",
    user: "tool-results",
  });
  assert.deepEqual(CLAUDE_SYSTEM_DISPOSITIONS, {
    api_retry: "note",
    background_tasks_changed: "note",
    commands_changed: "drop",
    compact_boundary: "drop",
    control_request_progress: "control-progress",
    elicitation_complete: "drop",
    files_persisted: "note",
    hook_progress: "drop",
    hook_response: "drop",
    hook_started: "note",
    informational: "note",
    init: "drop",
    local_command_output: "drop",
    memory_recall: "drop",
    mirror_error: "note",
    model_refusal_fallback: "note",
    model_refusal_no_fallback: "note",
    notification: "note",
    permission_denied: "note",
    plugin_install: "note",
    session_state_changed: "drop",
    status: "note",
    task_notification: "note",
    task_progress: "note",
    task_started: "note",
    task_updated: "note",
    thinking_tokens: "drop",
    worker_shutting_down: "note",
  });
});

test("Claude maps narration, drops native streams, and contains runtime skew", async () => {
  const longNotice = `line one\n${"x".repeat(220)}`;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      return fakeQuery([
        { type: "system", subtype: "init", session_id: "session-events" } as unknown as SDKMessage,
        {
          type: "assistant",
          uuid: "assistant-events",
          session_id: "session-events",
          parent_tool_use_id: null,
          message: { content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "secret" } },
          ] },
        } as unknown as SDKMessage,
        {
          type: "user",
          session_id: "session-events",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "secret result body" }] },
        } as unknown as SDKMessage,
        { type: "stream_event", event: { delta: { text: "partial" } }, session_id: "session-events" } as unknown as SDKMessage,
        { type: "rate_limit_event", rate_limit_info: { used: 1 }, session_id: "session-events" } as unknown as SDKMessage,
        { type: "system", subtype: "api_retry", attempt: 2, max_retries: 4, session_id: "session-events" } as unknown as SDKMessage,
        { type: "system", subtype: "informational", content: longNotice, session_id: "session-events" } as unknown as SDKMessage,
        { type: "future_type", secret: "must not escape", session_id: "session-events" } as unknown as SDKMessage,
        { type: "system", subtype: "future_subtype", secret: "must not escape", session_id: "session-events" } as unknown as SDKMessage,
        { type: "result", subtype: "success", result: "done", session_id: "session-events" } as unknown as SDKMessage,
      ], input.prompt as AsyncIterable<unknown>);
    },
  }));
  const drive = await provider.start({
    body: "observe", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  assert.equal(typeof drive.tell, "function");
  const events = [];
  for await (const event of drive.events) events.push(event);

  assert.deepEqual(events.slice(0, 5), [
    { type: "session", coordinate: { sessionId: "session-events" } },
    { type: "assistant", text: "working" },
    { type: "tool", phase: "started", id: "tool-1", name: "Bash", call: { kind: "run", command: "secret" } },
    { type: "tool", phase: "completed", id: "tool-1", name: "Bash", call: { kind: "run", command: "secret" }, result: { status: "ok" } },
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
      return fakeQuery([
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
      ], input.prompt as AsyncIterable<unknown>);
    },
  }));
  const drive = await provider.start({
    body: "build it", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  const events = [];
  for await (const event of drive.events) events.push(event);

  assert.deepEqual(events[0], { type: "session", coordinate: { sessionId: "session-1" } });
  assert.ok(events.some((event) => event.type === "assistant" && event.text === "working"));
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "assistant-history-1" });
  assert.deepEqual(seenOptions, [{
    cwd: "/work",
    abortController: seenOptions.length === 0 ? undefined : (seenOptions[0] as { abortController: unknown }).abortController,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["user", "project", "local"],
  }]);
});

test("Claude adapter restores only the native session coordinate it was given", async () => {
  let resume: unknown;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      resume = input.options?.resume;
      return fakeQuery([{
        type: "result",
        subtype: "error_during_execution",
        session_id: "session-1",
        errors: ["native resume failed"],
      } as unknown as SDKMessage], input.prompt as AsyncIterable<unknown>);
    },
  }));
  const drive = await provider.resume!({
    body: "continue",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "resume", coordinate: { sessionId: "session-1" } },
  });
  for await (const _event of drive.events) { /* drain */ }
  assert.equal(resume, "session-1");
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "native resume failed" });
});

test("Claude refuses a Pi coordinate before loading its native SDK", async () => {
  let loaded = false;
  const provider = createClaudeProvider(async () => {
    loaded = true;
    throw new Error("must not load");
  });
  await assert.rejects(provider.resume!({
    body: "continue",
    launchTells: [],
    cwd: "/work",
    options: {},
    session: { kind: "resume", coordinate: { sessionFile: "/sessions/pi.jsonl" } },
  }), /Claude resume requires sessionId/u);
  await assert.rejects(
    provider.fork!({ session: { sessionFile: "/sessions/pi.jsonl" }, at: "message-1", cwd: "/work" }),
    /Claude resume requires sessionId/u,
  );
  assert.equal(loaded, false);
});

test("Claude answers without substituting a result UUID for the assistant fork point", async () => {
  const provider = createClaudeProvider(async () => ({
    query(input) {
      return fakeQuery([{
        type: "result",
        subtype: "success",
        session_id: "session-without-assistant",
        uuid: "result-only-uuid",
        result: "done",
      } as unknown as SDKMessage], input.prompt as AsyncIterable<unknown>);
    },
  }));
  const drive = await provider.start({
    body: "build", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done" });
});

test("Claude never substitutes a sidechain assistant UUID for the outer fork point", async () => {
  const provider = createClaudeProvider(async () => ({
    query(input) {
      return fakeQuery([
        {
          type: "assistant",
          uuid: "outer-assistant-uuid",
          session_id: "mixed-session",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "outer answer" }] },
        } as unknown as SDKMessage,
        {
          type: "assistant",
          uuid: "sidechain-assistant-uuid",
          session_id: "mixed-session",
          parent_tool_use_id: "tool-use-1",
          message: { content: [{ type: "text", text: "subagent answer" }] },
        } as unknown as SDKMessage,
        {
          type: "result",
          subtype: "success",
          session_id: "mixed-session",
          uuid: "result-uuid",
          result: "done",
        } as unknown as SDKMessage,
      ], input.prompt as AsyncIterable<unknown>);
    },
  }));
  const drive = await provider.start({
    body: "delegate", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  assert.deepEqual(await drive.completion, {
    kind: "answered",
    answer: "done",
    historyId: "outer-assistant-uuid",
  });
});

test("Claude adapter consumes the admitted Archetype options", async () => {
  let seen: unknown;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      seen = input.options;
      return fakeQuery([
        {
          type: "assistant",
          uuid: "assistant-history-options",
          session_id: "session-options",
          parent_tool_use_id: null,
          message: { content: [] },
        } as unknown as SDKMessage,
        {
          type: "result",
          subtype: "success",
          session_id: "session-options",
          uuid: "result-history-options",
          result: "done",
        } as unknown as SDKMessage,
      ], input.prompt as AsyncIterable<unknown>);
    },
  }));
  const admitted = provider.admitOptions({
    model: "claude-sonnet-4-5",
    effort: "high",
    readonly: true,
    systemPrompt: "Review only.",
  });
  assert.equal(admitted.kind, "admitted");
  if (admitted.kind !== "admitted") return;
  assert.deepEqual(admitted.readonly, { enforcement: "native" });
  const drive = await provider.start({
    body: "inspect", launchTells: [], cwd: "/work", options: admitted.options, session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  await drive.completion;
  assert.deepEqual(seen, {
    cwd: "/work",
    abortController: (seen as { abortController: unknown }).abortController,
    permissionMode: "plan",
    settingSources: ["user", "project", "local"],
    model: "claude-sonnet-4-5",
    effort: "high",
    systemPrompt: { type: "preset", preset: "claude_code", append: "Review only." },
  });
  assert.deepEqual(provider.admitOptions({ network: "disabled" }), {
    kind: "refused",
    diagnostic: "Claude provider does not support the network option",
  });
});

test("Claude execution overlays literal env and selects its executable", async () => {
  let seen: unknown;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      seen = input.options;
      return fakeQuery([
        {
          type: "assistant",
          uuid: "assistant-execution",
          session_id: "session-execution",
          parent_tool_use_id: null,
          message: { content: [] },
        } as unknown as SDKMessage,
        { type: "result", subtype: "success", session_id: "session-execution", result: "done" } as unknown as SDKMessage,
      ], input.prompt as AsyncIterable<unknown>);
    },
  }), { executable: "/custom/claude", env: { SETTINGS_LITERAL: "yes" } });
  const drive = await provider.start({
    body: "inspect", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  await drive.completion;
  const options = seen as { pathToClaudeCodeExecutable: string; env: NodeJS.ProcessEnv };
  assert.equal(options.pathToClaudeCodeExecutable, "/custom/claude");
  assert.equal(options.env.SETTINGS_LITERAL, "yes");
  assert.equal(options.env.PATH, process.env.PATH);
});

test("Claude start consumes its admitted snapshot without a second admission", async () => {
  let called = false;
  const provider = createClaudeProvider(async () => ({
    query(input) {
      called = true;
      return fakeQuery([
        {
          type: "assistant",
          uuid: "assistant-history-snapshot",
          session_id: "session-snapshot",
          parent_tool_use_id: null,
          message: { content: [] },
        } as unknown as SDKMessage,
        {
          type: "result",
          subtype: "success",
          session_id: "session-snapshot",
          uuid: "result-history-snapshot",
          result: "done",
        } as unknown as SDKMessage,
      ], input.prompt as AsyncIterable<unknown>);
    },
  }));
  const drive = await provider.start({
    body: "continue",
    launchTells: [],
    cwd: "/work",
    options: { network: "disabled" },
    session: { kind: "fresh" },
  });
  for await (const _event of drive.events) { /* drain */ }
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "assistant-history-snapshot" });
  assert.equal(called, true);
});

test("Claude live tell waits for a post-yield source pull and shares one Query", async () => {
  const harness = controlledClaude();
  let queries = 0;
  const provider = createClaudeProvider(async () => ({
    query(input) { queries += 1; return harness.sdk.query(input); },
  }));
  const drive = await provider.start({
    body: "initial", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  assert.equal(queries, 1);
  let resolved = false;
  const submission = drive.tell!({ id: "tell-live-1", text: "steer now" })
    .then((value) => { resolved = true; return value; });
  const yielded = await harness.receiveInput();
  assert.equal(yielded.done, false);
  assert.equal((yielded.value.message.content as string), "steer now");
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

test("Claude receipt waits for both acknowledgement and a later successful checkpoint", async () => {
  const harness = controlledClaude();
  const provider = createClaudeProvider(async () => harness.sdk);
  const drive = await provider.start({
    body: "initial", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  const tell = drive.tell!({ id: "tell-live-2", text: "after checkpoint" });
  const yielded = await harness.receiveInput();
  assert.equal(yielded.done, false);
  harness.output(...claudeResult(1));
  let received = false;
  const receipt = drive.receipts![Symbol.asyncIterator]().next().then((value) => { received = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, false);
  harness.acknowledgeInput();
  await tell;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, false);
  harness.output(...claudeResult(2));
  assert.deepEqual(await receipt, {
    done: false,
    value: { evidence: "exact", tellId: "tell-live-2", kind: "consumed" },
  });
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done 2", historyId: "assistant-live-2" });
});

test("Claude terminality and failure before source acknowledgement preserve honest tell outcomes", async () => {
  const terminal = controlledClaude();
  const terminalProvider = createClaudeProvider(async () => terminal.sdk);
  const terminalDrive = await terminalProvider.start({
    body: "initial", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  terminal.output(...claudeResult(1));
  terminal.end();
  await terminalDrive.completion;
  assert.deepEqual(await terminalDrive.tell!({ id: "late", text: "too late" }), { kind: "turn-ended" });

  const failing = controlledClaude();
  const failingProvider = createClaudeProvider(async () => failing.sdk);
  const failingDrive = await failingProvider.start({
    body: "initial", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  const submission = failingDrive.tell!({ id: "failed", text: "not accepted" });
  await failing.receiveInput();
  failing.fail(new Error("native input failed"));
  await assert.rejects(submission, /native input failed/u);
  assert.deepEqual(await failingDrive.completion, { kind: "failed", diagnostic: "native input failed" });
});

test("Claude successful terminality wins over an in-flight tell acknowledgement", async () => {
  const harness = controlledClaude();
  const provider = createClaudeProvider(async () => harness.sdk);
  const drive = await provider.start({
    body: "initial", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  const submission = drive.tell!({ id: "ended-race", text: "too late" });
  const yielded = await harness.receiveInput();
  assert.equal(yielded.done, false);
  harness.output(...claudeResult(1));
  harness.end();
  assert.deepEqual(await submission, { kind: "turn-ended" });
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done 1", historyId: "assistant-live-1" });
});

test("Claude abort rejects an unacknowledged tell and settles the Query", async () => {
  const harness = controlledClaude();
  const provider = createClaudeProvider(async () => harness.sdk);
  const drive = await provider.start({
    body: "initial", launchTells: [], cwd: "/work", options: {}, session: { kind: "fresh" },
  });
  const submission = drive.tell!({ id: "aborted", text: "pending" });
  await harness.receiveInput();
  await drive.abort();
  await assert.rejects(submission, /aborted/u);
  assert.equal((await drive.completion).kind, "failed");
});

test("Claude fork maps the exact native pair and returns a distinct child coordinate", async () => {
  const calls: unknown[] = [];
  const provider = createClaudeProvider(async () => ({
    query() { throw new Error("fork must not resume the source query"); },
    async forkSession(sessionId, options) {
      calls.push({ sessionId, options });
      return { sessionId: "child-session" };
    },
  }));

  assert.deepEqual(await provider.fork!({
    session: { sessionId: "source-session" },
    at: "outer-assistant-uuid",
    cwd: "/work",
  }), { session: { sessionId: "child-session" } });
  assert.deepEqual(calls, [{
    sessionId: "source-session",
    options: { dir: "/work", upToMessageId: "outer-assistant-uuid" },
  }]);
});

test("Claude fork rejects an unavailable primitive and dishonest child coordinates", async () => {
  const unavailable = createClaudeProvider(async () => ({
    query() { throw new Error("unused"); },
  }));
  await assert.rejects(
    unavailable.fork!({ session: { sessionId: "source" }, at: "point", cwd: "/work" }),
    /does not expose forkSession/,
  );

  for (const child of ["", "source"]) {
    const provider = createClaudeProvider(async () => ({
      query() { throw new Error("unused"); },
      async forkSession() { return { sessionId: child }; },
    }));
    await assert.rejects(
      provider.fork!({ session: { sessionId: "source" }, at: "point", cwd: "/work" }),
      child === "" ? /empty child session id/ : /reused the source session id/,
    );
  }
});

test("Claude fork refuses a frozen environment it cannot apply", async () => {
  let loaded = false;
  const provider = createClaudeProvider(async () => {
    loaded = true;
    return {
      query() { throw new Error("unused"); },
      async forkSession() { return { sessionId: "child" }; },
    };
  }, { env: { CLAUDE_CONFIG_DIR: "/configured" } });
  await assert.rejects(
    provider.fork!({ session: { sessionId: "source" }, at: "point", cwd: "/work" }),
    /cannot apply the frozen provider environment/u,
  );
  assert.equal(loaded, false);
});

test("Codex observation dispositions pin every currently known method and item", () => {
  assert.deepEqual(CODEX_NOTIFICATION_DISPOSITIONS, {
    "account/login/completed": "drop",
    "account/rateLimits/updated": "drop",
    "account/updated": "drop",
    "app/list/updated": "drop",
    "command/exec/outputDelta": "drop",
    configWarning: "note",
    deprecationNotice: "note",
    error: "error",
    "externalAgentConfig/import/completed": "note",
    "externalAgentConfig/import/progress": "note",
    "fs/changed": "note",
    "fuzzyFileSearch/sessionCompleted": "drop",
    "fuzzyFileSearch/sessionUpdated": "drop",
    guardianWarning: "note",
    "hook/completed": "drop",
    "hook/started": "note",
    "item/agentMessage/delta": "drop",
    "item/autoApprovalReview/completed": "note",
    "item/autoApprovalReview/started": "note",
    "item/commandExecution/outputDelta": "drop",
    "item/commandExecution/terminalInteraction": "drop",
    "item/completed": "item-completed",
    "item/fileChange/outputDelta": "drop",
    "item/fileChange/patchUpdated": "drop",
    "item/mcpToolCall/progress": "drop",
    "item/plan/delta": "drop",
    "item/reasoning/summaryPartAdded": "drop",
    "item/reasoning/summaryTextDelta": "drop",
    "item/reasoning/textDelta": "drop",
    "item/started": "item-started",
    "mcpServer/oauthLogin/completed": "drop",
    "mcpServer/startupStatus/updated": "drop",
    "model/rerouted": "note",
    "model/safetyBuffering/updated": "drop",
    "model/verification": "drop",
    "process/exited": "drop",
    "process/outputDelta": "drop",
    "rawResponse/completed": "drop",
    "rawResponseItem/completed": "drop",
    "remoteControl/status/changed": "drop",
    "serverRequest/resolved": "drop",
    "skills/changed": "drop",
    "thread/archived": "drop",
    "thread/closed": "drop",
    "thread/compacted": "drop",
    "thread/deleted": "drop",
    "thread/environment/connected": "drop",
    "thread/environment/disconnected": "drop",
    "thread/goal/cleared": "note",
    "thread/goal/updated": "note",
    "thread/name/updated": "drop",
    "thread/realtime/closed": "drop",
    "thread/realtime/error": "note",
    "thread/realtime/itemAdded": "drop",
    "thread/realtime/outputAudio/delta": "drop",
    "thread/realtime/sdp": "drop",
    "thread/realtime/started": "drop",
    "thread/realtime/transcript/delta": "drop",
    "thread/realtime/transcript/done": "drop",
    "thread/settings/updated": "drop",
    "thread/started": "drop",
    "thread/status/changed": "drop",
    "thread/tokenUsage/updated": "drop",
    "thread/unarchived": "drop",
    "turn/completed": "terminal",
    "turn/diff/updated": "drop",
    "turn/moderationMetadata": "note",
    "turn/plan/updated": "plan",
    "turn/started": "drop",
    warning: "note",
    "windows/worldWritableWarning": "note",
    "windowsSandbox/setupCompleted": "note",
  });
  assert.deepEqual(CODEX_ITEM_DISPOSITIONS, {
    agentMessage: "assistant",
    collabAgentToolCall: "tool",
    commandExecution: "tool",
    contextCompaction: "drop",
    dynamicToolCall: "tool",
    enteredReviewMode: "note",
    exitedReviewMode: "note",
    fileChange: "tool",
    hookPrompt: "drop",
    imageGeneration: "tool",
    imageView: "tool",
    mcpToolCall: "tool",
    plan: "plan",
    reasoning: "thought",
    sleep: "note",
    subAgentActivity: "note",
    userMessage: "drop",
    webSearch: "tool",
  });
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
      env: { SETTINGS_LITERAL: "from-settings" },
    });
    const options = {
      model: "gpt-test",
      effort: "high",
      network: "enabled" as const,
      systemPrompt: "Work precisely.",
    };
    assert.deepEqual(provider.admitOptions(options), { kind: "admitted", options });
    assert.deepEqual(provider.confinement({ cwd: root, options }), { kind: "declared", writableRoots: [root] });
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
    });
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "codex answer", historyId: "turn-1" });
    assert.deepEqual(events[0], { type: "session", coordinate: { sessionId: "thread-fresh" } });
    assert.ok(events.some((event) => event.type === "assistant" && event.text === "codex answer"));

    const requests = fake.requests();
    assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "thread/start", "turn/start"]);
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex readonly admits native enforcement and requests the native read-only sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-readonly-"));
  try {
    const fake = fakeCodex(root);
    const provider = createCodexAppServerProvider(fake.executable);
    const drive = await provider.start({
      body: "inspect",
      launchTells: [],
      cwd: root,
      options: { readonly: true, network: "enabled" },
      session: { kind: "fresh" },
    });
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "codex answer", historyId: "turn-1" });
    assert.ok(events.some((event) => event.type === "assistant" && event.text === "codex answer"));
    const turn = fake.requests().at(-1)!.params as Record<string, unknown>;
    assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: true });
    assert.deepEqual(provider.admitOptions({ readonly: true }), {
      kind: "admitted",
      options: { readonly: true },
      readonly: { enforcement: "native" },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex maps observations without leaking output or unknown payloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-observations-"));
  try {
    const provider = createCodexAppServerProvider(fakeCodex(root, "observations").executable);
    const drive = await provider.start({
      body: "observe", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    const events = [];
    for await (const event of drive.events) events.push(event);

    assert.deepEqual(events, [
      { type: "session", coordinate: { sessionId: "thread-fresh" } },
      { type: "tool", phase: "started", id: "command-1", name: "commandExecution", call: { kind: "run", command: "npm test" } },
      { type: "tool", phase: "completed", id: "command-1", name: "commandExecution", call: { kind: "run", command: "npm test" }, result: { status: "ok", exitCode: 0 } },
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex drains admitted native completion narration before terminal closure", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-terminal-drain-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "terminal-drain").executable).start({
      body: "drain", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    let completionSettled = false;
    void drive.completion.then(() => { completionSettled = true; });
    const events = [];
    for await (const event of drive.events) {
      events.push(event);
      if (event.type === "tool" && event.phase === "completed") assert.equal(completionSettled, false);
    }

    assert.deepEqual(events.slice(1), [
      {
        type: "tool", phase: "started", id: "command-terminal", name: "commandExecution",
        call: { kind: "run", command: "npm test" },
      },
      {
        type: "tool", phase: "completed", id: "command-terminal", name: "commandExecution",
        call: { kind: "run", command: "npm test" }, result: { status: "ok", exitCode: 0 },
      },
    ]);
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex preserves an empty final agent message as the answered turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-empty-answer-"));
  try {
    const provider = createCodexAppServerProvider(fakeCodex(root, "empty-final").executable);
    const drive = await provider.start({
      body: "answer", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(events, [
      { type: "session", coordinate: { sessionId: "thread-fresh" } },
      { type: "assistant", text: "first answer" },
      { type: "assistant", text: "" },
    ]);
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex leaves an unmatched native tool start unmatched at terminal closure", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-terminal-unmatched-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "terminal-unmatched").executable).start({
      body: "observe", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    const events = [];
    for await (const event of drive.events) events.push(event);

    assert.deepEqual(events.slice(1), [{
      type: "tool", phase: "started", id: "command-terminal", name: "commandExecution",
      call: { kind: "run", command: "npm test" },
    }]);
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex terminal drain has a bounded fallback for a hung producer", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-terminal-hang-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "terminal-hang").executable).start({
      body: "observe", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    const started = performance.now();
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
    assert.ok(performance.now() - started < 2_000);
    for await (const _event of drive.events) { /* drain */ }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex settles when the native process exits without turn completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-exit-before-completion-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "exit-before-completion").executable).start({
      body: "exit", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    for await (const _event of drive.events) { /* drain */ }
    assert.deepEqual(await drive.completion, {
      kind: "failed",
      diagnostic: "codex app-server exited before completion (7)",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("Codex failed turns retain native notification and turn diagnostics", async () => {
  for (const [mode, diagnostic] of [
    ["failed-notification", "native request exploded: provider detail"],
    ["failed-turn", "native turn failed: turn detail"],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `keiyaku-codex-${mode}-`));
    try {
      const provider = createCodexAppServerProvider(fakeCodex(root, mode).executable);
      const drive = await provider.start({
        body: "fail", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
      });
      for await (const _event of drive.events) { /* drain */ }
      assert.deepEqual(await drive.completion, { kind: "failed", diagnostic });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Codex app-server resumes and forks only the supplied native coordinates", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-resume-"));
  try {
    const fake = fakeCodex(root);
    const provider = createCodexAppServerProvider(fake.executable);
    const drive = await provider.resume!({
      body: "continue",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "resume", coordinate: { sessionId: "thread-source" } },
    });
    for await (const _event of drive.events) { /* drain */ }
    assert.equal((await drive.completion).kind, "answered");
    assert.deepEqual(await provider.fork!({
      session: { sessionId: "thread-source" },
      at: "turn-exact",
      cwd: root,
    }), { session: { sessionId: "thread-child" } });
    const requests = fake.requests();
    assert.deepEqual(requests.find((request) => request.method === "thread/resume")?.params, {
      threadId: "thread-source",
      cwd: root,
    });
    assert.deepEqual(requests.find((request) => request.method === "thread/fork")?.params, {
      threadId: "thread-source",
      lastTurnId: "turn-exact",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex app-server refuses a Pi coordinate before starting a native process", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-wrong-coordinate-"));
  try {
    const fake = fakeCodex(root);
    const provider = createCodexAppServerProvider(fake.executable);
    await assert.rejects(provider.resume!({
      body: "continue",
      launchTells: [],
      cwd: root,
      options: {},
      session: { kind: "resume", coordinate: { sessionFile: "/sessions/pi.jsonl" } },
    }), /Codex app-server resume requires sessionId/u);
    await assert.rejects(
      provider.fork!({ session: { sessionFile: "/sessions/pi.jsonl" }, at: "turn-1", cwd: root }),
      /Codex app-server fork requires sessionId/u,
    );
    assert.deepEqual(fake.requests(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex app-server abort interrupts and releases its owned child", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-abort-"));
  try {
    const fake = fakeCodex(root, "interrupt");
    const provider = createCodexAppServerProvider(fake.executable);
    const drive = await provider.start({
      body: "wait", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    await drive.abort();
    for await (const _event of drive.events) { /* drain */ }
    assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "codex app-server interrupted" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex app-server live tell steers the admitted turn with exact correlation", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-steer-"));
  try {
    const fake = fakeCodex(root, "steer");
    const drive = await createCodexAppServerProvider(fake.executable).start({
      body: "work", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    assert.ok(drive.tell !== undefined);
    assert.deepEqual(await drive.tell!({ id: "tell-live-1", text: "check the race" }), {
      kind: "accepted",
      fence: "turn-1:tell-live-1",
    });
    assert.equal((await drive.completion).kind, "answered");
    assert.deepEqual(fake.requests().find((request) => request.method === "turn/steer")?.params, {
      threadId: "thread-fresh",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "check the race" }],
      clientUserMessageId: "tell-live-1",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex rejects a steer acknowledgement that remains pending at terminal observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-steer-complete-first-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "steer-complete-first").executable).start({
      body: "work", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    await assert.rejects(
      drive.tell!({ id: "tell-live-pending", text: "check the boundary" }),
      /line RPC process is closed/u,
    );
    assert.equal((await drive.completion).kind, "answered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex live tell rejects a mismatched native turn acknowledgement", async () => {
  for (const [mode, expected] of [
    ["steer-mismatch", /acknowledged a different turn/u],
    ["steer-missing", /did not return a turn id/u],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `keiyaku-codex-${mode}-`));
    try {
      const fake = fakeCodex(root, mode);
      const drive = await createCodexAppServerProvider(fake.executable).start({
        body: "work", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
      });
      await assert.rejects(drive.tell!({ id: "tell-live-2", text: "check the turn" }), expected);
      await drive.abort();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Codex closes a pending rejected steer when completion arrives first", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-steer-rejected-"));
  try {
    const fake = fakeCodex(root, "steer-error-after-complete");
    const drive = await createCodexAppServerProvider(fake.executable).start({
      body: "work", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    await assert.rejects(drive.tell!({ id: "tell-live-error", text: "check rejection" }), /line RPC process is closed/u);
    assert.equal((await drive.completion).kind, "answered");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex terminal closure fails a hung steer acknowledgement without waiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-steer-hung-terminal-"));
  try {
    const drive = await createCodexAppServerProvider(fakeCodex(root, "steer-hung-terminal").executable).start({
      body: "work", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    await assert.rejects(
      drive.tell!({ id: "tell-live-hung", text: "never acknowledged" }),
      /line RPC process is closed/u,
    );
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "", historyId: "turn-1" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
