import type { LineRpcNotification } from "../../../runtime/proc/line-rpc.js";
import {
  AgentEventChannel,
  modelEvent,
  noteEvent,
  type ToolCall,
  type ToolResult,
  type TurnResult,
} from "../../provider.js";
import { stringValue } from "../decode.js";
import { diffstatFromUnifiedPatch } from "../unified-patch.js";

export type CodexTurnState = {
  threadId?: string;
  turnId?: string;
  lastAnswer?: string;
  error?: string;
  settled: boolean;
  tools: Map<string, Readonly<{ name: string; call: ToolCall }>>;
};

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
    const patch = stringValue(change?.diff);
    const diffstat = patch === undefined ? undefined : diffstatFromUnifiedPatch(patch);
    return [
      {
        op,
        path,
        ...(diffstat === undefined ? {} : { diffstat }),
        ...(patch === undefined ? {} : { patch }),
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
  const output = stringValue(item.aggregatedOutput);
  const exitCode = typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined;
  return {
    status: failed || (exitCode !== undefined && exitCode !== 0) ? "error" : "ok",
    ...(detail === undefined ? {} : { message: detail }),
    ...(output === undefined ? {} : { output }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function emitItem(
  item: Readonly<Record<string, unknown>>,
  completed: boolean,
  events: AgentEventChannel,
  state: CodexTurnState,
): void {
  const kind = codexText(item.type);
  switch (kind) {
    case "agentMessage": {
      if (!completed) return;
      const message = typeof item.text === "string" ? item.text : undefined;
      if (message !== undefined) {
        state.lastAnswer = message;
        events.emit({ type: "assistant", text: message });
      }
      return;
    }
    case "reasoning": {
      if (!completed) return;
      const summary = reasoningSummary(item);
      if (summary !== undefined) events.emit({ type: "thought", text: summary });
      return;
    }
    case "contextCompaction":
      if (completed) events.emit(noteEvent("Context compacted"));
      return;
    case "collabAgentToolCall":
    case "commandExecution":
    case "dynamicToolCall":
    case "fileChange":
    case "imageGeneration":
    case "imageView":
    case "mcpToolCall":
    case "webSearch":
      break;
    default:
      return;
  }
  const id = codexText(item.id);
  if (id === undefined) return;
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

function hookDiagnostic(params: Readonly<Record<string, unknown>>): string | undefined {
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
  return codexText(run?.statusMessage) ?? codexText(issue?.text);
}

function observeError(
  params: Readonly<Record<string, unknown>>,
  state: CodexTurnState,
  events: AgentEventChannel,
): void {
  const detail = turnError(params.error) ?? codexText(params.message) ?? "codex app-server error";
  state.error = detail;
  events.emit(noteEvent(detail));
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
  const params = codexObject(notification.params) ?? {};
  const notificationThreadId = codexText(params.threadId);
  if (state.threadId !== undefined && notificationThreadId !== undefined && notificationThreadId !== state.threadId) {
    return undefined;
  }
  switch (method) {
    case "model/rerouted":
      events.emit(modelEvent(codexText(params.toModel)));
      return undefined;
    case "hook/completed": {
      const diagnostic = hookDiagnostic(params);
      if (diagnostic !== undefined) events.emit(noteEvent(diagnostic));
      return undefined;
    }
    case "thread/compacted":
      events.emit(noteEvent("Context compacted"));
      return undefined;
    case "thread/realtime/error": {
      const diagnostic =
        codexText(params.message) ?? codexText(params.reason) ?? codexText(params.error) ?? turnError(params.error);
      if (diagnostic !== undefined) events.emit(noteEvent(diagnostic));
      return undefined;
    }
    case "item/started":
    case "item/completed": {
      const item = codexObject(params.item);
      if (item !== undefined) emitItem(item, method === "item/completed", events, state);
      return undefined;
    }
    case "error":
      observeError(params, state, events);
      return undefined;
    case "turn/completed":
      return terminalResult(params, state);
    default:
      return undefined;
  }
}
