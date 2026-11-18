import type { SessionUpdate, ToolCallLocation } from "@agentclientprotocol/sdk";
import { otherToolCall, type AgentEvent, type ToolCall } from "../../provider.js";
import {
  nonblank,
  object,
  observedTextBlocks,
  readToolCall,
  searchToolCall,
  stringValue,
  toolResult,
} from "../decode.js";
import { ToolObservations } from "../tool-observations.js";

type Emit = (event: AgentEvent) => void;
type OpenBlock = { type: "assistant" | "thought"; text: string };
export type AcpToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;
export type AcpToolInterpreter = (update: AcpToolUpdate) => ToolCall | undefined;
export type AcpEventState = {
  answer: string;
  assistantMessageId: string | null;
  open: OpenBlock | null;
  tools: ToolObservations;
};

export function createAcpEventState(emit: Emit): AcpEventState {
  return { answer: "", assistantMessageId: null, open: null, tools: new ToolObservations(emit) };
}

export function flushAcpEvents(state: AcpEventState, emit: Emit): void {
  const block = state.open;
  state.open = null;
  if (block !== null) emit(block);
}

function appendBlock(
  state: AcpEventState,
  type: OpenBlock["type"],
  text: string,
  emit: Emit,
  messageId?: string,
): void {
  const newMessage = type === "assistant" && messageId !== undefined && state.assistantMessageId !== messageId;
  if (state.open !== null && (state.open.type !== type || newMessage)) flushAcpEvents(state, emit);
  if (type === "assistant") {
    state.answer = `${newMessage ? "" : state.answer}${text}`;
    if (messageId !== undefined) state.assistantMessageId = messageId;
  }
  if (state.open === null) state.open = { type, text };
  else state.open.text += text;
}

function locationCall(locations: readonly ToolCallLocation[] | null | undefined): ToolCall | undefined {
  for (const location of locations ?? []) {
    const call = readToolCall(location.path, location.line);
    if (call !== undefined) return call;
  }
  return undefined;
}

/** Only native text blocks or a raw string are observed output. */
function verifiedToolOutput(update: AcpToolUpdate): string | undefined {
  const blocks = update.content?.flatMap((entry) => (entry.type === "content" ? [entry.content] : []));
  return observedTextBlocks(blocks, "") ?? stringValue(update.rawOutput);
}

function standardCall(update: AcpToolUpdate): ToolCall | undefined {
  if (update.kind === "read") return locationCall(update.locations);
  const input = object(update.rawInput);
  if (update.kind === "search") {
    return searchToolCall(input?.query, input?.scope, { path: input?.path, glob: input?.glob });
  }
  const command = update.kind === "execute" ? nonblank(input?.command) : undefined;
  return command === undefined ? undefined : { kind: "run", command };
}

export function emitAcpUpdate(
  update: SessionUpdate,
  state: AcpEventState,
  emit: Emit,
  interpret?: AcpToolInterpreter,
): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text")
        appendBlock(state, "assistant", update.content.text, emit, update.messageId ?? undefined);
      return;
    case "agent_thought_chunk":
      if (update.content.type === "text") appendBlock(state, "thought", update.content.text, emit);
      return;
    case "tool_call":
    case "tool_call_update": {
      const previous = state.tools.get(update.toolCallId);
      if (previous?.phase === "completed") return;
      const finished = update.status === "completed" || update.status === "failed";
      if (!finished && previous === undefined && update.sessionUpdate === "tool_call_update") return;
      const name = nonblank(update.name) ?? nonblank(update.title) ?? previous?.name ?? "ACP tool";
      const call = standardCall(update) ?? interpret?.(update) ?? otherToolCall(name, update.rawInput);
      const observed = { name, call };
      if (finished || previous?.phase !== "started") flushAcpEvents(state, emit);
      if (finished) {
        const result = toolResult(update.status === "completed" ? "ok" : "error", verifiedToolOutput(update));
        state.tools.finish(update.toolCallId, observed, result);
      } else {
        state.tools.start(update.toolCallId, observed);
      }
      return;
    }
    case "user_message_chunk":
      flushAcpEvents(state, emit);
      return;
  }
}
