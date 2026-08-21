import { noteEvent, type AgentEvent, type ToolCall, type ToolResult } from "../../provider.js";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk";

type Emitter = { emit(event: AgentEvent): void };
type ObservedTool = Readonly<{ name: string; call: ToolCall }>;
type State = {
  sessionId?: string;
  assistantParts: Set<string>;
  reasoningParts: Set<string>;
  tools: Map<string, ObservedTool>;
  completedTools: Set<string>;
  failure?: string;
};
type Part = Record<string, unknown>;
type NativeEventKind = OpencodeEvent["type"];

export const OPENCODE_EVENT_DISPOSITIONS = {
  "server.instance.disposed": "dropped",
  "installation.updated": "dropped",
  "installation.update-available": "dropped",
  "lsp.client.diagnostics": "dropped",
  "lsp.updated": "dropped",
  "message.updated": "mapped",
  "message.removed": "dropped",
  "message.part.updated": "mapped",
  "message.part.removed": "dropped",
  "permission.updated": "dropped",
  "permission.replied": "dropped",
  "session.status": "dropped",
  "session.idle": "dropped",
  "session.compacted": "dropped",
  "file.edited": "dropped",
  "todo.updated": "mapped",
  "command.executed": "dropped",
  "session.created": "dropped",
  "session.updated": "dropped",
  "session.deleted": "dropped",
  "session.diff": "dropped",
  "session.error": "mapped",
  "file.watcher.updated": "dropped",
  "vcs.branch.updated": "dropped",
  "tui.prompt.append": "dropped",
  "tui.command.execute": "dropped",
  "tui.toast.show": "dropped",
  "pty.created": "dropped",
  "pty.updated": "dropped",
  "pty.exited": "dropped",
  "pty.deleted": "dropped",
  "server.connected": "dropped",
} as const satisfies Record<NativeEventKind, "mapped" | "dropped">;

