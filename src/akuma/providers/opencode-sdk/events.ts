import {
  modelEvent,
  noteEvent,
  otherToolCall,
  type AgentEvent,
  type ToolCall,
  type ToolResult,
} from "../../provider.js";
import { nonnegativeCount, object, positiveLine, stringValue, text } from "../decode.js";

type Emitter = { emit(event: AgentEvent): void };
type NativeData = Readonly<Record<string, unknown>>;
type State = {
  sessionId?: string;
  tools: Map<string, { name: string; call?: ToolCall }>;
  completed: Set<string>;
};

export function diagnostic(value: unknown): string {
  const data = object(value);
  return text(data?.message) ?? text(object(data?.data)?.message) ?? "OpenCode execution failed";
}
function shellCall(value: NativeData | undefined): ToolCall {
  return { kind: "run", command: text(value?.command) ?? "shell" };
}
function readCall(value: NativeData | undefined): ToolCall | undefined {
  const path = text(value?.filePath) ?? text(value?.path);
  if (path === undefined) return undefined;
  return {
    kind: "read",
    path,
    ...(positiveLine(value?.offset) === undefined ? {} : { offset: positiveLine(value?.offset)! }),
    ...(positiveLine(value?.limit) === undefined ? {} : { limit: positiveLine(value?.limit)! }),
  };
}
function searchCall(name: "grep" | "glob", value: NativeData | undefined): ToolCall | undefined {
  const query = text(value?.pattern);
  const path = text(value?.path);
  if (query === undefined) return undefined;
  return {
    kind: "search",
    scope: name === "glob" ? "files" : "content",
    query,
    ...(path === undefined ? {} : { path }),
  };
}
function editCall(value: NativeData | undefined): ToolCall | undefined {
  const path = text(value?.path);
  if (path !== undefined) return { kind: "fileChange", changes: [{ op: "update", path }] };
  return undefined;
}
function callFor(name: string, input: unknown): ToolCall {
  const value = object(input);
  switch (name) {
    case "shell":
      return shellCall(value);
    case "read":
      return readCall(value) ?? otherToolCall(name, input);
    case "grep":
    case "glob":
      return searchCall(name, value) ?? otherToolCall(name, input);
    case "edit":
      return editCall(value) ?? otherToolCall(name, input);
    default:
      return otherToolCall(name, input);
  }
}
function observedChanges(metadata: unknown): Extract<ToolCall, { kind: "fileChange" }> | undefined {
  const files = object(metadata)?.files;
  if (!Array.isArray(files)) return undefined;
  const changes = files.flatMap((item) => {
    const file = object(item);
    const path = text(file?.file);
    const status = file?.status;
    if (path === undefined || (status !== "added" && status !== "deleted" && status !== "modified")) return [];
    const added = nonnegativeCount(file?.additions);
    const removed = nonnegativeCount(file?.deletions);
    const patch = stringValue(file?.patch);
    return [
      {
        op: status === "added" ? ("add" as const) : status === "deleted" ? ("delete" as const) : ("update" as const),
        path,
        ...(added === undefined || removed === undefined ? {} : { diffstat: { added, removed } }),
        ...(patch === undefined ? {} : { patch }),
      },
    ];
  });
  return changes.length === 0 ? undefined : { kind: "fileChange", changes };
}
function output(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    const value = object(part);
    const text = value?.type === "text" ? stringValue(value.text) : undefined;
    return text === undefined ? [] : [text];
  });
  return parts.length === 0 ? undefined : parts.join("\n\n");
}
const DROPPED = new Set([
  "server.connected",
  "server.heartbeat",
  "session.created",
  "session.forked",
  "session.deleted",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.inbox.delivery.changed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.model.selected",
  "session.agent.selected",
  "session.instructions.updated",
  "session.permissions",
  "session.step.streamed",
  "session.step.ended",
  "session.usage.updated",
  "session.usage.recorded",
  "session.text.started",
  "session.text.delta",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.progress",
  "session.retry.scheduled",
]);

function toolResult(type: string, data: NativeData): ToolResult {
  const observed = output(data.content);
  const nativeExit = object(data.metadata)?.exit;
  const exit = typeof nativeExit === "number" && Number.isInteger(nativeExit) ? nativeExit : undefined;
  return {
    status: type === "session.tool.failed" || (exit !== undefined && exit !== 0) ? "error" : "ok",
    ...(type === "session.tool.failed" ? { message: diagnostic(data.error) } : {}),
    ...(observed === undefined ? {} : { output: observed }),
    ...(exit === undefined ? {} : { exitCode: exit }),
  };
}
function toolEvent(type: string, data: NativeData, events: Emitter, state: State): void {
  const id = text(data.id);
  const started = id === undefined ? undefined : state.tools.get(id);
  if (id === undefined || started === undefined || state.completed.has(id)) return;
  if (started.call === undefined) {
    started.call = callFor(started.name, data.input);
    events.emit({ type: "tool", phase: "started", id, name: started.name, call: started.call });
  }
  if (type === "session.tool.called") return;
  if (started.name === "edit" || started.name === "patch" || started.name === "write") {
    started.call = observedChanges(data.metadata) ?? started.call;
  }
  const result = toolResult(type, data);
  state.completed.add(id);
  events.emit({ type: "tool", phase: "completed", id, name: started.name, call: started.call, result });
}
function stepStarted(data: NativeData, events: Emitter): void {
  const model = object(data.model);
  const provider = text(model?.providerID);
  const id = text(model?.id);
  if (provider !== undefined && id !== undefined) events.emit(modelEvent(`${provider}/${id}`));
}
function toolInputStarted(data: NativeData, state: State): void {
  if (typeof data.id === "string" && typeof data.name === "string") state.tools.set(data.id, { name: data.name });
}

/** Only complete native values enter narration. The caller enforces submission/step correlation. */
export function mapEvent(value: unknown, events: Emitter, state: State): void {
  const event = object(value);
  if (event === undefined || typeof event.type !== "string") return;
  const data = object(event.data) ?? {};
  if (state.sessionId !== undefined && data.sessionID !== state.sessionId) return;
  const type = event.type;
  switch (type) {
    case "session.step.started":
      stepStarted(data, events);
      return;
    case "session.text.ended":
    case "session.reasoning.ended":
      if (typeof data.text === "string")
        events.emit({ type: type === "session.text.ended" ? "assistant" : "thought", text: data.text });
      return;
    case "session.tool.input.started":
      toolInputStarted(data, state);
      return;
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed":
      toolEvent(type, data, events, state);
      return;
    case "session.compaction.ended":
      events.emit(noteEvent("Context compacted"));
      return;
    case "session.compaction.failed":
      events.emit(noteEvent(diagnostic(data.error)));
      return;
    case "session.compaction.started":
    case "session.compaction.delta":
      return;
    default:
      if (!DROPPED.has(type)) events.emit({ type: "unknown", kind: type });
  }
}
export function createEventState(sessionId?: string): State {
  return { ...(sessionId === undefined ? {} : { sessionId }), tools: new Map(), completed: new Set() };
}
