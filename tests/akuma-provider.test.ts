import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AGENT_EVENT_TEXT_LIMIT,
  decodeAgentEvent,
  encodeAgentEvent,
  noteEvent,
  type AgentEvent,
} from "../src/akuma/provider.js";
import {
  CLAUDE_MESSAGE_DISPOSITIONS,
  CLAUDE_SYSTEM_DISPOSITIONS,
  createClaudeProvider,
} from "../src/akuma/providers/claude/index.js";
import {
  CODEX_ITEM_DISPOSITIONS,
  CODEX_NOTIFICATION_DISPOSITIONS,
  createCodexAppServerProvider,
} from "../src/akuma/providers/codex-app-server/index.js";
import { createOpencodeProvider } from "../src/akuma/providers/opencode-sdk/index.js";
import { createEventState, mapEvent, OPENCODE_EVENT_DISPOSITIONS } from "../src/akuma/providers/opencode-sdk/events.js";
import type { OpencodeSdkLoader, OpencodeSdkSession } from "../src/akuma/providers/opencode-sdk/session.js";

function fakeOpencode() {
  let closed = 0;
  const switchedModels: unknown[] = [];
  const events = [
    { id: "event-1", durable: { aggregateID: "session-fresh", seq: 1, version: 1 }, type: "session.next.tool.called", data: { callID: "tool-1", tool: "shell", input: { command: "npm test" } } },
    { id: "event-2", durable: { aggregateID: "session-fresh", seq: 2, version: 1 }, type: "session.next.tool.success", data: { callID: "tool-1" } },
    { id: "event-3", durable: { aggregateID: "session-fresh", seq: 3, version: 1 }, type: "session.next.reasoning.ended", data: { text: "checked" } },
    { id: "event-4", durable: { aggregateID: "session-fresh", seq: 4, version: 1 }, type: "session.next.text.ended", data: { text: "answer" } },
    { id: "event-5", durable: { aggregateID: "session-fresh", seq: 5, version: 1 }, type: "session.next.future", data: { secret: "drop" } },
  ];
  const stream = async function* (): AsyncGenerator<Readonly<{ data: string }>> {
    for (const event of events) yield { data: JSON.stringify(event) };
  };
  const session = {
    async create() { return { data: { data: { id: "session-fresh" } } }; },
    async get() { return { data: { data: { id: "session-resume" } } }; },
    async prompt() { return { data: { data: { id: "prompt-1", admittedSeq: 3, sessionID: "session-fresh", prompt: { text: "" }, delivery: "queue", timeCreated: 1 } } }; },
    async events() { return { stream: stream() }; },
    async wait() { return undefined; },
    async history() { return { data: { data: events, hasMore: false } }; },
    async messages() { return { data: { data: [{ id: "message-1", type: "assistant", time: { created: 1 }, agent: "build", model: { providerID: "p", id: "m" }, content: [{ type: "text", id: "text-1", text: "answer" }] }] } }; },
    async interrupt() { return undefined; },
    async switchModel(input: unknown) { switchedModels.push(input); return undefined; },
  } as unknown as OpencodeSdkSession;
  const loader: OpencodeSdkLoader = async () => ({
    client: {
      v2: { session },
      session: { async fork() { return { data: { id: "session-child" } }; } },
    },
    close: () => { closed += 1; },
  });
  return { loader, closed: () => closed, switchedModels };
}

test("OpenCode V2 adapter admits, maps, completes, and cleans up through a loader fake", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  assert.equal(provider.admitOptions({ access: "write" }).kind, "refused");
  const drive = await provider.start({ body: "build", launchTells: [{ id: "tell-1", text: "also check" }], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  assert.match(drive.admission.fence, /session-fresh:3/u);
  const observed = [];
  for await (const event of drive.events) observed.push(event);
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "answer", historyId: "message-1" });
  assert.deepEqual(observed.map((event) => event.type), ["session", "tool", "tool", "thought", "assistant", "unknown"]);
  assert.equal(JSON.stringify(observed).includes("secret"), false);
  assert.equal(fake.closed(), 1);
});

