import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawnStdioProcess, type StdioProcess } from "../../../runtime/proc/stdio.js";
import { abortable } from "../../abort.js";
import {
  AgentEventChannel,
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

export type AcpStartInput = Parameters<ProviderAdapter["start"]>[0]
  | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

export type AcpDependencies = Readonly<{
  spawnProcess?: typeof spawnStdioProcess;
  interpretTool?: AcpToolInterpreter;
}>;

export type AcpLiveSession = Readonly<{
  session: Session;
  agent: acp.ClientContext;
  sessionId: string;
  open(): boolean;
}>;

type AcpLaunch = Readonly<{
  argv: readonly [string, ...string[]];
  env?: Readonly<Record<string, string>>;
}>;

function diagnostic(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (!(error instanceof acp.RequestError) || error.data === undefined) return error.message;
  let data: string;
  try { data = typeof error.data === "string" ? error.data : JSON.stringify(error.data); }
  catch { data = String(error.data); }
  return data.length === 0 ? `${error.message} [${error.code}]` : `${error.message} [${error.code}]: ${data}`;
}

function createAcpClient(onUpdate: (notification: acp.SessionNotification) => void): acp.ClientApp {
  return acp.client({ name: "keiyaku" })
    .onNotification(acp.methods.client.session.update, ({ params }) => onUpdate(params));
}

function promptResult(response: acp.PromptResponse): TurnResult {
  if (response.stopReason === "end_turn" || response.stopReason === "max_tokens"
    || response.stopReason === "max_turn_requests") {
    return { kind: "answered", answer: "" };
  }
  return { kind: "failed", diagnostic: `ACP prompt ended ${response.stopReason}` };
}

async function establishSession(agent: acp.ClientContext, input: AcpStartInput): Promise<string> {
  const initialized = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "keiyaku", version: "4" },
  });
  if (input.session.kind === "resume" && initialized.agentCapabilities?.loadSession !== true) {
    throw new Error("ACP agent does not advertise session/load");
  }
  if (input.session.kind === "fresh") {
    return (await agent.request(acp.methods.agent.session.new, { cwd: input.cwd, mcpServers: [] })).sessionId;
  }
  const sessionId = input.session.coordinate.sessionId;
  if (sessionId === undefined) throw new Error("ACP resume coordinate has no session id");
  await agent.request(acp.methods.agent.session.load, { cwd: input.cwd, mcpServers: [], sessionId });
  return sessionId;
}

function createAcpTurn(connection: acp.ClientConnection, interpret?: AcpToolInterpreter) {
  const events = new AgentEventChannel();
  let state = EMPTY_ACP_EVENT_STATE;
  let terminal = false;
  let resolveCompletion!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => { resolveCompletion = resolve; });
  const update = (next: acp.SessionUpdate): void => {
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
      completionResult = { kind: "failed", diagnostic: `ACP cleanup failed: ${diagnostic(error)}` };
    };
    try { await cleanup(); } catch (error) { failCleanup(error); }
    try { connection.close(); } catch (error) { failCleanup(error); }
    const flushed = flushAcpEvents(state);
    for (const event of flushed.events) events.emit(event);
    events.end();
    resolveCompletion(completionResult.kind === "answered"
      ? { ...completionResult, answer: flushed.state.answer }
      : completionResult);
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
  agent: acp.ClientContext,
  child: StdioProcess,
  turn: ReturnType<typeof createAcpTurn>,
  sessionId: string,
  input: AcpStartInput,
): Session {
  void agent.request<acp.PromptResponse, acp.PromptRequest>(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: input.body }, ...input.launchTells.map(({ text }) => ({ type: "text" as const, text }))],
  }).then(
    (response) => turn.finish(promptResult(response), () => child.endInputAndDrain()),
    (error: unknown) => turn.finish({ kind: "failed", diagnostic: diagnostic(error) }, () => child.endInputAndDrain()),
  );
  void child.exited.then((exit) => turn.finish({
    kind: "failed",
    diagnostic: exit.stderr || `ACP process exited${exit.code === null ? "" : ` with code ${exit.code}`}`,
  }, () => child.endInputAndDrain()));
  return {
    admission: { fence: sessionId },
    events: turn.events,
    completion: turn.completion,
    abort: async () => {
      let result: TurnResult = { kind: "failed", diagnostic: "ACP turn cancelled" };
      try { await agent.notify(acp.methods.agent.session.cancel, { sessionId }); }
      catch (error) { result = { kind: "failed", diagnostic: diagnostic(error) }; }
      if (!turn.open()) await child.close(true);
      else await turn.finish(result, () => child.close(true));
    },
  };
}

export async function startAcpSession(
  launch: AcpLaunch,
  input: AcpStartInput,
  dependencies: AcpDependencies = {},
): Promise<AcpLiveSession> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const child = (dependencies.spawnProcess ?? spawnStdioProcess)({
    argv: launch.argv,
    cwd: input.cwd,
    env: { ...globalThis.process.env, ...launch.env },
  });
  let sessionId: string | undefined;
  let turn!: ReturnType<typeof createAcpTurn>;
  const connection = createAcpClient((notification) => {
    if (notification.sessionId === sessionId) turn.update(notification.update);
  }).connect(acp.ndJsonStream(
    Writable.toWeb(child.input) as WritableStream<Uint8Array>,
    Readable.toWeb(child.output) as ReadableStream<Uint8Array>,
  ));
  turn = createAcpTurn(connection, dependencies.interpretTool);
  try {
    sessionId = await abortable(establishSession(connection.agent, input), signal);
    turn.events.emit({ type: "session", coordinate: { sessionId } });
    const session = beginAcpPrompt(connection.agent, child, turn, sessionId, input);
    return { session, agent: connection.agent, sessionId, open: turn.open };
  } catch (error) {
    connection.close(error);
    try { await child.close(true); }
    catch (cleanup) {
      throw new Error(`${diagnostic(error)}; ACP cleanup failed: ${diagnostic(cleanup)}`, { cause: error });
    }
    turn.events.end();
    throw error;
  }
}
