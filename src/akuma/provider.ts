import type { Confinement, ProviderOptions } from "./heart/index.js";
import { decodeResumeCoordinate, encodeResumeCoordinate, type ResumeCoordinate } from "./coordinate.js";
export type { ResumeCoordinate } from "./coordinate.js";
export type { ProviderOptions } from "./heart/index.js";

export const AKUMA_REQUESTS_ENV = "AKUMA_REQUESTS";

export const AGENT_EVENT_TEXT_LIMIT = 16_384;
export const AGENT_THOUGHT_TEXT_LIMIT = 4_000;

export type ToolCall =
  | Readonly<{ kind: "run"; command: string }>
  | Readonly<{ kind: "read"; path: string }>
  | Readonly<{ kind: "search"; query: string }>
  | Readonly<{
      kind: "fileChange";
      changes: readonly Readonly<{
        op: "add" | "update" | "delete";
        path: string;
        diffstat?: Readonly<{ added: number; removed: number }>;
      }>[];
    }>
  | Readonly<{ kind: "other"; display: string }>;

export type ToolResult = Readonly<{
  status: "ok" | "error";
  message?: string;
  exitCode?: number;
}>;

export type ToolEvent = Readonly<{
  type: "tool";
  id: string;
  name: string;
  call: ToolCall;
  truncated?: true;
}> & (
  | Readonly<{ phase: "started"; result?: never }>
  | Readonly<{ phase: "completed"; result: ToolResult }>
);

export type AgentEvent =
  | Readonly<{ type: "session"; coordinate: ResumeCoordinate }>
  | Readonly<{ type: "assistant"; text: string; truncated?: true }>
  | Readonly<{ type: "thought"; text: string; truncated?: true }>
  | ToolEvent
  | Readonly<{ type: "note"; text: string; truncated?: true }>
  | Readonly<{ type: "unknown"; kind: string; truncated?: true }>;

const AGENT_EVENT_TYPES = {
  session: true,
  assistant: true,
  thought: true,
  tool: true,
  note: true,
  unknown: true,
} as const satisfies Readonly<Record<AgentEvent["type"], true>>;

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export { decodeResumeCoordinate, encodeResumeCoordinate };

function optionText(
  options: Readonly<Record<string, unknown>>,
  field: "model" | "effort" | "systemPrompt",
  blank: "allow" | "refuse",
): string | undefined {
  const selected = options[field];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || (blank === "refuse" && selected.trim().length === 0)) {
    throw new TypeError(`provider option ${field} must be ${blank === "allow" ? "a string" : "a nonblank string"}`);
  }
  return selected;
}

function optionEnum<T extends string>(
  options: Readonly<Record<string, unknown>>,
  field: "access" | "network",
  allowed: readonly T[],
): T | undefined {
  const selected = options[field];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || !allowed.includes(selected as T)) {
    throw new TypeError(`provider option ${field} must be ${allowed.join(", ")}`);
  }
  return selected as T;
}

export function decodeProviderOptions(value: unknown): ProviderOptions {
  const options = object(value);
  if (options === null) throw new TypeError("provider options must be an object");
  const allowed = ["access", "effort", "model", "network", "systemPrompt"];
  const unknown = Object.keys(options).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`provider options have unknown field ${unknown}`);
  const model = optionText(options, "model", "refuse");
  const effort = optionText(options, "effort", "refuse");
  const access = optionEnum(options, "access", ["read", "write", "auto"] as const);
  const network = optionEnum(options, "network", ["disabled", "enabled"] as const);
  const systemPrompt = optionText(options, "systemPrompt", "allow");
  return Object.freeze({
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(access === undefined ? {} : { access }),
    ...(network === undefined ? {} : { network }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  });
}

function eventType(value: unknown): value is AgentEvent["type"] {
  return typeof value === "string" && Object.hasOwn(AGENT_EVENT_TYPES, value);
}

function decodeToolCall(value: unknown): ToolCall | null {
  const call = object(value);
  if (call?.kind === "run" && typeof call.command === "string") return { kind: "run", command: call.command };
  if (call?.kind === "read" && typeof call.path === "string") return { kind: "read", path: call.path };
  if (call?.kind === "search" && typeof call.query === "string") return { kind: "search", query: call.query };
  if (call?.kind === "fileChange" && Array.isArray(call.changes)) {
    const changes = call.changes.map((value) => {
      const change = object(value);
      if (change === null || (change.op !== "add" && change.op !== "update" && change.op !== "delete")
        || typeof change.path !== "string") return null;
      const rawDiffstat = change.diffstat;
      const op = change.op as "add" | "update" | "delete";
      if (rawDiffstat === undefined) return { op, path: change.path };
      const diffstat = object(rawDiffstat);
      if (diffstat === null || !Number.isSafeInteger(diffstat.added) || !Number.isSafeInteger(diffstat.removed)
        || (diffstat.added as number) < 0 || (diffstat.removed as number) < 0) return null;
      return {
        op,
        path: change.path,
        diffstat: { added: diffstat.added as number, removed: diffstat.removed as number },
      };
    });
    if (changes.every((change) => change !== null)) return { kind: "fileChange", changes };
  }
  if (call?.kind === "other" && typeof call.display === "string") return { kind: "other", display: call.display };
  return null;
}

