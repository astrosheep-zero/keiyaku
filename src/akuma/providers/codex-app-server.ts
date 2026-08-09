import { LineRpcProcess, type LineRpcNotification } from "../../runtime/proc/line-rpc.js";
import {
  actionEvent,
  AgentEventChannel,
  AKUMA_REQUESTS_ENV,
  unknownEvent,
  type Drive,
  type ProviderAdapter,
  type ProviderOptions,
  type TurnResult,
} from "../provider.js";

type StartInput = Parameters<ProviderAdapter["start"]>[0];
type ForkInput = Parameters<NonNullable<ProviderAdapter["fork"]>>[0];
type Finish = (result: TurnResult) => void;
type TurnState = {
  threadId?: string;
  turnId?: string;
  answers: string[];
  error?: string;
  settled: boolean;
};

type NotificationDisposition = "action" | "drop" | "error" | "item-completed" | "item-started" | "plan" | "terminal";
type ItemDisposition = "action" | "assistant" | "drop" | "plan";

export const CODEX_NOTIFICATION_DISPOSITIONS = {
  "account/login/completed": "drop",
  "account/rateLimits/updated": "drop",
  "account/updated": "drop",
  "app/list/updated": "drop",
  "command/exec/outputDelta": "drop",
  configWarning: "action",
  deprecationNotice: "action",
  error: "error",
  "externalAgentConfig/import/completed": "action",
  "externalAgentConfig/import/progress": "action",
  "fs/changed": "action",
  "fuzzyFileSearch/sessionCompleted": "drop",
  "fuzzyFileSearch/sessionUpdated": "drop",
  guardianWarning: "action",
  "hook/completed": "drop",
  "hook/started": "action",
  "item/agentMessage/delta": "drop",
  "item/autoApprovalReview/completed": "action",
  "item/autoApprovalReview/started": "action",
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
  "model/rerouted": "action",
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
  "thread/goal/cleared": "action",
  "thread/goal/updated": "action",
  "thread/name/updated": "drop",
  "thread/realtime/closed": "drop",
  "thread/realtime/error": "action",
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
  "turn/moderationMetadata": "action",
  "turn/plan/updated": "plan",
  "turn/started": "drop",
  warning: "action",
  "windows/worldWritableWarning": "action",
  "windowsSandbox/setupCompleted": "action",
} as const satisfies Readonly<Record<string, NotificationDisposition>>;

export const CODEX_ITEM_DISPOSITIONS = {
  agentMessage: "assistant",
  collabAgentToolCall: "action",
  commandExecution: "action",
  contextCompaction: "drop",
  dynamicToolCall: "action",
  enteredReviewMode: "action",
  exitedReviewMode: "action",
  fileChange: "action",
  hookPrompt: "drop",
  imageGeneration: "action",
  imageView: "action",
  mcpToolCall: "action",
  plan: "plan",
  reasoning: "drop",
  sleep: "action",
  subAgentActivity: "action",
  userMessage: "drop",
  webSearch: "action",
} as const satisfies Readonly<Record<string, ItemDisposition>>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function turnError(value: unknown): string | undefined {
  const error = object(value);
  const message = text(error?.message);
  const details = text(error?.additionalDetails);
  if (message === undefined) return details;
  return details === undefined || details === message ? message : `${message}: ${details}`;
}

function itemAction(item: Readonly<Record<string, unknown>>, kind: string): string {
  switch (kind) {
    case "collabAgentToolCall": return `Agent tool ${text(item.tool) ?? "unknown"}`;
    case "commandExecution": return `Command ${text(item.command) ?? "started"}`;
    case "dynamicToolCall": return `Tool ${text(item.namespace) === undefined ? "" : `${text(item.namespace)}/`}${text(item.tool) ?? "unknown"}`;
    case "enteredReviewMode": return "Entered review mode";
    case "exitedReviewMode": return "Exited review mode";
    case "fileChange": return "File change";
    case "imageGeneration": return "Image generation";
    case "imageView": return `Image view${text(item.path) === undefined ? "" : `: ${text(item.path)}`}`;
    case "mcpToolCall": return `Tool ${text(item.server) ?? "unknown"}/${text(item.tool) ?? "unknown"}`;
    case "sleep": return "Waiting";
    case "subAgentActivity": return `Agent activity: ${text(item.kind) ?? "updated"}`;
    case "webSearch": return "Web search";
    default: return kind;
  }
}

function emitItem(item: Readonly<Record<string, unknown>>, completed: boolean, events: AgentEventChannel, state: TurnState): void {
  const kind = text(item.type) ?? "unknown";
  if (!Object.hasOwn(CODEX_ITEM_DISPOSITIONS, kind)) {
    events.emit(unknownEvent(kind));
    return;
  }
  const disposition = CODEX_ITEM_DISPOSITIONS[kind as keyof typeof CODEX_ITEM_DISPOSITIONS];
  if (disposition === "assistant") {
    if (!completed) return;
    const message = text(item.text);
    if (message !== undefined) {
      state.answers.push(message);
      events.emit({ type: "assistant", text: message });
    }
    return;
  }
  if (disposition === "plan") {
    if (completed) events.emit(actionEvent(`Plan updated: ${text(item.text) ?? "updated"}`));
    return;
  }
  if (disposition === "action" && !completed) events.emit(actionEvent(itemAction(item, kind)));
}

