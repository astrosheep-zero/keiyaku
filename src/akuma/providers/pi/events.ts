import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { modelEvent, noteEvent, otherToolCall, type AgentEvent, type ToolCall } from "../../provider.js";
import { nonblank, observedTextContent, positiveLine, searchToolCall } from "../decode.js";
import { diffstatFromUnifiedPatch } from "../unified-patch.js";

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function textContent(content: unknown): string {
  return observedTextContent(content) ?? "";
}

function hasTextContent(content: unknown): boolean {
  return observedTextContent(content) !== undefined;
}

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

function runCall(name: string, value: Readonly<Record<string, unknown>>): ToolCall | undefined {
  return name === "bash" && typeof value.command === "string" ? { kind: "run", command: value.command } : undefined;
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
  return searchToolCall(query, name === "find" ? "files" : "content", {
    path: nonblank(value.path),
    glob: name === "grep" ? nonblank(value.glob) : undefined,
  });
}

function fileChangeCall(name: string, value: Readonly<Record<string, unknown>>): ToolCall | undefined {
  // Native write cannot prove creation versus overwrite and reports no patch, so
  // it joins the conservative update operation with unknown diffstat.
  if ((name !== "edit" && name !== "write") || typeof value.path !== "string") return undefined;
  return { kind: "fileChange", changes: [{ op: "update", path: value.path }] };
}

function refineEditCall(call: ToolCall, result: unknown): ToolCall {
  if (call.kind !== "fileChange") return call;
  const details = record(record(result)?.details);
  const patch = typeof details?.patch === "string" ? details.patch : undefined;
  if (patch === undefined) return call;
  const diffstat = diffstatFromUnifiedPatch(patch);
  const change = call.changes[0];
  if (change === undefined) return call;
  return { kind: "fileChange", changes: [{ ...change, ...(diffstat === undefined ? {} : { diffstat }), patch }] };
}

function toolCall(name: string, args: unknown): ToolCall {
  const value = record(args) ?? {};
  return (
    runCall(name, value) ??
    readCall(name, value) ??
    searchCall(name, value) ??
    fileChangeCall(name, value) ??
    otherToolCall(name, args)
  );
}

export type PiEventState = {
  answer: string;
  assistantSeen: boolean;
  tools: Map<string, Readonly<{ name: string; call: ToolCall }>>;
};

function translateToolStart(
  event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
  state: PiEventState,
): readonly AgentEvent[] {
  const call = toolCall(event.toolName, event.args);
  state.tools.set(event.toolCallId, { name: event.toolName, call });
  return [{ type: "tool", phase: "started", id: event.toolCallId, name: event.toolName, call }];
}

function translateToolEnd(
  event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
  state: PiEventState,
): readonly AgentEvent[] {
  const started = state.tools.get(event.toolCallId);
  state.tools.delete(event.toolCallId);
  const name = started?.name ?? event.toolName;
  const call = started?.call ?? otherToolCall(name);
  const output = observedTextContent(record(event.result)?.content);
  return [
    {
      type: "tool",
      phase: "completed",
      id: event.toolCallId,
      name,
      call: event.isError ? call : refineEditCall(call, event.result),
      result: {
        status: event.isError ? "error" : "ok",
        ...(output === undefined ? {} : { output }),
      },
    },
  ];
}

function translateMessage(
  event: Extract<AgentSessionEvent, { type: "message_end" }>,
  state: PiEventState,
): readonly AgentEvent[] {
  const message = record(event.message);
  if (message?.role !== "assistant") return [];
  const translated: AgentEvent[] = [];
  const model = piModel(message.provider, message.model);
  if (model !== undefined) translated.push(modelEvent(model));
  const error = message.stopReason === "error" ? nonblank(message.errorMessage) : undefined;
  if (error !== undefined) translated.push(noteEvent(error));
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
  const terminal = message.stopReason !== "toolUse";
  if (terminal) {
    state.assistantSeen = true;
    state.answer = text;
  }
  // Some providers emit a blank text block alongside every tool-use message:
  // empty from Gemini, whitespace from openai-responses-style proxies. It is
  // transport scaffolding, not narration; an ordinary terminal empty answer
  // remains public evidence.
  if (hasTextContent(message.content) && !(message.stopReason === "toolUse" && text.trim().length === 0)) {
    translated.push({ type: "assistant", text });
  }
  return translated;
}

export function translatePiEvent(event: AgentSessionEvent, state: PiEventState): readonly AgentEvent[] {
  switch (event.type) {
    case "compaction_end":
      if (event.errorMessage !== undefined) return [noteEvent(event.errorMessage)];
      return event.result !== undefined && !event.aborted ? [noteEvent("Context compacted")] : [];
    case "auto_retry_start":
    case "summarization_retry_scheduled":
      return [noteEvent(event.errorMessage)];
    case "auto_retry_end":
      return !event.success && event.finalError !== undefined ? [noteEvent(event.finalError)] : [];
    case "tool_execution_start":
      return translateToolStart(event, state);
    case "tool_execution_end":
      return translateToolEnd(event, state);
    case "message_end":
      return translateMessage(event, state);
    default:
      return [];
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
