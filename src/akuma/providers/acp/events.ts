import type { SessionUpdate, ToolCallLocation } from "@agentclientprotocol/sdk";
import { noteEvent, unknownEvent, type AgentEvent, type ToolCall } from "../../provider.js";

type OpenBlock = Readonly<{ type: "assistant" | "thought"; text: string }> | null;

export type AcpToolObservation = Readonly<{ name: string; call: ToolCall }>;
export type AcpToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;
export type AcpToolInterpreter = (update: AcpToolUpdate) => ToolCall | undefined;

export type AcpEventState = Readonly<{
  answer: string;
  assistantMessageId: string | null;
  open: OpenBlock;
  tools: ReadonlyMap<string, AcpToolObservation>;
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
  const newAssistantMessage = type === "assistant" && messageId !== undefined && state.assistantMessageId !== messageId;
  const flushed =
    state.open === null || (state.open.type === type && !newAssistantMessage)
      ? { events: [], state }
      : flushAcpEvents(state);
  return {
    events: flushed.events,
    state: {
      ...flushed.state,
      answer: type === "assistant" ? `${newAssistantMessage ? "" : flushed.state.answer}${text}` : flushed.state.answer,
      assistantMessageId:
        type === "assistant" && messageId !== undefined ? messageId : flushed.state.assistantMessageId,
      open: { type, text: `${flushed.state.open?.text ?? ""}${text}` },
    },
  };
}

function nonblank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function otherCall(name: string): ToolCall {
  return { kind: "other", display: name };
}

function locationFact(locations: readonly ToolCallLocation[] | null | undefined): {
  path?: string;
  offset?: number;
} {
  if (locations === null || locations === undefined) return {};
  for (const location of locations) {
    const path = nonblank(location.path);
    if (path === undefined) continue;
    const offset = positiveLine(location.line);
    return offset === undefined ? { path } : { path, offset };
  }
  return {};
}

function standardCall(update: AcpToolUpdate, name: string): ToolCall {
  const location = locationFact(update.locations);
  if (update.kind === "read") {
    return location.path === undefined
      ? otherCall(name)
      : {
          kind: "read",
          path: location.path,
          ...(location.offset === undefined ? {} : { offset: location.offset }),
        };
  }
  const input = object(update.rawInput);
  if (update.kind === "execute") {
    const command = nonblank(input?.command);
    return command === undefined ? otherCall(name) : { kind: "run", command };
  }
  if (update.kind === "search") {
    const query = nonblank(input?.query);
    if (query === undefined) return otherCall(name);
    const path = nonblank(input?.path);
    const glob = nonblank(input?.glob);
    const scope = input?.scope;
    const searchScope = scope === "content" || scope === "files" || scope === "web" ? scope : undefined;
    return {
      kind: "search",
      query,
      ...(searchScope === undefined ? {} : { scope: searchScope }),
      ...(path === undefined ? {} : { path }),
      ...(glob === undefined ? {} : { glob }),
    };
  }
  return otherCall(name);
}

function strongest(previous: ToolCall | undefined, next: ToolCall): ToolCall {
  if (previous === undefined || previous.kind === "other") return next;
  return next.kind === "other" ? previous : next;
}

function observeTool(
  update: AcpToolUpdate,
  previous: AcpToolObservation | undefined,
  interpret?: AcpToolInterpreter,
): AcpToolObservation {
  const name = nonblank(update.name) ?? nonblank(update.title) ?? previous?.name ?? "ACP tool";
  const standard = standardCall(update, name);
  const dialect = standard.kind === "other" ? interpret?.(update) : undefined;
  return { name, call: strongest(previous?.call, dialect ?? standard) };
}

export function mapAcpUpdate(
  update: SessionUpdate,
  previous: AcpEventState,
  interpret?: AcpToolInterpreter,
): AcpEventMapping {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const text = update.content.type === "text" ? update.content.text : undefined;
      if (text === undefined)
        return flushAcpEvents(previous, [unknownEvent(`${update.sessionUpdate}/${update.content.type}`)]);
      return appendBlock(
        previous,
        update.sessionUpdate === "agent_message_chunk" ? "assistant" : "thought",
        text,
        update.sessionUpdate === "agent_message_chunk" && update.messageId !== null ? update.messageId : undefined,
      );
    }
    case "user_message_chunk":
      return flushAcpEvents(previous);
    case "tool_call":
    case "tool_call_update": {
      const observed = observeTool(update, previous.tools.get(update.toolCallId), interpret);
      const tools = new Map(previous.tools);
      if (update.status === "completed" || update.status === "failed") {
        tools.delete(update.toolCallId);
        return flushAcpEvents({ ...previous, tools }, [
          {
            type: "tool",
            phase: "completed",
            id: update.toolCallId,
            ...observed,
            result: { status: update.status === "completed" ? "ok" : "error" },
          },
        ]);
      }
      const started = tools.has(update.toolCallId);
      tools.set(update.toolCallId, observed);
      return started
        ? flushAcpEvents({ ...previous, tools })
        : flushAcpEvents({ ...previous, tools }, [
            { type: "tool", phase: "started", id: update.toolCallId, ...observed },
          ]);
    }
    case "plan":
      return flushAcpEvents(previous, [
        noteEvent(`Plan updated: ${update.entries.map((entry) => entry.content).join("; ")}`),
      ]);
    case "available_commands_update":
      return flushAcpEvents(previous, [noteEvent("ACP commands updated")]);
    case "current_mode_update":
      return flushAcpEvents(previous, [noteEvent("ACP mode updated")]);
    case "config_option_update":
      return flushAcpEvents(previous, [noteEvent("ACP configuration updated")]);
    case "session_info_update":
      return flushAcpEvents(previous, [noteEvent("ACP session metadata updated")]);
    case "usage_update":
      return flushAcpEvents(previous);
    case "plan_update":
    case "plan_removed":
      return flushAcpEvents(previous, [unknownEvent(update.sessionUpdate)]);
    default:
      return { events: [unknownEvent(String((update as { sessionUpdate?: unknown }).sessionUpdate))], state: previous };
  }
}