test("OpenCode V2 adapter resumes the supplied coordinate and forks the exact point", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  const drive = await provider.resume!({ body: "continue", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "resume", coordinate: { sessionId: "session-resume" } } });
  await drive.abort();
  assert.equal((await drive.completion).kind, "failed");
  assert.deepEqual(await provider.fork!({ session: { sessionId: "session-resume" }, at: "message-1", cwd: "/tmp" }), { session: { sessionId: "session-child" } });
});

test("OpenCode V2 abort cleanup does not await an uncooperative native interrupt", async () => {
  let closed = 0;
  const session = {
    async create() { return { data: { data: { id: "session-stuck-interrupt" } } }; },
    async events() { return { stream: (async function* () {})() }; },
    async prompt() { return { data: { data: { id: "prompt-id", admittedSeq: 1 } } }; },
    async wait() { await new Promise<void>(() => undefined); },
    async interrupt() { await new Promise<void>(() => undefined); },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { v2: { session } }, close: () => { closed += 1; } }) });
  const drive = await provider.start({ body: "interrupt", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  await drive.abort();
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "OpenCode session interrupted" });
  assert.equal(closed, 1);
});

test("OpenCode V2 cleans up when prompt admission rejects", async () => {
  let closed = 0;
  const session = {
    async create() { return { data: { data: { id: "session-rejected" } } }; },
    async events() { return { stream: (async function* () {})() }; },
    async prompt() { throw new Error("prompt rejected"); },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { v2: { session } }, close: () => { closed += 1; } }) });
  await assert.rejects(() => provider.start({ body: "fail", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } }), /prompt rejected/u);
  assert.equal(closed, 1);
});

test("OpenCode V2 refuses unsupported options before birth and applies resume model", async () => {
  const fake = fakeOpencode();
  const provider = createOpencodeProvider({ loader: fake.loader });
  assert.equal(provider.admitOptions({ systemPrompt: "must enforce" }).kind, "refused");
  assert.equal(provider.admitOptions({ effort: "high" }).kind, "refused");
  assert.equal(provider.admitOptions({ model: "not-a-provider-model" }).kind, "refused");
  assert.equal(provider.admitOptions({ model: "provider/model", effort: "high" }).kind, "admitted");
  const drive = await provider.resume!({ body: "continue", launchTells: [], cwd: "/tmp", options: { model: "provider/model", effort: "high" }, session: { kind: "resume", coordinate: { sessionId: "session-resume" } } });
  await drive.abort();
  assert.deepEqual(fake.switchedModels, [{ sessionID: "session-resume", model: { providerID: "provider", id: "model", variant: "high" } }]);
});

test("OpenCode V2 pins every installed durable event kind and retains a future fallback", () => {
  assert.equal(OPENCODE_EVENT_DISPOSITIONS["session.next.step.ended"], "dropped");
  const observed: AgentEvent[] = [];
  const emitter = { emit(event: AgentEvent) { observed.push(event); } };
  mapEvent({ id: "step-ended", type: "session.next.step.ended", data: {} }, emitter, createEventState());
  mapEvent({ id: "future", type: "session.next.future", data: {} }, emitter, createEventState());
  assert.deepEqual(observed, [{ type: "unknown", kind: "session.next.future" }]);
});

test("OpenCode V2 fails an idle drain without native assistant evidence", async () => {
  let closed = 0;
  const session = {
    async create() { return { data: { data: { id: "session-idle" } } }; },
    async events() { return { stream: (async function* () {})() }; },
    async prompt() { return { data: { data: { id: "prompt-id", admittedSeq: 1 } } }; },
    async wait() { return undefined; },
    async history() { return { data: { data: [], hasMore: false } }; },
    async messages() { return { data: { data: [] } }; },
    async interrupt() { return undefined; },
  } as unknown as OpencodeSdkSession;
  const provider = createOpencodeProvider({ loader: async () => ({ client: { v2: { session } }, close: () => { closed += 1; } }) });
  const drive = await provider.start({ body: "idle", launchTells: [], cwd: "/tmp", options: {}, session: { kind: "fresh" } });
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "OpenCode completed without a native assistant answer/history point" });
  assert.equal(closed, 1);
});

