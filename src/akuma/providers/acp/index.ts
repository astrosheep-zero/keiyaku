import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { AgentEventChannel, type ProviderAdapter, type ProviderOptionAdmission, type ProviderOptions, type Session, type TurnResult } from "../../provider.js";
import type { ProviderExecution } from "../../heart/index.js";
import { spawnStdioProcess, type StdioProcess } from "../../../runtime/proc/stdio.js";
import { EMPTY_ACP_EVENT_STATE, flushAcpEvents, mapAcpUpdate } from "./events.js";
type StartInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
export type AcpExecutionConfig = Readonly<{
  argvBefore: readonly string[];
  argvAfter: readonly string[];
  modelArg?: string;
  effortArg?: string;
  systemPromptArg?: string;
}>;
function argumentName(value: Readonly<Record<string, unknown>>, key: "modelArg" | "effortArg" | "systemPromptArg"): string | undefined {
  const selected = value[key];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || selected.trim().length === 0) throw new TypeError(`ACP provider config ${key} must be a nonblank string`);
  return selected;
}
export function decodeAcpConfig(value: unknown): AcpExecutionConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("ACP provider config must be an object");
  const config = value as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(config).find((key) => !["argvBefore", "argvAfter", "effortArg", "modelArg", "systemPromptArg"].includes(key));
  if (unknown !== undefined) throw new TypeError(`ACP provider config has unknown field ${unknown}`);
  if (!Array.isArray(config.argvBefore) || config.argvBefore.some((arg) => typeof arg !== "string" || arg.trim().length === 0)) {
    throw new TypeError("ACP provider config argvBefore must be an array of nonblank strings");
  }
  if (!Array.isArray(config.argvAfter) || config.argvAfter.some((arg) => typeof arg !== "string" || arg.trim().length === 0)) {
    throw new TypeError("ACP provider config argvAfter must be an array of nonblank strings");
  }
  const modelArg = argumentName(config, "modelArg");
  const effortArg = argumentName(config, "effortArg");
  const systemPromptArg = argumentName(config, "systemPromptArg");
  return Object.freeze({
    argvBefore: Object.freeze([...config.argvBefore] as string[]),
    argvAfter: Object.freeze([...config.argvAfter] as string[]),
    ...(modelArg === undefined ? {} : { modelArg }),
    ...(effortArg === undefined ? {} : { effortArg }),
    ...(systemPromptArg === undefined ? {} : { systemPromptArg }),
  });
}
function optionAdmission(options: ProviderOptions, config: AcpExecutionConfig): ProviderOptionAdmission {
  if (options.access !== undefined) return { kind: "refused", diagnostic: "ACP provider does not support the Archetype access option" };
  if (options.network !== undefined) return { kind: "refused", diagnostic: "ACP provider does not support the Archetype network option" };
  if (options.model !== undefined && config.modelArg === undefined) return { kind: "refused", diagnostic: "ACP provider has no model argument mapping" };
  if (options.effort !== undefined && config.effortArg === undefined) return { kind: "refused", diagnostic: "ACP provider has no effort argument mapping" };
  if (options.systemPrompt !== undefined && config.systemPromptArg === undefined) return { kind: "refused", diagnostic: "ACP provider has no systemPrompt argument mapping" };
  return { kind: "admitted", options };
}
function argv(execution: ProviderExecution, config: AcpExecutionConfig, options: ProviderOptions): readonly [string, ...string[]] {
  if (execution.executable === undefined) throw new Error("ACP provider execution requires executable");
  const values = [execution.executable, ...config.argvBefore];
  if (options.model !== undefined) values.push(config.modelArg!, options.model);
  if (options.effort !== undefined) values.push(config.effortArg!, options.effort);
  if (options.systemPrompt !== undefined) values.push(config.systemPromptArg!, options.systemPrompt);
  values.push(...config.argvAfter);
  return values as [string, ...string[]];
}
function diagnostic(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function unsupportedClientRequest(method: string): never { throw new acp.RequestError(-32000, `Keiyaku ACP client refuses ${method}`); }

function createAcpClient(onUpdate: (notification: acp.SessionNotification) => void): acp.ClientApp {
  return acp.client({ name: "keiyaku" })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
    .onRequest(acp.methods.client.fs.readTextFile, () => unsupportedClientRequest(acp.methods.client.fs.readTextFile))
    .onRequest(acp.methods.client.fs.writeTextFile, () => unsupportedClientRequest(acp.methods.client.fs.writeTextFile))
    .onRequest(acp.methods.client.terminal.create, () => unsupportedClientRequest(acp.methods.client.terminal.create))
    .onRequest(acp.methods.client.terminal.output, () => unsupportedClientRequest(acp.methods.client.terminal.output))
    .onRequest(acp.methods.client.terminal.release, () => unsupportedClientRequest(acp.methods.client.terminal.release))
    .onRequest(acp.methods.client.terminal.waitForExit, () => unsupportedClientRequest(acp.methods.client.terminal.waitForExit))
    .onRequest(acp.methods.client.terminal.kill, () => unsupportedClientRequest(acp.methods.client.terminal.kill))
    .onRequest(acp.methods.client.elicitation.create, () => ({ action: "cancel" }))
    .onNotification(acp.methods.client.session.update, ({ params }) => onUpdate(params));
}

function promptResult(response: acp.PromptResponse): TurnResult {
  if (response.stopReason === "end_turn" || response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests") {
    return { kind: "answered", answer: "" };
  }
  return { kind: "failed", diagnostic: `ACP prompt ended ${response.stopReason}` };
}
async function establishSession(agent: acp.ClientContext, input: StartInput): Promise<string> {
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
type AcpDependencies = Readonly<{ spawnProcess?: typeof spawnStdioProcess }>;

function createAcpTurn(connection: acp.ClientConnection) {
  const events = new AgentEventChannel();
  let state = EMPTY_ACP_EVENT_STATE;
  let terminal = false;
  let settled = false;
  let resolveCompletion!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => { resolveCompletion = resolve; });
  const update = (next: acp.SessionUpdate): void => {
    if (settled) return;
    const mapped = mapAcpUpdate(next, state);
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
    settled = true;
    const flushed = flushAcpEvents(state);
    for (const event of flushed.events) events.emit(event);
    events.end();
    resolveCompletion(completionResult.kind === "answered" ? { ...completionResult, answer: flushed.state.answer } : completionResult);
  };
  return {
    events,
    completion,
    update,
    finish,
    terminal: () => terminal,
  };
}

function beginAcpPrompt(agent: acp.ClientContext, child: StdioProcess, turn: ReturnType<typeof createAcpTurn>, sessionId: string, input: StartInput): Session {
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
      if (turn.terminal()) await child.close(true);
      else await turn.finish(result, () => child.close(true));
    },
  };
}

