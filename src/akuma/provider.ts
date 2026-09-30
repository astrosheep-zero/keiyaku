import { type ResumeCoordinate } from "./coordinate.js";
import type { ProviderOptions } from "./provider-recipe.js";

/* eslint-disable max-lines-per-function -- Provider custody is the single owner boundary for its public protocol. */
export type { ResumeCoordinate } from "./coordinate.js";
export { decodeResumeCoordinate, encodeResumeCoordinate } from "./coordinate.js";

export { AKUMA_REQUESTS_ENV } from "./providers/execution-environment.js";

export const AGENT_EVENT_TEXT_LIMIT = 16_384;
export const AGENT_THOUGHT_TEXT_LIMIT = 4_000;
export const AGENT_EVENT_QUEUE_LIMIT = 256;

export { agentEventSchema, decodeAgentEvent } from "./heart/activity-schema.js";
export type { AgentEvent, SearchScope, ToolCall, ToolEvent, ToolInput, ToolResult } from "./heart/activity-schema.js";
import type { AgentEvent, ToolCall, ToolResult, ToolInput } from "./heart/activity-schema.js";

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
    case "other": {
      const input = call.input;
      const display = boundedEventText(call.display);
      const bounded = input === undefined ? undefined : boundedToolInputJson(input.json);
      return {
        value: {
          kind: call.kind,
          display,
          ...(bounded === undefined || input === undefined
            ? {}
            : { input: { json: bounded.value, truncated: input.truncated || bounded.truncated } }),
        },
        truncated:
          call.display.length > AGENT_EVENT_TEXT_LIMIT ||
          (input !== undefined && (input.truncated || bounded?.truncated === true)),
      };
    }
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

export function encodeAgentEvent(event: AgentEvent): AgentEvent {
  const marked = <T extends AgentEvent>(value: T, changed: boolean): T =>
    changed || ("truncated" in event && event.truncated === true) ? { ...value, truncated: true } : value;
  switch (event.type) {
    case "session": {
      const coordinate =
        "sessionFile" in event.coordinate
          ? event.coordinate.sessionId === undefined
            ? { sessionFile: event.coordinate.sessionFile }
            : { sessionFile: event.coordinate.sessionFile, sessionId: event.coordinate.sessionId }
          : { sessionId: event.coordinate.sessionId };
      return { type: event.type, coordinate };
    }
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

/**
 * Admit only a compact JSON view of structured tool invocation input.  This
 * deliberately receives adapter start evidence, never result or delta bodies.
 */
export function boundedToolInput(input: unknown): ToolInput | undefined {
  if (input === undefined) return undefined;
  let json: string;
  try {
    const encoded = JSON.stringify(input);
    if (encoded === undefined) return undefined;
    json = encoded;
  } catch {
    return undefined;
  }
  const bounded = boundedToolInputJson(json);
  return { json: bounded.value, truncated: bounded.truncated };
}

/** Build one generic call from the provider's structured invocation evidence. */
export function otherToolCall(display: string, input?: unknown): Extract<ToolCall, { kind: "other" }> {
  const preview = boundedToolInput(input);
  return { kind: "other", display, ...(preview === undefined ? {} : { input: preview }) };
}

function boundedToolInputJson(value: string): Readonly<{ value: string; truncated: boolean }> {
  if (new TextEncoder().encode(value).length <= AGENT_EVENT_TEXT_LIMIT) return { value, truncated: false };
  let bytes = 0;
  let prefix = "";
  const encoder = new TextEncoder();
  for (const codePoint of value) {
    const length = encoder.encode(codePoint).length;
    if (bytes + length > AGENT_EVENT_TEXT_LIMIT) break;
    prefix += codePoint;
    bytes += length;
  }
  return { value: prefix, truncated: true };
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

// Slow consumers may lose reconstructible narration, but session coordinates,
// notes, and error events stay observable. A full protected queue replaces one
// protected item with a bounded aggregate note; `end` ignores later emission.
function isErrorEvent(event: AgentEvent): boolean {
  if (event.type === "note") return true;
  if (event.type === "tool" && event.phase === "completed") return event.result.status === "error";
  return event.type === "unknown" && /(?:error|fail|abort|cancel|stop|terminal)/iu.test(event.kind);
}

function isReconstructibleEvent(event: AgentEvent): boolean {
  return event.type !== "session" && !isErrorEvent(event);
}

const AGENT_EVENT_OVERFLOW_PREFIX = "Agent event queue overflow";

function overflowEvent(count: number): Extract<AgentEvent, { type: "note" }> {
  return { type: "note", text: `${AGENT_EVENT_OVERFLOW_PREFIX}: ${count} terminal/error events coalesced` };
}

export class AgentEventChannel implements AsyncIterable<AgentEvent> {
  private readonly queued: AgentEvent[] = [];
  private readonly waiters: EventWaiter[] = [];
  private overflowMarker: Extract<AgentEvent, { type: "note" }> | undefined;
  private overflowCount = 0;
  private ended = false;

  emit(event: AgentEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: event });
      return;
    }
    if (this.queued.length >= AGENT_EVENT_QUEUE_LIMIT) {
      const reconstructible = this.queued.findIndex(isReconstructibleEvent);
      if (reconstructible === -1) {
        if (isReconstructibleEvent(event)) return;
        this.overflowCount += 1;
        if (this.overflowMarker !== undefined) {
          const marker = overflowEvent(this.overflowCount);
          const markerIndex = this.queued.indexOf(this.overflowMarker);
          if (markerIndex !== -1) {
            this.queued[markerIndex] = marker;
            this.overflowMarker = marker;
            return;
          }
          this.overflowMarker = undefined;
        }
        const protectedIndex = this.queued.findIndex((queued) => queued.type !== "session");
        const replacement = protectedIndex === -1 ? 0 : protectedIndex;
        this.overflowCount += 1;
        const marker = overflowEvent(this.overflowCount);
        this.queued[replacement] = marker;
        this.overflowMarker = marker;
        return;
      }
      this.queued.splice(reconstructible, 1);
    }
    this.queued.push(event);
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
        if (event === this.overflowMarker) {
          this.overflowMarker = undefined;
          this.overflowCount = 0;
        }
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
  let establishmentSettled = false;
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
    if (establishmentSettled) throw new Error("cannot own a resource after provider establishment settles");
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
    .finally(() => {
      establishmentSettled = true;
      parent.removeEventListener("abort", cancelFromParent);
    });

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
  void closed.catch(() => undefined);
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
  schemaJson?: string;
}>;

export type ProviderOptionAdmission =
  | Readonly<{ kind: "admitted"; options: ProviderOptions }>
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
