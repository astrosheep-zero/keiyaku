import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentEventChannel,
  modelEvent,
  noteEvent,
  otherToolCall,
  unknownEvent,
  type ToolCall,
} from "../../provider.js";
import {
  finiteNumber,
  object,
  observedTextContent,
  positiveLine,
  searchToolCall,
  stringValue,
  trimmed,
} from "../decode.js";
import { diffstatFromUnifiedPatch } from "../unified-patch.js";

type ClaudeMessageType = SDKMessage["type"];
type ClaudeSystemSubtype = Extract<SDKMessage, { type: "system" }>["subtype"];
type MessageDisposition = "assistant" | "auth" | "note" | "system" | "tool-results" | "drop" | "terminal";
type SystemDisposition = "hook-response" | "note" | "control-progress" | "drop";
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
  compact_boundary: "note",
  control_request_progress: "control-progress",
  elicitation_complete: "drop",
  files_persisted: "note",
  hook_progress: "drop",
  hook_response: "hook-response",
  hook_started: "drop",
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

function readRange(value: Readonly<Record<string, unknown>>): Readonly<{ offset?: number; limit?: number }> {
  const offset = positiveLine(value.offset);
  const limit = positiveLine(value.limit);
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

const CLAUDE_SYSTEM_NOTES = {
  api_retry: (message) => {
    const attempt = finiteNumber(message.attempt);
    const maximum = finiteNumber(message.max_retries);
    return attempt === undefined || maximum === undefined
      ? "Retrying request"
      : `Retrying request ${attempt}/${maximum}`;
  },
  compact_boundary: () => "Context compacted",
  background_tasks_changed: (message) => `Background tasks: ${Array.isArray(message.tasks) ? message.tasks.length : 0}`,
  files_persisted: (message) => {
    const files = Array.isArray(message.files) ? message.files.length : 0;
    const failed = Array.isArray(message.failed) ? message.failed.length : 0;
    return failed === 0 ? `Persisted ${files} files` : `Persisted ${files} files; ${failed} failed`;
  },
  informational: (message) => trimmed(message.content) ?? "Informational notice",
  mirror_error: (message) =>
    `Transcript mirror warning: ${trimmed(message.error) ?? trimmed(message.message) ?? "unknown error"}`,
  model_refusal_fallback: () => "Model refusal; using fallback",
  model_refusal_no_fallback: () => "Model refusal; no fallback available",
  notification: (message) => trimmed(message.message) ?? trimmed(message.content) ?? "Notification",
  permission_denied: (message) =>
    `Permission refused${trimmed(message.message) === undefined ? "" : `: ${trimmed(message.message)}`}`,
  plugin_install: (message) =>
    `Plugin install ${trimmed(message.status) ?? "updated"}${trimmed(message.name) === undefined ? "" : `: ${trimmed(message.name)}`}`,
  status: (message) =>
    `Status: ${trimmed(message.status) ?? "idle"}${trimmed(message.error) === undefined ? "" : ` (${trimmed(message.error)})`}`,
  task_notification: (message) =>
    `Task ${trimmed(message.task_id) ?? "unknown"} ${trimmed(message.status) ?? "updated"}`,
  task_progress: (message) =>
    trimmed(message.description) ?? `Task ${trimmed(message.task_id) ?? "unknown"} progressed`,
  task_started: (message) => trimmed(message.description) ?? `Task ${trimmed(message.task_id) ?? "unknown"} started`,
  task_updated: (message) => `Task ${trimmed(message.task_id) ?? "unknown"} updated`,
  worker_shutting_down: (message) => `Worker stopping: ${trimmed(message.reason) ?? "unknown reason"}`,
} satisfies Partial<Record<ClaudeSystemSubtype, (message: Readonly<Record<string, unknown>>) => string>>;

function runCall(name: string, value: Readonly<Record<string, unknown>>, input: unknown): ToolCall | undefined {
  if (name !== "Bash") return undefined;
  const command = trimmed(value.command);
  return command === undefined ? otherToolCall(name, input) : { kind: "run", command };
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
    const query = trimmed(value.pattern) ?? trimmed(value.query);
    return query === undefined
      ? undefined
      : searchToolCall(query, "content", { path: trimmed(value.path), glob: trimmed(value.glob) });
  }
  if (name === "Glob") {
    const query = trimmed(value.pattern);
    return query === undefined ? undefined : searchToolCall(query, "files", { path: trimmed(value.path) });
  }
  if (name === "WebSearch") {
    const query = trimmed(value.query);
    return query === undefined ? undefined : searchToolCall(query, "web");
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

function startedPath(name: string, value: Readonly<Record<string, unknown>>): string | undefined {
  if (name === "NotebookEdit") return trimmed(value.notebook_path);
  return trimmed(value.file_path) ?? (name === "Read" ? trimmed(value.path) : undefined);
}

function nonnegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function fileChange(
  op: "add" | "update",
  path: string,
  result: Readonly<Record<string, unknown>>,
): Extract<ToolCall, { kind: "fileChange" }> {
  const diff = object(result.gitDiff);
  const added = nonnegativeInt(diff?.additions);
  const removed = nonnegativeInt(diff?.deletions);
  const patch = stringValue(diff?.patch) ?? structuredPatchText(path, result.structuredPatch);
  const diffstat =
    added === undefined || removed === undefined
      ? patch === undefined
        ? undefined
        : diffstatFromUnifiedPatch(patch)
      : { added, removed };
  return {
    kind: "fileChange",
    changes: [
      {
        op,
        path,
        ...(diffstat === undefined ? {} : { diffstat }),
        ...(patch === undefined ? {} : { patch }),
      },
    ],
  };
}

/**
 * Render the native hunk record as unified diff text when the provider supplied
 * no patch of its own. Every figure comes from that record; nothing is
 * reconstructed from the working tree or from proposed old and new strings.
 */
function structuredPatchText(path: string, value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const hunks: string[] = [];
  for (const entry of value) {
    const hunk = object(entry);
    const oldStart = finiteNumber(hunk?.oldStart);
    const oldLines = finiteNumber(hunk?.oldLines);
    const newStart = finiteNumber(hunk?.newStart);
    const newLines = finiteNumber(hunk?.newLines);
    const lines = hunk?.lines;
    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined ||
      !Array.isArray(lines) ||
      lines.some((line) => typeof line !== "string")
    ) {
      return undefined;
    }
    hunks.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...(lines as readonly string[]));
  }
  return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
}

