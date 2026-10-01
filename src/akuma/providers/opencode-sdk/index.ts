import {
  AgentEventChannel,
  createProviderAttempt,
  type AttemptCustody,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "../../provider.js";
import type { ResumeCoordinate } from "../../heart/index.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { ownEventStream, type OwnedEventStream } from "./event-stream.js";
import { createEventState, mapEvent } from "./events.js";
import {
  coordinate,
  loadOpencode,
  messageId,
  OPENCODE_SDK_PROVIDER,
  parseModel,
  type OpencodeSdkLoader,
} from "./session.js";

type Input = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
export type OpencodeProviderTestOptions = Readonly<{ loader?: OpencodeSdkLoader }>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function diagnostic(error: unknown): string {
  const value = object(error);
  const nested = object(value?.data);
  return text(nested?.message) ?? text(value?.message) ?? String(error);
}
function opencodeSessionId(coordinateValue: ResumeCoordinate): string {
  if (!("sessionId" in coordinateValue) || coordinateValue.sessionId === undefined) {
    throw new Error("OpenCode resume requires sessionId");
  }
  return coordinateValue.sessionId;
}
function admit(options: ProviderOptions): void {
  if (options.network !== undefined) throw new Error("OpenCode does not support explicit network");
  if (options.systemPromptMode === "replace") {
    throw new Error("OpenCode V1 does not support replacing the native system prompt");
  }
  if (options.model !== undefined) parseModel(options.model);
}
function eventValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { type: value };
  }
}

function promptBody(
  input: Input,
  messageID: string,
): Readonly<{
  messageID: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  system?: string;
  parts: [{ type: "text"; text: string }];
}> {
  const model = input.options.model === undefined ? undefined : parseModel(input.options.model);
  const promptText = [input.body, ...input.launchTells.map((tell) => tell.text)]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return {
    messageID,
    ...(model === undefined ? {} : { model }),
    ...(input.options.effort === undefined ? {} : { variant: input.options.effort }),
    ...(input.options.systemPrompt === undefined ? {} : { system: input.options.systemPrompt }),
    parts: [{ type: "text", text: promptText }],
  };
}

