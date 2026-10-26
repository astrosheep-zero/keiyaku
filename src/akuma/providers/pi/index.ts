import type {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashToolDefinition,
  getAgentDir,
  SessionManager,
  CreateAgentSessionOptions,
  CreateAgentSessionFromServicesOptions,
  AgentSessionServices,
} from "@earendil-works/pi-coding-agent";

/* eslint-disable max-lines-per-function -- Native Pi setup and disposal share one custody boundary. */
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import type { ResumeCoordinate } from "../../coordinate.js";
import { abortable } from "../../abort.js";
import { akumaExecutionEnvironment } from "../execution-environment.js";
import {
  AgentEventChannel,
  createProviderAttempt,
  launchPrompt,
  modelEvent,
  tellRegistry,
  type AttemptCustody,
  type ProviderAdapter,
  type Session,
  type TellSubmission,
  type TurnResult,
} from "../../provider.js";
import { piSessionModel, piTerminalFailure, translatePiEvent, type PiEventState } from "./events.js";

export type PiSdk = Readonly<{
  createAgentSessionFromServices: typeof createAgentSessionFromServices;
  createAgentSessionServices: typeof createAgentSessionServices;
  createBashToolDefinition: typeof createBashToolDefinition;
  getAgentDir: typeof getAgentDir;
  SessionManager: typeof SessionManager;
}>;

type PiThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
const PI_THINKING_LEVELS = new Set<PiThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_PATTERN = /^[^/\s]+\/[^\s]+$/u;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function admitPiOptions(options: ProviderOptions): ReturnType<ProviderAdapter["admitOptions"]> {
  if (options.network !== undefined)
    return { kind: "refused", diagnostic: "Pi provider does not support the network option" };
  if (options.model !== undefined && !MODEL_PATTERN.test(options.model)) {
    return { kind: "refused", diagnostic: "Pi provider model must use <provider>/<id>" };
  }
  if (options.effort !== undefined && !PI_THINKING_LEVELS.has(options.effort as PiThinkingLevel)) {
    return { kind: "refused", diagnostic: "Pi provider effort must be minimal, low, medium, high, xhigh, or max" };
  }
  return {
    kind: "admitted",
    options: Object.freeze({ ...options }),
  };
}

function piCreateOptions(
  sdk: PiSdk,
  input: PiDriveInput,
  services: AgentSessionServices,
): CreateAgentSessionFromServicesOptions {
  let model: CreateAgentSessionOptions["model"];
  if (input.options.model !== undefined) {
    const slash = input.options.model.indexOf("/");
    model = services.modelRuntime.getModel(input.options.model.slice(0, slash), input.options.model.slice(slash + 1));
    if (model === undefined) throw new Error(`Pi model '${input.options.model}' is unavailable`);
  }
  const sessionManager =
    input.session.kind === "fresh"
      ? sdk.SessionManager.create(input.cwd)
      : "sessionFile" in input.session.coordinate
        ? sdk.SessionManager.open(input.session.coordinate.sessionFile)
        : (() => {
            throw new Error("Pi resume requires sessionFile");
          })();
  const customTools =
    input.requests === undefined
      ? undefined
      : [
          sdk.createBashToolDefinition(input.cwd, {
            spawnHook: (context) => ({
              ...context,
              env: akumaExecutionEnvironment(context.env, {}, input.requests.dir, ["PI_SESSION_ID", "PI_SESSION_FILE"]),
            }),
          }) as NonNullable<CreateAgentSessionOptions["customTools"]>[number],
        ];
  return {
    services,
    sessionManager,
    ...(model === undefined ? {} : { model }),
    ...(input.options.effort === undefined ? {} : { thinkingLevel: input.options.effort as PiThinkingLevel }),
    ...(customTools === undefined ? {} : { customTools }),
  };
}

type PiDriveInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

type PiCreatedSession = Awaited<ReturnType<PiSdk["createAgentSessionFromServices"]>>;
type PiNativeSession = PiCreatedSession["session"];
type PiNativeMessage = Parameters<PiNativeSession["agent"]["steer"]>[0];
type PiDriveState = {
  terminalFailure: string | null;
  aborting: boolean;
  settled: boolean;
};