function writeResult(result: unknown): ToolCall | undefined {
  const value = object(result);
  if (value === undefined || (value.type !== "create" && value.type !== "update")) return undefined;
  const path = trimmed(value.filePath);
  if (path === undefined) return undefined;
  return fileChange(value.type === "create" ? "add" : "update", path, value);
}

function editResult(result: unknown): ToolCall | undefined {
  const value = object(result);
  if (value === undefined || value.type === "create" || value.type === "update") return undefined;
  const path = trimmed(value.filePath);
  if (path === undefined) return undefined;
  const status = object(value.gitDiff)?.status;
  return fileChange(status === "added" ? "add" : "update", path, value);
}

function notebookResult(result: unknown): ToolCall | undefined {
  const path = trimmed(object(result)?.notebook_path);
  return path === undefined ? undefined : { kind: "fileChange", changes: [{ op: "update", path }] };
}

function structuredFileChange(name: string, result: unknown): ToolCall | undefined {
  if (name === "Write") return writeResult(result);
  if (name === "Edit") return editResult(result);
  return name === "NotebookEdit" ? notebookResult(result) : undefined;
}

function toolCall(name: string, input: unknown): ToolCall {
  const value = object(input) ?? {};
  const run = runCall(name, value, input);
  if (run !== undefined) return run;
  const path = startedPath(name, value);
  return (
    readCall(name, path, value) ?? searchCall(name, value) ?? fileChangeCall(name, path) ?? otherToolCall(name, input)
  );
}

