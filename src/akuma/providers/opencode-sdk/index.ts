import { AgentEventChannel, type ProviderAdapter, type ProviderOptions, type Session, type TurnResult } from "../../provider.js";
import type { ProviderExecution, ResumeCoordinate } from "../../heart/index.js";
import { createEventState, mapEvent } from "./events.js";
import { coordinate, loadOpencode, OPENCODE_SDK_PROVIDER, parseModel, type OpencodeSdkLoader, type OpencodeSdkSession } from "./session.js";

type Input = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
export type OpencodeProviderTestOptions = Readonly<{ loader?: OpencodeSdkLoader }>;

function diagnostic(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function opencodeSessionId(coordinate: ResumeCoordinate): string {
  if (!("sessionId" in coordinate) || coordinate.sessionId === undefined) {
    throw new Error("OpenCode resume requires sessionId");
  }
  return coordinate.sessionId;
}
function admit(options: ProviderOptions): void {
  if (options.access !== undefined) throw new Error("OpenCode does not support explicit access");
  if (options.network !== undefined) throw new Error("OpenCode does not support explicit network");
  if (options.systemPrompt !== undefined && options.systemPrompt.length > 0) {
    throw new Error("OpenCode V2 does not expose an enforceable system prompt option");
  }
  if (options.effort !== undefined && options.model === undefined) {
    throw new Error("OpenCode effort requires an explicit model");
  }
  if (options.model !== undefined) parseModel(options.model, options.effort);
}
function eventValue(value: unknown): unknown {
  const envelope = objectData(value);
  if (envelope !== undefined && typeof envelope.data === "string") return eventValue(envelope.data);
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return { type: value }; }
}

async function drive(execution: ProviderExecution, input: Input, loader?: OpencodeSdkLoader): Promise<Session> {
  admit(input.options);
  const resumeSessionId = input.session.kind === "resume"
    ? opencodeSessionId(input.session.coordinate)
    : undefined;
  const events = new AgentEventChannel();
  const state = createEventState();
  const abortController = new AbortController();
  const runtime = await loadOpencode(execution, input.cwd, abortController.signal, loader);
  let closed = false;
  const closeOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await runtime.close();
  };
  try {
    const session = runtime.client.v2.session;
    const model = input.options.model === undefined ? undefined : parseModel(input.options.model, input.options.effort);
    const response = input.session.kind === "fresh"
      ? await session.create({ location: { directory: input.cwd }, ...(model === undefined ? {} : { model }) }, { throwOnError: true })
      : await session.get({ sessionID: resumeSessionId! }, { throwOnError: true });
    const responseData = objectData(objectData(response)?.data);
    const info = objectData(responseData?.data) ?? responseData;
    const sessionId = textData(info?.id) ?? resumeSessionId;
    if (sessionId === undefined) throw new Error("OpenCode did not return a session id");
    if (input.session.kind === "resume" && model !== undefined) {
      await session.switchModel({ sessionID: sessionId, model }, { throwOnError: true });
    }
    events.emit({ type: "session", coordinate: coordinate(sessionId) });
    const streamResult = await session.events({ sessionID: sessionId });
    const iterator = streamResult.stream[Symbol.asyncIterator]();
    const promptText = [input.body, ...input.launchTells.map((tell) => tell.text)].filter((part) => part.length > 0).join("\n\n");
    const promptResponse = await session.prompt({ sessionID: sessionId, prompt: { text: promptText } }, { throwOnError: true });
    const fence = admittedFence(sessionId, promptResponse);
  let settled = false;
  let settle!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => { settle = resolve; });
  const finish = async (result: TurnResult): Promise<void> => {
    if (settled) return; settled = true; events.end();
    try { await closeOnce(); settle(result); } catch (error) { settle({ kind: "failed", diagnostic: `OpenCode cleanup failed: ${diagnostic(error)}` }); }
  };
  void (async () => {
    try {
      await consumeSession(session, sessionId, iterator, state, events);
      const messages = await session.messages({ sessionID: sessionId, order: "desc", limit: 32 }, { throwOnError: true });
      const final = messages.data.data.find((message) => message.type === "assistant");
      const answer = final?.type === "assistant" ? final.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n") : state.answer.join("\n\n");
      const historyId = final?.type === "assistant" ? textData(final.id) : undefined;
      if (state.failure !== undefined || final?.type === "assistant" && final.error !== undefined) await finish({ kind: "failed", diagnostic: state.failure ?? diagnostic(final?.type === "assistant" ? final.error : undefined) });
      else if (historyId === undefined) {
        await finish({ kind: "failed", diagnostic: "OpenCode completed without a native assistant answer/history point" });
      } else await finish({ kind: "answered", answer, historyId });
    } catch (error) { await finish({ kind: "failed", diagnostic: diagnostic(error) }); }
  })();
  return {
    admission: { fence },
    events,
    completion,
    abort: async () => {
      abortController.abort();
      void session.interrupt({ sessionID: sessionId }, { throwOnError: true }).catch(() => undefined);
      await finish({ kind: "failed", diagnostic: "OpenCode session interrupted" });
    },
  };
  } catch (error) {
    try { await closeOnce(); } catch (cleanupError) { throw new Error(`OpenCode setup failed: ${diagnostic(error)}; cleanup failed: ${diagnostic(cleanupError)}`); }
    throw error;
  }
}

function objectData(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined; }
function textData(value: unknown): string | undefined { return typeof value === "string" && value.trim().length > 0 ? value : undefined; }

function admittedFence(sessionId: string, response: unknown): string {
  const outer = objectData(response);
  const envelope = objectData(outer?.data);
  const admission = objectData(envelope?.data) ?? envelope;
  const id = textData(admission?.id);
  const sequence = typeof admission?.admittedSeq === "number" && Number.isSafeInteger(admission.admittedSeq)
    ? admission.admittedSeq : undefined;
  if (id === undefined && sequence === undefined) throw new Error("OpenCode did not return prompt admission evidence");
  return `${sessionId}:${sequence ?? id}`;
}

async function consumeSession(
  session: OpencodeSdkSession,
  sessionId: string,
  iterator: AsyncIterator<unknown>,
  state: ReturnType<typeof createEventState>,
  events: AgentEventChannel,
): Promise<void> {
  const stream = (async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      mapEvent(eventValue(next.value), events, state);
    }
  })();
  stream.catch(() => undefined);
  await session.wait({ sessionID: sessionId }, { throwOnError: true });
  await iterator.return?.();
  await stream;
  let after: number | undefined;
  for (;;) {
    const history = await session.history({ sessionID: sessionId, limit: 200, ...(after === undefined ? {} : { after }) }, { throwOnError: true });
    for (const event of history.data.data) mapEvent(event, events, state);
    const latest = history.data.data.at(-1)?.durable?.seq;
    if (!history.data.hasMore || latest === undefined || latest === after) return;
    after = latest;
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
        const fork = runtime.client.session?.fork;
        if (fork === undefined) throw new Error("OpenCode fork is unavailable");
        const result = objectData(await fork({ sessionID: sessionId, messageID: input.at }));
        const data = objectData(result?.data);
        const id = textData(data?.id); if (id === undefined || id === sessionId) throw new Error("OpenCode fork returned an invalid session id");
        return { session: coordinate(id) };
      } finally { await runtime.close(); }
    },
  };
}

export const opencodeProvider = createOpencodeProvider();
