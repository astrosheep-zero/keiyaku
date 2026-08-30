import type { LineRpcNotification } from "../../../runtime/proc/line-rpc.js";
import {
  AgentEventChannel,
  noteEvent,
  unknownEvent,
  type ToolCall,
  type ToolResult,
  type TurnResult,
} from "../../provider.js";
import { diffstatFromUnifiedPatch } from "../unified-patch.js";

export type CodexTurnState = {
  threadId?: string;
  turnId?: string;
  lastAnswer?: string;
  error?: string;
  settled: boolean;
  tools: Map<string, Readonly<{ name: string; call: ToolCall }>>;
};

type NotificationDisposition =
  | "hook-completed"
  | "note"
  | "drop"
  | "error"
  | "item-completed"
  | "item-started"
  | "plan"
  | "terminal";
type ItemDisposition = "tool" | "note" | "assistant" | "thought" | "drop" | "plan";

export const CODEX_NOTIFICATION_DISPOSITIONS = {
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
  "hook/completed": "hook-completed",
  "hook/started": "drop",
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
} as const satisfies Readonly<Record<string, NotificationDisposition>>;

export const CODEX_ITEM_DISPOSITIONS = {
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
} as const satisfies Readonly<Record<string, ItemDisposition>>;

export function codexObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function codexText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function turnError(value: unknown): string | undefined {
  const error = codexObject(value);
  const message = codexText(error?.message);
  const details = codexText(error?.additionalDetails);
  if (message === undefined) return details;
  return details === undefined || details === message ? message : `${message}: ${details}`;
}

function itemNote(item: Readonly<Record<string, unknown>>, kind: string): string {
  switch (kind) {
    case "enteredReviewMode":
      return "Entered review mode";
    case "exitedReviewMode":
      return "Exited review mode";
    case "sleep":
      return "Waiting";
    case "subAgentActivity":
      return `Agent activity: ${codexText(item.kind) ?? "updated"}`;
    default:
      return kind;
  }
}

function itemToolName(item: Readonly<Record<string, unknown>>, kind: string): string {
  if (kind === "mcpToolCall") return `${codexText(item.server) ?? "unknown"}/${codexText(item.tool) ?? "unknown"}`;
  if (kind === "dynamicToolCall") {
    const namespace = codexText(item.namespace);
    return `${namespace === undefined ? "" : `${namespace}/`}${codexText(item.tool) ?? "unknown"}`;
  }
  return codexText(item.tool) ?? kind;
}

function fileChangeOp(value: unknown): "add" | "update" | "delete" | undefined {
  if (value === "add" || value === "update" || value === "delete") return value;
  const record = codexObject(value);
  return record?.type === "add" || record?.type === "update" || record?.type === "delete" ? record.type : undefined;
}

function itemChanges(item: Readonly<Record<string, unknown>>): Extract<ToolCall, { kind: "fileChange" }>["changes"] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((value) => {
    const change = codexObject(value);
    const path = codexText(change?.path);
    const op = fileChangeOp(change?.kind);
    if (path === undefined || op === undefined) return [];
    const diffstat = typeof change?.diff === "string" ? diffstatFromUnifiedPatch(change.diff) : undefined;
    return [
      {
        op,
        path,
        ...(diffstat === undefined ? {} : { diffstat }),
      },
    ];
  });
}

function reasoningSummary(item: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof item.summary === "string") return codexText(item.summary);
  if (!Array.isArray(item.summary)) return undefined;
  return codexText(
    item.summary
      .map((part) => {
        if (typeof part === "string") return part;
        const value = codexObject(part);
        return value?.type === "summary_text" || value?.type === "text" ? (codexText(value.text) ?? "") : "";
      })
      .join("\n"),
  );
}