type MessageRow = Readonly<{ info: Record<string, unknown>; parts: readonly unknown[] }>;
function messageRows(value: unknown, sessionId: string): MessageRow[] {
  const response = object(value);
  const rows = Array.isArray(response?.data) ? response.data : Array.isArray(value) ? value : [];
  return rows.flatMap((row) => {
    const entry = object(row);
    const info = object(entry?.info);
    if (info?.sessionID !== sessionId) return [];
    return [{ info, parts: Array.isArray(entry?.parts) ? entry.parts : [] }];
  });
}
function newest(rows: readonly MessageRow[]): MessageRow | undefined {
  return rows.reduce<MessageRow | undefined>((latest, row) => {
    if (latest === undefined) return row;
    const at = Number(object(row.info.time)?.created ?? 0);
    const latestAt = Number(object(latest.info.time)?.created ?? 0);
    return at > latestAt || (at === latestAt && String(row.info.id) > String(latest.info.id)) ? row : latest;
  }, undefined);
}
async function readTurnResult(
  input: Readonly<{
    session: Awaited<ReturnType<typeof loadOpencode>>["client"]["session"];
    sessionId: string;
    cwd: string;
    messageID: string;
    state: ReturnType<typeof createEventState>;
  }>,
): Promise<TurnResult> {
  try {
    const response = await input.session.messages({
      path: { id: input.sessionId },
      query: { directory: input.cwd },
      throwOnError: true,
    });
    const rows = messageRows(response, input.sessionId);
    const user = rows.find((row) => row.info.role === "user" && row.info.id === input.messageID);
    if (user === undefined)
      return { kind: "failed", diagnostic: "OpenCode completed without the admitted user message" };
    const userId = text(user.info.id);
    const assistant = newest(
      rows.filter((row) => row.info.role === "assistant" && row.info.parentID === userId && row.info.summary !== true),
    );
    const historyId = text(assistant?.info.id);
    if (input.state.failure !== undefined) return { kind: "failed", diagnostic: input.state.failure };
    if (assistant === undefined)
      return { kind: "failed", diagnostic: "OpenCode completed without a native assistant answer" };
    if (assistant.info.error !== undefined) return { kind: "failed", diagnostic: diagnostic(assistant.info.error) };
    const answer = assistant.parts
      .map((part) => object(part))
      .filter((part) => part?.type === "text")
      .map((part) => part?.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n\n");
    return historyId === undefined ? { kind: "answered", answer } : { kind: "answered", answer, historyId };
  } catch (error) {
    return { kind: "failed", diagnostic: diagnostic(error) };
  }
}
function nativeSessionId(value: unknown): string | undefined {
  const event = object(value);
  const properties = object(event?.properties);
  const direct = text(properties?.sessionID);
  if (direct !== undefined) return direct;
  const info = object(properties?.info);
  const part = object(properties?.part);
  return text(info?.sessionID) ?? text(part?.sessionID);
}
function scopedProperties(value: unknown, sessionId: string): Record<string, unknown> | undefined {
  const properties = object(object(value)?.properties);
  return nativeSessionId(value) === sessionId ? properties : undefined;
}
type NativeProgress = Readonly<{ busy: boolean; terminal: boolean }>;
function nativeProgress(type: unknown, properties: Record<string, unknown>, busy: boolean): NativeProgress {
  if (type === "session.idle") return { busy, terminal: busy };
  if (type !== "session.status") return { busy, terminal: false };
  const status = object(properties.status)?.type;
  const nextBusy = busy || status === "busy";
  return { busy: nextBusy, terminal: status === "idle" && nextBusy };
}
function startsTurn(value: unknown, sessionId: string, messageID: string): boolean {
  const event = object(value);
  const info = object(object(event?.properties)?.info);
  return (
    event?.type === "message.updated" && info?.sessionID === sessionId && info.role === "user" && info.id === messageID
  );
}
function recognizeAdmission(value: unknown, sessionId: string, admission: ReturnType<typeof liveAdmission>): void {
  const event = object(value);
  const properties = object(event?.properties);
  const info = object(properties?.info);
  if (
    event?.type === "message.updated" &&
    info?.sessionID === sessionId &&
    info.role === "user" &&
    typeof info.id === "string"
  ) {
    admission.admit(info.id);
  }
}

type ObservedEvent = Readonly<{ active: boolean; busy: boolean; terminal: boolean; result?: TurnResult }>;
function observeEvent(
  input: Readonly<{
    value: unknown;
    sessionId: string;
    messageID: string;
    active: boolean;
    busy: boolean;
    admission: ReturnType<typeof liveAdmission>;
    events: AgentEventChannel;
    state: ReturnType<typeof createEventState>;
    submissionState: { started: boolean };
  }>,
): ObservedEvent {
  const observedSessionId = nativeSessionId(input.value);
  if (observedSessionId !== undefined && observedSessionId !== input.sessionId) {
    return { active: input.active, busy: input.busy, terminal: false };
  }
  const event = object(input.value);
  const properties = scopedProperties(input.value, input.sessionId);
  if (properties === undefined) {
    if (input.active) mapEvent(input.value, input.events, input.state);
    return { active: input.active, busy: input.busy, terminal: false };
  }
  const starts = !input.active && startsTurn(input.value, input.sessionId, input.messageID);
  const active = input.active || starts;
  const busy = starts ? false : input.busy;
  recognizeAdmission(input.value, input.sessionId, input.admission);
  const submittedError = event?.type === "session.error" && input.submissionState.started;
  if (!active && !submittedError) return { active, busy, terminal: false };
  mapEvent(input.value, input.events, input.state);
  if (event?.type === "session.error") {
    input.admission.end();
    return {
      active,
      busy,
      terminal: true,
      result: { kind: "failed", diagnostic: input.state.failure ?? diagnostic(properties.error) },
    };
  }
  const progress = nativeProgress(event?.type, properties, busy);
  return { active, busy: progress.busy, terminal: progress.terminal };
}

async function observeTurn(
  input: Readonly<{
    stream: OwnedEventStream;
    session: Awaited<ReturnType<typeof loadOpencode>>["client"]["session"];
    sessionId: string;
    cwd: string;
    messageID: string;
    admission: ReturnType<typeof liveAdmission>;
    events: AgentEventChannel;
    state: ReturnType<typeof createEventState>;
    submissionState: { started: boolean };
  }>,
): Promise<TurnResult> {
  let active = false;
  let busy = false;
  try {
    for (;;) {
      const next = await input.stream.next();
      if (next.done) return { kind: "failed", diagnostic: "OpenCode event stream ended before Turn completion" };
      const observed = observeEvent({
        value: eventValue(next.value),
        sessionId: input.sessionId,
        messageID: input.messageID,
        active,
        busy,
        admission: input.admission,
        events: input.events,
        state: input.state,
        submissionState: input.submissionState,
      });
      active = observed.active;
      busy = observed.busy;
      if (observed.result !== undefined) return observed.result;
      if (!observed.terminal) continue;
      input.admission.end();
      return await readTurnResult({ ...input, messageID: input.admission.latest() });
    }
  } catch (error) {
    return { kind: "failed", diagnostic: `OpenCode event stream failed: ${diagnostic(error)}` };
  } finally {
    input.admission.end();
  }
}

function liveAdmission(initial: string) {
  let latest = initial;
  let ended = false;
  const pending = new Map<
    string,
    { resolve(value: Awaited<ReturnType<NonNullable<Session["tell"]>>>): void; reject(error: unknown): void }
  >();
  const wait = (id: string) => {
    if (ended) return Promise.resolve({ kind: "turn-ended" } as const);
    return new Promise<Awaited<ReturnType<NonNullable<Session["tell"]>>>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };
  return {
    initial: wait(initial),
    latest: () => latest,
    open: () => !ended,
    wait,
    admit(id: string) {
      const waiter = pending.get(id);
      if (waiter === undefined || ended) return;
      pending.delete(id);
      latest = id;
      waiter.resolve({ kind: "accepted", fence: id });
    },
    fail(id: string, error: unknown) {
      pending.get(id)?.reject(error);
      pending.delete(id);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of pending.values()) waiter.resolve({ kind: "turn-ended" });
      pending.clear();
    },
  };
}

