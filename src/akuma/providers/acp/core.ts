import type * as AcpSdk from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawnStdioProcess } from "../../../runtime/proc/stdio.js";
import { abortable } from "../../abort.js";
import {
  AgentEventChannel,
  launchPrompt,
  type AttemptCustody,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "../../provider.js";
import { akumaExecutionEnvironment } from "../execution-environment.js";
import { providerTurn } from "../turn.js";
import {
  createAcpEventState,
  emitAcpUpdate,
  flushAcpEvents,
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
  configureClient?: (client: AcpSdk.ClientApp) => void;
  onTerminal?: () => void;
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
  sessionOptions?: readonly Readonly<{ field: "model" | "effort"; id: string; value: string }>[];
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

function promptResult(response: AcpSdk.PromptResponse, answer: string): TurnResult {
  if (
    response.stopReason === "end_turn" ||
    response.stopReason === "max_tokens" ||
    response.stopReason === "max_turn_requests"
  ) {
    return { kind: "answered", answer };
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
  selections: NonNullable<AcpLaunch["sessionOptions"]>,
): Promise<string> {
  const initialized = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "keiyaku", version: "4" },
  });
  if (input.session.kind === "resume" && initialized.agentCapabilities?.loadSession !== true) {
    throw new Error("ACP agent does not advertise session/load");
  }
  let sessionId: string;
  let configOptions: AcpSdk.SessionConfigOption[] | null | undefined;
  if (input.session.kind === "fresh") {
    const created = await agent.request(acp.methods.agent.session.new, {
      cwd: input.cwd,
      mcpServers: [],
      ...requestMeta(dependencies.freshSessionMeta),
    });
    sessionId = created.sessionId;
    configOptions = created.configOptions;
  } else {
    const coordinate = input.session.coordinate.sessionId;
    if (coordinate === undefined) throw new Error("ACP resume coordinate has no session id");
    sessionId = coordinate;
    const loaded = await agent.request(acp.methods.agent.session.load, {
      cwd: input.cwd,
      mcpServers: [],
      sessionId,
      ...requestMeta(dependencies.loadSessionMeta),
    });
    configOptions = loaded.configOptions;
  }
  for (const selection of selections) {
    const selected = configOptions?.find((option) => option.id === selection.id);
    if (selected?.type !== "select") throw new Error(`ACP ${selection.field} option '${selection.id}' is unavailable`);
    const choices = selected.options.flatMap((option) => ("options" in option ? option.options : [option]));
    if (selected.currentValue === selection.value) continue;
    if (!choices.some((option) => option.value === selection.value)) {
      throw new Error(`ACP ${selection.field} value '${selection.value}' is unavailable`);
    }
    const updated = await agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: selection.id,
      value: selection.value,
    });
    configOptions = updated.configOptions;
    if (configOptions.find((option) => option.id === selection.id)?.currentValue !== selection.value) {
      throw new Error(`ACP ${selection.field} option '${selection.id}' did not select '${selection.value}'`);
    }
  }
  return sessionId;
}

