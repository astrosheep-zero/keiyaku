import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { noteEvent, unknownEvent, type AgentEvent, type ToolCall } from "../../provider.js";

type Disposition = "drop" | "message" | "note" | "tool-end" | "tool-start";

export const PI_EVENT_DISPOSITIONS = {
  agent_end: "drop",
  agent_settled: "drop",
  agent_start: "drop",
  auto_retry_end: "drop",
  auto_retry_start: "note",
  compaction_end: "note",
  compaction_start: "drop",
  entry_appended: "drop",
  message_end: "message",
  message_start: "drop",
  message_update: "drop",
  queue_update: "drop",
  session_info_changed: "drop",
  thinking_level_changed: "drop",
  tool_execution_end: "tool-end",
  tool_execution_start: "tool-start",
  tool_execution_update: "drop",
  turn_end: "drop",
  turn_start: "drop",
} as const satisfies Readonly<Record<AgentSessionEvent["type"], Disposition>>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    const value = record(block);
    return value?.type === "text" && typeof value.text === "string" ? value.text : "";
  }).join("");
}

function hasTextContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((block) => {
    const value = record(block);
    return value?.type === "text" && typeof value.text === "string";
  });
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function runCall(name: string, value: Readonly<Record<string, unknown>>): ToolCall | undefined {
  return name === "bash" && typeof value.command === "string"
    ? { kind: "run", command: value.command }
    : undefined;
}

function readCall(name: string, value: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name !== "read" || typeof value.path !== "string") return undefined;
  const offset = positiveLine(value.offset);
  const limit = positiveLine(value.limit);
  return {
    kind: "read",
    path: value.path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function searchCall(name: string, value: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name !== "grep" && name !== "find") return undefined;
  const query = value.pattern ?? value.query;
  if (typeof query !== "string") return undefined;
  const path = optionalText(value.path);
  const glob = optionalText(value.glob);
  return {
    kind: "search",
    query,
    scope: name === "find" ? "files" : "content",
    ...(path === undefined ? {} : { path }),
    ...(name === "grep" && glob !== undefined ? { glob } : {}),
  };
}

function fileChangeCall(name: string, value: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if ((name !== "edit" && name !== "write") || typeof value.path !== "string") return undefined;
  return { kind: "fileChange", changes: [{ op: name === "write" ? "add" : "update", path: value.path }] };
}

function toolCall(name: string, args: unknown): ToolCall {
  const value = record(args) ?? {};
  return runCall(name, value)
    ?? readCall(name, value)
    ?? searchCall(name, value)
    ?? fileChangeCall(name, value)
    ?? { kind: "other", display: name };
}

export type PiEventState = {
  answer: string;
  assistantSeen: boolean;
  tools: Map<string, Readonly<{ name: string; call: ToolCall }>>;
};

function translateNote(event: Extract<AgentSessionEvent, { type: "auto_retry_start" | "compaction_end" }>): readonly AgentEvent[] {
  if (event.type === "auto_retry_start") return [noteEvent(`Retrying request ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`)];
  return event.errorMessage === undefined ? [] : [noteEvent(event.errorMessage)];
}

function translateToolStart(event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>, state: PiEventState): readonly AgentEvent[] {
  const call = toolCall(event.toolName, event.args);
  state.tools.set(event.toolCallId, { name: event.toolName, call });
  return [{ type: "tool", phase: "started", id: event.toolCallId, name: event.toolName, call }];
}

function translateToolEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>, state: PiEventState): readonly AgentEvent[] {
  const started = state.tools.get(event.toolCallId);
  state.tools.delete(event.toolCallId);
  const name = started?.name ?? event.toolName;
  return [{
    type: "tool", phase: "completed", id: event.toolCallId, name,
    call: started?.call ?? { kind: "other", display: name },
    result: { status: event.isError ? "error" : "ok" },
  }];
}

function translateMessage(event: Extract<AgentSessionEvent, { type: "message_end" }>, state: PiEventState): readonly AgentEvent[] {
  const message = record(event.message);
  if (message?.role !== "assistant") return [];
  state.assistantSeen = true;
  const translated: AgentEvent[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const value = record(block);
      if (
        value?.type === "thinking" &&
        value.redacted !== true &&
        typeof value.thinking === "string" &&
        value.thinking.trim().length > 0
      ) {
        translated.push({ type: "thought", text: value.thinking });
      }
    }
  }
  const text = textContent(message.content);
  state.answer = text;
  if (hasTextContent(message.content)) {
    translated.push({ type: "assistant", text });
  }
  return translated;
}

export function translatePiEvent(event: AgentSessionEvent, state: PiEventState): readonly AgentEvent[] {
  const disposition = PI_EVENT_DISPOSITIONS[event.type];
  if (disposition === "drop") return [];
  if (disposition === "note") return translateNote(event as Extract<AgentSessionEvent, { type: "auto_retry_start" | "compaction_end" }>);
  if (disposition === "tool-start") return translateToolStart(event as Extract<AgentSessionEvent, { type: "tool_execution_start" }>, state);
  if (disposition === "tool-end") return translateToolEnd(event as Extract<AgentSessionEvent, { type: "tool_execution_end" }>, state);
  if (disposition === "message") return translateMessage(event as Extract<AgentSessionEvent, { type: "message_end" }>, state);
  return [unknownEvent(event.type)];
}

export function piTerminalFailure(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "error") return null;
    return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
      ? message.errorMessage : "Pi provider ended with an error";
  }
  return null;
}
