import { KeiyakuError } from "../../../errors.js";
import type {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashToolDefinition,
  getAgentDir,
  SessionManager,
  CreateAgentSessionOptions,
  CreateAgentSessionFromServicesOptions,
  AgentSessionServices,
  createEventBus,
  LoadExtensionsResult,
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
  noteEvent,
  tellRegistry,
  type AttemptCustody,
  type ProviderAdapter,
  type Session,
  type TellSubmission,
  type TurnResult,
} from "../../provider.js";
import { providerLifecycle } from "../lifecycle.js";
import { ToolObservations } from "../tool-observations.js";
import { providerTurn } from "../turn.js";
import { piSessionModel, piTerminalFailure, translatePiEvent, type PiEventState } from "./events.js";

export type PiSdk = Readonly<{
  createAgentSessionFromServices: typeof createAgentSessionFromServices;
  createAgentSessionServices: typeof createAgentSessionServices;
  createBashToolDefinition: typeof createBashToolDefinition;
  createEventBus: typeof createEventBus;
  getAgentDir: typeof getAgentDir;
  SessionManager: typeof SessionManager;
}>;

type PiThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
const PI_THINKING_LEVELS = new Set<PiThinkingLevel>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_PATTERN = /^[^/\s]+\/[^\s]+$/u;

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
  const customTools = [
    sdk.createBashToolDefinition(input.cwd, {
      spawnHook: (context) => ({
        ...context,
        env: akumaExecutionEnvironment(context.env, {}, ["PI_SESSION_ID", "PI_SESSION_FILE"], input.execution),
      }),
    }) as NonNullable<CreateAgentSessionOptions["customTools"]>[number],
  ];
  return {
    services,
    sessionManager,
    ...(model === undefined ? {} : { model }),
    ...(input.options.effort === undefined ? {} : { thinkingLevel: input.options.effort as PiThinkingLevel }),
    customTools,
  };
}

type PiDriveInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

