import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentEventChannel, modelEvent, noteEvent, otherToolCall, type ToolCall } from "../../provider.js";
import {
  diffCounts,
  fileChangeToolCall,
  finiteNumber,
  nonblank,
  object,
  observedChange,
  observedTextContent,
  readToolCall,
  searchToolCall,
  stringValue,
  toolResult,
  trimmed,
} from "../decode.js";
import { ToolObservations } from "../tool-observations.js";
import { diffstatFromUnifiedPatch } from "../unified-patch.js";

function structuredToolCall(name: string, input: unknown): ToolCall | undefined {
  const value = object(input);
  if (value === undefined) return undefined;
  switch (name) {
    case "Bash": {
      const command = trimmed(value.command);
      return command === undefined ? undefined : { kind: "run", command };
    }
    case "Read": {
      const path = nonblank(value.file_path) ?? nonblank(value.path);
      return readToolCall(path, value.offset, value.limit);
    }
    case "Grep":
      return searchToolCall(nonblank(value.pattern) ?? value.query, "content", { path: value.path, glob: value.glob });
    case "Glob":
      return searchToolCall(value.pattern, "files", { path: value.path });
    case "WebSearch":
      return searchToolCall(value.query, "web");
    case "Write":
      return fileChangeToolCall("add", trimmed(value.file_path));
    case "Edit":
      return fileChangeToolCall("update", trimmed(value.file_path));
    case "NotebookEdit":
      return fileChangeToolCall("update", trimmed(value.notebook_path));
    default:
      return undefined;
  }
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

function structuredFileChange(name: string, result: unknown): ToolCall | undefined {
  const value = object(result);
  if (value === undefined) return undefined;
  if (name === "NotebookEdit") return fileChangeToolCall("update", trimmed(value.notebook_path));
  if (name !== "Edit" && name !== "Write") return undefined;
  const writeShape = value.type === "create" || value.type === "update";
  const path = trimmed(value.filePath);
  if (path === undefined || (name === "Write") !== writeShape) return undefined;
  const diff = object(value.gitDiff);
  const op = (writeShape ? value.type === "create" : diff?.status === "added") ? "add" : "update";
  const patch = stringValue(diff?.patch) ?? structuredPatchText(path, value.structuredPatch);
  const diffstat =
    diffCounts(diff?.additions, diff?.deletions) ?? (patch === undefined ? undefined : diffstatFromUnifiedPatch(patch));
  return { kind: "fileChange", changes: [observedChange(op, path, patch, diffstat)] };
}

function assistantEvents(
  message: Extract<SDKMessage, { type: "assistant" }>,
  events: AgentEventChannel,
  tools: ToolObservations,
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
    const call = structuredToolCall(block.name, block.input) ?? otherToolCall(block.name, block.input);
    tools.start(block.id, { name: block.name, call });
  }
}

function toolResultEvents(message: Extract<SDKMessage, { type: "user" }>, tools: ToolObservations): void {
  const content = object(message.message)?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const value = object(block);
    if (value?.type !== "tool_result") continue;
    const id = nonblank(value.tool_use_id);
    if (id === undefined) continue;
    const observed = tools.get(id);
    if (observed === undefined || observed.phase === "completed") continue;
    const failed = value.is_error === true;
    const structured = failed ? undefined : structuredFileChange(observed.name, message.tool_use_result);
    tools.finish(
      id,
      structured === undefined ? undefined : { name: observed.name, call: structured },
      toolResult(failed ? "error" : "ok", observedTextContent(value.content)),
    );
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

export function emitClaudeMessage(message: SDKMessage, events: AgentEventChannel, tools: ToolObservations): void {
  switch (message.type) {
    case "assistant":
      assistantEvents(message, events, tools);
      return;
    case "user":
      toolResultEvents(message, tools);
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
