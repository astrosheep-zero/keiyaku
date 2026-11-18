import { LineRpcProcess } from "../../../runtime/proc/line-rpc.js";
import {
  AgentEventChannel,
  createProviderAttempt,
  launchPrompt,
  modelEvent,
  type AttemptCustody,
  type Session,
  type ProviderAdapter,
  type TurnResult,
} from "../../provider.js";
import { akumaExecutionEnvironment } from "../execution-environment.js";
import { providerLifecycle } from "../lifecycle.js";
import { providerTurn } from "../turn.js";
import type { ProviderExecution } from "../../provider-recipe.js";
import { codexNotificationResult, codexObject, codexText, type CodexTurnState } from "./events.js";

type StartInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
type ForkInput = Parameters<NonNullable<ProviderAdapter["fork"]>>[0];

async function initializeCodex(server: LineRpcProcess): Promise<void> {
  await server.request("initialize", {
    clientInfo: { name: "keiyaku", title: "keiyaku", version: "4" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  server.notify("initialized");
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Thread admission answers with the model the server actually loaded. */
function emitAdmittedModel(result: unknown, events: AgentEventChannel): void {
  const model = codexText(codexObject(result)?.model);
  if (model !== undefined) events.emit(modelEvent(model));
}

async function steerTurn(
  server: LineRpcProcess,
  state: CodexTurnState,
  tell: Readonly<{ id: string; text: string }>,
): ReturnType<NonNullable<Session["tell"]>> {
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

async function admitTurn(
  server: LineRpcProcess,
  input: StartInput,
  state: CodexTurnState,
  events: AgentEventChannel,
  config?: Readonly<Record<string, unknown>>,
): Promise<void> {
  await initializeCodex(server);
  input.signal?.throwIfAborted();
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
    const admitted = await server.request("thread/start", threadParams);
    state.threadId = threadId(admitted);
    emitAdmittedModel(admitted, events);
  } else {
    const resumed = input.session.coordinate.sessionId;
    const admitted = await server.request("thread/resume", { threadId: resumed, ...threadParams });
    state.threadId = threadId(admitted, resumed);
    emitAdmittedModel(admitted, events);
  }
  input.signal?.throwIfAborted();
  events.emit({ type: "session", coordinate: { sessionId: state.threadId } });
  state.turnId = turnId(
    await server.request("turn/start", {
      threadId: state.threadId,
      input: [
        {
          type: "text",
          text: launchPrompt(input.body, input.launchTells),
        },
      ],
      ...(input.options.model === undefined ? {} : { model: input.options.model }),
      ...(input.options.effort === undefined ? {} : { effort: input.options.effort }),
      approvalPolicy: "never",
      ...(input.runtimeInstructions === undefined
        ? {}
        : { additionalContext: { keiyaku_execution: { kind: "application", value: input.runtimeInstructions } } }),
      ...(input.schemaJson === undefined ? {} : { outputSchema: JSON.parse(input.schemaJson) as unknown }),
    }),
  );
}

async function forkCodex(
  execution: ProviderExecution,
  input: ForkInput,
  custody: AttemptCustody,
): Promise<Readonly<{ session: { sessionId: string } }>> {
  if (!("sessionId" in input.session)) throw new Error("Codex app-server fork requires sessionId");
  const server = new LineRpcProcess({
    argv: [execution.executable ?? "codex", "app-server", "--listen", "stdio://"],
    cwd: input.cwd,
    env: akumaExecutionEnvironment(process.env, execution.env),
  });
  const closed = new Promise<void>((resolve) => server.onExit(() => resolve()));
  custody.own({
    closed,
    abort: async () => await server.close(true),
    forceDispose: async () => await server.close(true),
  });
  try {
    await initializeCodex(server);
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

function codexServer(execution: ProviderExecution, input: StartInput): LineRpcProcess {
  return new LineRpcProcess({
    argv: [execution.executable ?? "codex", "app-server", "--listen", "stdio://"],
    cwd: input.cwd,
    env: akumaExecutionEnvironment(process.env, execution.env, [], input.execution),
  });
}

async function startCodex(execution: ProviderExecution, input: StartInput, custody: AttemptCustody): Promise<Session> {
  const { signal } = custody;
  if (input.session.kind === "resume" && !("sessionId" in input.session.coordinate))
    throw new Error("Codex app-server resume requires sessionId");
  signal.throwIfAborted();
  const turn = providerTurn(new AgentEventChannel());
  const server = codexServer(execution, input);
  let retainRetirement!: (operation: Promise<void>) => void;
  const retired = new Promise<void>((resolve) => {
    retainRetirement = resolve;
  });
  const exited = new Promise<void>((resolve) => server.onExit(() => resolve()));
  const state: CodexTurnState = {
    get settled() {
      return turn.terminal;
    },
    tools: new Map(),
  };
  const finish = (result: TurnResult): void => {
    if (turn.finish(result)) retainRetirement(server.endInputAndDrain());
  };
  const stop = (diagnostic: string): Promise<void> => {
    const won = turn.finish({ kind: "failed", diagnostic });
    const closing = server.close(true);
    if (won) retainRetirement(closing);
    return closing;
  };
  custody.own({
    closed: retired.finally(() => exited),
    abort: () => stop("codex app-server interrupted"),
    forceDispose: () => stop("codex app-server force-disposed"),
  });
  server.onNotification((notification) => {
    if (turn.terminal) return;
    try {
      const result = codexNotificationResult(notification, state, turn.events);
      if (result !== undefined) finish(result);
    } catch (error) {
      if (turn.fail(error)) retainRetirement(server.endInputAndDrain());
    }
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
  try {
    await admitTurn(server, input, state, turn.events, execution.config);
    signal.throwIfAborted();
  } catch (error) {
    if (turn.fail(error)) retainRetirement(server.close(true));
    if (signal.aborted) throw signal.reason;
    throw error instanceof Error ? error : new Error(diagnostic(error));
  }
  return {
    admission: { fence: state.turnId! },
    events: turn.events,
    completion: turn.completion,
    tell: (tell) => (turn.terminal ? Promise.resolve({ kind: "turn-ended" }) : steerTurn(server, state, tell)),
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
      };
    },
    fork: (input) =>
      createProviderAttempt(
        new AbortController().signal,
        async (custody) => await forkCodex(execution, input, custody),
      ),
    ...providerLifecycle((input, custody) => startCodex(execution, input, custody)),
  };
}
