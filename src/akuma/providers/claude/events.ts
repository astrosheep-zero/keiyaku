import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentEventChannel, modelEvent, noteEvent, otherToolCall, type ToolCall } from "../../provider.js";
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

export type ClaudeObservationState = { tools: Map<string, Readonly<{ name: string; call: ToolCall }>> };

function readRange(value: Readonly<Record<string, unknown>>): Readonly<{ offset?: number; limit?: number }> {
  const offset = positiveLine(value.offset);
  const limit = positiveLine(value.limit);
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

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
    events.emit(noteEvent(message.error));
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

function emitSystemMessage(value: Readonly<Record<string, unknown>>, events: AgentEventChannel): void {
  switch (value.subtype) {
    case "init": {
      const model = trimmed(value.model);
      if (model !== undefined) events.emit(modelEvent(model));
      return;
    }
    case "model_refusal_fallback":
      if (value.scope !== "local" && value.direction !== "revert" && value.direction !== "sticky") {
        events.emit(modelEvent(trimmed(value.fallback_model)));
      }
      return;
    case "compact_boundary":
      events.emit(noteEvent("Context compacted"));
      return;
    case "hook_response": {
      if (value.outcome !== "error" && value.outcome !== "cancelled") return;
      const diagnostic = trimmed(value.stderr) ?? trimmed(value.output) ?? trimmed(value.stdout);
      if (diagnostic !== undefined) events.emit(noteEvent(diagnostic));
      return;
    }
    case "api_retry":
    case "mirror_error": {
      const diagnostic = trimmed(value.error);
      if (diagnostic !== undefined) events.emit(noteEvent(diagnostic));
      return;
    }
  }
}

export function emitClaudeMessage(message: SDKMessage, events: AgentEventChannel, state: ClaudeObservationState): void {
  switch (message.type) {
    case "assistant":
      assistantEvents(message, events, state);
      return;
    case "user":
      toolResultEvents(message, events, state);
      return;
    case "auth_status": {
      const diagnostic = trimmed(message.error);
      if (diagnostic !== undefined) events.emit(noteEvent(diagnostic));
      return;
    }
    case "system":
      emitSystemMessage(object(message) ?? {}, events);
      return;
  }
}
