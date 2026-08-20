import { randomUUID } from "node:crypto";
import { abortable } from "../../abort.js";
import {
  AKUMA_REQUESTS_ENV,
  AgentEventChannel,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "../../provider.js";
import type { ResumeCoordinate } from "../../heart/index.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { createEventState, mapEvent } from "./events.js";
import { coordinate, loadOpencode, OPENCODE_SDK_PROVIDER, parseModel, type OpencodeSdkLoader } from "./session.js";

type Input = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
export type OpencodeProviderTestOptions = Readonly<{ loader?: OpencodeSdkLoader }>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
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
  try { return JSON.parse(value) as unknown; } catch { return { type: value }; }
}

function promptBody(input: Input, messageID: string): Readonly<{
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
    return at >= latestAt ? row : latest;
  }, undefined);
}
async function readTurnResult(input: Readonly<{
  session: Awaited<ReturnType<typeof loadOpencode>>["client"]["session"];
  sessionId: string;
  cwd: string;
  messageID: string;
  state: ReturnType<typeof createEventState>;
}>): Promise<TurnResult | undefined> {
  try {
    const response = await input.session.messages({
      path: { id: input.sessionId },
      query: { directory: input.cwd },
      throwOnError: true,
    });
    const rows = messageRows(response, input.sessionId);
    const user = rows.find((row) => row.info.role === "user" && row.info.id === input.messageID);
    if (user === undefined) return undefined;
    const userId = text(user?.info.id);
    const assistant = newest(rows.filter((row) => row.info.role === "assistant" && row.info.parentID === userId));
    const historyId = text(assistant?.info.id);
    if (input.state.failure !== undefined) return { kind: "failed", diagnostic: input.state.failure };
    if (assistant === undefined) return { kind: "failed", diagnostic: "OpenCode completed without a native assistant answer" };
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
function stopIterator(iterator: AsyncIterator<unknown> | undefined): void {
  const stopped = iterator?.return?.(undefined);
  void stopped?.catch(() => undefined);
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
  return event?.type === "message.updated"
    && info?.sessionID === sessionId
    && info.role === "user"
    && info.id === messageID;
}
async function observeTurn(input: Readonly<{
  iterator: AsyncIterator<unknown>;
  session: Awaited<ReturnType<typeof loadOpencode>>["client"]["session"];
  sessionId: string;
  cwd: string;
  messageID: string;
  events: AgentEventChannel;
  state: ReturnType<typeof createEventState>;
  submissionState: { started: boolean };
}>): Promise<TurnResult> {
  let active = false;
  let busy = false;
  try {
    for (;;) {
      const next = await input.iterator.next();
      if (next.done) return { kind: "failed", diagnostic: "OpenCode event stream ended before Turn completion" };
      const value = eventValue(next.value);
      const observedSessionId = nativeSessionId(value);
      if (observedSessionId !== undefined && observedSessionId !== input.sessionId) continue;
      const event = object(value);
      const properties = scopedProperties(value, input.sessionId);
      if (properties === undefined) {
        if (active) mapEvent(value, input.events, input.state);
        continue;
      }
      if (startsTurn(value, input.sessionId, input.messageID)) {
        active = true;
        busy = false;
      }
      const submittedError = event?.type === "session.error" && input.submissionState.started;
      if (!active && !submittedError) continue;
      mapEvent(value, input.events, input.state);
      if (event?.type === "session.error") {
        return { kind: "failed", diagnostic: input.state.failure ?? diagnostic(properties.error) };
      }
      const progress = nativeProgress(event?.type, properties, busy);
      busy = progress.busy;
      if (!progress.terminal) continue;
      const result = await readTurnResult(input);
      if (result !== undefined) return result;
    }
  } catch (error) {
    return { kind: "failed", diagnostic: `OpenCode event stream failed: ${diagnostic(error)}` };
  }
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
        events.end();
        await close();
        resolve(result);
      })();
      return settlement;
    };
  });
  return { completion, finish };
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