async function createPiSession(
  sdk: PiSdk,
  execution: ProviderExecution,
  input: PiDriveInput,
): Promise<PiCreatedSession> {
  if (execution.config !== undefined) {
    throw new TypeError("Pi provider config cannot be consumed by native CreateAgentSessionOptions");
  }
  const services = await sdk.createAgentSessionServices({
    cwd: input.cwd,
    agentDir: sdk.getAgentDir(),
    modelRuntimeSignal: input.signal,
    ...(input.options.systemPrompt === undefined
      ? {}
      : {
          resourceLoaderOptions:
            input.options.systemPromptMode === "append"
              ? { appendSystemPromptOverride: (base: string[]) => [...base, input.options.systemPrompt!] }
              : { systemPromptOverride: () => input.options.systemPrompt },
        }),
  });
  try {
    input.signal?.throwIfAborted();
    return await sdk.createAgentSessionFromServices(piCreateOptions(sdk, input, services));
  } catch (error) {
    // Before a session owns the extension runtime, failed selection/setup must
    // retire registrations and event-bus subscriptions loaded by the services.
    services.resourceLoader.getExtensions().runtime.invalidate();
    throw error;
  }
}

async function runPiPrompt(
  native: PiNativeSession,
  input: PiDriveInput,
  events: PiEventState,
  state: PiDriveState,
  settle: (result: TurnResult) => void,
): Promise<void> {
  try {
    await native.prompt(launchPrompt(input.body, input.launchTells, input.schemaJson));
    let result: TurnResult;
    if (state.aborting) result = { kind: "failed", diagnostic: "Pi session aborted" };
    else if (state.terminalFailure !== null) result = { kind: "failed", diagnostic: state.terminalFailure };
    else if (!events.assistantSeen)
      result = { kind: "failed", diagnostic: "Pi completed without a native assistant answer" };
    else {
      const historyId = native.sessionManager.getLeafId();
      result = {
        kind: "answered",
        answer: events.answer,
        ...(historyId === null ? {} : { historyId }),
      };
    }
    settle(result);
  } catch (error) {
    settle(
      state.aborting
        ? { kind: "failed", diagnostic: "Pi session aborted" }
        : { kind: "failed", diagnostic: diagnostic(error) },
    );
  }
}