function terminalSettlement(
  events: AgentEventChannel,
  close: () => Promise<void>,
): Readonly<{ completion: Promise<TurnResult>; finish: (result: TurnResult) => Promise<void> }> {
  let finish!: (result: TurnResult) => Promise<void>;
  const completion = new Promise<TurnResult>((resolve) => {
    let settlement: Promise<void> | undefined;
    finish = (result): Promise<void> => {
      settlement ??= (async () => {
        // Whole closure is proved before narration ends. The driver therefore
        // stays inside its Heart/control observation race while retirement is
        // outstanding, so a rejected or unprovable closure still reaches attempt
        // custody's bounded hung handling instead of parking on a pending
        // completion. Ending narration first would move that await outside the
        // driver's race and make the Body unresponsive to stop or Heart loss.
        await close();
        events.end();
        resolve(result);
      })();
      return settlement;
    };
  });
  return { completion, finish };
}

/**
 * One memoized whole-close: stream retirement and existing server retirement
 * start together on every terminal path, so a live socket can never outwait the
 * server's death.
 */
function wholeClosure(retireStream: () => Promise<void>, closeServer: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= Promise.all([retireStream(), closeServer()]).then(() => undefined);
    return closing;
  };
}

async function forceDisposeOpencode(
  abortController: AbortController,
  close: () => Promise<void>,
  finish: (result: TurnResult) => Promise<void>,
): Promise<void> {
  abortController.abort();
  await close();
  await finish({ kind: "failed", diagnostic: "OpenCode session force-disposed" });
}

type OpencodeRuntime = Awaited<ReturnType<typeof loadOpencode>>;

async function loadDriveRuntime(
  execution: ProviderExecution,
  input: Input,
  signal: AbortSignal,
  loader?: OpencodeSdkLoader,
  onRuntime?: (runtime: OpencodeRuntime) => void,
): Promise<OpencodeRuntime> {
  const runtime = await loadOpencode({
    execution,
    cwd: input.cwd,
    signal,
    ...(loader === undefined ? {} : { loader }),
    ...(onRuntime === undefined ? {} : { onRuntime }),
    ...(input.requests === undefined ? {} : { requests: input.requests.dir }),
  });
  if (signal.aborted) {
    await runtime.close();
    signal.throwIfAborted();
  }
  return runtime;
}