async function drive(execution: ProviderExecution, input: Input, loader?: OpencodeSdkLoader): Promise<Session> {
  admit(input.options);
  const signal = input.signal ?? new AbortController().signal;
  const resumeSessionId = input.session.kind === "resume"
    ? opencodeSessionId(input.session.coordinate)
    : undefined;
  const abortController = new AbortController();
  const abortSetup = () => abortController.abort(signal.reason);
  signal.addEventListener("abort", abortSetup, { once: true });
  signal.throwIfAborted();
  const runtime = await abortable(
    loadOpencode({
      ...execution,
      env: {
        ...execution.env,
        ...(input.requests === undefined ? {} : { [AKUMA_REQUESTS_ENV]: input.requests.dir }),
      },
    }, input.cwd, abortController.signal, loader),
    abortController.signal,
    async (late) => await late.close(),
  );
  let closing: Promise<void> | undefined;
  let iterator: AsyncIterator<unknown> | undefined;
  const closeOnce = (): Promise<void> => {
    closing ??= runtime.close();
    return closing;
  };
  try {
    const session = runtime.client.session;
    const sessionResponse = await abortable(input.session.kind === "fresh"
      ? session.create({ query: { directory: input.cwd }, throwOnError: true })
      : session.get({ path: { id: resumeSessionId! }, query: { directory: input.cwd }, throwOnError: true }),
    abortController.signal);
    const info = object(object(sessionResponse)?.data) ?? object(sessionResponse);
    const sessionId = text(info?.id) ?? resumeSessionId;
    if (sessionId === undefined) throw new Error("OpenCode did not return a session id");

    const events = new AgentEventChannel();
    const state = createEventState(sessionId);
    const messageID = `msg_${randomUUID().replaceAll("-", "")}`;
    const submissionState = { started: false };
    events.emit({ type: "session", coordinate: coordinate(sessionId) });
    const streamResult = await abortable(
      runtime.client.event.subscribe({ query: { directory: input.cwd } }),
      abortController.signal,
      async (late) => { await late.stream[Symbol.asyncIterator]().return?.(undefined); },
    );
    iterator = streamResult.stream[Symbol.asyncIterator]();
    const { completion, finish } = terminalSettlement(events, closeOnce);
    const observation = observeTurn({
      iterator, session, sessionId, cwd: input.cwd, messageID, events, state, submissionState,
    });
    submissionState.started = true;
    await abortable(session.promptAsync({
      path: { id: sessionId },
      query: { directory: input.cwd },
      body: promptBody(input, messageID),
      throwOnError: true,
    }), abortController.signal);
    void observation.then(finish);
    signal.removeEventListener("abort", abortSetup);
    return {
      admission: { fence: sessionId },
      events,
      completion,
      abort: async () => {
        abortController.abort();
        void session.abort({ path: { id: sessionId }, query: { directory: input.cwd }, throwOnError: true }).catch(() => undefined);
        await finish({ kind: "failed", diagnostic: "OpenCode session interrupted" });
      },
      forceDispose: () => forceDisposeOpencode(abortController, closeOnce, finish),
    };
  } catch (error) {
    signal.removeEventListener("abort", abortSetup);
    stopIterator(iterator);
    await closeOnce();
    throw error;
  }
}

export function createOpencodeProvider(input: ProviderExecution | OpencodeProviderTestOptions = { name: OPENCODE_SDK_PROVIDER, kind: "opencode-sdk" }): ProviderAdapter {
  const execution: ProviderExecution = "kind" in input ? input : { name: OPENCODE_SDK_PROVIDER, kind: "opencode-sdk" };
  const loader = "loader" in input ? input.loader : undefined;
  return {
    admitOptions(options: ProviderOptions) {
      try { admit(options); } catch (error) { return { kind: "refused", diagnostic: diagnostic(error) }; }
      return {
        kind: "admitted",
        options: Object.freeze({ ...options }),
        ...(options.readonly === undefined ? {} : {
          readonly: {
            enforcement: "none" as const,
            diagnostic: "OpenCode V1 cannot remove task-surface mutation capabilities",
          },
        }),
      };
    },
    start: (input) => drive(execution, input, loader),
    resume: (input) => drive(execution, input, loader),
    fork: async (input: { session: ResumeCoordinate; at: string; cwd: string }) => {
      const sessionId = opencodeSessionId(input.session);
      const runtime = await loadOpencode(execution, input.cwd, new AbortController().signal, loader);
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
        await runtime.close();
      }
    },
  };
}
