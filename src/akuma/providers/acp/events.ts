import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { noteEvent, unknownEvent, type AgentEvent, type ToolCall } from "../../provider.js";

type OpenBlock = Readonly<{ type: "assistant" | "thought"; text: string }> | null;

export type AcpEventState = Readonly<{
  answer: string;
  assistantMessageId: string | null;
  open: OpenBlock;
  tools: ReadonlyMap<string, string>;
}>;
type AcpEventMapping = Readonly<{ events: readonly AgentEvent[]; state: AcpEventState }>;

export const EMPTY_ACP_EVENT_STATE: AcpEventState = Object.freeze({
  answer: "",
  assistantMessageId: null,
  open: null,
  tools: new Map(),
});

export function flushAcpEvents(state: AcpEventState, boundary: readonly AgentEvent[] = []): AcpEventMapping {
  const events = state.open === null ? boundary : [{ type: state.open.type, text: state.open.text }, ...boundary];
  return {
    events,
    state: state.open === null ? state : { ...state, open: null },
  };
}

function appendBlock(
  state: AcpEventState,
  type: "assistant" | "thought",
  text: string,
  messageId?: string,
): AcpEventMapping {
  const newAssistantMessage = type === "assistant"
    && messageId !== undefined
    && state.assistantMessageId !== messageId;
  const flushed = state.open === null || (state.open.type === type && !newAssistantMessage)
    ? { events: [], state }
    : flushAcpEvents(state);
  return {
    events: flushed.events,
    state: {
      ...flushed.state,
      answer: type === "assistant"
        ? `${newAssistantMessage ? "" : flushed.state.answer}${text}`
        : flushed.state.answer,
      assistantMessageId: type === "assistant" && messageId !== undefined
        ? messageId
        : flushed.state.assistantMessageId,
      open: { type, text: `${flushed.state.open?.text ?? ""}${text}` },
    },
  };
}

export function mapAcpUpdate(update: SessionUpdate, previous: AcpEventState): AcpEventMapping {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const text = update.content.type === "text" ? update.content.text : undefined;
      if (text === undefined) return flushAcpEvents(previous, [unknownEvent(`${update.sessionUpdate}/${update.content.type}`)]);
      return appendBlock(
        previous,
        update.sessionUpdate === "agent_message_chunk" ? "assistant" : "thought",
        text,
        update.sessionUpdate === "agent_message_chunk" && update.messageId !== null
          ? update.messageId
          : undefined,
      );
    }
    case "user_message_chunk": return flushAcpEvents(previous);
    case "tool_call":
    case "tool_call_update": {
      const name = update.title ?? (update.sessionUpdate === "tool_call" ? undefined : previous.tools.get(update.toolCallId)) ?? "ACP tool";
      const observed = { name, call: { kind: "other", display: name } as ToolCall };
      const tools = new Map(previous.tools);
      if (update.status === "completed" || update.status === "failed") {
        tools.delete(update.toolCallId);
        return flushAcpEvents({ ...previous, tools }, [{ type: "tool", phase: "completed", id: update.toolCallId, ...observed, result: { status: update.status === "completed" ? "ok" : "error" } }]);
      }
      const started = tools.has(update.toolCallId);
      tools.set(update.toolCallId, name);
      return started
        ? flushAcpEvents({ ...previous, tools })
        : flushAcpEvents({ ...previous, tools }, [{ type: "tool", phase: "started", id: update.toolCallId, ...observed }]);
    }
    case "plan": return flushAcpEvents(previous, [noteEvent(`Plan updated: ${update.entries.map((entry) => entry.content).join("; ")}`)]);
    case "available_commands_update": return flushAcpEvents(previous, [noteEvent("ACP commands updated")]);
    case "current_mode_update": return flushAcpEvents(previous, [noteEvent("ACP mode updated")]);
    case "config_option_update": return flushAcpEvents(previous, [noteEvent("ACP configuration updated")]);
    case "session_info_update": return flushAcpEvents(previous, [noteEvent("ACP session metadata updated")]);
    case "usage_update": return flushAcpEvents(previous);
    case "plan_update":
    case "plan_removed": return flushAcpEvents(previous, [unknownEvent(update.sessionUpdate)]);
    default: return { events: [unknownEvent(String((update as { sessionUpdate?: unknown }).sessionUpdate))], state: previous };
  }
}