function ownRuntime(custody: AttemptCustody | undefined, runtime: OpencodeRuntime): () => Promise<void> {
  let closing: Promise<void> | undefined;
  let settleRuntimeClosed!: () => void;
  let rejectRuntimeClosed!: (reason?: unknown) => void;
  const runtimeClosed = new Promise<void>((resolve, reject) => {
    settleRuntimeClosed = resolve;
    rejectRuntimeClosed = reject;
  });
  const close = (): Promise<void> => {
    if (closing === undefined) {
      closing = runtime.close();
      void closing.then(settleRuntimeClosed, rejectRuntimeClosed);
    }
    return closing;
  };
  custody?.own({ closed: runtimeClosed, abort: close, forceDispose: close });
  return close;
}

async function openDriveSession(
  runtime: OpencodeRuntime,
  input: Input,
  resumeSessionId: string | undefined,
  signal: AbortSignal,
): Promise<Readonly<{ session: OpencodeRuntime["client"]["session"]; sessionId: string }>> {
  const session = runtime.client.session;
  const response = await (input.session.kind === "fresh"
    ? session.create({ query: { directory: input.cwd }, throwOnError: true })
    : session.get({ path: { id: resumeSessionId! }, query: { directory: input.cwd }, throwOnError: true }));
  signal.throwIfAborted();
  const info = object(object(response)?.data) ?? object(response);
  const sessionId = text(info?.id) ?? resumeSessionId;
  if (sessionId === undefined) throw new Error("OpenCode did not return a session id");
  return { session, sessionId };
}

function createLiveSession(
  input: Readonly<{
    session: Awaited<ReturnType<typeof loadOpencode>>["client"]["session"];
    sessionId: string;
    cwd: string;
    promptBody(messageID: string, text: string): ReturnType<typeof promptBody>;
    admission: ReturnType<typeof liveAdmission>;
    nextMessageId(): string;
    events: AgentEventChannel;
    completion: Promise<TurnResult>;
    abortController: AbortController;
    close: () => Promise<void>;
    finish(result: TurnResult): Promise<void>;
  }>,
): Session {
  let submissions: Promise<void> = input.admission.initial.then(() => undefined);
  const submit = (tell: Readonly<{ id: string; text: string }>) => {
    const submission = async () => {
      if (!input.admission.open()) return { kind: "turn-ended" } as const;
      const receipt = input.admission.wait(tell.id);
      void input.session
        .promptAsync({
          path: { id: input.sessionId },
          query: { directory: input.cwd },
          body: input.promptBody(tell.id, tell.text),
          throwOnError: true,
        })
        .catch((error: unknown) => input.admission.fail(tell.id, error));
      return await receipt;
    };
    const next = submissions.then(submission);
    submissions = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    admission: { fence: input.sessionId },
    events: input.events,
    completion: input.completion,
    tell: (tell) => submit({ ...tell, id: input.nextMessageId() }),
    abort: async () => {
      input.admission.end();
      input.abortController.abort();
      void input.session
        .abort({ path: { id: input.sessionId }, query: { directory: input.cwd }, throwOnError: true })
        .catch(() => undefined);
      await input.finish({ kind: "failed", diagnostic: "OpenCode session interrupted" });
    },
    forceDispose: () => {
      input.admission.end();
      return forceDisposeOpencode(input.abortController, input.close, input.finish);
    },
  };
}

