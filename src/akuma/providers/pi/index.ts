import {
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { abortable } from "../../abort.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import type { ResumeCoordinate } from "../../coordinate.js";
import {
  AKUMA_REQUESTS_ENV,
  AgentEventChannel,
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

function diagnostic(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function admitPiOptions(options: ProviderOptions): ReturnType<ProviderAdapter["admitOptions"]> {
  if (options.network !== undefined) return { kind: "refused", diagnostic: "Pi provider does not support the network option" };
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
  const resourceLoader = input.options.systemPrompt === undefined ? undefined : new sdk.DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: sdk.getAgentDir(),
    systemPromptOverride: () => input.options.systemPrompt,
  });
  await resourceLoader?.reload();
  const sessionManager = input.session.kind === "fresh"
    ? sdk.SessionManager.create(input.cwd)
    : "sessionFile" in input.session.coordinate
      ? sdk.SessionManager.open(input.session.coordinate.sessionFile)
      : (() => { throw new Error("Pi resume requires sessionFile"); })();
  return {
    cwd: input.cwd,
    sessionManager,
    ...(model === undefined || modelRuntime === undefined ? {} : { model, modelRuntime }),
    ...(resourceLoader === undefined ? {} : { resourceLoader }),
    ...(input.options.effort === undefined ? {} : { thinkingLevel: input.options.effort as PiThinkingLevel }),
    ...(input.options.readonly === undefined ? {} : { tools: ["read", "grep", "find", "ls"] }),
    ...(input.requests === undefined || input.options.readonly === true
      ? {}
      : { customTools: [createBashToolDefinition(input.cwd, {
          spawnHook: (context) => ({
            ...context,
            env: { ...context.env, [AKUMA_REQUESTS_ENV]: input.requests.dir },
          }),
        }) as NonNullable<CreateAgentSessionOptions["customTools"]>[number]] }),
  };
}

type PiDriveInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

type PiCreatedSession = Awaited<ReturnType<PiSdk["createAgentSession"]>>;

async function createPiSession(sdk: PiSdk, input: PiDriveInput, signal: AbortSignal): Promise<PiCreatedSession> {
  const setup = piCreateOptions(sdk, input).then(async (options) => await sdk.createAgentSession(options));
  return await abortable(setup, signal, (created) => created.session.dispose());
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

async function drivePi(sdk: PiSdk, input: PiDriveInput, signal: AbortSignal): Promise<Session> {
  const created = await createPiSession(sdk, input, signal);
  const native = created.session;
  if (signal.aborted) {
    native.dispose();
    signal.throwIfAborted();
  }
  if (native.sessionFile === undefined || native.sessionFile.trim().length === 0) {
    native.dispose();
    throw new Error("Pi session admitted without sessionFile");
  }
  const events = new AgentEventChannel();
  const state: PiEventState = { answer: "", assistantSeen: false, tools: new Map() };
  let terminalFailure: string | null = null;
  let disposed = false;
  let abortRequest: Promise<void> | undefined;
  let aborting = false;
  let settled = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try { unsubscribe(); } finally {
      try { native.dispose(); } finally { events.end(); }
    }
  };
  const unsubscribe = native.subscribe((event) => {
    if (event.type === "agent_end" && !event.willRetry) terminalFailure = piTerminalFailure(event.messages);
    for (const translated of translatePiEvent(event, state)) events.emit(translated);
  });
  events.emit({ type: "session", coordinate: { sessionFile: native.sessionFile, sessionId: native.sessionId } });
  let settleCompletion!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => { settleCompletion = resolve; });
  const settle = (result: TurnResult): void => {
    if (settled) return;
    settled = true;
    dispose();
    settleCompletion(result);
  };
  void (async () => {
    try {
      await native.prompt([input.body, ...input.launchTells.map((tell) => tell.text)].join("\n\n"));
      if (aborting) {
        settle({ kind: "failed", diagnostic: "Pi session aborted" });
        return;
      }
      if (terminalFailure !== null) {
        settle({ kind: "failed", diagnostic: terminalFailure });
        return;
      }
      if (!state.assistantSeen) {
        settle({ kind: "failed", diagnostic: "Pi completed without a native assistant answer" });
        return;
      }
      const historyId = native.sessionManager.getLeafId();
      settle({
        kind: "answered",
        answer: state.answer,
        ...(historyId === null ? {} : { historyId }),
      });
    } catch (error) {
      settle(aborting
        ? { kind: "failed", diagnostic: "Pi session aborted" }
        : { kind: "failed", diagnostic: diagnostic(error) });
    }
  })();
  return {
    admission: { fence: native.sessionId }, events, completion,
    abort: () => {
      abortRequest ??= (async () => {
        if (settled) return;
        aborting = true;
        try { await native.abort(); } catch { /* prompt settlement still proves local cleanup */ }
        settle({ kind: "failed", diagnostic: "Pi session aborted" });
      })();
      return abortRequest;
    },
    forceDispose: () => forceDisposePi(dispose, settle, () => { aborting = true; }),
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
  if (child === undefined || child === sessionFile) throw new Error("Pi fork did not create a distinct child session file");
  return { session: { sessionFile: child } };
}

const defaultSdk: PiSdk = { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager };

export function createPiProvider(
  execution: ProviderExecution = { name: "pi", kind: "pi" },
  load: () => Promise<PiSdk> = async () => defaultSdk,
): ProviderAdapter {
  if (execution.executable !== undefined || execution.config !== undefined) {
    throw new TypeError("Pi provider does not support executable or config");
  }
  if (execution.env !== undefined && Object.keys(execution.env).length > 0) {
    throw new TypeError("env injection not supported for provider pi");
  }
  const drive = async (input: PiDriveInput): Promise<Session> => {
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    return drivePi(await abortable(load(), signal), input, signal);
  };
  return {
    admitOptions: admitPiOptions,
    start: drive,
    resume: async (input) => {
      piSessionFile(input.session.coordinate);
      return drive(input);
    },
    fork: async (input) => {
      piSessionFile(input.session);
      return forkPi(await load(), input);
    },
  };
}
