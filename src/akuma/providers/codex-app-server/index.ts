import { LineRpcProcess } from "../../../runtime/proc/line-rpc.js";
import {
  AgentEventChannel,
  AKUMA_REQUESTS_ENV,
  type Session,
  type ProviderAdapter,
  type TurnResult,
} from "../../provider.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { codexNotificationResult, codexObject, codexText, type CodexTurnState } from "./events.js";

export { CODEX_ITEM_DISPOSITIONS, CODEX_NOTIFICATION_DISPOSITIONS } from "./events.js";

type StartInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
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
  const value = codexObject(result);
  const thread = codexObject(value?.thread) ?? value;
  const id = codexText(thread?.id) ?? fallback;
  if (id === undefined) throw new Error("codex app-server did not return a thread id");
  return id;
}

function turnId(result: unknown): string {
  const value = codexObject(result);
  const turn = codexObject(value?.turn) ?? value;
  const id = codexText(turn?.id);
  if (id === undefined) throw new Error("codex app-server did not return a turn id");
  return id;
}

async function steerTurn(
  server: LineRpcProcess,
  state: CodexTurnState,
  tell: Readonly<{ id: string; text: string }>,
): ReturnType<NonNullable<Session["tell"]>> {
  if (state.settled) return { kind: "turn-ended" };
  if (state.threadId === undefined || state.turnId === undefined)
    throw new Error("codex app-server turn is not admitted");
  const request = server.request("turn/steer", {
    threadId: state.threadId,
    expectedTurnId: state.turnId,
    input: [{ type: "text", text: tell.text }],
    clientUserMessageId: tell.id,
  });
  const response = codexObject(await request);
  const accepted = codexText(response?.turnId);
  if (accepted === undefined) throw new Error("codex app-server steer did not return a turn id");
  if (accepted !== state.turnId) throw new Error("codex app-server steer acknowledged a different turn");
  return { kind: "accepted", fence: `${accepted}:${tell.id}` };
}

function sandbox(
  cwd: string,
  options: ProviderOptions,
  requests?: Readonly<{ dir: string }>,
): Readonly<Record<string, unknown>> {
  if (options.readonly === true) {
    return { type: "readOnly", networkAccess: options.network === "enabled" };
  }
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
  state: CodexTurnState,
  events: AgentEventChannel,
  config?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await initialize(server);
  const threadParams = {
    cwd: input.cwd,
    ...(config === undefined ? {} : { config }),
    ...(input.options.model === undefined ? {} : { model: input.options.model }),
    ...(input.options.systemPrompt === undefined || input.options.systemPrompt.length === 0
      ? {}
      : input.options.systemPromptMode === "replace"
        ? { baseInstructions: input.options.systemPrompt }
        : { developerInstructions: input.options.systemPrompt }),
  };
  if (input.session.kind === "fresh") {
    state.threadId = threadId(await server.request("thread/start", threadParams));
  } else {
    state.threadId = threadId(
      await server.request("thread/resume", {
        threadId: input.session.coordinate.sessionId,
        ...threadParams,
      }),
      input.session.coordinate.sessionId,
    );
  }
  events.emit({ type: "session", coordinate: { sessionId: state.threadId } });
  state.turnId = turnId(
    await server.request("turn/start", {
      threadId: state.threadId,
      input: [
        {
          type: "text",
          text: [input.body, ...input.launchTells.map((tell) => tell.text)]
            .filter((part) => part.length > 0)
            .join("\n\n"),
        },
      ],
      ...(input.options.model === undefined ? {} : { model: input.options.model }),
      ...(input.options.effort === undefined ? {} : { effort: input.options.effort }),
      approvalPolicy: "never",
      sandboxPolicy: sandbox(input.cwd, input.options, input.requests),
    }),
  );
}

