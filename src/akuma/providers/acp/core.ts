import type * as AcpSdk from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawnStdioProcess, type StdioProcess } from "../../../runtime/proc/stdio.js";
import { abortable } from "../../abort.js";
import {
  AKUMA_REQUESTS_ENV,
  AgentEventChannel,
  type AttemptCustody,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "../../provider.js";
import {
  EMPTY_ACP_EVENT_STATE,
  flushAcpEvents,
  mapAcpUpdate,
  type AcpToolInterpreter,
  type AcpToolUpdate,
} from "./events.js";

export type { AcpToolInterpreter, AcpToolUpdate };

export type AcpStartInput =
  | Parameters<ProviderAdapter["start"]>[0]
  | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

export type AcpSessionMeta = Readonly<Record<string, unknown>>;

export type AcpDependencies = Readonly<{
  spawnProcess?: typeof spawnStdioProcess;
  interpretTool?: AcpToolInterpreter;
  freshSessionMeta?: AcpSessionMeta;
  loadSessionMeta?: AcpSessionMeta;
}>;

export type AcpLiveSession = Readonly<{
  session: Session;
  agent: AcpSdk.ClientContext;
  sessionId: string;
  open(): boolean;
}>;

type AcpModule = typeof import("@agentclientprotocol/sdk");

type AcpLaunch = Readonly<{
  argv: readonly [string, ...string[]];
  env?: Readonly<Record<string, string>>;
}>;

function diagnostic(acp: AcpModule, error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!(error instanceof acp.RequestError) || error.data === undefined) return error.message;
  let data: string;
  try {
    data = typeof error.data === "string" ? error.data : JSON.stringify(error.data);
  } catch {
    data = String(error.data);
  }
  return data.length === 0 ? `${error.message} [${error.code}]` : `${error.message} [${error.code}]: ${data}`;
}

function createAcpClient(
  acp: AcpModule,
  onUpdate: (notification: AcpSdk.SessionNotification) => void,
): AcpSdk.ClientApp {
  return acp
    .client({ name: "keiyaku" })
    .onNotification(acp.methods.client.session.update, ({ params }) => onUpdate(params));
}

function promptResult(response: AcpSdk.PromptResponse): TurnResult {
  if (
    response.stopReason === "end_turn" ||
    response.stopReason === "max_tokens" ||
    response.stopReason === "max_turn_requests"
  ) {
    return { kind: "answered", answer: "" };
  }
  return { kind: "failed", diagnostic: `ACP prompt ended ${response.stopReason}` };
}

function requestMeta(meta?: AcpSessionMeta): Readonly<{ _meta: AcpSessionMeta }> | Readonly<Record<string, never>> {
  return meta === undefined || Object.keys(meta).length === 0 ? {} : { _meta: meta };
}

async function establishSession(
  acp: AcpModule,
  agent: AcpSdk.ClientContext,
  input: AcpStartInput,
  dependencies: AcpDependencies,
): Promise<string> {
  const initialized = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "keiyaku", version: "4" },
  });
  if (input.session.kind === "resume" && initialized.agentCapabilities?.loadSession !== true) {
    throw new Error("ACP agent does not advertise session/load");
  }
  if (input.session.kind === "fresh") {
    return (
      await agent.request(acp.methods.agent.session.new, {
        cwd: input.cwd,
        mcpServers: [],
        ...requestMeta(dependencies.freshSessionMeta),
      })
    ).sessionId;
  }
  const sessionId = input.session.coordinate.sessionId;
  if (sessionId === undefined) throw new Error("ACP resume coordinate has no session id");
  await agent.request(acp.methods.agent.session.load, {
    cwd: input.cwd,
    mcpServers: [],
    sessionId,
    ...requestMeta(dependencies.loadSessionMeta),
  });
  return sessionId;
}

