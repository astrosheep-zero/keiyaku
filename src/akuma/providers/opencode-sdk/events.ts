import {
  modelEvent,
  noteEvent,
  otherToolCall,
  type AgentEvent,
  type PermissionRequest,
  type ToolCall,
  type ToolResult,
} from "../../provider.js";
import {
  diffCounts,
  fileChangeToolCall,
  nonblank,
  object,
  observedChange,
  observedTextBlocks,
  readToolCall,
  searchToolCall,
  stringValue,
  text,
  toolResult,
} from "../decode.js";
import { ToolObservations } from "../tool-observations.js";

type Emitter = { emit(event: AgentEvent): void };
type NativeData = Readonly<Record<string, unknown>>;
type State = {
  sessionId?: string;
  tools?: ToolObservations;
  permissions: Map<string, PermissionRequest>;
};

export function diagnostic(value: unknown): string {
  const data = object(value);
  return text(data?.message) ?? text(object(data?.data)?.message) ?? "OpenCode execution failed";
}

function structuralCall(name: string, input: unknown): ToolCall | undefined {
  const value = object(input);
  switch (name) {
    case "shell":
      return { kind: "run", command: text(value?.command) ?? "shell" };
    case "read":
      return readToolCall(nonblank(value?.filePath) ?? value?.path, value?.offset, value?.limit);
    case "grep":
    case "glob":
      return searchToolCall(value?.pattern, name === "glob" ? "files" : "content", { path: value?.path });
    case "edit":
      return fileChangeToolCall("update", text(value?.path));
    default:
      return undefined;
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
    const op = status === "added" ? "add" : status === "deleted" ? "delete" : "update";
    return [observedChange(op, path, stringValue(file?.patch), diffCounts(file?.additions, file?.deletions))];
  });
  return changes.length === 0 ? undefined : { kind: "fileChange", changes };
}

function result(type: string, data: NativeData): ToolResult {
  const failed = type === "session.tool.failed";
  return toolResult(
    failed ? "error" : "ok",
    observedTextBlocks(data.content, "\n\n"),
    failed ? diagnostic(data.error) : undefined,
    object(data.metadata)?.exit,
  );
}

function toolEvent(type: string, data: NativeData, tools: ToolObservations): void {
  const id = text(data.id);
  if (id === undefined) return;
  const observed = tools.get(id);
  if (observed === undefined || observed.phase === "completed") return;
  const { name } = observed;
  if (type === "session.tool.called") {
    const call = structuralCall(name, data.input) ?? otherToolCall(name, data.input);
    tools.start(id, { name, call });
    return;
  }
  const refined = name === "edit" || name === "patch" || name === "write" ? observedChanges(data.metadata) : undefined;
  tools.finish(id, { name, call: refined ?? otherToolCall(name) }, result(type, data));
}
function stepStarted(data: NativeData, events: Emitter): void {
  const model = object(data.model);
  const provider = text(model?.providerID);
  const id = text(model?.id);
  if (provider !== undefined && id !== undefined) events.emit(modelEvent(`${provider}/${id}`));
}

function permissionEvent(type: string, data: NativeData, events: Emitter, state: State): void {
  const id = text(type === "permission.asked" ? data.id : data.requestID);
  if (id === undefined) return;
  if (type === "permission.asked") {
    const action = text(data.action);
    if (action === undefined || !Array.isArray(data.resources)) return;
    const source = object(data.source);
    const tool =
      source?.type === "tool" && typeof source.id === "string" ? state.tools?.get(source.id)?.name : undefined;
    state.permissions.set(id, {
      id,
      action,
      resources: data.resources.filter((value): value is string => typeof value === "string"),
      ...(tool === undefined ? {} : { tool }),
    });
  } else if (!state.permissions.delete(id)) return;
  events.emit({ type: "permission", requests: [...state.permissions.values()] });
}

/** Only complete native values enter narration. The caller enforces submission/step correlation. */
export function mapEvent(value: unknown, events: Emitter, state: State): void {
  const event = object(value);
  if (event === undefined || typeof event.type !== "string") return;
  const data = object(event.data) ?? {};
  if (state.sessionId !== undefined && data.sessionID !== state.sessionId) return;
  const type = event.type;
  switch (type) {
    case "permission.asked":
    case "permission.replied":
      permissionEvent(type, data, events, state);
      return;
    case "session.step.started":
      stepStarted(data, events);
      return;
    case "session.text.ended":
    case "session.reasoning.ended":
      if (typeof data.text === "string")
        events.emit({ type: type === "session.text.ended" ? "assistant" : "thought", text: data.text });
      return;
    case "session.tool.input.started":
      if (typeof data.id === "string" && typeof data.name === "string") {
        state.tools ??= new ToolObservations((event) => events.emit(event));
        state.tools.pending(data.id, data.name);
      }
      return;
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed":
      if (state.tools !== undefined) toolEvent(type, data, state.tools);
      return;
    case "session.compaction.ended":
      events.emit(noteEvent("Context compacted"));
      return;
    case "session.compaction.failed":
    case "session.execution.failed":
    case "session.retry.scheduled":
      events.emit(noteEvent(diagnostic(data.error)));
      return;
    default:
      return;
  }
}
export function createEventState(sessionId?: string): State {
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    permissions: new Map(),
  };
}