function itemToolCall(item: Readonly<Record<string, unknown>>, kind: string): ToolCall {
  if (kind === "commandExecution") {
    return { kind: "run", command: codexText(item.command) ?? "command" };
  }
  if (kind === "imageView") {
    const path = codexText(item.path);
    return path === undefined ? { kind: "other", display: "image view" } : { kind: "read", path };
  }
  if (kind === "webSearch") {
    const query = codexText(item.query);
    return query === undefined ? { kind: "other", display: "web search" } : { kind: "search", query, scope: "web" };
  }
  if (kind === "fileChange") {
    const changes = itemChanges(item);
    return changes.length === 0 ? { kind: "other", display: "fileChange" } : { kind: "fileChange", changes };
  }
  return { kind: "other", display: itemToolName(item, kind) };
}

function itemToolResult(item: Readonly<Record<string, unknown>>): ToolResult {
  const error = codexObject(item.error);
  const status = codexText(item.status);
  const failed = error !== undefined || status === "failed" || status === "error";
  const detail = codexText(error?.message) ?? codexText(error?.additionalDetails);
  const exitCode = typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined;
  return {
    status: failed || (exitCode !== undefined && exitCode !== 0) ? "error" : "ok",
    ...(detail === undefined ? {} : { message: detail }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function emitItem(
  item: Readonly<Record<string, unknown>>,
  completed: boolean,
  events: AgentEventChannel,
  state: CodexTurnState,
): void {
  const kind = codexText(item.type) ?? "unknown";
  if (!Object.hasOwn(CODEX_ITEM_DISPOSITIONS, kind)) {
    events.emit(unknownEvent(kind));
    return;
  }
  const disposition = CODEX_ITEM_DISPOSITIONS[kind as keyof typeof CODEX_ITEM_DISPOSITIONS];
  if (disposition === "assistant") {
    if (!completed) return;
    const message = typeof item.text === "string" ? item.text : undefined;
    if (message !== undefined) {
      state.lastAnswer = message;
      events.emit({ type: "assistant", text: message });
    }
    return;
  }
  if (disposition === "plan") {
    if (completed) events.emit(noteEvent(`Plan updated: ${codexText(item.text) ?? "updated"}`));
    return;
  }
  if (disposition === "thought") {
    if (!completed) return;
    const summary = reasoningSummary(item);
    if (summary !== undefined) events.emit({ type: "thought", text: summary });
    return;
  }
  if (disposition === "note") {
    if (!completed) events.emit(noteEvent(itemNote(item, kind)));
    return;
  }
  if (disposition !== "tool") return;
  const id = codexText(item.id);
  if (id === undefined) {
    events.emit(unknownEvent(`${kind}/missing-id`));
    return;
  }
  if (!completed) {
    const observed = { name: itemToolName(item, kind), call: itemToolCall(item, kind) };
    state.tools.set(id, observed);
    events.emit({ type: "tool", phase: "started", id, ...observed });
    return;
  }
  const started = state.tools.get(id);
  const observed = {
    name: started?.name ?? itemToolName(item, kind),
    call: itemToolCall(item, kind),
  };
  state.tools.delete(id);
  events.emit({ type: "tool", phase: "completed", id, ...observed, result: itemToolResult(item) });
}

function notificationAction(method: string, params: Readonly<Record<string, unknown>>): string {
  const message = codexText(params.message) ?? codexText(params.reason) ?? codexText(params.error);
  switch (method) {
    case "configWarning":
      return `Configuration warning: ${message ?? "unknown warning"}`;
    case "deprecationNotice":
      return `Deprecation warning: ${message ?? "deprecated behavior"}`;
    case "externalAgentConfig/import/completed":
      return "External agent configuration import completed";
    case "externalAgentConfig/import/progress":
      return "External agent configuration import updated";
    case "fs/changed":
      return "Filesystem changed";
    case "guardianWarning":
      return `Guardian warning: ${message ?? "action warned"}`;
    case "item/autoApprovalReview/completed":
      return "Action approval review completed";
    case "item/autoApprovalReview/started":
      return "Action approval review started";
    case "model/rerouted":
      return `Model rerouted${message === undefined ? "" : `: ${message}`}`;
    case "thread/goal/cleared":
      return "Goal cleared";
    case "thread/goal/updated":
      return "Goal updated";
    case "thread/realtime/error":
      return `Realtime warning: ${message ?? "unknown error"}`;
    case "turn/moderationMetadata":
      return "Moderation updated";
    case "warning":
      return `Warning: ${message ?? "unknown warning"}`;
    case "windows/worldWritableWarning":
      return `Filesystem warning: ${message ?? "world-writable path"}`;
    case "windowsSandbox/setupCompleted":
      return "Windows sandbox setup completed";
    default:
      return method;
  }
}

function hookCompletionNote(params: Readonly<Record<string, unknown>>): string | undefined {
  const run = codexObject(params.run);
  const status = codexText(run?.status);
  const issue = Array.isArray(run?.entries)
    ? run.entries.map(codexObject).find((entry) => {
        const kind = codexText(entry?.kind);
        return kind === "warning" || kind === "error" || kind === "stop";
      })
    : undefined;
  const issueKind = codexText(issue?.kind);
  if (status !== "failed" && status !== "blocked" && status !== "stopped" && issueKind === undefined) return undefined;
  const eventName = codexText(run?.eventName) ?? "unknown";
  const label = status === "failed" || status === "blocked" || status === "stopped" ? status : issueKind!;
  const diagnostic = codexText(run?.statusMessage) ?? codexText(issue?.text);
  return `Hook ${eventName} ${label}${diagnostic === undefined ? "" : `: ${diagnostic}`}`;
}

function observeError(
  params: Readonly<Record<string, unknown>>,
  state: CodexTurnState,
  events: AgentEventChannel,
): void {
  const detail = turnError(params.error) ?? codexText(params.message) ?? "codex app-server error";
  state.error = detail;
  events.emit(noteEvent(params.willRetry === true ? `Retrying after error: ${detail}` : `Error: ${detail}`));
}

function terminalResult(params: Readonly<Record<string, unknown>>, state: CodexTurnState): TurnResult {
  const turn = codexObject(params.turn);
  const completedId = codexText(turn?.id);
  const status = codexText(turn?.status) ?? "unknown";
  if (completedId === undefined) return { kind: "failed", diagnostic: "codex app-server completed without a turn id" };
  if (state.turnId !== undefined && completedId !== state.turnId) {
    return { kind: "failed", diagnostic: "codex app-server completed a different turn" };
  }
  return status === "completed"
    ? { kind: "answered", answer: state.lastAnswer ?? "", historyId: completedId }
    : { kind: "failed", diagnostic: turnError(turn?.error) ?? state.error ?? `codex app-server turn ended ${status}` };
}
export function codexNotificationResult(
  notification: LineRpcNotification,
  state: CodexTurnState,
  events: AgentEventChannel,
): TurnResult | undefined {
  const method = notification.method;
  if (!Object.hasOwn(CODEX_NOTIFICATION_DISPOSITIONS, method)) {
    events.emit(unknownEvent(method));
    return undefined;
  }
  const disposition = CODEX_NOTIFICATION_DISPOSITIONS[method as keyof typeof CODEX_NOTIFICATION_DISPOSITIONS];
  const params = codexObject(notification.params) ?? {};
  switch (disposition) {
    case "drop":
      return undefined;
    case "hook-completed": {
      const note = hookCompletionNote(params);
      if (note !== undefined) events.emit(noteEvent(note));
      return undefined;
    }
    case "note":
      events.emit(noteEvent(notificationAction(method, params)));
      return undefined;
    case "plan": {
      const explanation = codexText(params.explanation);
      const steps = Array.isArray(params.plan) ? params.plan.length : 0;
      events.emit(noteEvent(`Plan updated: ${explanation ?? `${steps} steps`}`));
      return undefined;
    }
    case "item-started":
    case "item-completed": {
      const item = codexObject(params.item);
      if (item !== undefined) emitItem(item, disposition === "item-completed", events, state);
      return undefined;
    }
    case "error":
      observeError(params, state, events);
      return undefined;
    case "terminal":
      return terminalResult(params, state);
  }
}
