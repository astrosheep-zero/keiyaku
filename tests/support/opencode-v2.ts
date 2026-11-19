import type { ModelRef, ServerInfo, SessionInboxUser, SessionInfo } from "@opencode/client";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { TestContext } from "node:test";
import { Agent } from "undici";
import { NativeOpencodeRuntime, type RuntimeOpener } from "../../src/akuma/providers/opencode-sdk/session.js";
import { processExists, waitForCondition, waitForFixtureFile, waitForProcessExit } from "./process.js";

export function ownedOpenCode(context: TestContext, cwd: string) {
  const fixture = new URL("./opencode-native-server.mjs", import.meta.url).href;
  writeFileSync(join(cwd, "serve"), `void import(${JSON.stringify(fixture)});`);
  const recorded = join(cwd, "opencode-child.json");
  const read = () => JSON.parse(readFileSync(recorded, "utf8")) as { pid: number; env: NodeJS.ProcessEnv };
  let observed: ReturnType<typeof read> | undefined;
  const child = async () => {
    await waitForFixtureFile(recorded);
    return (observed ??= read());
  };
  context.after(async () => {
    let pid: number;
    try {
      ({ pid } = observed ?? read());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (processExists(pid)) {
      process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid);
    }
  });
  return { child, executable: process.execPath };
}

export function failDispatcherRetirement(context: TestContext, message: string) {
  const destroy: (this: Agent, callback: () => void) => void = Agent.prototype.destroy;
  return context.mock.method(Agent.prototype, "destroy", async function (this: Agent) {
    // Use the direct callback overload: the promise overload calls this.destroy again.
    await new Promise<void>((resolve) => destroy.call(this, resolve));
    throw new Error(message);
  });
}

export const nativeInfo: ServerInfo = { version: "2.0.20", pid: process.pid, urls: [], paths: { tmp: "/tmp" } };
export const nativeAuth = `Basic ${Buffer.from("opencode:test-password").toString("base64")}`;

export function json(response: http.ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function sse(response: http.ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
}

export function nativeEndpoint(
  context: TestContext,
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void> | void,
) {
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    void Promise.resolve()
      .then(async () => {
        assert.equal(request.headers.authorization, nativeAuth);
        await handler(request, response);
      })
      .catch((error: unknown) => response.destroy(error as Error));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let listening: Promise<void> | undefined;
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const open: RuntimeOpener = async (input) => {
    listening ??= new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await listening;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await NativeOpencodeRuntime.open(input, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      password: "test-password",
    });
  };
  return { open, sockets, retired: () => until(() => sockets.size === 0, "OpenCode client sockets closed") };
}