function assistantEvents(
  message: Extract<SDKMessage, { type: "assistant" }>,
  events: AgentEventChannel,
  state: ClaudeObservationState,
): void {
  // Every complete response names the model that produced it; the native model
  // identity is reported as-is.
  const model = trimmed(object(message.message)?.model);
  if (model !== undefined) events.emit(modelEvent(model));
  if (message.aborted === true) return;
  if (message.error !== undefined) {
    events.emit(noteEvent(`Assistant error: ${message.error}`));
    return;
  }
  const text = message.message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
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
    const id = trimmed(value.tool_use_id);
    if (id === undefined) continue;
    const observed = state.tools.get(id);
    if (observed === undefined) continue;
    state.tools.delete(id);
    const failed = value.is_error === true;
    const structured = failed ? undefined : structuredFileChange(observed.name, message.tool_use_result);
    const output = observedTextContent(value.content);
    events.emit({
      type: "tool",
      phase: "completed",
      id,
      name: observed.name,
      call: structured ?? observed.call,
      result: {
        status: failed ? "error" : "ok",
        ...(output === undefined ? {} : { output }),
      },
    });
  }
}

function hookResponseNote(value: Readonly<Record<string, unknown>>): string | undefined {
  const outcome = trimmed(value.outcome);
  if (outcome !== "error" && outcome !== "cancelled") return undefined;
  const hook = trimmed(value.hook_name) ?? "unknown";
  const exitCode = finiteNumber(value.exit_code);
  return `Hook ${hook} ${outcome}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`;
}

/**
 * Native system notices that prove which model the session is actually using.
 * `init` reports the startup selection. A refusal fallback reports the model
 * that serves the retried request; only a session-scoped fallback swaps the
 * session model, and `local` leaves it unchanged. The two no-longer-emitted
 * directions stay in the native enum and are never treated as evidence.
 */
function systemModelEvidence(subtype: string, value: Readonly<Record<string, unknown>>): string | undefined {
  if (subtype === "init") return trimmed(value.model);
  if (subtype !== "model_refusal_fallback" || value.scope === "local") return undefined;
  return value.direction === "revert" || value.direction === "sticky" ? undefined : trimmed(value.fallback_model);
}

function emitSystemMessage(value: Readonly<Record<string, unknown>>, events: AgentEventChannel): void {
  const subtype = trimmed(value?.subtype) ?? "unknown";
  if (!Object.hasOwn(CLAUDE_SYSTEM_DISPOSITIONS, subtype)) {
    events.emit(unknownEvent(subtype));
    return;
  }
  const evidence = systemModelEvidence(subtype, value);
  if (evidence !== undefined) events.emit(modelEvent(evidence));
  const systemDisposition = CLAUDE_SYSTEM_DISPOSITIONS[subtype as ClaudeSystemSubtype];
  if (systemDisposition === "drop") return;
  if (systemDisposition === "hook-response") {
    const note = hookResponseNote(value);
    if (note !== undefined) events.emit(noteEvent(note));
    return;
  }
  if (systemDisposition === "control-progress" && value?.status !== "api_retry") return;
  const note = CLAUDE_SYSTEM_NOTES[subtype as keyof typeof CLAUDE_SYSTEM_NOTES];
  events.emit(noteEvent(note?.(value ?? {}) ?? subtype));
}

export function emitClaudeMessage(message: SDKMessage, events: AgentEventChannel, state: ClaudeObservationState): void {
  const value = object(message) ?? {};
  const kind = trimmed(value.type) ?? "unknown";
  if (!Object.hasOwn(CLAUDE_MESSAGE_DISPOSITIONS, kind)) return events.emit(unknownEvent(kind));
  const disposition = CLAUDE_MESSAGE_DISPOSITIONS[kind as ClaudeMessageType];
  if (disposition === "assistant") {
    assistantEvents(message as Extract<SDKMessage, { type: "assistant" }>, events, state);
  } else if (disposition === "tool-results") {
    toolResultEvents(message as Extract<SDKMessage, { type: "user" }>, events, state);
  } else if (disposition === "auth") {
    const error = trimmed(value.error);
    if (error !== undefined) events.emit(noteEvent(`Authentication warning: ${error}`));
  } else if (disposition === "note") {
    events.emit(noteEvent("Conversation reset"));
  } else if (disposition === "system") {
    emitSystemMessage(value, events);
  }
}
