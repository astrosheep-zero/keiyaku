import type { AgentEvent, ToolCall, ToolResult } from "../../provider.js";
import type { SessionDurableEvent } from "@opencode-ai/sdk/v2";

type Emitter = { emit(event: AgentEvent): void };
type ToolState = Readonly<{ name: string; call: ToolCall }>;
type State = { tools: Map<string, ToolState>; answer: string[]; seen: Set<string>; failure?: string };

type NativeEventKind = SessionDurableEvent["type"];
export const OPENCODE_EVENT_DISPOSITIONS = {
  "session.next.agent.switched": "dropped",
  "session.next.model.switched": "dropped",
  "session.next.moved": "dropped",
  "session.next.prompted": "dropped",
  "session.next.prompt.admitted": "dropped",
  "session.next.context.updated": "dropped",
  "session.next.synthetic": "dropped",
  "session.next.shell.started": "dropped",
  "session.next.shell.ended": "dropped",
  "session.next.step.started": "dropped",
  "session.next.step.ended": "dropped",
  "session.next.step.failed": "mapped",
  "session.next.text.started": "dropped",
  "session.next.text.ended": "mapped",
  "session.next.tool.input.started": "dropped",
  "session.next.tool.input.ended": "dropped",
  "session.next.tool.called": "mapped",
  "session.next.tool.progress": "dropped",
  "session.next.tool.success": "mapped",
  "session.next.tool.failed": "mapped",
  "session.next.reasoning.started": "dropped",
  "session.next.reasoning.ended": "mapped",
  "session.next.retried": "mapped",
  "session.next.compaction.started": "dropped",
  "session.next.compaction.ended": "dropped",
  "session.next.revert.staged": "dropped",
  "session.next.revert.cleared": "dropped",
  "session.next.revert.committed": "dropped",
} as const satisfies Record<NativeEventKind, "mapped" | "dropped">;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function diagnostic(value: unknown): string { const v = object(value); return text(v?.message) ?? text(v?.error) ?? "OpenCode session failed"; }
function callFor(name: string, input: unknown): ToolCall {
  const value = object(input);
  if (name === "shell") return { kind: "run", command: text(value?.command) ?? "shell" };
  if (name === "read") return { kind: "read", path: text(value?.path) ?? "file" };
  if (name === "grep" || name === "search") return { kind: "search", query: text(value?.query) ?? "search" };
  return { kind: "other", display: name };
}
function resultFor(value: unknown, failed: boolean): ToolResult {
  return { status: failed ? "error" : "ok", ...(failed ? { message: diagnostic(value) } : {}) };
}

export function mapEvent(value: unknown, events: Emitter, state: State): void {
  const event = object(value);
  const eventId = text(event?.id);
  if (eventId !== undefined && state.seen.has(eventId)) return;
  if (eventId !== undefined) state.seen.add(eventId);
  const kind = text(event?.type) ?? "unknown";
  const data = object(event?.data) ?? event ?? {};
  switch (kind) {
    case "session.next.text.ended": {
      const value = text(data.text); if (value !== undefined) { state.answer.push(value); events.emit({ type: "assistant", text: value }); } return;
    }
    case "session.next.reasoning.ended": { const value = text(data.text); if (value !== undefined) events.emit({ type: "thought", text: value }); return; }
    case "session.next.tool.called": {
      const id = text(data.callID); if (id === undefined) { events.emit({ type: "unknown", kind: `${kind}/missing-id` }); return; }
      const observed = { name: text(data.tool) ?? "tool", call: callFor(text(data.tool) ?? "tool", data.input) };
      state.tools.set(id, observed); events.emit({ type: "tool", phase: "started", id, ...observed }); return;
    }
    case "session.next.tool.success":
    case "session.next.tool.failed": {
      const id = text(data.callID); if (id === undefined) { events.emit({ type: "unknown", kind: `${kind}/missing-id` }); return; }
      const started = state.tools.get(id); const failed = kind.endsWith("failed");
      if (started === undefined) { events.emit({ type: "unknown", kind: `${kind}/orphan` }); return; }
      state.tools.delete(id); events.emit({ type: "tool", phase: "completed", id, ...started, result: resultFor(data.error, failed) }); return;
    }
    case "session.next.step.failed": state.failure = diagnostic(data.error); events.emit({ type: "note", text: state.failure }); return;
    case "session.next.retried": events.emit({ type: "note", text: "Retrying" }); return;
    default: {
      const disposition = OPENCODE_EVENT_DISPOSITIONS[kind as NativeEventKind];
      if (disposition === "dropped") return;
      events.emit({ type: "unknown", kind });
    }
  }
}

export type EventState = State;
export function createEventState(): State { return { tools: new Map(), answer: [], seen: new Set() }; }