function decodeToolResult(value: unknown): ToolResult | null {
  const result = object(value);
  if (result === null || (result.status !== "ok" && result.status !== "error")) return null;
  if (result.message !== undefined && typeof result.message !== "string") return null;
  if (result.exitCode !== undefined && !Number.isSafeInteger(result.exitCode)) return null;
  return {
    status: result.status,
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode as number }),
  };
}

function decodeToolEvent(event: Readonly<Record<string, unknown>>): ToolEvent | null {
  if (event.truncated !== undefined && event.truncated !== true) return null;
  if (typeof event.id !== "string" || typeof event.name !== "string") return null;
  const call = decodeToolCall(event.call);
  if (call !== null && event.phase === "started" && event.result === undefined) {
    return { type: "tool", phase: "started", id: event.id, name: event.name, call,
      ...(event.truncated === true ? { truncated: true } : {}) };
  }
  const result = decodeToolResult(event.result);
  if (call !== null && event.phase === "completed" && result !== null) {
    return { type: "tool", phase: "completed", id: event.id, name: event.name, call, result,
      ...(event.truncated === true ? { truncated: true } : {}) };
  }
  return null;
}

function decodeTypedEvent(type: AgentEvent["type"], event: Readonly<Record<string, unknown>>): AgentEvent | null {
  if (type !== "session" && event.truncated !== undefined && event.truncated !== true) return null;
  const truncated = event.truncated === true ? { truncated: true as const } : {};
  switch (type) {
    case "assistant":
    case "thought": return typeof event.text === "string" ? { type, text: event.text, ...truncated } : null;
    case "note": return typeof event.text === "string" ? { type, text: event.text, ...truncated } : null;
    case "unknown": return typeof event.kind === "string" ? { type, kind: event.kind, ...truncated } : null;
    case "session": {
      const coordinate = decodeResumeCoordinate(event.coordinate);
      return coordinate === null ? null : { type, coordinate };
    }
    case "tool": return decodeToolEvent(event);
    default: return type satisfies never;
  }
}

export function decodeAgentEvent(value: unknown): AgentEvent {
  const event = object(value);
  if (event === null || !eventType(event.type)) throw new Error("Akuma activity has an invalid event shape");
  const decoded = decodeTypedEvent(event.type, event);
  if (decoded === null) throw new Error("Akuma activity has an invalid event shape");
  return decoded;
}

function boundedToolCall(call: ToolCall): Readonly<{ value: ToolCall; truncated: boolean }> {
  switch (call.kind) {
    case "run": return { value: { kind: call.kind, command: boundedEventText(call.command) }, truncated: call.command.length > AGENT_EVENT_TEXT_LIMIT };
    case "read": return { value: { kind: call.kind, path: boundedEventText(call.path) }, truncated: call.path.length > AGENT_EVENT_TEXT_LIMIT };
    case "search": return { value: { kind: call.kind, query: boundedEventText(call.query) }, truncated: call.query.length > AGENT_EVENT_TEXT_LIMIT };
    case "fileChange": return {
      value: {
        kind: call.kind,
        changes: call.changes.map((change) => ({ ...change, path: boundedEventText(change.path) })),
      },
      truncated: call.changes.some((change) => change.path.length > AGENT_EVENT_TEXT_LIMIT),
    };
    case "other": return { value: { kind: call.kind, display: boundedEventText(call.display) }, truncated: call.display.length > AGENT_EVENT_TEXT_LIMIT };
    default: return call satisfies never;
  }
}

function boundedToolResult(result: ToolResult): Readonly<{ value: ToolResult; truncated: boolean }> {
  return {
    value: {
      status: result.status,
      ...(result.message === undefined ? {} : { message: boundedEventText(result.message) }),
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    },
    truncated: result.message !== undefined && result.message.length > AGENT_EVENT_TEXT_LIMIT,
  };
}