function createAcpTurn(acp: AcpModule, connection: AcpSdk.ClientConnection, interpret?: AcpToolInterpreter) {
  const events = new AgentEventChannel();
  let state = EMPTY_ACP_EVENT_STATE;
  let terminal = false;
  let resolveCompletion!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const update = (next: AcpSdk.SessionUpdate): void => {
    if (terminal) return;
    const mapped = mapAcpUpdate(next, state, interpret);
    state = mapped.state;
    for (const event of mapped.events) events.emit(event);
  };
  const finish = async (result: TurnResult, cleanup: () => Promise<void>): Promise<void> => {
    if (terminal) return;
    terminal = true;
    let completionResult = result;
    const failCleanup = (error: unknown): void => {
      completionResult = { kind: "failed", diagnostic: `ACP cleanup failed: ${diagnostic(acp, error)}` };
    };
    try {
      await cleanup();
    } catch (error) {
      failCleanup(error);
    }
    try {
      connection.close();
    } catch (error) {
      failCleanup(error);
    }
    const flushed = flushAcpEvents(state);
    for (const event of flushed.events) events.emit(event);
    events.end();
    resolveCompletion(
      completionResult.kind === "answered" ? { ...completionResult, answer: flushed.state.answer } : completionResult,
    );
  };
  return {
    events,
    completion,
    update,
    finish,
    open: () => !terminal,
  };
}

function beginAcpPrompt(
  context: Readonly<{ acp: AcpModule; agent: AcpSdk.ClientContext }>,
  child: StdioProcess,
  turn: ReturnType<typeof createAcpTurn>,
  sessionId: string,
  input: AcpStartInput,
): Session {
  const { acp, agent } = context;
  void agent
    .request<AcpSdk.PromptResponse, AcpSdk.PromptRequest>(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: "text", text: input.body },
        ...input.launchTells.map(({ text }) => ({ type: "text" as const, text })),
      ],
    })
    .then(
      (response) => turn.finish(promptResult(response), () => child.endInputAndDrain()),
      (error: unknown) =>
        turn.finish({ kind: "failed", diagnostic: diagnostic(acp, error) }, () => child.endInputAndDrain()),
    );
  void child.exited.then((exit) =>
    turn.finish(
      {
        kind: "failed",
        diagnostic: exit.stderr || `ACP process exited${exit.code === null ? "" : ` with code ${exit.code}`}`,
      },
      () => child.endInputAndDrain(),
    ),
  );
  return {
    admission: { fence: sessionId },
    events: turn.events,
    completion: turn.completion,
    abort: async () => {
      let result: TurnResult = { kind: "failed", diagnostic: "ACP turn cancelled" };
      try {
        await agent.notify(acp.methods.agent.session.cancel, { sessionId });
      } catch (error) {
        result = { kind: "failed", diagnostic: diagnostic(acp, error) };
      }
      if (!turn.open()) await child.close(true);
      else await turn.finish(result, () => child.close(true));
    },
    forceDispose: async () => {
      if (!turn.open()) await child.close(true);
      else await turn.finish({ kind: "failed", diagnostic: "ACP turn force-disposed" }, () => child.close(true));
    },
  };
}

export async function startAcpSession(
  launch: AcpLaunch,
  input: AcpStartInput,
  dependencies: AcpDependencies = {},
  custody?: AttemptCustody,
): Promise<AcpLiveSession> {
  const acp = await import("@agentclientprotocol/sdk");
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const child = (dependencies.spawnProcess ?? spawnStdioProcess)({
    argv: launch.argv,
    cwd: input.cwd,
    env: {
      ...globalThis.process.env,
      ...launch.env,
      ...(input.requests === undefined ? {} : { [AKUMA_REQUESTS_ENV]: input.requests.dir }),
    },
  });
  custody?.own({
    closed: child.exited.then(() => undefined),
    abort: async () => await child.close(true),
    forceDispose: async () => await child.close(true),
  });
  let sessionId: string | undefined;
  let turn!: ReturnType<typeof createAcpTurn>;
  const connection = createAcpClient(acp, (notification) => {
    if (notification.sessionId === sessionId) turn.update(notification.update);
  }).connect(
    acp.ndJsonStream(
      Writable.toWeb(child.input) as WritableStream<Uint8Array>,
      Readable.toWeb(child.output) as ReadableStream<Uint8Array>,
    ),
  );
  turn = createAcpTurn(acp, connection, dependencies.interpretTool);
  try {
    sessionId = await abortable(establishSession(acp, connection.agent, input, dependencies), signal);
    turn.events.emit({ type: "session", coordinate: { sessionId } });
    const session = beginAcpPrompt({ acp, agent: connection.agent }, child, turn, sessionId, input);
    return { session, agent: connection.agent, sessionId, open: turn.open };
  } catch (error) {
    connection.close(error);
    if (custody === undefined) {
      try {
        await child.close(true);
      } catch (cleanup) {
        throw new Error(`${diagnostic(acp, error)}; ACP cleanup failed: ${diagnostic(acp, cleanup)}`, { cause: error });
      }
    }
    turn.events.end();
    throw error;
  }
}