type PiCreatedSession = Awaited<ReturnType<PiSdk["createAgentSessionFromServices"]>>;
type PiSessionSetup = Readonly<{
  created: PiCreatedSession;
  extensionErrors: readonly LoadExtensionsResult["errors"][number][];
  stopActorRequests(): void;
}>;
type PiNativeSession = PiCreatedSession["session"];
type PiNativeMessage = Parameters<PiNativeSession["agent"]["steer"]>[0];
async function createPiSession(sdk: PiSdk, execution: ProviderExecution, input: PiDriveInput): Promise<PiSessionSetup> {
  if (execution.config !== undefined) {
    throw new KeiyakuError(
      "invalid-input",
      "Pi provider config cannot be consumed by native CreateAgentSessionOptions",
    );
  }
  const personality = input.options.systemPrompt;
  const append = [
    ...(input.options.systemPromptMode === "append" && personality !== undefined ? [personality] : []),
    ...(input.runtimeInstructions === undefined ? [] : [input.runtimeInstructions]),
  ];
  const eventBus = sdk.createEventBus();
  const coordinate = input.execution;
  const stopActorRequests = eventBus.on("keiyaku:actor:request", (request: unknown) => {
    if (
      coordinate !== undefined &&
      typeof request === "object" &&
      request !== null &&
      "reply" in request &&
      typeof request.reply === "function"
    )
      request.reply({ world: coordinate.world, akuId: coordinate.akumaId });
  });
  let services: AgentSessionServices | undefined;
  try {
    services = await sdk.createAgentSessionServices({
      cwd: input.cwd,
      agentDir: sdk.getAgentDir(),
      modelRuntimeSignal: input.signal,
      resourceLoaderOptions: {
        eventBus,
        ...(personality === undefined || input.options.systemPromptMode === "append"
          ? {}
          : { systemPromptOverride: () => personality }),
        appendSystemPromptOverride: (base: string[]) => [...base, ...append],
      },
    });
    const extensionErrors = services.resourceLoader.getExtensions().errors ?? [];
    for (const failure of extensionErrors) console.error(`Pi extension load failed: ${failure.path}\n${failure.error}`);
    input.signal?.throwIfAborted();
    const created = await sdk.createAgentSessionFromServices(piCreateOptions(sdk, input, services));
    return { created, extensionErrors, stopActorRequests };
  } catch (error) {
    stopActorRequests();
    // Before a session owns the extension runtime, failed selection/setup must
    // retire registrations and event-bus subscriptions loaded by the services.
    services?.resourceLoader.getExtensions().runtime.invalidate();
    throw error;
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
  custody: AttemptCustody,
): Promise<Session> {
  const { signal } = custody;
  const { created, extensionErrors, stopActorRequests } = await createPiSession(sdk, execution, input);
  const { session: native } = created;
  const { agent } = native;
  const events = new AgentEventChannel();
  const emit = events.emit.bind(events);
  const eventState: PiEventState = { answer: "", assistantSeen: false, tools: new ToolObservations(emit) };
  const tells = tellRegistry<PiNativeMessage>((id) => `${native.sessionId}:${id}`);
  const subscriptions: Array<() => void> = [];
  let terminalFailure: string | null = null;
  let aborting: Promise<void> | undefined;
  let cleanupFailure: unknown;
  let binding: Promise<void> | undefined;
  let prompting: Promise<void> | undefined;
  let retainRetirement!: (operation: Promise<void>) => void;
  const retired = new Promise<void>((resolve) => {
    retainRetirement = resolve;
  });
  const turn = providerTurn(events, () => {
    tells.end();
    for (const unsubscribe of subscriptions) {
      try {
        unsubscribe();
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
  });
  const retire = async (): Promise<void> => {
    // Binding may acquire extension resources; dispose only requests abort of
    // outstanding tool work. Both binding and the prompt itself must retire.
    await binding?.catch(() => undefined);
    try {
      await retirePiSession(native);
    } finally {
      stopActorRequests();
      await prompting;
    }
    await aborting;
    if (cleanupFailure !== undefined) throw cleanupFailure;
  };
  const finish = (result: TurnResult): void => {
    if (turn.finish(result)) retainRetirement(retire());
  };
  const fail = (error: unknown): void => {
    if (turn.fail(error)) retainRetirement(retire());
  };
  const aborted: TurnResult = { kind: "failed", diagnostic: "Pi session aborted" };
  custody.own({
    closed: retired,
    async abort() {
      if (!turn.terminal) {
        aborting = Promise.resolve().then(() => native.abort());
        await aborting.catch(() => undefined);
        finish(aborted);
      }
      await retired;
    },
    forceDispose() {
      finish({ kind: "failed", diagnostic: "Pi session force-disposed" });
      return retired;
    },
  });
  try {
    // Deliver every queued Tell at the next native boundary, not one per Turn.
    agent.steeringMode = "all";
    subscriptions.push(
      agent.subscribe((event) => {
        if (!turn.terminal && event.type === "message_end") tells.accept(event.message);
      }),
    );
    subscriptions.push(
      native.subscribe((event) => {
        if (turn.terminal) return;
        if (event.type === "agent_end" && !event.willRetry) terminalFailure = piTerminalFailure(event.messages);
        translatePiEvent(event, eventState, emit);
      }),
    );
    signal.throwIfAborted();
    if (native.sessionFile === undefined || native.sessionFile.trim().length === 0)
      throw new Error("Pi session admitted without sessionFile");
    binding = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return native.bindExtensions({});
    });
    await abortable(binding, signal);
    signal.throwIfAborted();
    events.emit({ type: "session", coordinate: { sessionFile: native.sessionFile, sessionId: native.sessionId } });
    for (const failure of extensionErrors) {
      events.emit(noteEvent(`Pi extension load failed: ${failure.path}: ${failure.error}`));
    }
    const sessionModel = piSessionModel(native.model);
    if (sessionModel !== undefined) events.emit(modelEvent(sessionModel));
  } catch (error) {
    fail(error);
    throw error;
  }
  prompting = Promise.resolve().then(async () => {
    if (signal.aborted || turn.terminal) return;
    try {
      await native.prompt(launchPrompt(input.launchTells, input.schemaJson));
      if (turn.terminal) return;
      if (aborting) return finish(aborted);
      if (terminalFailure !== null) return finish({ kind: "failed", diagnostic: terminalFailure });
      if (!eventState.assistantSeen)
        return finish({ kind: "failed", diagnostic: "Pi completed without a native assistant answer" });
      const historyId = native.sessionManager.getLeafId();
      finish({ kind: "answered", answer: eventState.answer, ...(historyId === null ? {} : { historyId }) });
    } catch (error) {
      if (aborting) finish(aborted);
      else fail(error);
    }
  });
  return {
    admission: { fence: native.sessionId },
    events,
    completion: turn.completion,
    tell: (tell: Readonly<{ id: string; text: string }>): Promise<TellSubmission> => {
      if (turn.terminal) return Promise.resolve({ kind: "turn-ended" });
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
    createEventBus: sdk.createEventBus,
    getAgentDir: sdk.getAgentDir,
    SessionManager: sdk.SessionManager,
  };
}

export function createPiProvider(
  execution: ProviderExecution = { name: "pi", kind: "pi" },
  load: () => Promise<PiSdk> = loadPiSdk,
): ProviderAdapter {
  if (execution.executable !== undefined)
    throw new KeiyakuError("invalid-input", "Pi provider does not support executable");
  if (execution.env !== undefined && Object.keys(execution.env).length > 0) {
    throw new KeiyakuError("invalid-input", "env injection not supported for provider pi");
  }
  return {
    admitOptions: admitPiOptions,
    ...providerLifecycle(async (input, custody) => {
      if (input.session.kind === "resume") piSessionFile(input.session.coordinate);
      custody.signal.throwIfAborted();
      const sdk = await abortable(load(), custody.signal);
      custody.signal.throwIfAborted();
      return await drivePi(sdk, execution, input, custody);
    }),
    fork: (input) =>
      createProviderAttempt(new AbortController().signal, async () => {
        piSessionFile(input.session);
        return await forkPi(await load(), input);
      }),
  };
}