async function startAcpSession(
  execution: ProviderExecution,
  config: AcpExecutionConfig,
  input: StartInput,
  dependencies: AcpDependencies,
): Promise<Session> {
  const child = (dependencies.spawnProcess ?? spawnStdioProcess)({
    argv: argv(execution, config, input.options),
    cwd: input.cwd,
    env: { ...globalThis.process.env, ...execution.env },
  });
  let sessionId: string | undefined;
  let turn!: ReturnType<typeof createAcpTurn>;
  const connection = createAcpClient((notification) => {
    if (notification.sessionId === sessionId) turn.update(notification.update);
  }).connect(acp.ndJsonStream(
    Writable.toWeb(child.input) as WritableStream<Uint8Array>,
    Readable.toWeb(child.output) as ReadableStream<Uint8Array>,
  ));
  turn = createAcpTurn(connection);
  try {
    sessionId = await establishSession(connection.agent, input);
    turn.events.emit({ type: "session", coordinate: { sessionId } });
    return beginAcpPrompt(connection.agent, child, turn, sessionId, input);
  } catch (error) {
    connection.close(error);
    await child.close(true);
    turn.events.end();
    throw error;
  }
}
export function createAcpProvider(execution: ProviderExecution, dependencies: AcpDependencies = {}): ProviderAdapter {
  if (execution.executable === undefined) throw new TypeError("ACP provider execution requires executable");
  const config = decodeAcpConfig(execution.config);
  return {
    confinement: () => ({ kind: "unconfined" }),
    admitOptions: (options) => optionAdmission(options, config),
    start: async (input) => await startAcpSession(execution, config, input, dependencies),
    resume: async (input) => await startAcpSession(execution, config, input, dependencies),
  };
}
