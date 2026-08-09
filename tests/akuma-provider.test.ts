import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeProvider } from "../src/akuma/providers/claude.js";
import { createCodexAppServerProvider } from "../src/akuma/providers/codex-app-server.js";

function fakeCodex(root: string, mode: "complete" | "interrupt" = "complete"): Readonly<{
  executable: string;
  requests(): readonly Readonly<Record<string, unknown>>[];
  requestEnvironment(): string;
}> {
  const executable = join(root, "codex");
  const log = join(root, "requests.jsonl");
  const environment = join(root, "request-environment.txt");
  writeFileSync(executable, [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');",
    "const readline=require('node:readline');",
    `const log=${JSON.stringify(log)};`,
    `fs.writeFileSync(${JSON.stringify(environment)},process.env.AKUMA_REQUESTS||'');`,
    `const mode=${JSON.stringify(mode)};`,
    "const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');",
    "const reply=(message,result)=>send({id:message.id,result});",
    "readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',(line)=>{",
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
    requestEnvironment: () => readFileSync(environment, "utf8"),
  };
}

function fakeQuery(messages: readonly SDKMessage[]): Query {
  return (async function* () {
    for (const message of messages) yield message;
  })() as unknown as Query;
}

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
      ]);
    },
  }));
  const drive = await provider.start({ prompt: "build it", cwd: "/work", options: {} });
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
      } as unknown as SDKMessage]);
    },
  }));
  const drive = await provider.start({
    prompt: "continue",
    cwd: "/work",
    options: {},
    session: { sessionId: "session-1" },
  });
  for await (const _event of drive.events) { /* drain */ }
  assert.equal(resume, "session-1");
  assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "native resume failed" });
});

test("Claude never substitutes a result UUID for the assistant fork point", async () => {
  const provider = createClaudeProvider(async () => ({
    query() {
      return fakeQuery([{
        type: "result",
        subtype: "success",
        session_id: "session-without-assistant",
        uuid: "result-only-uuid",
        result: "done",
      } as unknown as SDKMessage]);
    },
  }));
  const drive = await provider.start({ prompt: "build", cwd: "/work", options: {} });
  for await (const _event of drive.events) { /* drain */ }
  assert.deepEqual(await drive.completion, {
    kind: "failed",
    diagnostic: "Claude query succeeded without an assistant history id",
  });
});

test("Claude never substitutes a sidechain assistant UUID for the outer fork point", async () => {
  const provider = createClaudeProvider(async () => ({
    query() {
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
      ]);
    },
  }));
  const drive = await provider.start({ prompt: "delegate", cwd: "/work", options: {} });
  for await (const _event of drive.events) { /* drain */ }
  assert.deepEqual(await drive.completion, {
    kind: "answered",
    answer: "done",
    historyId: "outer-assistant-uuid",
  });
});

test("Claude adapter consumes the admitted Persona options", async () => {
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
      ]);
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
  const drive = await provider.start({ prompt: "inspect", cwd: "/work", options: admitted.options });
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
    diagnostic: "Claude provider does not support the Persona network option",
  });
});

test("Claude start consumes its admitted snapshot without a second admission", async () => {
  let called = false;
  const provider = createClaudeProvider(async () => ({
    query() {
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
      ]);
    },
  }));
  const drive = await provider.start({
    prompt: "continue",
    cwd: "/work",
    options: { network: "disabled" },
  });
  for await (const _event of drive.events) { /* drain */ }
  assert.deepEqual(await drive.completion, { kind: "answered", answer: "done", historyId: "assistant-history-snapshot" });
  assert.equal(called, true);
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

test("Codex app-server maps admitted options, native session, answer, and exact turn history", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-provider-"));
  try {
    const fake = fakeCodex(root);
    const provider = createCodexAppServerProvider(fake.executable);
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
      prompt: "build",
      cwd: root,
      options,
      requests: { dir: requestDirectory },
    });
    const events = [];
    for await (const event of drive.events) events.push(event);
    assert.deepEqual(await drive.completion, { kind: "answered", answer: "codex answer", historyId: "turn-1" });
    assert.deepEqual(events[0], { type: "session", coordinate: { sessionId: "thread-fresh" } });
    assert.ok(events.some((event) => event.type === "assistant" && event.text === "codex answer"));

    const requests = fake.requests();
    assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "thread/start", "turn/start"]);
    const thread = requests[2]!.params as Record<string, unknown>;
    assert.deepEqual(thread, { cwd: root, model: "gpt-test", developerInstructions: "Work precisely." });
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
    assert.equal(fake.requestEnvironment(), requestDirectory);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex app-server resumes and forks only the supplied native coordinates", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-codex-resume-"));
  try {
    const fake = fakeCodex(root);
    const provider = createCodexAppServerProvider(fake.executable);
    const drive = await provider.start({
      prompt: "continue",
      cwd: root,
      options: {},
      session: { sessionId: "thread-source" },
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
    const drive = await provider.start({ prompt: "wait", cwd: root, options: {} });
    await drive.abort();
    for await (const _event of drive.events) { /* drain */ }
    assert.deepEqual(await drive.completion, { kind: "failed", diagnostic: "codex app-server turn ended interrupted" });
    assert.deepEqual(fake.requests().find((request) => request.method === "turn/interrupt")?.params, {
      threadId: "thread-fresh",
      turnId: "turn-1",
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