async function retirePiSession(native: PiNativeSession): Promise<void> {
  let failure: unknown;
  let unsubscribe: (() => void) | undefined;
  try {
    const runner = native.extensionRunner;
    unsubscribe = runner?.onError((error) => {
      if (error.event === "session_shutdown") failure ??= new Error(error.error);
    });
    await runner?.emit({ type: "session_shutdown", reason: "quit" });
  } catch (error) {
    failure ??= error;
  } finally {
    try {
      unsubscribe?.();
    } catch (error) {
      failure ??= error;
    }
    try {
      native.dispose();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function drivePi(
  sdk: PiSdk,
  execution: ProviderExecution,
  input: PiDriveInput,
  signal: AbortSignal,
  custody?: AttemptCustody,
): Promise<Session> {
  const created = await createPiSession(sdk, execution, input);
  const native = created.session;
  let settleRetired!: () => void;
  let failRetired!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    settleRetired = resolve;
    failRetired = reject;
  });
  const events = new AgentEventChannel();
  const eventState: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
  const state: PiDriveState = {
    terminalFailure: null,
    aborting: false,
    settled: false,
  };
  const tells = tellRegistry<PiNativeMessage>((id) => `${native.sessionId}:${id}`);
  let settleCompletion!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => {
    settleCompletion = resolve;
  });
  const agent = native.agent;
  // Tells are harness input, not interactive typing: deliver every queued one at
  // the next boundary regardless of the user's interactive Pi setting.
  agent.steeringMode = "all";
  let unsubscribeAgent: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let binding: Promise<void> | undefined;
  const settle = (result: TurnResult): Promise<void> => {
    if (state.settled) return closed;
    state.settled = true;
    tells.end();
    let failure: unknown;
    try {
      unsubscribe?.();
    } catch (error) {
      failure = error;
    }
    try {
      unsubscribeAgent?.();
    } catch (error) {
      failure ??= error;
    }
    events.end();
    settleCompletion(result);
    void (async () => {
      // Binding can create extension resources after cancellation. Shutdown must
      // run after that work, while its contexts are still valid.
      await binding?.catch(() => undefined);
      try {
        await retirePiSession(native);
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    })().then(settleRetired, failRetired);
    return closed;
  };
  const abort = async (): Promise<void> => {
    if (state.settled) return;
    state.aborting = true;
    try {
      await native.abort();
    } catch {
      /* prompt settlement still proves local cleanup */
    }
    await settle({ kind: "failed", diagnostic: "Pi session aborted" });
  };
  const forceDispose = async (): Promise<void> => {
    if (!state.settled) state.aborting = true;
    await settle({ kind: "failed", diagnostic: "Pi session force-disposed" });
  };
  custody?.own({ closed, abort, forceDispose });
  try {
    unsubscribeAgent = agent.subscribe((event) => {
      if (event.type === "message_end") tells.accept(event.message);
    });
    unsubscribe = native.subscribe((event) => {
      if (event.type === "agent_end" && !event.willRetry) {
        state.terminalFailure = piTerminalFailure(event.messages);
      }
      for (const translated of translatePiEvent(event, eventState)) events.emit(translated);
    });
  } catch (error) {
    await settle({ kind: "failed", diagnostic: diagnostic(error) });
    throw error;
  }
  if (signal.aborted) {
    await settle({ kind: "failed", diagnostic: "Pi session aborted" });
    signal.throwIfAborted();
  }
  if (native.sessionFile === undefined || native.sessionFile.trim().length === 0) {
    await settle({ kind: "failed", diagnostic: "Pi session admitted without sessionFile" });
    throw new Error("Pi session admitted without sessionFile");
  }
  binding = Promise.resolve().then(() => native.bindExtensions({}));
  await abortable(binding, signal);
  signal.throwIfAborted();
  events.emit({ type: "session", coordinate: { sessionFile: native.sessionFile, sessionId: native.sessionId } });
  const sessionModel = piSessionModel(native.model);
  if (sessionModel !== undefined) events.emit(modelEvent(sessionModel));
  void runPiPrompt(native, input, eventState, state, (result) => {
    void settle(result).catch(() => undefined);
  });
  return {
    admission: { fence: native.sessionId },
    events,
    completion,
    tell: (tell: Readonly<{ id: string; text: string }>): Promise<TellSubmission> => {
      if (state.settled) return Promise.resolve({ kind: "turn-ended" });
      const message: PiNativeMessage = {
        role: "user",
        content: [{ type: "text", text: tell.text }],
        timestamp: new Date().getTime(),
      };
      const submission = tells.register(message, tell.id);
      try {
        agent.steer(message);
      } catch (error) {
        tells.fail(message, error);
      }
      return submission;
    },
  };
}

function piSessionFile(coordinate: ResumeCoordinate): string {
  if (!("sessionFile" in coordinate)) throw new Error("Pi requires sessionFile");
  return coordinate.sessionFile;
}

async function forkPi(sdk: PiSdk, input: Parameters<NonNullable<ProviderAdapter["fork"]>>[0]) {
  const sessionFile = piSessionFile(input.session);
  const manager = sdk.SessionManager.open(sessionFile);
  const child = manager.createBranchedSession(input.at);
  if (child === undefined || child === sessionFile)
    throw new Error("Pi fork did not create a distinct child session file");
  return { session: { sessionFile: child } };
}

async function loadPiSdk(): Promise<PiSdk> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  return {
    createAgentSessionFromServices: sdk.createAgentSessionFromServices,
    createAgentSessionServices: sdk.createAgentSessionServices,
    createBashToolDefinition: sdk.createBashToolDefinition,
    getAgentDir: sdk.getAgentDir,
    SessionManager: sdk.SessionManager,
  };
}

export function createPiProvider(
  execution: ProviderExecution = { name: "pi", kind: "pi" },
  load: () => Promise<PiSdk> = loadPiSdk,
): ProviderAdapter {
  if (execution.executable !== undefined) throw new TypeError("Pi provider does not support executable");
  if (execution.env !== undefined && Object.keys(execution.env).length > 0) {
    throw new TypeError("env injection not supported for provider pi");
  }
  const drive = async (input: PiDriveInput, custody: AttemptCustody): Promise<Session> => {
    custody.signal.throwIfAborted();
    const sdk = await abortable(load(), custody.signal);
    custody.signal.throwIfAborted();
    return await drivePi(sdk, execution, { ...input, signal: custody.signal }, custody.signal, custody);
  };
  return {
    admitOptions: admitPiOptions,
    start: (input) => createProviderAttempt(input.signal, async (custody) => await drive(input, custody)),
    resume: (input) =>
      createProviderAttempt(input.signal, async (custody) => {
        piSessionFile(input.session.coordinate);
        return await drive(input, custody);
      }),
    fork: (input) =>
      createProviderAttempt(new AbortController().signal, async () => {
        piSessionFile(input.session);
        return await forkPi(await load(), input);
      }),
  };
}
