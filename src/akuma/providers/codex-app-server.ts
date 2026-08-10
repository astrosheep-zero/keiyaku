import { LineRpcProcess } from "../../runtime/proc/line-rpc.js";
import {
  codexNotificationResult,
  codexObject as object,
  codexText as text,
  type CodexTurnState as TurnState,
} from "./codex-app-server-events.js";
import {
  AgentEventChannel,
  AKUMA_REQUESTS_ENV,
  type Drive,
  type ProviderAdapter,
  type ProviderOptions,
  type TurnResult,
} from "../provider.js";
import type { ProviderExecution } from "../heart/index.js";

export { CODEX_ITEM_DISPOSITIONS, CODEX_NOTIFICATION_DISPOSITIONS } from "./codex-app-server-events.js";

type StartInput = Parameters<ProviderAdapter["start"]>[0];
type ForkInput = Parameters<NonNullable<ProviderAdapter["fork"]>>[0];
type Finish = (result: TurnResult) => void;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function initialize(server: LineRpcProcess): Promise<void> {
  await server.request("initialize", {
    clientInfo: { name: "keiyaku", title: "keiyaku", version: "4" },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  server.notify("initialized");
}

function threadId(result: unknown, fallback?: string): string {
  const value = object(result);
  const thread = object(value?.thread) ?? value;
  const id = text(thread?.id) ?? fallback;
  if (id === undefined) throw new Error("codex app-server did not return a thread id");
  return id;
}

function turnId(result: unknown): string {
  const value = object(result);
  const turn = object(value?.turn) ?? value;
  const id = text(turn?.id);
  if (id === undefined) throw new Error("codex app-server did not return a turn id");
  return id;
}

function sandbox(cwd: string, options: ProviderOptions, requests?: Readonly<{ dir: string }>): Readonly<Record<string, unknown>> {
  return {
    type: "workspaceWrite",
    writableRoots: [cwd, ...(requests === undefined ? [] : [requests.dir])],
    networkAccess: options.network === "enabled",
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

async function admitTurn(
  server: LineRpcProcess,
  input: StartInput,
  state: TurnState,
  events: AgentEventChannel,
  config?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await initialize(server);
  const threadParams = {
    cwd: input.cwd,
    ...(config === undefined ? {} : { config }),
    ...(input.options.model === undefined ? {} : { model: input.options.model }),
    ...(input.options.systemPrompt === undefined || input.options.systemPrompt.length === 0
      ? {} : { developerInstructions: input.options.systemPrompt }),
  };
  state.threadId = input.session === undefined
    ? threadId(await server.request("thread/start", threadParams))
    : threadId(await server.request("thread/resume", {
      threadId: input.session.sessionId,
      ...threadParams,
    }), input.session.sessionId);
  events.emit({ type: "session", coordinate: { sessionId: state.threadId } });
  state.turnId = turnId(await server.request("turn/start", {
    threadId: state.threadId,
    input: [{ type: "text", text: input.prompt }],
    ...(input.options.model === undefined ? {} : { model: input.options.model }),
    ...(input.options.effort === undefined ? {} : { effort: input.options.effort }),
    approvalPolicy: "never",
    sandboxPolicy: sandbox(input.cwd, input.options, input.requests),
  }));
}

async function forkCodex(execution: ProviderExecution, input: ForkInput): Promise<Readonly<{ session: { sessionId: string } }>> {
  const server = new LineRpcProcess({
    argv: [execution.executable ?? "codex", "app-server", "--listen", "stdio://"],
    cwd: input.cwd,
    ...(execution.env === undefined ? {} : { env: { ...process.env, ...execution.env } }),
  });
  try {
    await initialize(server);
    const child = threadId(await server.request("thread/fork", {
      threadId: input.session.sessionId,
      lastTurnId: input.at,
    }));
    if (child === input.session.sessionId) throw new Error("Codex app-server fork reused the source thread id");
    return { session: { sessionId: child } };
  } finally { await server.close(); }
}

async function abortTurn(
  server: LineRpcProcess,
  state: TurnState,
  completion: Promise<TurnResult>,
  finish: Finish,
): Promise<void> {
  if (!state.settled && state.threadId !== undefined && state.turnId !== undefined) {
    try {
      await server.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId });
      await completion;
    } catch (error) { finish({ kind: "failed", diagnostic: diagnostic(error) }); }
  } else if (!state.settled) {
    finish({ kind: "failed", diagnostic: "codex app-server aborted before turn admission" });
  }
  await server.close(true);
}

async function startCodex(execution: ProviderExecution, input: StartInput): Promise<Drive> {
  const events = new AgentEventChannel();
  const server = new LineRpcProcess({
    argv: [execution.executable ?? "codex", "app-server", "--listen", "stdio://"],
    cwd: input.cwd,
    ...((execution.env === undefined && input.requests === undefined) ? {} : { env: {
      ...process.env,
      ...execution.env,
      ...(input.requests === undefined ? {} : { [AKUMA_REQUESTS_ENV]: input.requests.dir }),
    } }),
  });
  const state: TurnState = { answers: [], settled: false, tools: new Map() };
  let settle!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => { settle = resolve; });
  const finish: Finish = (result) => {
    if (state.settled) return;
    state.settled = true;
    events.end();
    void server.close().then(
      () => settle(result),
      (error: unknown) => settle({ kind: "failed", diagnostic: `codex app-server cleanup failed: ${diagnostic(error)}` }),
    );
  };
  server.onExit(({ code, signal, stderr }) => finish({
    kind: "failed",
    diagnostic: stderr || `codex app-server exited before completion (${code ?? signal ?? "unknown"})`,
  }));
  server.onServerRequest((request) => finish({
    kind: "failed",
    diagnostic: `codex app-server made forbidden interactive request ${request.method}`,
  }));
  server.onNotification((notification) => {
    const result = codexNotificationResult(notification, state, events);
    if (result !== undefined) finish(result);
  });
  try { await admitTurn(server, input, state, events, execution.config); }
  catch (error) { finish({ kind: "failed", diagnostic: diagnostic(error) }); }
  return {
    events,
    completion,
    abort: () => abortTurn(server, state, completion, finish),
  };
}

export function createCodexAppServerProvider(input: string | ProviderExecution = "codex"): ProviderAdapter {
  const execution: ProviderExecution = typeof input === "string"
    ? { name: "codex-app-server", kind: "codex-app-server", executable: input }
    : input;
  return {
    confinement: ({ cwd }) => ({ kind: "declared", writableRoots: [cwd] }),
    admitOptions(options) {
      if (options.access !== undefined && options.access !== "write") {
        return { kind: "refused", diagnostic: "Codex app-server supports only access: write" };
      }
      return { kind: "admitted", options: Object.freeze({ ...options }) };
    },
    fork: (input) => forkCodex(execution, input),
    start: (input) => startCodex(execution, input),
  };
}

export const codexAppServerProvider = createCodexAppServerProvider();
