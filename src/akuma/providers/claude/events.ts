import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentEventChannel,
  noteEvent,
  unknownEvent,
  type ToolCall,
} from "../../provider.js";

type ClaudeMessageType = SDKMessage["type"];
type ClaudeSystemSubtype = Extract<SDKMessage, { type: "system" }>["subtype"];
type MessageDisposition = "assistant" | "auth" | "note" | "system" | "tool-results" | "drop" | "terminal";
type SystemDisposition = "note" | "control-progress" | "drop";
export type ClaudeObservationState = { tools: Map<string, Readonly<{ name: string; call: ToolCall }>> };

export const CLAUDE_MESSAGE_DISPOSITIONS = {
  assistant: "assistant",
  auth_status: "auth",
  conversation_reset: "note",
  prompt_suggestion: "drop",
  rate_limit_event: "drop",
  result: "terminal",
  stream_event: "drop",
  system: "system",
  tool_progress: "drop",
  tool_use_summary: "drop",
  user: "tool-results",
} as const satisfies Record<ClaudeMessageType, MessageDisposition>;

export const CLAUDE_SYSTEM_DISPOSITIONS = {
  api_retry: "note",
  background_tasks_changed: "note",
  commands_changed: "drop",
  compact_boundary: "drop",
  control_request_progress: "control-progress",
  elicitation_complete: "drop",
  files_persisted: "note",
  hook_progress: "drop",
  hook_response: "drop",
  hook_started: "note",
  informational: "note",
  init: "drop",
  local_command_output: "drop",
  memory_recall: "drop",
  mirror_error: "note",
  model_refusal_fallback: "note",
  model_refusal_no_fallback: "note",
  notification: "note",
  permission_denied: "note",
  plugin_install: "note",
  session_state_changed: "drop",
  status: "note",
  task_notification: "note",
  task_progress: "note",
  task_started: "note",
  task_updated: "note",
  thinking_tokens: "drop",
  worker_shutting_down: "note",
} as const satisfies Record<ClaudeSystemSubtype, SystemDisposition>;

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function nonblank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function readRange(value: Readonly<Record<string, unknown>>): Readonly<{ offset?: number; limit?: number }> {
  const offset = positiveLine(value.offset);
  const limit = positiveLine(value.limit);
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function contentSearch(value: Readonly<Record<string, unknown>>, query: string): Extract<ToolCall, { kind: "search" }> {
  const path = nonblank(value.path);
  const glob = nonblank(value.glob);
  return {
    kind: "search",
    query,
    scope: "content",
    ...(path === undefined ? {} : { path }),
    ...(glob === undefined ? {} : { glob }),
  };
}

const CLAUDE_SYSTEM_NOTES = {
  api_retry: (message) => {
    const attempt = number(message.attempt);
    const maximum = number(message.max_retries);
    return attempt === undefined || maximum === undefined
      ? "Retrying request"
      : `Retrying request ${attempt}/${maximum}`;
  },
  background_tasks_changed: (message) => `Background tasks: ${Array.isArray(message.tasks) ? message.tasks.length : 0}`,
  files_persisted: (message) => {
    const files = Array.isArray(message.files) ? message.files.length : 0;
    const failed = Array.isArray(message.failed) ? message.failed.length : 0;
    return failed === 0 ? `Persisted ${files} files` : `Persisted ${files} files; ${failed} failed`;
  },
  hook_started: (message) => `Hook ${nonblank(message.hook_name) ?? "unknown"} started`,
  informational: (message) => nonblank(message.content) ?? "Informational notice",
  mirror_error: (message) => `Transcript mirror warning: ${nonblank(message.error) ?? nonblank(message.message) ?? "unknown error"}`,
  model_refusal_fallback: () => "Model refusal; using fallback",
  model_refusal_no_fallback: () => "Model refusal; no fallback available",
  notification: (message) => nonblank(message.message) ?? nonblank(message.content) ?? "Notification",
  permission_denied: (message) => `Permission refused${nonblank(message.message) === undefined ? "" : `: ${nonblank(message.message)}`}`,
  plugin_install: (message) => `Plugin install ${nonblank(message.status) ?? "updated"}${nonblank(message.name) === undefined ? "" : `: ${nonblank(message.name)}`}`,
  status: (message) => `Status: ${nonblank(message.status) ?? "idle"}${nonblank(message.error) === undefined ? "" : ` (${nonblank(message.error)})`}`,
  task_notification: (message) => `Task ${nonblank(message.task_id) ?? "unknown"} ${nonblank(message.status) ?? "updated"}`,
  task_progress: (message) => nonblank(message.description) ?? `Task ${nonblank(message.task_id) ?? "unknown"} progressed`,
  task_started: (message) => nonblank(message.description) ?? `Task ${nonblank(message.task_id) ?? "unknown"} started`,
  task_updated: (message) => `Task ${nonblank(message.task_id) ?? "unknown"} updated`,
  worker_shutting_down: (message) => `Worker stopping: ${nonblank(message.reason) ?? "unknown reason"}`,
} satisfies Partial<Record<ClaudeSystemSubtype, (message: Readonly<Record<string, unknown>>) => string>>;

function runCall(name: string, value: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name !== "Bash") return undefined;
  const command = nonblank(value.command);
  return command === undefined ? { kind: "other", display: name } : { kind: "run", command };
}

