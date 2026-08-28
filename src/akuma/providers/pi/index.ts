import type {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

/* eslint-disable max-lines-per-function -- Native Pi setup and disposal share one custody boundary. */
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import type { ResumeCoordinate } from "../../coordinate.js";
import { abortable } from "../../abort.js";
import {
  AKUMA_REQUESTS_ENV,
  AgentEventChannel,
  createProviderAttempt,
  type AttemptCustody,
  type ProviderAdapter,
  type Session,
  type TurnResult,
} from "../../provider.js";
import { piTerminalFailure, translatePiEvent, type PiEventState } from "./events.js";

export type PiSdk = Readonly<{
  createAgentSession(options?: CreateAgentSessionOptions): ReturnType<typeof createAgentSession>;
  DefaultResourceLoader: typeof DefaultResourceLoader;
  getAgentDir: typeof getAgentDir;
  ModelRuntime: typeof ModelRuntime;
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
    ...(options.readonly === undefined ? {} : { readonly: { enforcement: "native" as const } }),
  };
}

async function piCreateOptions(sdk: PiSdk, input: PiDriveInput): Promise<CreateAgentSessionOptions> {
  let model: CreateAgentSessionOptions["model"];
  let modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>> | undefined;
  if (input.options.model !== undefined) {
    const slash = input.options.model.indexOf("/");
    modelRuntime = await sdk.ModelRuntime.create();
    model = modelRuntime.getModel(input.options.model.slice(0, slash), input.options.model.slice(slash + 1));
    if (model === undefined) throw new Error(`Pi model '${input.options.model}' is unavailable`);
  }
  const resourceLoader =
    input.options.systemPrompt === undefined
      ? undefined
      : new sdk.DefaultResourceLoader({
          cwd: input.cwd,
          agentDir: sdk.getAgentDir(),
          ...(input.options.systemPromptMode === "append"
            ? { appendSystemPromptOverride: (base: string[]) => [...base, input.options.systemPrompt!] }
            : { systemPromptOverride: () => input.options.systemPrompt }),
        });
  await resourceLoader?.reload();
  const sessionManager =
    input.session.kind === "fresh"
      ? sdk.SessionManager.create(input.cwd)
      : "sessionFile" in input.session.coordinate
        ? sdk.SessionManager.open(input.session.coordinate.sessionFile)
        : (() => {
            throw new Error("Pi resume requires sessionFile");
          })();
  const customTools =
    input.requests === undefined || input.options.readonly === true
      ? undefined
      : [
          (await import("@earendil-works/pi-coding-agent")).createBashToolDefinition(input.cwd, {
            spawnHook: (context) => ({
              ...context,
              env: { ...context.env, [AKUMA_REQUESTS_ENV]: input.requests.dir },
            }),
          }) as NonNullable<CreateAgentSessionOptions["customTools"]>[number],
        ];
  return {
    cwd: input.cwd,
    sessionManager,
    ...(model === undefined || modelRuntime === undefined ? {} : { model, modelRuntime }),
    ...(resourceLoader === undefined ? {} : { resourceLoader }),
    ...(input.options.effort === undefined ? {} : { thinkingLevel: input.options.effort as PiThinkingLevel }),
    ...(input.options.readonly === undefined ? {} : { tools: ["read", "grep", "find", "ls"] }),
    ...(customTools === undefined ? {} : { customTools }),
  };
}

type PiDriveInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

type PiCreatedSession = Awaited<ReturnType<PiSdk["createAgentSession"]>>;
type PiNativeSession = PiCreatedSession["session"];
type PiDriveState = {
  terminalFailure: string | null;
  disposed: boolean;
  abortRequest?: Promise<void>;
  aborting: boolean;
  settled: boolean;
};

async function createPiSession(
  sdk: PiSdk,
  execution: ProviderExecution,
  input: PiDriveInput,
  signal: AbortSignal,
): Promise<PiCreatedSession> {
  const setup = piCreateOptions(sdk, input).then(async (options) => {
    if (execution.config !== undefined) {
      throw new TypeError("Pi provider config cannot be consumed by native CreateAgentSessionOptions");
    }
    return await sdk.createAgentSession(options);
  });
  const created = await setup;
  if (signal.aborted) {
    await created.session.dispose();
    signal.throwIfAborted();
  }
  return created;
}

function forceDisposePi(
  dispose: () => void,
  settle: (result: TurnResult) => void,
  setAborting: () => void,
): Promise<void> {
  setAborting();
  dispose();
  settle({ kind: "failed", diagnostic: "Pi session force-disposed" });
  return Promise.resolve();
}

async function runPiPrompt(
  native: PiNativeSession,
  input: PiDriveInput,
  events: PiEventState,
  state: PiDriveState,
  settle: (result: TurnResult) => void,
): Promise<void> {
  try {
    await native.prompt([input.body, ...input.launchTells.map((tell) => tell.text)].join("\n\n"));
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

async function drivePi(
  sdk: PiSdk,
  execution: ProviderExecution,
  input: PiDriveInput,
  signal: AbortSignal,
  custody?: AttemptCustody,
): Promise<Session> {
  const created = await createPiSession(sdk, execution, input, signal);
  const native = created.session;
  let retired = false;
  let settleRetired!: () => void;
  const closed = new Promise<void>((resolve) => {
    settleRetired = resolve;
  });
  custody?.own({
    closed,
    abort: async () => {
      native.dispose();
      retired = true;
      settleRetired();
    },
    forceDispose: async () => {
      native.dispose();
      retired = true;
      settleRetired();
    },
  });
  if (signal.aborted) {
    native.dispose();
    signal.throwIfAborted();
  }
  if (native.sessionFile === undefined || native.sessionFile.trim().length === 0) {
    native.dispose();
    throw new Error("Pi session admitted without sessionFile");
  }
  const events = new AgentEventChannel();
  const eventState: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
  const state: PiDriveState = {
    terminalFailure: null,
    disposed: false,
    aborting: false,
    settled: false,
  };
  const dispose = (): void => {
    if (state.disposed) return;
    state.disposed = true;
    try {
      unsubscribe();
    } finally {
      try {
        native.dispose();
        if (!retired) {
          retired = true;
          settleRetired();
        }
      } finally {
        events.end();
      }
    }
  };
  const unsubscribe = native.subscribe((event) => {
    if (event.type === "agent_end" && !event.willRetry) state.terminalFailure = piTerminalFailure(event.messages);
    for (const translated of translatePiEvent(event, eventState)) events.emit(translated);
  });
  events.emit({ type: "session", coordinate: { sessionFile: native.sessionFile, sessionId: native.sessionId } });
  let settleCompletion!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => {
    settleCompletion = resolve;
  });
  const settle = (result: TurnResult): void => {
    if (state.settled) return;
    state.settled = true;
    dispose();
    settleCompletion(result);
  };
  void runPiPrompt(native, input, eventState, state, settle);
  return {
    admission: { fence: native.sessionId },
    events,
    completion,
    abort: () => {
      state.abortRequest ??= (async () => {
        if (state.settled) return;
        state.aborting = true;
        try {
          await native.abort();
        } catch {
          /* prompt settlement still proves local cleanup */
        }
        settle({ kind: "failed", diagnostic: "Pi session aborted" });
      })();
      return state.abortRequest;
    },
    forceDispose: () =>
      forceDisposePi(dispose, settle, () => {
        state.aborting = true;
      }),
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
    createAgentSession: sdk.createAgentSession,
    DefaultResourceLoader: sdk.DefaultResourceLoader,
    getAgentDir: sdk.getAgentDir,
    ModelRuntime: sdk.ModelRuntime,
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