export function encodeAgentEvent(event: AgentEvent): unknown {
  const marked = (value: Readonly<Record<string, unknown>>, changed: boolean): unknown => ({
    ...value,
    ...(changed || ("truncated" in event && event.truncated === true) ? { truncated: true } : {}),
  });
  switch (event.type) {
    case "session": return { type: event.type, coordinate: encodeResumeCoordinate(event.coordinate) };
    case "assistant": return marked({ type: event.type, text: boundedEventText(event.text) }, event.text.length > AGENT_EVENT_TEXT_LIMIT);
    case "thought": return marked({ type: event.type, text: boundedThoughtText(event.text) }, event.text.length > AGENT_THOUGHT_TEXT_LIMIT);
    case "note": return marked({ type: event.type, text: boundedEventText(event.text) }, event.text.length > AGENT_EVENT_TEXT_LIMIT);
    case "unknown": return marked({ type: event.type, kind: boundedEventText(event.kind) }, event.kind.length > AGENT_EVENT_TEXT_LIMIT);
    case "tool": {
      const call = boundedToolCall(event.call);
      const name = boundedEventText(event.name);
      const result = event.phase === "completed" ? boundedToolResult(event.result) : undefined;
      return marked(event.phase === "started" ? {
          type: event.type,
          id: event.id,
          phase: event.phase,
          name,
          call: call.value,
        }
      : {
          type: event.type,
          id: event.id,
          phase: event.phase,
          name,
          call: call.value,
          result: result!.value,
        }, name !== event.name || call.truncated || result?.truncated === true);
    }
    default: return event satisfies never;
  }
}

export function boundedEventText(value: string): string {
  return value.slice(0, AGENT_EVENT_TEXT_LIMIT);
}

export function boundedThoughtText(value: string): string {
  return value.slice(0, AGENT_THOUGHT_TEXT_LIMIT);
}

export function noteEvent(note: string): Extract<AgentEvent, { type: "note" }> {
  return { type: "note", text: note.replace(/\s+/g, " ").trim() };
}

export function unknownEvent(kind: string): Extract<AgentEvent, { type: "unknown" }> {
  return { type: "unknown", kind };
}

type EventWaiter = Readonly<{ resolve(value: IteratorResult<AgentEvent>): void }>;

export class AgentEventChannel implements AsyncIterable<AgentEvent> {
  private readonly queued: AgentEvent[] = [];
  private readonly waiters: EventWaiter[] = [];
  private ended = false;

  emit(event: AgentEvent): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.queued.push(event);
    else waiter.resolve({ done: false, value: event });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const event = this.queued.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push({ resolve }));
      },
    };
  }
}

export type TurnResult =
  | Readonly<{ kind: "answered"; answer: string; historyId: string }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type ProviderFence = string;
export type TellReceipt =
  | Readonly<{ evidence: "exact"; tellId: string; kind: string }>
  | Readonly<{ evidence: "fence"; fence: ProviderFence; kind: string }>;
export type TellSubmission =
  | Readonly<{ kind: "accepted"; fence: ProviderFence }>
  | Readonly<{ kind: "turn-ended" }>;

export type Session = Readonly<{
  admission: Readonly<{ fence: ProviderFence }>;
  events: AsyncIterable<AgentEvent>;
  receipts?: AsyncIterable<TellReceipt>;
  completion: Promise<TurnResult>;
  abort(): Promise<void>;
  tell?(tell: Readonly<{ id: string; text: string }>): Promise<TellSubmission>;
}>;

export type DriveInput = Readonly<{
  body: string;
  launchTells: readonly Readonly<{ id: string; text: string }>[];
  cwd: string;
  options: ProviderOptions;
  requests?: Readonly<{ dir: string }>;
}>;

export type ProviderOptionAdmission =
  | Readonly<{ kind: "admitted"; options: ProviderOptions }>
  | Readonly<{ kind: "refused"; diagnostic: string }>;

export type ProviderAdapter = Readonly<{
  confinement(input: Readonly<{ cwd: string; options: ProviderOptions }>): Confinement;
  admitOptions(options: ProviderOptions): ProviderOptionAdmission;
  fork?(input: Readonly<{
    session: ResumeCoordinate;
    at: string;
    cwd: string;
  }>): Promise<Readonly<{ session: ResumeCoordinate }>>;
  start(input: DriveInput & Readonly<{ session: Readonly<{ kind: "fresh" }> }>): Promise<Session>;
  resume?(input: DriveInput & Readonly<{
    session: Readonly<{ kind: "resume"; coordinate: ResumeCoordinate }>;
  }>): Promise<Session>;
}>;