type WireRequest = { method: string; path: string; body?: unknown };
export function opencodeFixture(context: TestContext) {
  const id = "ses_fixture";
  const sessionPath = `/api/session/${id}`;
  const instructionsPath = `/api/experimental/session/${id}/instructions/entries`;
  const prompts: { body: { id: string; text: string } }[] = [];
  const calls: WireRequest[] = [];
  const messages = new Map<string, Record<string, unknown>>();
  const controls: {
    onPrompt?: (id: string) => void;
    onInterrupt?: () => Promise<void>;
    rejectPrompt?: string;
    busy?: boolean;
    resumeID?: string;
  } = {};
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let selected: ModelRef | undefined;
  let feed: http.ServerResponse | undefined;
  let subscriptions = 0;
  let sequence = 0;
  const model = { providerID: "vendor", id: "model" };
  const push = (type: string, data: Record<string, unknown> = {}, eventID = "evt_event") => {
    assert.ok(feed && !feed.destroyed, "a live native subscription must precede events");
    sse(feed, {
      id: eventID,
      type,
      created: 1,
      durable: { aggregateID: id, seq: ++sequence, version: 1 },
      data: { sessionID: id, ...data },
    });
  };
  const sessionInfo = (sessionID: string, fork?: SessionInfo["fork"]): SessionInfo => ({
    id: sessionID,
    projectID: "project_fixture",
    agent: "build",
    cost: 0,
    tokens,
    location: { directory: "/tmp" },
    time: { created: 1, updated: 1 },
    ...(selected === undefined ? {} : { model: selected }),
    ...(fork === undefined ? {} : { fork }),
  });
  const endpoint = nativeEndpoint(context, async (request, response) => {
    const { method = "", url = "" } = request;
    const { pathname, search } = new URL(url, "http://127.0.0.1");
    if (pathname === "/api/info") return json(response, nativeInfo);
    if (pathname === "/api/event") {
      subscriptions += 1;
      feed = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      sse(response, { type: "server.connected", data: {} });
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = raw === "" ? undefined : JSON.parse(raw);
    calls.push({ method, path: pathname + search, ...(body === undefined ? {} : { body }) });
    if (method === "POST" && pathname === "/api/session") {
      selected = body.model;
      return json(response, { data: sessionInfo(id) });
    }
    if (pathname === "/api/session/active")
      return json(response, { data: controls.busy ? { [id]: { type: "running" } } : {} });
    if (pathname === sessionPath) return json(response, { data: sessionInfo(controls.resumeID ?? id) });
    if (pathname === `${sessionPath}/model`) {
      selected = body.model;
      response.writeHead(204).end();
      return;
    }
    if (pathname.startsWith(`${instructionsPath}/`)) {
      response.writeHead(204).end();
      return;
    }
    if (pathname === `${sessionPath}/prompt`) {
      if (controls.rejectPrompt !== undefined)
        return json(response, { _tag: "SessionBusyError", sessionID: id, message: controls.rejectPrompt }, 409);
      prompts.push({ body });
      controls.onPrompt?.(body.id);
      const admission: SessionInboxUser = {
        id: body.id,
        type: "user",
        sessionID: id,
        time: { created: 1 },
        payload: { text: body.text },
        delivery: "steer",
      };
      return json(response, { data: admission });
    }
    if (pathname.startsWith(`${sessionPath}/message/`)) {
      const messageID = decodeURIComponent(pathname.slice(`${sessionPath}/message/`.length));
      const message = messages.get(messageID);
      return message !== undefined
        ? json(response, { data: message })
        : json(response, { _tag: "MessageNotFoundError", sessionID: id, messageID, message: "message not found" }, 404);
    }
    if (pathname === `${sessionPath}/interrupt`) {
      await controls.onInterrupt?.();
      return json(response, { interrupted: true });
    }
    if (pathname === `${sessionPath}/fork`) {
      return json(response, {
        data: sessionInfo("ses_child", { sessionID: id, boundary: { type: "before", messageID: body.before } }),
      });
    }
    response.writeHead(404).end();
  });
  const admitted = (nativeID: string) =>
    push("session.inbox.enqueued", {
      inboxID: nativeID,
      item: { type: "user", payload: { text: "input" }, delivery: "steer" },
    });
  const delivered = (nativeID: string) => push("session.inbox.delivered", { inboxID: nativeID });
  const step = (assistantMessageID = "msg_assistant") =>
    push("session.step.started", { assistantMessageID, model, agent: "build" });
  const complete = (text = "answer", assistantID = "msg_assistant", terminalID = "evt_terminal") => {
    messages.set(assistantID, {
      id: assistantID,
      type: "assistant",
      time: { created: 1, completed: 2 },
      agent: "build",
      model,
      content: [{ type: "text", text }],
    });
    const boundary = terminalID.replace(/^evt_/u, "msg_");
    messages.set(boundary, { id: boundary, type: "idle", outcome: "succeeded", time: { created: 2 } });
    push("session.text.ended", { assistantMessageID: assistantID, ordinal: 0, text });
    push("session.step.ended", { assistantMessageID: assistantID, finish: "stop", cost: 0, tokens });
    push("session.execution.succeeded", {}, terminalID);
  };
  return {
    ...endpoint,
    id,
    sessionPath,
    instructionsPath,
    controls,
    prompts,
    calls,
    messages,
    push,
    admitted,
    delivered,
    step,
    complete,
    get subscriptions() {
      return subscriptions;
    },
    disconnect: () => feed?.end(),
    input: {
      launchTells: [{ id: "launch", text: "launch" }],
      cwd: "/tmp",
      options: {},
      signal: new AbortController().signal,
      session: { kind: "fresh" as const },
    },
  };
}

export async function until(check: () => boolean, label = "native OpenCode event"): Promise<void> {
  await waitForCondition(label, check, { budgetMs: 5_000 });
}