async function forkCodex(
  execution: ProviderExecution,
  input: ForkInput,
): Promise<Readonly<{ session: { sessionId: string } }>> {
  if (!("sessionId" in input.session)) throw new Error("Codex app-server fork requires sessionId");
  const server = new LineRpcProcess({
    argv: [execution.executable ?? "codex", "app-server", "--listen", "stdio://"],
    cwd: input.cwd,
    ...(execution.env === undefined ? {} : { env: { ...process.env, ...execution.env } }),
  });
  try {
    await initialize(server);
    const child = threadId(
      await server.request("thread/fork", {
        threadId: input.session.sessionId,
        lastTurnId: input.at,
      }),
    );
    if (child === input.session.sessionId) throw new Error("Codex app-server fork reused the source thread id");
    return { session: { sessionId: child } };
  } finally {
    await server.close();
  }
}

async function abortTurn(server: LineRpcProcess, state: CodexTurnState, settle: Finish): Promise<void> {
  if (!state.settled) settle({ kind: "failed", diagnostic: "codex app-server interrupted" });
  await server.close(true);
}

function codexServer(execution: ProviderExecution, input: StartInput): LineRpcProcess {
  return new LineRpcProcess({
    argv: [execution.executable ?? "codex", "app-server", "--listen", "stdio://"],
    cwd: input.cwd,
    ...(execution.env === undefined && input.requests === undefined
      ? {}
      : {
          env: {
            ...process.env,
            ...execution.env,
            ...(input.requests === undefined ? {} : { [AKUMA_REQUESTS_ENV]: input.requests.dir }),
          },
        }),
  });
}

async function startCodex(execution: ProviderExecution, input: StartInput): Promise<Session> {
  const signal = input.signal ?? new AbortController().signal;
  if (input.session.kind === "resume" && !("sessionId" in input.session.coordinate))
    throw new Error("Codex app-server resume requires sessionId");
  const events = new AgentEventChannel();
  const server = codexServer(execution, input);
  const state: CodexTurnState = { settled: false, tools: new Map() };
  let settle!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => {
    settle = resolve;
  });
  let terminal: TurnResult | undefined;
  const finish: Finish = (result) => {
    if (terminal !== undefined) return;
    terminal = result;
    state.settled = true;
    void server.endInputAndDrain().then(
      () => {
        events.end();
        settle(result);
      },
      () => {
        events.end();
        settle(result);
      },
    );
  };
  server.onNotification((notification) => {
    const result = codexNotificationResult(notification, state, events);
    if (result !== undefined) finish(result);
  });
  server.onExit(({ code, signal, stderr }) =>
    finish({
      kind: "failed",
      diagnostic: stderr || `codex app-server exited before completion (${code ?? signal ?? "unknown"})`,
    }),
  );
  server.onServerRequest((request) =>
    finish({
      kind: "failed",
      diagnostic: `codex app-server made forbidden interactive request ${request.method}`,
    }),
  );
  const abortSetup = () => {
    void server.close(true);
  };
  signal.addEventListener("abort", abortSetup, { once: true });
  try {
    signal.throwIfAborted();
    await admitTurn(server, input, state, events, execution.config);
  } catch (error) {
    if (signal.aborted) {
      await server.close(true);
      throw signal.reason;
    }
    finish({ kind: "failed", diagnostic: diagnostic(error) });
  } finally {
    signal.removeEventListener("abort", abortSetup);
  }
  if (state.turnId === undefined) throw new Error("codex app-server did not admit a turn");
  return {
    admission: { fence: state.turnId },
    events,
    completion,
    abort: () => abortTurn(server, state, finish),
    forceDispose: async () => {
      if (!state.settled) settle({ kind: "failed", diagnostic: "codex app-server force-disposed" });
      await server.close(true);
    },
    tell: (tell) => steerTurn(server, state, tell),
  };
}

export function createCodexAppServerProvider(input: string | ProviderExecution = "codex"): ProviderAdapter {
  const execution: ProviderExecution =
    typeof input === "string" ? { name: "codex-app-server", kind: "codex-app-server", executable: input } : input;
  return {
    admitOptions(options) {
      return {
        kind: "admitted",
        options: Object.freeze({ ...options }),
        ...(options.readonly === undefined ? {} : { readonly: { enforcement: "native" as const } }),
      };
    },
    fork: (input) => forkCodex(execution, input),
    start: (input) => startCodex(execution, input),
    resume: (input) => startCodex(execution, input),
  };
}
