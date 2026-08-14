import { randomUUID } from "node:crypto";
import { AgentEventChannel, type ProviderAdapter, type ProviderOptions, type Session, type TurnResult } from "../../provider.js";
import type { ProviderExecution, ResumeCoordinate } from "../../heart/index.js";
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
  if (options.access !== undefined) throw new Error("OpenCode does not support explicit access");
  if (options.network !== undefined) throw new Error("OpenCode does not support explicit network");
  if (options.effort !== undefined) throw new Error("OpenCode V1 does not expose an enforceable effort option");
  if (options.model !== undefined) parseModel(options.model);
}
function eventValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return { type: value }; }
}

function promptBody(input: Input, messageID: string): Readonly<{
  messageID: string;
  model?: { providerID: string; modelID: string };
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
    if (assistant === undefined || historyId === undefined) {
      return { kind: "failed", diagnostic: "OpenCode completed without a native assistant answer/history point" };
    }
    if (assistant.info.error !== undefined) return { kind: "failed", diagnostic: diagnostic(assistant.info.error) };
    const answer = assistant.parts
      .map((part) => object(part))
      .filter((part) => part?.type === "text")
      .map((part) => part?.text)
      .filter((part): part is string => typeof part === "string")
      .join("\n\n");
    return { kind: "answered", answer, historyId };
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
  iterator: AsyncIterator<unknown>,
  close: () => Promise<void>,
): Readonly<{ completion: Promise<TurnResult>; finish: (result: TurnResult) => Promise<void> }> {
  let finish!: (result: TurnResult) => Promise<void>;
  const completion = new Promise<TurnResult>((resolve) => {
    let settled = false;
    finish = async (result): Promise<void> => {
      if (settled) return;
      settled = true;
      events.end();
      stopIterator(iterator);
      try { await close(); resolve(result); }
      catch (error) { resolve({ kind: "failed", diagnostic: `OpenCode cleanup failed: ${diagnostic(error)}` }); }
    };
  });
  return { completion, finish };
}

async function drive(execution: ProviderExecution, input: Input, loader?: OpencodeSdkLoader): Promise<Session> {
  admit(input.options);
  const resumeSessionId = input.session.kind === "resume"
    ? opencodeSessionId(input.session.coordinate)
    : undefined;
  const abortController = new AbortController();
  const runtime = await loadOpencode(execution, input.cwd, abortController.signal, loader);
  let closed = false;
  let iterator: AsyncIterator<unknown> | undefined;
  const closeOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await runtime.close();
  };
  try {
    const session = runtime.client.session;
    const sessionResponse = input.session.kind === "fresh"
      ? await session.create({ query: { directory: input.cwd }, throwOnError: true })
      : await session.get({ path: { id: resumeSessionId! }, query: { directory: input.cwd }, throwOnError: true });
    const info = object(object(sessionResponse)?.data) ?? object(sessionResponse);
    const sessionId = text(info?.id) ?? resumeSessionId;
    if (sessionId === undefined) throw new Error("OpenCode did not return a session id");

    const events = new AgentEventChannel();
    const state = createEventState(sessionId);
    const messageID = `msg_${randomUUID().replaceAll("-", "")}`;
    const submissionState = { started: false };
    events.emit({ type: "session", coordinate: coordinate(sessionId) });
    const streamResult = await runtime.client.event.subscribe({ query: { directory: input.cwd } });
    iterator = streamResult.stream[Symbol.asyncIterator]();
    const { completion, finish } = terminalSettlement(events, iterator, closeOnce);
    const observation = observeTurn({
      iterator, session, sessionId, cwd: input.cwd, messageID, events, state, submissionState,
    });
    submissionState.started = true;
    await session.promptAsync({
      path: { id: sessionId },
      query: { directory: input.cwd },
      body: promptBody(input, messageID),
      throwOnError: true,
    });
    void observation.then(finish);
    return {
      admission: { fence: sessionId },
      events,
      completion,
      abort: async () => {
        abortController.abort();
        void session.abort({ path: { id: sessionId }, query: { directory: input.cwd }, throwOnError: true }).catch(() => undefined);
        await finish({ kind: "failed", diagnostic: "OpenCode session interrupted" });
      },
    };
  } catch (error) {
    stopIterator(iterator);
    try { await closeOnce(); } catch (cleanupError) { throw new Error(`OpenCode setup failed: ${diagnostic(error)}; cleanup failed: ${diagnostic(cleanupError)}`); }
    throw error;
  }
}

export function createOpencodeProvider(input: ProviderExecution | OpencodeProviderTestOptions = { name: OPENCODE_SDK_PROVIDER, kind: "opencode-sdk" }): ProviderAdapter {
  const execution: ProviderExecution = "kind" in input ? input : { name: OPENCODE_SDK_PROVIDER, kind: "opencode-sdk" };
  const loader = "loader" in input ? input.loader : undefined;
  return {
    confinement: ({ cwd }) => ({ kind: "declared", writableRoots: [cwd] }),
    admitOptions(options: ProviderOptions) {
      try { admit(options); } catch (error) { return { kind: "refused", diagnostic: diagnostic(error) }; }
      return { kind: "admitted", options: Object.freeze({ ...options }) };
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

export const opencodeProvider = createOpencodeProvider();