test("provider activity codec round trips every closed event and tool-call arm", () => {
  const events: readonly AgentEvent[] = [
    { type: "session", coordinate: { sessionId: "native-1" } },
    { type: "assistant", text: "complete answer" },
    { type: "note", text: "Retrying" },
    { type: "unknown", kind: "future/event" },
    { type: "tool", phase: "started", id: "run", name: "Bash", call: { kind: "run", command: "npm test" } },
    { type: "tool", phase: "completed", id: "read", name: "Read", call: { kind: "read", path: "README.md" }, result: { status: "error", message: "missing" } },
    { type: "tool", phase: "started", id: "search", name: "Search", call: { kind: "search", query: "TODO" } },
    { type: "tool", phase: "completed", id: "change", name: "Edit", call: { kind: "fileChange", changes: [{ op: "update", path: "src/a.ts" }] }, result: { status: "ok" } },
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
});

function fakeCodex(
  root: string,
  mode: "complete" | "empty-final" | "interrupt" | "observations" | "failed-notification" | "failed-turn"
    | "terminal-drain" | "terminal-unmatched" | "terminal-hang" | "exit-before-completion" | "steer" | "steer-complete-first"
    | "steer-hung-terminal" | "steer-error-after-complete" | "steer-mismatch" | "steer-missing" = "complete",
): Readonly<{
  executable: string;
  requests(): readonly Readonly<Record<string, unknown>>[];
  requestEnvironment(): Readonly<{ requests: string; literal: string }>;
}> {
  const executable = join(root, "codex");
  const log = join(root, "requests.jsonl");
  const environment = join(root, "request-environment.txt");
  writeFileSync(executable, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');",
    "const readline=require('node:readline');",
    `const log=${JSON.stringify(log)};`,
    `fs.writeFileSync(${JSON.stringify(environment)},JSON.stringify({requests:process.env.AKUMA_REQUESTS||'',literal:process.env.SETTINGS_LITERAL||''}));`,
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

test("Claude never substitutes a result UUID for the assistant fork point", async () => {
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
  assert.deepEqual(await drive.completion, {
    kind: "failed",
    diagnostic: "Claude query succeeded without an assistant history id",
  });
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
    access: "read",
    systemPrompt: "Review only.",
  });
  assert.equal(admitted.kind, "admitted");
  if (admitted.kind !== "admitted") return;
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
    diagnostic: "Claude provider does not support the Archetype network option",
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
      access: "write" as const,
      network: "enabled" as const,
      systemPrompt: "Work precisely.",
    };
    assert.deepEqual(provider.admitOptions(options), { kind: "admitted", options });
    assert.deepEqual(provider.confinement({ cwd: root, options }), { kind: "declared", writableRoots: [root] });
    assert.equal(provider.admitOptions({ access: "read" }).kind, "refused");
    assert.equal(provider.admitOptions({ access: "auto" }).kind, "refused");

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
    assert.deepEqual(fake.requestEnvironment(), { requests: requestDirectory, literal: "from-settings" });
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

test("Codex app-server abort requests native interruption and waits for terminal proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-abort-"));
  try {
    const fake = fakeCodex(root, "interrupt");
    const provider = createCodexAppServerProvider(fake.executable);
    const drive = await provider.start({
      body: "wait", launchTells: [], cwd: root, options: {}, session: { kind: "fresh" },
    });
    await drive.abort();
    for await (const _event of drive.events) { /* drain */ }
    assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "codex app-server turn ended interrupted" });
    assert.deepEqual(fake.requests().find((request) => request.method === "turn/interrupt")?.params, {
      threadId: "thread-fresh",
      turnId: "turn-1",
    });
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
