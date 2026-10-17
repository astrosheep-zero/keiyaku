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
type State = {
  sessionId?: string;
  tools: Map<string, { name: string; call?: ToolCall }>;
  completed: Set<string>;
};

export function diagnostic(value: unknown): string {
  const data = object(value);
  return text(data?.message) ?? text(object(data?.data)?.message) ?? "OpenCode execution failed";
}
function callFor(name: string, input: unknown): ToolCall {
  const value = object(input);
  if (name === "shell") return { kind: "run", command: text(value?.command) ?? name };
  if (name === "read") {
    const path = text(value?.filePath) ?? text(value?.path);
    if (path !== undefined)
      return {
        kind: "read",
        path,
        ...(positiveLine(value?.offset) === undefined ? {} : { offset: positiveLine(value?.offset)! }),
        ...(positiveLine(value?.limit) === undefined ? {} : { limit: positiveLine(value?.limit)! }),
      };
  }
  if (name === "grep" || name === "glob") {
    const query = text(value?.pattern);
    const path = text(value?.path);
    if (query !== undefined)
      return {
        kind: "search",
        scope: name === "glob" ? "files" : "content",
        query,
        ...(path === undefined ? {} : { path }),
      };
  }
  if (name === "edit") {
    const path = text(value?.path);
    if (path !== undefined) return { kind: "fileChange", changes: [{ op: "update", path }] };
  }
  return otherToolCall(name, input);
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

/** Only complete native values enter narration. The caller enforces submission/step correlation. */
export function mapEvent(value: unknown, events: Emitter, state: State): void {
  const event = object(value);
  if (event === undefined || typeof event.type !== "string") return;
  const data = object(event.data) ?? {};
  if (state.sessionId !== undefined && data.sessionID !== state.sessionId) return;
  const type = event.type;
  if (type === "session.step.started") {
    const model = object(data.model);
    const provider = text(model?.providerID);
    const id = text(model?.id);
    if (provider !== undefined && id !== undefined) events.emit(modelEvent(`${provider}/${id}`));
    return;
  }
  if (type === "session.text.ended" || type === "session.reasoning.ended") {
    if (typeof data.text === "string")
      events.emit({ type: type === "session.text.ended" ? "assistant" : "thought", text: data.text });
    return;
  }
  if (type === "session.tool.input.started") {
    if (typeof data.id === "string" && typeof data.name === "string") state.tools.set(data.id, { name: data.name });
    return;
  }
  if (type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") {
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
    const observed = output(data.content);
    const nativeExit = object(data.metadata)?.exit;
    const exit = typeof nativeExit === "number" && Number.isInteger(nativeExit) ? nativeExit : undefined;
    const result: ToolResult = {
      status: type === "session.tool.failed" || (exit !== undefined && exit !== 0) ? "error" : "ok",
      ...(type === "session.tool.failed" ? { message: diagnostic(data.error) } : {}),
      ...(observed === undefined ? {} : { output: observed }),
      ...(exit === undefined ? {} : { exitCode: exit }),
    };
    state.completed.add(id);
    events.emit({ type: "tool", phase: "completed", id, name: started.name, call: started.call, result });
    return;
  }
  if (type === "session.compaction.ended") {
    events.emit(noteEvent("Context compacted"));
    return;
  }
  if (type === "session.compaction.failed") {
    events.emit(noteEvent(diagnostic(data.error)));
    return;
  }
  if (type === "session.compaction.started" || type === "session.compaction.delta" || DROPPED.has(type)) return;
  events.emit({ type: "unknown", kind: type });
}
export function createEventState(sessionId?: string): State {
  return { ...(sessionId === undefined ? {} : { sessionId }), tools: new Map(), completed: new Set() };
}
