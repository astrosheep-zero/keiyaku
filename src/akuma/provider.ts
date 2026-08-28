import { decodeResumeCoordinate, encodeResumeCoordinate, type ResumeCoordinate } from "./coordinate.js";
import type { ProviderOptions, ReadonlyRestraint } from "./provider-recipe.js";

/* eslint-disable max-lines, max-lines-per-function -- Provider custody is the single owner boundary for its public protocol. */
export type { ResumeCoordinate } from "./coordinate.js";

export const AKUMA_REQUESTS_ENV = "AKUMA_REQUESTS";

export const AGENT_EVENT_TEXT_LIMIT = 16_384;
export const AGENT_THOUGHT_TEXT_LIMIT = 4_000;

export type SearchScope = "content" | "files" | "web";

export type ToolCall =
  | Readonly<{ kind: "run"; command: string }>
  | Readonly<{ kind: "read"; path: string; offset?: number; limit?: number }>
  | Readonly<{
      kind: "search";
      query: string;
      scope?: SearchScope;
      path?: string;
      glob?: string;
    }>
  | Readonly<{
      kind: "fileChange";
      changes: readonly Readonly<{
        op: "add" | "update" | "delete" | "unspecified";
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
}> &
  (Readonly<{ phase: "started"; result?: never }> | Readonly<{ phase: "completed"; result: ToolResult }>);

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
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export { decodeResumeCoordinate, encodeResumeCoordinate };

function eventType(value: unknown): value is AgentEvent["type"] {
  return typeof value === "string" && Object.hasOwn(AGENT_EVENT_TYPES, value);
}

const SEARCH_SCOPES = {
  content: true,
  files: true,
  web: true,
} as const satisfies Readonly<Record<SearchScope, true>>;

function decodePositiveLine(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function decodeOptionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function decodeSearchScope(value: unknown): SearchScope | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && Object.hasOwn(SEARCH_SCOPES, value) ? (value as SearchScope) : null;
}

function decodeRunCall(call: Readonly<Record<string, unknown>>): ToolCall | null {
  return typeof call.command === "string" ? { kind: "run", command: call.command } : null;
}

function decodeReadCall(call: Readonly<Record<string, unknown>>): ToolCall | null {
  if (typeof call.path !== "string") return null;
  const offset = decodePositiveLine(call.offset);
  const limit = decodePositiveLine(call.limit);
  if (offset === null || limit === null) return null;
  return {
    kind: "read",
    path: call.path,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function decodeSearchCall(call: Readonly<Record<string, unknown>>): ToolCall | null {
  if (typeof call.query !== "string") return null;
  const scope = decodeSearchScope(call.scope);
  const path = decodeOptionalText(call.path);
  const glob = decodeOptionalText(call.glob);
  if (scope === null || path === null || glob === null) return null;
  return {
    kind: "search",
    query: call.query,
    ...(scope === undefined ? {} : { scope }),
    ...(path === undefined ? {} : { path }),
    ...(glob === undefined ? {} : { glob }),
  };
}

function decodeNonnegativeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function decodeDiffstat(value: unknown): Readonly<{ added: number; removed: number }> | null | undefined {
  if (value === undefined) return undefined;
  const diffstat = object(value);
  if (diffstat === null) return null;
  const added = decodeNonnegativeCount(diffstat.added);
  const removed = decodeNonnegativeCount(diffstat.removed);
  return added === null || removed === null ? null : { added, removed };
}

function decodeFileChangeMember(value: unknown): Extract<ToolCall, { kind: "fileChange" }>["changes"][number] | null {
  const change = object(value);
  if (
    change === null ||
    (change.op !== "add" && change.op !== "update" && change.op !== "delete" && change.op !== "unspecified") ||
    typeof change.path !== "string"
  )
    return null;
  const diffstat = decodeDiffstat(change.diffstat);
  if (diffstat === null) return null;
  return {
    op: change.op,
    path: change.path,
    ...(diffstat === undefined ? {} : { diffstat }),
  };
}

function decodeFileChangeCall(call: Readonly<Record<string, unknown>>): ToolCall | null {
  if (!Array.isArray(call.changes)) return null;
  const changes = call.changes.map(decodeFileChangeMember);
  return changes.every((change) => change !== null) ? { kind: "fileChange", changes } : null;
}

function decodeOtherCall(call: Readonly<Record<string, unknown>>): ToolCall | null {
  return typeof call.display === "string" ? { kind: "other", display: call.display } : null;
}

function decodeToolCall(value: unknown): ToolCall | null {
  const call = object(value);
  if (call === null) return null;
  switch (call.kind) {
    case "run":
      return decodeRunCall(call);
    case "read":
      return decodeReadCall(call);
    case "search":
      return decodeSearchCall(call);
    case "fileChange":
      return decodeFileChangeCall(call);
    case "other":
      return decodeOtherCall(call);
    default:
      return null;
  }
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
    return {
      type: "tool",
      phase: "started",
      id: event.id,
      name: event.name,
      call,
      ...(event.truncated === true ? { truncated: true } : {}),
    };
  }
  const result = decodeToolResult(event.result);
  if (call !== null && event.phase === "completed" && result !== null) {
    return {
      type: "tool",
      phase: "completed",
      id: event.id,
      name: event.name,
      call,
      result,
      ...(event.truncated === true ? { truncated: true } : {}),
    };
  }
  return null;
}

function decodeTypedEvent(type: AgentEvent["type"], event: Readonly<Record<string, unknown>>): AgentEvent | null {
  if (type !== "session" && event.truncated !== undefined && event.truncated !== true) return null;
  const truncated = event.truncated === true ? { truncated: true as const } : {};
  switch (type) {
    case "assistant":
    case "thought":
      return typeof event.text === "string" ? { type, text: event.text, ...truncated } : null;
    case "note":
      return typeof event.text === "string" ? { type, text: event.text, ...truncated } : null;
    case "unknown":
      return typeof event.kind === "string" ? { type, kind: event.kind, ...truncated } : null;
    case "session": {
      const coordinate = decodeResumeCoordinate(event.coordinate);
      return coordinate === null ? null : { type, coordinate };
    }
    case "tool":
      return decodeToolEvent(event);
    default:
      return type satisfies never;
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
    case "run":
      return {
        value: { kind: call.kind, command: boundedEventText(call.command) },
        truncated: call.command.length > AGENT_EVENT_TEXT_LIMIT,
      };
    case "read":
      return {
        value: {
          kind: call.kind,
          path: boundedEventText(call.path),
          ...(call.offset === undefined ? {} : { offset: call.offset }),
          ...(call.limit === undefined ? {} : { limit: call.limit }),
        },
        truncated: call.path.length > AGENT_EVENT_TEXT_LIMIT,
      };
    case "search":
      return {
        value: {
          kind: call.kind,
          query: boundedEventText(call.query),
          ...(call.scope === undefined ? {} : { scope: call.scope }),
          ...(call.path === undefined ? {} : { path: boundedEventText(call.path) }),
          ...(call.glob === undefined ? {} : { glob: boundedEventText(call.glob) }),
        },
        truncated:
          call.query.length > AGENT_EVENT_TEXT_LIMIT ||
          (call.path !== undefined && call.path.length > AGENT_EVENT_TEXT_LIMIT) ||
          (call.glob !== undefined && call.glob.length > AGENT_EVENT_TEXT_LIMIT),
      };
    case "fileChange":
      return {
        value: {
          kind: call.kind,
          changes: call.changes.map((change) => ({ ...change, path: boundedEventText(change.path) })),
        },
        truncated: call.changes.some((change) => change.path.length > AGENT_EVENT_TEXT_LIMIT),
      };
    case "other":
      return {
        value: { kind: call.kind, display: boundedEventText(call.display) },
        truncated: call.display.length > AGENT_EVENT_TEXT_LIMIT,
      };
    default:
      return call satisfies never;
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
    case "session":
      return { type: event.type, coordinate: encodeResumeCoordinate(event.coordinate) };
    case "assistant":
      return marked(
        { type: event.type, text: boundedEventText(event.text) },
        event.text.length > AGENT_EVENT_TEXT_LIMIT,
      );
    case "thought":
      return marked(
        { type: event.type, text: boundedThoughtText(event.text) },
        event.text.length > AGENT_THOUGHT_TEXT_LIMIT,
      );
    case "note":
      return marked(
        { type: event.type, text: boundedEventText(event.text) },
        event.text.length > AGENT_EVENT_TEXT_LIMIT,
      );
    case "unknown":
      return marked(
        { type: event.type, kind: boundedEventText(event.kind) },
        event.kind.length > AGENT_EVENT_TEXT_LIMIT,
      );
    case "tool": {
      const call = boundedToolCall(event.call);
      const name = boundedEventText(event.name);
      const result = event.phase === "completed" ? boundedToolResult(event.result) : undefined;
      return marked(
        event.phase === "started"
          ? {
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
            },
        name !== event.name || call.truncated || result?.truncated === true,
      );
    }
    default:
      return event satisfies never;
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
  | Readonly<{ kind: "answered"; answer: string; historyId?: string }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

export type ProviderFence = string;
export type TellReceipt =
  | Readonly<{ evidence: "exact"; tellId: string; kind: string }>
  | Readonly<{ evidence: "fence"; fence: ProviderFence; kind: string }>;
export type TellSubmission = Readonly<{ kind: "accepted"; fence: ProviderFence }> | Readonly<{ kind: "turn-ended" }>;

export type Session = Readonly<{
  admission: Readonly<{ fence: ProviderFence }>;
  events: AsyncIterable<AgentEvent>;
  receipts?: AsyncIterable<TellReceipt>;
  completion: Promise<TurnResult>;
  /** Requests graceful adapter-owned cancellation. */
  abort(): Promise<void>;
  /** Fulfills only after forced adapter-owned disposal is proved. */
  forceDispose(): Promise<void>;
  tell?(tell: Readonly<{ id: string; text: string }>): Promise<TellSubmission>;
}>;

/**
 * Synchronous custody for one provider establishment or fork attempt.
 * `closed` is the sole proof that every resource created by the attempt retired.
 */
export type ProviderAttempt<Result> = Readonly<{
  result: Promise<Result>;
  closed: Promise<void>;
  abort(): Promise<void>;
  forceDispose(): Promise<void>;
}>;

export type AttemptResource = Readonly<{
  /** Resolves only when this physical resource has retired. */
  closed: Promise<void>;
  abort?(): Promise<void>;
  forceDispose(): Promise<void>;
}>;

export type AttemptCustody = Readonly<{
  signal: AbortSignal;
  /** Register a resource in the attempt before awaiting further setup work. */
  own(resource: AttemptResource): void;
}>;

/**
 * Starts provider work after its caller has received custody.  The input signal
 * remains a cancellation notification; this attempt owns its own controller
 * and any resulting native resource controls.
 */
export function createProviderAttempt<Result>(
  parentSignal: AbortSignal | undefined,
  establish: (custody: AttemptCustody) => Promise<Result>,
): ProviderAttempt<Result> {
  const parent = parentSignal ?? new AbortController().signal;
  const controller = new AbortController();
  type OwnedResource = {
    resource: AttemptResource;
    abort?: Promise<void>;
    forceDispose?: Promise<void>;
  };
  const resources: OwnedResource[] = [];
  const ownedResources = new Map<AttemptResource, OwnedResource>();
  const cleanupFailures: unknown[] = [];
  const cleanupOperations: Promise<void>[] = [];
  let setupComplete!: () => void;
  const setupSettled = new Promise<void>((resolve) => {
    setupComplete = resolve;
  });
  let retiring: "abort" | "forceDispose" | undefined;

  const remember = (operation: Promise<void>, reportFailure: boolean): Promise<void> => {
    const observed = operation.catch((error: unknown) => {
      if (reportFailure) cleanupFailures.push(error);
    });
    cleanupOperations.push(observed);
    return operation;
  };
  const observeBackgroundRetirement = (operation: Promise<void>): void => {
    void operation.catch(() => undefined);
  };
  const startRetirement = (owned: OwnedResource, kind: "abort" | "forceDispose"): Promise<void> => {
    if (kind === "abort" && owned.resource.abort === undefined) {
      const force = startRetirement(owned, "forceDispose");
      owned.abort = force;
      return force;
    }
    const existing = owned[kind];
    if (existing !== undefined) return existing;
    const graceful = kind === "abort";
    const dispose = graceful ? owned.resource.abort! : owned.resource.forceDispose;
    const operation = remember(
      Promise.resolve().then(() => dispose()),
      !graceful,
    );
    owned[kind] = operation;
    return operation;
  };
  const retire = (kind: "abort" | "forceDispose"): Promise<void> => {
    if (kind === "forceDispose" || retiring === undefined) retiring = kind;
    const pending = resources.map((resource) => startRetirement(resource, kind));
    return Promise.all(pending).then(() => undefined);
  };
  const own = (resource: AttemptResource): void => {
    if (ownedResources.has(resource)) return;
    const owned = { resource };
    resources.push(owned);
    ownedResources.set(resource, owned);
    void resource.closed.catch((error: unknown) => {
      cleanupFailures.push(error);
    });
    if (retiring !== undefined) observeBackgroundRetirement(startRetirement(owned, retiring));
  };
  const cancelFromParent = (): void => {
    if (!controller.signal.aborted) controller.abort(parent.reason);
    void retire("abort").catch(() => {
      observeBackgroundRetirement(retire("forceDispose"));
    });
  };
  parent.addEventListener("abort", cancelFromParent, { once: true });
  if (parent.aborted) cancelFromParent();

  const result = Promise.resolve()
    .then(() => establish({ signal: controller.signal, own }))
    .catch((error: unknown) => {
      if (!controller.signal.aborted) observeBackgroundRetirement(retire("forceDispose"));
      throw error;
    })
    .finally(() => parent.removeEventListener("abort", cancelFromParent));

  void result.then(
    () => setupComplete(),
    () => setupComplete(),
  );
  const closed = (async (): Promise<void> => {
    await setupSettled;
    for (;;) {
      const operations = [...cleanupOperations];
      const retired = resources.map((resource) => resource.resource.closed);
      await Promise.allSettled([...operations, ...retired]);
      if (operations.length === cleanupOperations.length) break;
    }
    if (cleanupFailures.length > 0) throw cleanupFailures[0];
  })();
  const control = async (operation: "abort" | "forceDispose"): Promise<void> => {
    if (!controller.signal.aborted) controller.abort(new Error("provider attempt retired"));
    await retire(operation);
  };
  return {
    result,
    closed,
    abort: async () => await control("abort"),
    forceDispose: async () => await control("forceDispose"),
  };
}

export type DriveInput = Readonly<{
  body: string;
  launchTells: readonly Readonly<{ id: string; text: string }>[];
  cwd: string;
  options: ProviderOptions;
  signal: AbortSignal;
  requests: Readonly<{ dir: string }>;
}>;

export type ProviderOptionAdmission =
  | Readonly<{ kind: "admitted"; options: ProviderOptions; readonly?: ReadonlyRestraint }>
  | Readonly<{ kind: "refused"; diagnostic: string }>;

export type ProviderAdapter = Readonly<{
  admitOptions(options: ProviderOptions): ProviderOptionAdmission;
  fork?(
    input: Readonly<{
      session: ResumeCoordinate;
      at: string;
      cwd: string;
    }>,
  ): ProviderAttempt<Readonly<{ session: ResumeCoordinate }>>;
  start(input: DriveInput & Readonly<{ session: Readonly<{ kind: "fresh" }> }>): ProviderAttempt<Session>;
  resume?(
    input: DriveInput &
      Readonly<{
        session: Readonly<{ kind: "resume"; coordinate: ResumeCoordinate }>;
      }>,
  ): ProviderAttempt<Session>;
}>;