function notificationAction(method: string, params: Readonly<Record<string, unknown>>): string {
  const message = text(params.message) ?? text(params.reason) ?? text(params.error);
  switch (method) {
    case "configWarning": return `Configuration warning: ${message ?? "unknown warning"}`;
    case "deprecationNotice": return `Deprecation warning: ${message ?? "deprecated behavior"}`;
    case "externalAgentConfig/import/completed": return "External agent configuration import completed";
    case "externalAgentConfig/import/progress": return "External agent configuration import updated";
    case "fs/changed": return "Filesystem changed";
    case "guardianWarning": return `Guardian warning: ${message ?? "action warned"}`;
    case "hook/started": return `Hook ${text(params.name) ?? text(params.hookName) ?? "unknown"} started`;
    case "item/autoApprovalReview/completed": return "Action approval review completed";
    case "item/autoApprovalReview/started": return "Action approval review started";
    case "model/rerouted": return `Model rerouted${message === undefined ? "" : `: ${message}`}`;
    case "thread/goal/cleared": return "Goal cleared";
    case "thread/goal/updated": return "Goal updated";
    case "thread/realtime/error": return `Realtime warning: ${message ?? "unknown error"}`;
    case "turn/moderationMetadata": return "Moderation updated";
    case "warning": return `Warning: ${message ?? "unknown warning"}`;
    case "windows/worldWritableWarning": return `Filesystem warning: ${message ?? "world-writable path"}`;
    case "windowsSandbox/setupCompleted": return "Windows sandbox setup completed";
    default: return method;
  }
}

function observeError(params: Readonly<Record<string, unknown>>, state: TurnState, events: AgentEventChannel): void {
  const detail = turnError(params.error) ?? text(params.message) ?? "codex app-server error";
  state.error = detail;
  events.emit(actionEvent(params.willRetry === true ? `Retrying after error: ${detail}` : `Error: ${detail}`));
}

function terminalResult(params: Readonly<Record<string, unknown>>, state: TurnState): TurnResult {
  const turn = object(params.turn);
  const completedId = text(turn?.id);
  const status = text(turn?.status) ?? "unknown";
  if (completedId === undefined) return { kind: "failed", diagnostic: "codex app-server completed without a turn id" };
  if (state.turnId !== undefined && completedId !== state.turnId) {
    return { kind: "failed", diagnostic: "codex app-server completed a different turn" };
  }
  return status === "completed"
    ? { kind: "answered", answer: state.answers.join("\n\n"), historyId: completedId }
    : { kind: "failed", diagnostic: turnError(turn?.error) ?? state.error ?? `codex app-server turn ended ${status}` };
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

function notificationResult(
  notification: LineRpcNotification,
  state: TurnState,
  events: AgentEventChannel,
): TurnResult | undefined {
  const method = notification.method;
  if (!Object.hasOwn(CODEX_NOTIFICATION_DISPOSITIONS, method)) {
    events.emit(unknownEvent(method));
    return undefined;
  }
  const disposition = CODEX_NOTIFICATION_DISPOSITIONS[method as keyof typeof CODEX_NOTIFICATION_DISPOSITIONS];
  const params = object(notification.params) ?? {};
  switch (disposition) {
    case "drop": return undefined;
    case "action":
      events.emit(actionEvent(notificationAction(method, params)));
      return undefined;
    case "plan": {
      const explanation = text(params.explanation);
      const steps = Array.isArray(params.plan) ? params.plan.length : 0;
      events.emit(actionEvent(`Plan updated: ${explanation ?? `${steps} steps`}`));
      return undefined;
    }
    case "item-started":
    case "item-completed": {
      const item = object(params.item);
      if (item !== undefined) emitItem(item, disposition === "item-completed", events, state);
      return undefined;
    }
    case "error":
      observeError(params, state, events);
      return undefined;
    case "terminal": return terminalResult(params, state);
  }
}

async function admitTurn(
  server: LineRpcProcess,
  input: StartInput,
  state: TurnState,
  events: AgentEventChannel,
): Promise<void> {
  await initialize(server);
  const threadParams = {
    cwd: input.cwd,
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

async function forkCodex(executable: string, input: ForkInput): Promise<Readonly<{ session: { sessionId: string } }>> {
  const server = new LineRpcProcess({ argv: [executable, "app-server", "--listen", "stdio://"], cwd: input.cwd });
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

async function startCodex(executable: string, input: StartInput): Promise<Drive> {
  const events = new AgentEventChannel();
  const server = new LineRpcProcess({
    argv: [executable, "app-server", "--listen", "stdio://"],
    cwd: input.cwd,
    ...(input.requests === undefined ? {} : {
      env: { ...process.env, [AKUMA_REQUESTS_ENV]: input.requests.dir },
    }),
  });
  const state: TurnState = { answers: [], settled: false };
  let settle!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => { settle = resolve; });
  const finish: Finish = (result) => {
    if (state.settled) return;
    state.settled = true;
    events.end();
    settle(result);
    void server.close();
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
    const result = notificationResult(notification, state, events);
    if (result !== undefined) finish(result);
  });
  try { await admitTurn(server, input, state, events); }
  catch (error) { finish({ kind: "failed", diagnostic: diagnostic(error) }); }
  return {
    events,
    completion,
    abort: () => abortTurn(server, state, completion, finish),
  };
}

export function createCodexAppServerProvider(executable = "codex"): ProviderAdapter {
  return {
    confinement: ({ cwd }) => ({ kind: "declared", writableRoots: [cwd] }),
    admitOptions(options) {
      if (options.access !== undefined && options.access !== "write") {
        return { kind: "refused", diagnostic: "Codex app-server supports only access: write" };
      }
      return { kind: "admitted", options: Object.freeze({ ...options }) };
    },
    fork: (input) => forkCodex(executable, input),
    start: (input) => startCodex(executable, input),
  };
}

export const codexAppServerProvider = createCodexAppServerProvider();