function ownAcpTransport(
  acp: AcpModule,
  child: ReturnType<typeof spawnStdioProcess>,
  custody: AttemptCustody,
  turn: ReturnType<typeof providerTurn>,
  cancel: () => Promise<void> | undefined,
) {
  let retainRetirement!: (operation: Promise<void>) => void;
  const retired = new Promise<void>((resolve) => {
    retainRetirement = resolve;
  });
  let connection: AcpSdk.ClientConnection | undefined;
  let closing: Promise<void> | undefined;
  let forcing: Promise<void> | undefined;
  let cancelling: Promise<void> | undefined;
  const close = (force: boolean): Promise<void> => {
    if (force) forcing ??= Promise.resolve().then(() => child.close(true));
    if (closing === undefined) {
      closing = (forcing ?? Promise.resolve().then(() => child.endInputAndDrain())).finally(async () => {
        connection?.close();
        await connection?.closed;
      });
      retainRetirement(closing);
    }
    return force ? Promise.all([closing, forcing]).then(() => undefined) : closing;
  };
  const stop = (diagnostic: string): Promise<void> => {
    turn.finish({ kind: "failed", diagnostic });
    return close(true);
  };
  custody.own({
    async abort() {
      try {
        await (cancelling = cancel());
      } finally {
        await stop("ACP turn cancelled");
      }
    },
    forceDispose: () => stop("ACP turn force-disposed"),
    closed: retired.finally(async () => {
      await child.exited;
      await Promise.all([forcing, cancelling]);
    }),
  });
  return {
    connect(
      onUpdate: (notification: AcpSdk.SessionNotification) => void,
      configure?: AcpDependencies["configureClient"],
    ): AcpSdk.ClientContext {
      const client = acp
        .client({ name: "keiyaku" })
        .onNotification(acp.methods.client.session.update, ({ params }) => onUpdate(params));
      configure?.(client);
      connection = client.connect(
        acp.ndJsonStream(
          Writable.toWeb(child.input) as WritableStream<Uint8Array>,
          Readable.toWeb(child.output) as ReadableStream<Uint8Array>,
        ),
      );
      return connection.agent;
    },
    close,
  };
}

export async function startAcpSession(
  launch: AcpLaunch,
  input: AcpStartInput,
  dependencies: AcpDependencies,
  custody: AttemptCustody,
): Promise<AcpLiveSession> {
  const acp = await import("@agentclientprotocol/sdk");
  const { signal } = custody;
  signal.throwIfAborted();
  const events = new AgentEventChannel();
  const emit = events.emit.bind(events);
  const narration = createAcpEventState(emit);
  const turn = providerTurn(events, () => {
    dependencies.onTerminal?.();
    flushAcpEvents(narration, emit);
  });
  const child = (dependencies.spawnProcess ?? spawnStdioProcess)({
    argv: launch.argv,
    cwd: input.cwd,
    env: akumaExecutionEnvironment(globalThis.process.env, launch.env, [], input.execution),
  });
  let agent: AcpSdk.ClientContext | undefined;
  let sessionId: string | undefined;
  const finish = (result: TurnResult): void => {
    if (turn.finish(result)) void transport.close(false);
  };
  const transport = ownAcpTransport(acp, child, custody, turn, () =>
    sessionId === undefined || turn.terminal
      ? undefined
      : agent!.notify(acp.methods.agent.session.cancel, { sessionId }),
  );
  try {
    agent = transport.connect((notification) => {
      if (turn.terminal || notification.sessionId !== sessionId) return;
      try {
        emitAcpUpdate(notification.update, narration, emit, dependencies.interpretTool);
      } catch (error) {
        if (turn.fail(error)) void transport.close(false);
      }
    }, dependencies.configureClient);
    sessionId = await abortable(establishSession(acp, agent, input, dependencies, launch.sessionOptions ?? []), signal);
    signal.throwIfAborted();
    events.emit({ type: "session", coordinate: { sessionId } });
    void agent
      .request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: launchPrompt(input.launchTells, input.schemaJson) }],
      })
      .then(
        (response) => finish(promptResult(response, narration.answer)),
        (error: unknown) => {
          if (error instanceof acp.RequestError) finish({ kind: "failed", diagnostic: diagnostic(acp, error) });
          else if (turn.fail(error)) void transport.close(false);
        },
      );
    void child.exited.then((exit) =>
      finish({
        kind: "failed",
        diagnostic: exit.stderr || `ACP process exited${exit.code === null ? "" : ` with code ${exit.code}`}`,
      }),
    );
    return {
      session: { admission: { fence: sessionId }, events, completion: turn.completion },
      agent,
      sessionId,
      open: () => !turn.terminal,
    };
  } catch (error) {
    turn.fail(error);
    throw error;
  }
}
