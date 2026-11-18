import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { modelEvent, noteEvent, otherToolCall, type AgentEvent, type ToolCall } from "../../provider.js";
import {
  attachObservedPatch,
  fileChangeToolCall,
  nonblank,
  object as record,
  observedTextContent,
  readToolCall,
  searchToolCall,
  stringValue,
  toolResult,
} from "../decode.js";
import { ToolObservations } from "../tool-observations.js";
import { diffstatFromUnifiedPatch } from "../unified-patch.js";

/**
 * Pi identifies a model as `<provider>/<id>`, the same convention its model
 * option uses. The selected model and every recorded response carry both
 * halves; a response without them names no model and stays unknown.
 */
function piModel(provider: unknown, id: unknown): string | undefined {
  const owner = nonblank(provider);
  const name = nonblank(id);
  return owner === undefined || name === undefined ? undefined : `${owner}/${name}`;
}

/** The model this native session will run, from its own selection. */
export function piSessionModel(selected: unknown): string | undefined {
  const value = record(selected);
  return piModel(value?.provider, value?.id);
}

function structuralCall(name: string, args: unknown): ToolCall | undefined {
  const value = record(args) ?? {};
  switch (name) {
    case "bash":
      return typeof value.command === "string" ? { kind: "run", command: value.command } : undefined;
    case "read":
      return readToolCall(value.path, value.offset, value.limit);
    case "grep":
    case "find":
      return searchToolCall(value.pattern ?? value.query, name === "find" ? "files" : "content", {
        path: value.path,
        glob: name === "grep" ? value.glob : undefined,
      });
    case "edit":
    case "write":
      // Native write does not prove creation versus overwrite.
      return fileChangeToolCall("update", stringValue(value.path));
    default:
      return undefined;
  }
}

export type PiEventState = {
  answer: string;
  assistantSeen: boolean;
  tools: ToolObservations;
};

export function translatePiEvent(
  event: AgentSessionEvent,
  state: PiEventState,
  emit: (event: AgentEvent) => void,
): void {
  switch (event.type) {
    case "compaction_end":
      if (event.errorMessage !== undefined) emit(noteEvent(event.errorMessage));
      else if (event.result !== undefined && !event.aborted) emit(noteEvent("Context compacted"));
      return;
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      emit(noteEvent(event.errorMessage));
      return;
    case "auto_retry_end":
      if (!event.success && event.finalError !== undefined) emit(noteEvent(event.finalError));
      return;
    case "tool_execution_start": {
      const { toolName: name, args } = event;
      const call = structuralCall(name, args) ?? otherToolCall(name, args);
      state.tools.start(event.toolCallId, { name, call });
      return;
    }
    case "tool_execution_end": {
      const started = state.tools.get(event.toolCallId);
      const name = started?.name ?? event.toolName;
      const call = started?.call ?? otherToolCall(name);
      const result = record(event.result);
      const patch =
        call.kind === "fileChange" && !event.isError ? stringValue(record(result?.details)?.patch) : undefined;
      const refined = patch === undefined ? call : attachObservedPatch(call, patch, diffstatFromUnifiedPatch(patch));
      state.tools.finish(
        event.toolCallId,
        { name, call: refined },
        toolResult(event.isError ? "error" : "ok", observedTextContent(result?.content)),
      );
      return;
    }
    case "message_end": {
      const message = event.message;
      if (message.role !== "assistant") return;
      const model = piModel(message.provider, message.model);
      if (model !== undefined) emit(modelEvent(model));
      const error = message.stopReason === "error" ? nonblank(message.errorMessage) : undefined;
      if (error !== undefined) emit(noteEvent(error));
      for (const block of message.content) {
        if (block.type === "thinking" && block.redacted !== true && nonblank(block.thinking) !== undefined) {
          emit({ type: "thought", text: block.thinking });
        }
      }
      const observed = observedTextContent(message.content);
      const text = observed ?? "";
      if (message.stopReason !== "toolUse") {
        state.assistantSeen = true;
        state.answer = text;
      }
      // A blank tool-use text block is transport scaffolding. A terminal empty
      // answer remains public evidence.
      if (observed !== undefined && !(message.stopReason === "toolUse" && text.trim().length === 0)) {
        emit({ type: "assistant", text });
      }
      return;
    }
    default:
      return;
  }
}

export function piTerminalFailure(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "error") return null;
    return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
      ? message.errorMessage
      : "Pi provider ended with an error";
  }
  return null;
}
