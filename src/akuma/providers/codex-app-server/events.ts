import type { LineRpcNotification } from "../../../runtime/proc/line-rpc.js";
import {
  AgentEventChannel,
  modelEvent,
  noteEvent,
  otherToolCall,
  type ToolCall,
  type ToolResult,
  type TurnResult,
} from "../../provider.js";
import { nonblank, object, observedChange, readToolCall, searchToolCall, stringValue, toolResult } from "../decode.js";
import { ToolObservations } from "../tool-observations.js";
import { diffstatFromUnifiedPatch } from "../unified-patch.js";

export type CodexTurnState = {
  threadId?: string;
  turnId?: string;
  lastAnswer?: string;
  error?: string;
  settled: boolean;
  tools: ToolObservations;
};

function turnError(value: unknown): string | undefined {
  const error = object(value);
  const message = nonblank(error?.message);
  const details = nonblank(error?.additionalDetails);
  if (message === undefined) return details;
  return details === undefined || details === message ? message : `${message}: ${details}`;
}

function itemToolName(item: Readonly<Record<string, unknown>>, kind: string): string {
  if (kind === "mcpToolCall") return `${nonblank(item.server) ?? "unknown"}/${nonblank(item.tool) ?? "unknown"}`;
  if (kind === "dynamicToolCall") {
    const namespace = nonblank(item.namespace);
    return `${namespace === undefined ? "" : `${namespace}/`}${nonblank(item.tool) ?? "unknown"}`;
  }
  return nonblank(item.tool) ?? kind;
}

function itemChanges(item: Readonly<Record<string, unknown>>): Extract<ToolCall, { kind: "fileChange" }>["changes"] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((value) => {
    const change = object(value);
    const path = nonblank(change?.path);
    const op = object(change?.kind)?.type ?? change?.kind;
    if (path === undefined || (op !== "add" && op !== "update" && op !== "delete")) return [];
    const patch = stringValue(change?.diff);
    const diffstat = patch === undefined ? undefined : diffstatFromUnifiedPatch(patch);
    return [observedChange(op, path, patch, diffstat)];
  });
}

function reasoningSummary(item: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof item.summary === "string") return nonblank(item.summary);
  if (!Array.isArray(item.summary)) return undefined;
  return nonblank(
    item.summary
      .map((part) => {
        if (typeof part === "string") return part;
        const value = object(part);
        return value?.type === "summary_text" || value?.type === "text" ? (nonblank(value.text) ?? "") : "";
      })
      .join("\n"),
  );
}

function itemToolCall(item: Readonly<Record<string, unknown>>, kind: string, name: string): ToolCall | undefined {
  switch (kind) {
    case "commandExecution":
      return { kind: "run", command: nonblank(item.command) ?? "command" };
    case "imageView":
      return readToolCall(item.path) ?? { kind: "other", display: "image view" };
    case "webSearch":
      return searchToolCall(item.query, "web") ?? { kind: "other", display: "web search" };
    case "fileChange": {
      const changes = itemChanges(item);
      return changes.length === 0 ? { kind: "other", display: "fileChange" } : { kind: "fileChange", changes };
    }
    case "collabAgentToolCall":
    case "imageGeneration":
      return otherToolCall(name);
    case "dynamicToolCall":
    case "mcpToolCall":
      return otherToolCall(name, item.arguments);
    default:
      return undefined;
  }
}

function itemToolResult(item: Readonly<Record<string, unknown>>): ToolResult {
  const error = object(item.error);
  const status = nonblank(item.status);
  const failed = error !== undefined || status === "failed" || status === "error";
  return toolResult(
    failed ? "error" : "ok",
    stringValue(item.aggregatedOutput),
    nonblank(error?.message) ?? nonblank(error?.additionalDetails),
    item.exitCode,
  );
}

function emitItem(
  item: Readonly<Record<string, unknown>>,
  completed: boolean,
  events: AgentEventChannel,
  state: CodexTurnState,
): void {
  const kind = nonblank(item.type);
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
  }
  const id = nonblank(item.id);
  if (id === undefined || kind === undefined) return;
  const name = itemToolName(item, kind);
  const call = itemToolCall(item, kind, name);
  if (call === undefined) return;
  const observation = { name, call };
  if (completed) state.tools.finish(id, observation, itemToolResult(item));
  else state.tools.start(id, observation);
}

function hookDiagnostic(params: Readonly<Record<string, unknown>>): string | undefined {
  const run = object(params.run);
  const status = nonblank(run?.status);
  const issue = Array.isArray(run?.entries)
    ? run.entries.map(object).find((entry) => {
        const kind = nonblank(entry?.kind);
        return kind === "warning" || kind === "error" || kind === "stop";
      })
    : undefined;
  const issueKind = nonblank(issue?.kind);
  if (status !== "failed" && status !== "blocked" && status !== "stopped" && issueKind === undefined) return undefined;
  return nonblank(run?.statusMessage) ?? nonblank(issue?.text);
}

function observeError(
  params: Readonly<Record<string, unknown>>,
  state: CodexTurnState,
  events: AgentEventChannel,
): void {
  const detail = turnError(params.error) ?? nonblank(params.message) ?? "codex app-server error";
  state.error = detail;
  events.emit(noteEvent(detail));
}

function terminalResult(params: Readonly<Record<string, unknown>>, state: CodexTurnState): TurnResult {
  const turn = object(params.turn);
  const completedId = nonblank(turn?.id);
  const status = nonblank(turn?.status) ?? "unknown";
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
  const params = object(notification.params) ?? {};
  const notificationThreadId = nonblank(params.threadId);
  if (state.threadId !== undefined && notificationThreadId !== undefined && notificationThreadId !== state.threadId) {
    return undefined;
  }
  switch (method) {
    case "model/rerouted":
      events.emit(modelEvent(nonblank(params.toModel)));
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
        nonblank(params.message) ?? nonblank(params.reason) ?? nonblank(params.error) ?? turnError(params.error);
      if (diagnostic !== undefined) events.emit(noteEvent(diagnostic));
      return undefined;
    }
    case "item/started":
    case "item/completed": {
      const item = object(params.item);
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