// OpenCode may emit these server-side metadata events before the generated
// SDK union catches up. They are all non-narrative and therefore remain drop
// dispositions; genuinely new execution events still use the unknown arm.
const RUNTIME_DROPPED_EVENT_KINDS = new Set([
  "plugin.added",
  "catalog.updated",
  "reference.updated",
  "integration.updated",
  "server.heartbeat",
  "message.part.delta",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function diagnostic(value: unknown): string {
  const data = object(value);
  const nested = object(data?.data);
  return text(nested?.message) ?? text(data?.message) ?? "OpenCode session failed";
}
function positiveLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}
function nonnegativeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
type FileChangeCall = Extract<ToolCall, { kind: "fileChange" }>;
function diffstat(value: Record<string, unknown> | undefined): FileChangeCall["changes"][number]["diffstat"] {
  if (value === undefined) return undefined;
  const added = nonnegativeCount(value.additions);
  const removed = nonnegativeCount(value.deletions);
  return added === undefined || removed === undefined ? undefined : { added, removed };
}
function fileChange(changes: FileChangeCall["changes"]): FileChangeCall | undefined {
  return changes.length === 0 ? undefined : { kind: "fileChange", changes };
}
function change(
  op: FileChangeCall["changes"][number]["op"],
  path: string,
  stats: FileChangeCall["changes"][number]["diffstat"],
): FileChangeCall["changes"][number] {
  return stats === undefined ? { op, path } : { op, path, diffstat: stats };
}
function editCall(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): ToolCall | undefined {
  const path = text(input?.filePath);
  if (path === undefined) return undefined;
  return fileChange([change("update", path, diffstat(object(metadata?.filediff)))]);
}
function writeCall(
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): ToolCall | undefined {
  const path = text(metadata?.filepath) ?? text(input?.filePath);
  const op =
    metadata?.exists === false ? ("add" as const) : metadata?.exists === true ? ("update" as const) : undefined;
  return path === undefined || op === undefined ? undefined : fileChange([change(op, path, undefined)]);
}
function applyPatchFile(value: unknown): FileChangeCall["changes"][number] | undefined {
  const file = object(value);
  if (file === undefined) return undefined;
  const type = file.type;
  const op =
    type === "add"
      ? ("add" as const)
      : type === "delete"
        ? ("delete" as const)
        : type === "update" || type === "modify" || type === "move"
          ? ("update" as const)
          : undefined;
  const path = type === "move" ? text(file.movePath) : text(file.filePath);
  return op === undefined || path === undefined ? undefined : change(op, path, diffstat(file));
}
function applyPatchCall(metadata: Record<string, unknown> | undefined): ToolCall | undefined {
  if (!Array.isArray(metadata?.files)) return undefined;
  return fileChange(
    metadata.files.flatMap((value) => {
      const next = applyPatchFile(value);
      return next === undefined ? [] : [next];
    }),
  );
}
function strongerCall(previous: ToolCall | undefined, next: ToolCall | undefined): ToolCall | undefined {
  if (next === undefined) return previous;
  if (previous?.kind === "fileChange" && next.kind !== "fileChange") return previous;
  return next;
}

function runCall(name: string, value: Record<string, unknown> | undefined): ToolCall | undefined {
  return name === "bash" || name === "shell" ? { kind: "run", command: text(value?.command) ?? name } : undefined;
}

function readCall(name: string, value: Record<string, unknown> | undefined): ToolCall | undefined {
  if (name !== "read") return undefined;
  const path = text(value?.filePath) ?? text(value?.path);
  if (path === undefined) return undefined;
  const offset = positiveLine(value?.offset);
  const limit = positiveLine(value?.limit);
  return {
    kind: "read",
    path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function searchCall(name: string, value: Record<string, unknown> | undefined): ToolCall | undefined {
  if (name !== "grep" && name !== "glob" && name !== "search") return undefined;
  const query = text(value?.pattern) ?? text(value?.query);
  if (query === undefined) return undefined;
  const path = text(value?.path) ?? text(value?.filePath);
  const glob = text(value?.glob);
  const scope = name === "glob" ? ("files" as const) : ("content" as const);
  return {
    kind: "search",
    query,
    scope,
    ...(path === undefined ? {} : { path }),
    ...(scope === "content" && glob !== undefined ? { glob } : {}),
  };
}

function callFor(name: string, input: unknown, metadata?: unknown): ToolCall | undefined {
  const value = object(input);
  const meta = object(metadata);
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "shell") return runCall(lower, value);
  if (lower === "read") return readCall(lower, value);
  if (lower === "grep" || lower === "glob" || lower === "search") return searchCall(lower, value);
  if (lower === "edit") return editCall(value, meta) ?? { kind: "other", display: name };
  if (lower === "write") return writeCall(value, meta) ?? { kind: "other", display: name };
  if (lower === "apply_patch") return applyPatchCall(meta) ?? { kind: "other", display: name };
  return { kind: "other", display: name };
}
function belongs(part: Part, state: State): boolean {
  return state.sessionId === undefined || part.sessionID === state.sessionId;
}
function mapTextPart(part: Part, events: Emitter, state: State, thought: boolean): void {
  const id = text(part.id);
  const time = object(part.time);
  const content = text(part.text);
  const seen = thought ? state.reasoningParts : state.assistantParts;
  if (!belongs(part, state) || id === undefined || content === undefined || time?.end === undefined || seen.has(id))
    return;
  seen.add(id);
  if (thought) events.emit({ type: "thought", text: content });
  else events.emit({ type: "assistant", text: content });
}
function resultFor(state: Part, failed: boolean): ToolResult {
  const exit = object(state.metadata)?.exit;
  const exitCode = typeof exit === "number" && Number.isInteger(exit) ? exit : undefined;
  if (failed) {
    return {
      status: "error",
      message: text(state.error) ?? "OpenCode tool failed",
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }
  return {
    status: exitCode !== undefined && exitCode !== 0 ? "error" : "ok",
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}
function mapToolPart(part: Part, events: Emitter, state: State): void {
  if (!belongs(part, state)) return;
  const id = text(part.callID);
  const name = text(part.tool);
  const toolState = object(part.state);
  if (id === undefined || name === undefined || toolState === undefined) return;
  const next = callFor(name, toolState.input, toolState.metadata);
  if (
    (toolState.status === "pending" || toolState.status === "running") &&
    !state.tools.has(id) &&
    !state.completedTools.has(id)
  ) {
    if (next === undefined) return;
    const observed = { name, call: next };
    state.tools.set(id, observed);
    events.emit({ type: "tool", phase: "started", id, ...observed });
    return;
  }
  if ((toolState.status !== "completed" && toolState.status !== "error") || state.completedTools.has(id)) return;
  const started = state.tools.get(id);
  const call = strongerCall(started?.call, next);
  if (call === undefined) return;
  const observed = { name: started?.name ?? name, call };
  if (!state.tools.has(id)) {
    state.tools.set(id, observed);
    events.emit({ type: "tool", phase: "started", id, ...observed });
  } else {
    state.tools.set(id, observed);
  }
  state.completedTools.add(id);
  events.emit({
    type: "tool",
    phase: "completed",
    id,
    ...observed,
    result: resultFor(toolState, toolState.status === "error"),
  });
}
function mapPart(part: Part, events: Emitter, state: State): void {
  if (part.type === "text") return mapTextPart(part, events, state, false);
  if (part.type === "reasoning") return mapTextPart(part, events, state, true);
  if (part.type === "tool") mapToolPart(part, events, state);
}
function mapSessionError(properties: Part, events: Emitter, state: State): void {
  if (state.sessionId !== undefined && properties.sessionID !== state.sessionId) return;
  state.failure = diagnostic(properties.error);
  events.emit(noteEvent(state.failure));
}
function mapTodo(properties: Part, events: Emitter, state: State): void {
  if (properties.sessionID !== state.sessionId || !Array.isArray(properties.todos)) return;
  const summary = properties.todos
    .flatMap((value) => {
      const todo = object(value);
      const content = text(todo?.content);
      return content === undefined ? [] : [`${text(todo?.status) ?? "todo"}: ${content}`];
    })
    .join("; ");
  if (summary.length > 0) events.emit(noteEvent(summary));
}
function ignoredEvent(type: unknown): boolean {
  return (
    typeof type === "string" &&
    (OPENCODE_EVENT_DISPOSITIONS[type as NativeEventKind] === "dropped" || RUNTIME_DROPPED_EVENT_KINDS.has(type))
  );
}

export function mapEvent(value: unknown, events: Emitter, state: State): void {
  const event = object(value);
  if (event === undefined) return;
  const properties = object(event.properties) ?? {};
  if (event.type === "message.part.updated") {
    const part = object(properties.part);
    if (part !== undefined) mapPart(part, events, state);
    return;
  }
  if (event.type === "message.updated") {
    const info = object(properties.info);
    if (
      info !== undefined &&
      info.sessionID === state.sessionId &&
      info.role === "assistant" &&
      info.error !== undefined
    ) {
      state.failure = diagnostic(info.error);
    }
    return;
  }
  if (event.type === "session.error") return mapSessionError(properties, events, state);
  if (event.type === "todo.updated") return mapTodo(properties, events, state);
  if (ignoredEvent(event.type)) return;
  events.emit({ type: "unknown", kind: typeof event.type === "string" ? event.type : "unknown" });
}

export type EventState = State;
export function createEventState(sessionId?: string): State {
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    assistantParts: new Set(),
    reasoningParts: new Set(),
    tools: new Map(),
    completedTools: new Set(),
  };
}