async function drive(
  execution: ProviderExecution,
  input: Input,
  loader?: OpencodeSdkLoader,
  custody?: AttemptCustody,
): Promise<Session> {
  admit(input.options);
  const signal = input.signal ?? new AbortController().signal;
  const resumeSessionId = input.session.kind === "resume" ? opencodeSessionId(input.session.coordinate) : undefined;
  const abortController = new AbortController();
  const abortSetup = () => abortController.abort(signal.reason);
  signal.addEventListener("abort", abortSetup, { once: true });
  signal.throwIfAborted();
  let closeOnce!: () => Promise<void>;
  const runtime = await loadDriveRuntime(execution, input, abortController.signal, loader, (ready) => {
    closeOnce = ownRuntime(custody, ready);
  });
  const stream = ownEventStream({
    directory: input.cwd,
    signal: abortController.signal,
    ...(custody === undefined ? {} : { custody }),
    subscribe: (request) => runtime.client.event.subscribe(request),
  });
  const wholeClose = wholeClosure(
    () => stream.retire(),
    () => closeOnce(),
  );
  try {
    const { session, sessionId } = await openDriveSession(runtime, input, resumeSessionId, abortController.signal);

    const events = new AgentEventChannel();
    const state = createEventState(sessionId);
    const messageSequence = { value: 0 };
    const nextMessageId = () => messageId(messageSequence.value++);
    const messageID = nextMessageId();
    const admission = liveAdmission(messageID);
    const submissionState = { started: false };
    events.emit({ type: "session", coordinate: coordinate(sessionId) });
    await stream.ready;
    if (abortController.signal.aborted) abortController.signal.throwIfAborted();
    const { completion, finish } = terminalSettlement(events, wholeClose);
    const observation = observeTurn({
      stream,
      session,
      sessionId,
      cwd: input.cwd,
      messageID,
      admission,
      events,
      state,
      submissionState,
    });
    submissionState.started = true;
    await session.promptAsync({
      path: { id: sessionId },
      query: { directory: input.cwd },
      body: promptBody(input, messageID),
      throwOnError: true,
    });
    abortController.signal.throwIfAborted();
    // The observer never awaits its own completion: finishing retires the whole
    // stream, but the observer that invoked finish stays outside that wait. Its
    // rejection is owned by attempt custody, not by an unobserved promise.
    void observation.then(finish).catch(() => undefined);
    return createLiveSession({
      session,
      sessionId,
      cwd: input.cwd,
      promptBody: (messageID, text) => promptBody({ ...input, body: text, launchTells: [] }, messageID),
      admission,
      nextMessageId,
      events,
      completion,
      abortController,
      close: wholeClose,
      finish,
    });
  } catch (error) {
    signal.removeEventListener("abort", abortSetup);
    await wholeClose();
    throw error;
  }
}

export function createOpencodeProvider(
  input: ProviderExecution | OpencodeProviderTestOptions = { name: OPENCODE_SDK_PROVIDER, kind: "opencode-sdk" },
): ProviderAdapter {
  const execution: ProviderExecution = "kind" in input ? input : { name: OPENCODE_SDK_PROVIDER, kind: "opencode-sdk" };
  const loader = "loader" in input ? input.loader : undefined;
  return {
    admitOptions(options: ProviderOptions) {
      try {
        admit(options);
      } catch (error) {
        return { kind: "refused", diagnostic: diagnostic(error) };
      }
      return {
        kind: "admitted",
        options: Object.freeze({ ...options }),
      };
    },
    start: (input) =>
      createProviderAttempt(
        input.signal,
        async (custody) => await drive(execution, { ...input, signal: custody.signal }, loader, custody),
      ),
    resume: (input) =>
      createProviderAttempt(
        input.signal,
        async (custody) => await drive(execution, { ...input, signal: custody.signal }, loader, custody),
      ),
    fork: (input: { session: ResumeCoordinate; at: string; cwd: string }) =>
      createProviderAttempt(new AbortController().signal, async (custody) => {
        const sessionId = opencodeSessionId(input.session);
        let close!: () => Promise<void>;
        const runtime = await loadOpencode({
          execution,
          cwd: input.cwd,
          signal: custody.signal,
          ...(loader === undefined ? {} : { loader }),
          onRuntime: (ready) => {
            let closing: Promise<void> | undefined;
            let settleRuntimeClosed!: () => void;
            let rejectRuntimeClosed!: (reason?: unknown) => void;
            const runtimeClosed = new Promise<void>((resolve, reject) => {
              settleRuntimeClosed = resolve;
              rejectRuntimeClosed = reject;
            });
            close = (): Promise<void> => {
              if (closing === undefined) {
                closing = ready.close();
                void closing.then(settleRuntimeClosed, rejectRuntimeClosed);
              }
              return closing;
            };
            custody.own({ closed: runtimeClosed, abort: close, forceDispose: close });
          },
        });
        try {
          const result = await runtime.client.session.fork({
            path: { id: sessionId },
            query: { directory: input.cwd },
            body: { messageID: input.at },
          });
          const info = object(object(result)?.data) ?? object(result);
          const id = text(info?.id);
          if (id === undefined || id === sessionId) throw new Error("OpenCode fork returned an invalid session id");
          return { session: coordinate(id) };
        } finally {
          await close();
        }
      }),
  };
}