function readCall(
  name: string,
  path: string | undefined,
  value: Readonly<Record<string, unknown>>,
): ToolCall | undefined {
  return name === "Read" && path !== undefined ? { kind: "read", path, ...readRange(value) } : undefined;
}

function searchCall(name: string, value: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name === "Grep") {
    const query = nonblank(value.pattern) ?? nonblank(value.query);
    return query === undefined ? undefined : contentSearch(value, query);
  }
  if (name === "Glob") {
    const query = nonblank(value.pattern);
    const globPath = nonblank(value.path);
    return query === undefined
      ? undefined
      : { kind: "search", query, scope: "files", ...(globPath === undefined ? {} : { path: globPath }) };
  }
  if (name === "WebSearch") {
    const query = nonblank(value.query);
    return query === undefined ? undefined : { kind: "search", query, scope: "web" };
  }
  return undefined;
}

function fileChangeCall(name: string, path: string | undefined): ToolCall | undefined {
  if (path === undefined) return undefined;
  if (name === "Write") return { kind: "fileChange", changes: [{ op: "add", path }] };
  if (name === "Edit" || name === "NotebookEdit") {
    return { kind: "fileChange", changes: [{ op: "update", path }] };
  }
  return undefined;
}

function toolCall(name: string, input: unknown): ToolCall {
  const value = object(input) ?? {};
  const run = runCall(name, value);
  if (run !== undefined) return run;
  const path = nonblank(value.file_path) ?? (name === "Read" ? nonblank(value.path) : undefined);
  return readCall(name, path, value)
    ?? searchCall(name, value)
    ?? fileChangeCall(name, path)
    ?? { kind: "other", display: name };
}

function assistantEvents(
  message: Extract<SDKMessage, { type: "assistant" }>,
  events: AgentEventChannel,
  state: ClaudeObservationState,
): void {
  if (message.aborted === true) return;
  if (message.error !== undefined) {
    events.emit(noteEvent(`Assistant error: ${message.error}`));
    return;
  }
  const text = message.message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text).join("");
  if (text.length > 0) events.emit({ type: "assistant", text });
  for (const block of message.message.content) {
    const value = object(block);
    if (value?.type === "thinking" && typeof value.thinking === "string" && value.thinking.trim().length > 0) {
      events.emit({ type: "thought", text: value.thinking });
      continue;
    }
    if (block.type !== "tool_use") continue;
    const call = toolCall(block.name, block.input);
    state.tools.set(block.id, { name: block.name, call });
    events.emit({ type: "tool", phase: "started", id: block.id, name: block.name, call });
  }
}

function toolResultEvents(
  message: Extract<SDKMessage, { type: "user" }>,
  events: AgentEventChannel,
  state: ClaudeObservationState,
): void {
  const content = object(message.message)?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const value = object(block);
    if (value?.type !== "tool_result") continue;
    const id = nonblank(value.tool_use_id);
    if (id === undefined) continue;
    const observed = state.tools.get(id);
    if (observed === undefined) continue;
    state.tools.delete(id);
    events.emit({
      type: "tool", phase: "completed", id, name: observed.name, call: observed.call,
      result: { status: value.is_error === true ? "error" : "ok" },
    });
  }
}

function emitSystemMessage(value: Readonly<Record<string, unknown>>, events: AgentEventChannel): void {
  const subtype = nonblank(value?.subtype) ?? "unknown";
  if (!Object.hasOwn(CLAUDE_SYSTEM_DISPOSITIONS, subtype)) {
    events.emit(unknownEvent(subtype));
    return;
  }
  const systemDisposition = CLAUDE_SYSTEM_DISPOSITIONS[subtype as ClaudeSystemSubtype];
  if (systemDisposition === "drop") return;
  if (systemDisposition === "control-progress" && value?.status !== "api_retry") return;
  const note = CLAUDE_SYSTEM_NOTES[subtype as keyof typeof CLAUDE_SYSTEM_NOTES];
  events.emit(noteEvent(note?.(value ?? {}) ?? subtype));
}

export function emitClaudeMessage(
  message: SDKMessage,
  events: AgentEventChannel,
  state: ClaudeObservationState,
): void {
  const value = object(message) ?? {};
  const kind = nonblank(value.type) ?? "unknown";
  if (!Object.hasOwn(CLAUDE_MESSAGE_DISPOSITIONS, kind)) return events.emit(unknownEvent(kind));
  const disposition = CLAUDE_MESSAGE_DISPOSITIONS[kind as ClaudeMessageType];
  if (disposition === "assistant") {
    assistantEvents(message as Extract<SDKMessage, { type: "assistant" }>, events, state);
  } else if (disposition === "tool-results") {
    toolResultEvents(message as Extract<SDKMessage, { type: "user" }>, events, state);
  } else if (disposition === "auth") {
    const error = nonblank(value.error);
    if (error !== undefined) events.emit(noteEvent(`Authentication warning: ${error}`));
  } else if (disposition === "note") {
    events.emit(noteEvent("Conversation reset"));
  } else if (disposition === "system") {
    emitSystemMessage(value, events);
  }
}
