import { randomUUID } from "node:crypto";
import { abortable } from "../../abort.js";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AKUMA_REQUESTS_ENV,
  AgentEventChannel,
  createProviderAttempt,
  type AttemptCustody,
  type ProviderAdapter,
  type Session,
  type TellReceipt,
  type TurnResult,
} from "../../provider.js";
import type { ProviderOptions } from "../../provider-recipe.js";
import { emitClaudeMessage, type ClaudeObservationState } from "./events.js";
import { claudeUserMessage, createClaudeInput, isClaudeTurnEnded, type ClaudeInput } from "./input.js";
import type { ResumeCoordinate } from "../../provider.js";

export { CLAUDE_MESSAGE_DISPOSITIONS, CLAUDE_SYSTEM_DISPOSITIONS } from "./events.js";

type ClaudeExecution = Readonly<{
  executable?: string;
  config?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, string>>;
}>;
type ClaudeDriveInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
type ReceiptWaiter = Readonly<{ resolve(value: IteratorResult<TellReceipt>): void }>;
type AcceptedTell = { id: string; afterCheckpoint: number; visible: boolean };

export type ClaudeSdk = Readonly<{
  query(input: Readonly<{ prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }>): Query;
  forkSession?(
    sessionId: string,
    options: Readonly<{ dir: string; upToMessageId: string }>,
  ): Promise<Readonly<{ sessionId: string }>>;
}>;

class ReceiptChannel implements AsyncIterable<TellReceipt> {
  private readonly queued: TellReceipt[] = [];
  private readonly waiters: ReceiptWaiter[] = [];
  private ended = false;

  emit(receipt: TellReceipt): void {
    if (this.ended) throw new Error("Claude receipt stream already ended");
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.queued.push(receipt);
    else waiter.resolve({ done: false, value: receipt });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<TellReceipt> {
    return {
      next: () => {
        const receipt = this.queued.shift();
        if (receipt !== undefined) return Promise.resolve({ done: false, value: receipt });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push({ resolve }));
      },
    };
  }
}

function admitClaudeOptions(options: ProviderOptions): ReturnType<ProviderAdapter["admitOptions"]> {
  if (options.network !== undefined) {
    return { kind: "refused", diagnostic: "Claude provider does not support the network option" };
  }
  return {
    kind: "admitted",
    options: Object.freeze({ ...options }),
    ...(options.readonly === undefined ? {} : { readonly: { enforcement: "native" as const } }),
  };
}

function permissionMode(readonly: ProviderOptions["readonly"]): "plan" | "bypassPermissions" {
  return readonly === true ? "plan" : "bypassPermissions";
}

function claudeSessionId(coordinate: ResumeCoordinate): string {
  if (!("sessionId" in coordinate) || coordinate.sessionId === undefined) {
    throw new Error("Claude resume requires sessionId");
  }
  return coordinate.sessionId;
}

function claudeQueryOptions(
  input: ClaudeDriveInput,
  execution: ClaudeExecution,
  abortController: AbortController,
): Options {
  const mode = permissionMode(input.options.readonly);
  return {
    ...(execution.config ?? {}),
    cwd: input.cwd,
    abortController,
    ...(input.requests === undefined ? {} : { additionalDirectories: [input.requests.dir] }),
    ...(execution.executable === undefined ? {} : { pathToClaudeCodeExecutable: execution.executable }),
    ...(execution.env === undefined && input.requests === undefined
      ? {}
      : {
          env: {
            ...process.env,
            ...execution.env,
            ...(input.requests === undefined ? {} : { [AKUMA_REQUESTS_ENV]: input.requests.dir }),
          },
        }),
    permissionMode: mode,
    ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    settingSources: ["user", "project", "local"],
    ...(input.options.model === undefined ? {} : { model: input.options.model }),
    ...(input.options.effort === undefined ? {} : { effort: input.options.effort as NonNullable<Options["effort"]> }),
    ...(input.options.systemPrompt === undefined || input.options.systemPrompt.length === 0
      ? {}
      : {
          systemPrompt:
            input.options.systemPromptMode === "replace"
              ? input.options.systemPrompt
              : { type: "preset", preset: "claude_code", append: input.options.systemPrompt },
        }),
    ...(input.session.kind === "fresh" ? {} : { resume: claudeSessionId(input.session.coordinate) }),
    ...(input.schemaJson === undefined
      ? {}
      : {
          outputFormat: {
            type: "json_schema" as const,
            schema: JSON.parse(input.schemaJson) as Record<string, unknown>,
          },
        }),
  };
}

async function forkClaude(
  load: () => Promise<ClaudeSdk>,
  execution: ClaudeExecution,
  input: Parameters<NonNullable<ProviderAdapter["fork"]>>[0],
): Promise<Readonly<{ session: { sessionId: string } }>> {
  const sessionId = claudeSessionId(input.session);
  if (execution.env !== undefined) throw new Error("Claude fork cannot apply the frozen provider environment");
  const sdk = await load();
  if (sdk.forkSession === undefined) throw new Error("Claude SDK does not expose forkSession");
  const forked = await sdk.forkSession(sessionId, { dir: input.cwd, upToMessageId: input.at });
  if (forked.sessionId.trim().length === 0) throw new Error("Claude fork returned an empty child session id");
  if (forked.sessionId === sessionId) throw new Error("Claude fork reused the source session id");
  return { session: { sessionId: forked.sessionId } };
}

function launchText(input: ClaudeDriveInput): string {
  return [input.body, ...input.launchTells.map((tell) => tell.text)].filter((part) => part.length > 0).join("\n\n");
}

type Observation = Readonly<{
  admission: Promise<void>;
  rejectAdmission(error: unknown): void;
  completion: Promise<TurnResult>;
  get ended(): boolean;
  get checkpoint(): number;
  flushReceipts(): void;
  settleReceipts(): void;
}>;

type ObserveInput = Readonly<{
  query: Query;
  input: ClaudeInput;
  events: AgentEventChannel;
  receipts: ReceiptChannel;
  accepted: AcceptedTell[];
  state: Readonly<{ get openSubmissions(): number }>;
}>;

type ClaudeObservationProgress = { checkpoint: number; ended: boolean };
type ClaudeReceiptControls = Readonly<{
  flushReceipts(): void;
  settleReceipts(): void;
  closeWhenIdle(): void;
}>;

function successfulResult(message: Extract<SDKMessage, { type: "result" }>, historyId?: string): TurnResult {
  return {
    kind: "answered",
    answer: message.subtype === "success" ? message.result : "",
    ...(historyId === undefined ? {} : { historyId }),
  };
}

function finishClaudeInput(input: ClaudeInput, terminal: TurnResult | null): void {
  if (terminal?.kind === "answered") input.end();
  else input.close();
}

type ConsumeClaudeContext = ObserveInput &
  Readonly<{
    observation: ClaudeObservationState;
    progress: ClaudeObservationProgress;
    admit: () => boolean;
    rejectAdmission: (error: unknown) => void;
    settle: (result: TurnResult) => void;
    controls: ClaudeReceiptControls;
  }>;

type ConsumeClaudeState = {
  admitted: boolean;
  terminal: TurnResult | null;
  historyId?: string;
};

function consumeClaudeMessage(context: ConsumeClaudeContext, state: ConsumeClaudeState, message: SDKMessage): void {
  const { input, events, observation, progress, admit, rejectAdmission, settle, controls } = context;
  if (state.terminal !== null) return;
  if (!state.admitted && "session_id" in message && typeof message.session_id === "string" && admit()) {
    state.admitted = true;
    events.emit({ type: "session", coordinate: { sessionId: message.session_id } });
  }
  emitClaudeMessage(message, events, observation);
  if (
    message.type === "assistant" &&
    message.parent_tool_use_id === null &&
    typeof message.uuid === "string" &&
    message.uuid.length > 0
  )
    state.historyId = message.uuid;
  if (message.type !== "result") return;
  if (message.subtype === "success") {
    state.terminal = successfulResult(message, state.historyId);
    progress.checkpoint += 1;
    controls.flushReceipts();
    queueMicrotask(controls.closeWhenIdle);
  } else {
    state.terminal = { kind: "failed", diagnostic: message.errors.join("; ") || message.subtype };
    input.close();
  }
  progress.ended = true;
  if (!state.admitted)
    rejectAdmission(
      new Error(
        state.terminal.kind === "failed" ? state.terminal.diagnostic : "Claude query ended before session admission",
      ),
    );
  finishClaudeInput(input, state.terminal);
  events.end();
  settle(state.terminal);
  controls.settleReceipts();
}

async function consumeClaudeQuery(context: ConsumeClaudeContext): Promise<void> {
  const { query, input, events, progress, rejectAdmission, settle, controls } = context;
  const state: ConsumeClaudeState = { admitted: false, terminal: null };
  try {
    for await (const message of query) consumeClaudeMessage(context, state, message);
    progress.ended = true;
    const result = state.terminal ?? { kind: "failed" as const, diagnostic: "Claude query ended without a result" };
    if (!state.admitted)
      rejectAdmission(
        new Error(result.kind === "failed" ? result.diagnostic : "Claude query ended before session admission"),
      );
    settle(result);
  } catch (error) {
    progress.ended = true;
    if (state.terminal !== null) return;
    input.fail(error);
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!state.admitted) rejectAdmission(failure);
    settle({ kind: "failed", diagnostic: failure.message });
  } finally {
    finishClaudeInput(input, state.terminal);
    events.end();
    controls.settleReceipts();
  }
}

type ClaudeDriveState = { submission: number; openSubmissions: number };

function claudeTell(
  input: ClaudeInput,
  observed: Observation,
  accepted: AcceptedTell[],
  state: ClaudeDriveState,
  run: string,
): NonNullable<Session["tell"]> {
  return (tell) => {
    if (observed.ended || input.closed) return Promise.resolve({ kind: "turn-ended" });
    state.openSubmissions += 1;
    const ordinal = ++state.submission;
    return new Promise((resolve, reject) => {
      const pending: AcceptedTell = { id: tell.id, afterCheckpoint: 0, visible: false };
      void input
        .push(claudeUserMessage(tell.text), () => {
          pending.afterCheckpoint = observed.checkpoint;
          accepted.push(pending);
        })
        .then(
          () => {
            state.openSubmissions -= 1;
            resolve({ kind: "accepted", fence: `claude:${run}:${ordinal}` });
            queueMicrotask(() => {
              pending.visible = true;
              observed.flushReceipts();
              observed.settleReceipts();
            });
          },
          (error) => {
            state.openSubmissions -= 1;
            if (isClaudeTurnEnded(error)) resolve({ kind: "turn-ended" });
            else reject(error);
            observed.settleReceipts();
          },
        );
    });
  };
}

function observeClaudeQuery(context: ObserveInput): Observation {
  const { input, receipts, accepted, state } = context;
  const observation: ClaudeObservationState = { tools: new Map() };
  let admit!: () => boolean;
  let rejectAdmission!: (error: unknown) => void;
  let admissionOpen = true;
  const admission = new Promise<void>((resolve, reject) => {
    admit = () => {
      if (!admissionOpen) return false;
      admissionOpen = false;
      resolve();
      return true;
    };
    rejectAdmission = (error) => {
      if (!admissionOpen) return;
      admissionOpen = false;
      reject(error);
    };
  });
  let settle!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => {
    settle = resolve;
  });
  const progress: ClaudeObservationProgress = { checkpoint: 0, ended: false };

  const settleReceipts = (): void => {
    if (progress.ended && state.openSubmissions === 0 && accepted.every((tell) => tell.visible)) receipts.end();
  };
  const flushReceipts = (): void => {
    for (let index = 0; index < accepted.length; ) {
      const tell = accepted[index]!;
      if (!tell.visible || tell.afterCheckpoint >= progress.checkpoint) {
        index += 1;
        continue;
      }
      accepted.splice(index, 1);
      receipts.emit({ evidence: "exact", tellId: tell.id, kind: "consumed" });
    }
    closeWhenIdle();
    settleReceipts();
  };
  const closeWhenIdle = (): void => {
    if (state.openSubmissions === 0 && accepted.length === 0 && input.pending === 0) input.close();
  };

  void consumeClaudeQuery({
    ...context,
    observation,
    progress,
    admit,
    rejectAdmission,
    settle,
    controls: { flushReceipts, settleReceipts, closeWhenIdle },
  });

  return {
    admission,
    rejectAdmission,
    completion,
    get ended() {
      return progress.ended;
    },
    get checkpoint() {
      return progress.checkpoint;
    },
    flushReceipts,
    settleReceipts,
  };
}

async function driveClaude(
  load: () => Promise<ClaudeSdk>,
  execution: ClaudeExecution,
  drive: ClaudeDriveInput,
  custody: AttemptCustody,
): Promise<Session> {
  if (drive.session.kind === "resume") claudeSessionId(drive.session.coordinate);
  const signal = drive.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const sdk = await abortable(load(), signal);
  signal.throwIfAborted();
  const events = new AgentEventChannel();
  const receipts = new ReceiptChannel();
  const input = createClaudeInput();
  const abortController = new AbortController();
  const run = randomUUID();
  const accepted: AcceptedTell[] = [];
  const driveState: ClaudeDriveState = { submission: 0, openSubmissions: 0 };
  const launchAcknowledged = input.push(claudeUserMessage(launchText(drive)));
  const query = sdk.query({
    prompt: input.iterable,
    options: claudeQueryOptions(drive, execution, abortController),
  });
  const shutDown = (error: unknown): void => {
    abortController.abort(error);
    input.fail(error);
    query.close();
  };
  let observed: Observation | undefined;
  const abortSetup = () => {
    shutDown(signal.reason);
    observed?.rejectAdmission(signal.reason);
  };
  signal.addEventListener("abort", abortSetup, { once: true });
  observed = observeClaudeQuery({
    query,
    input,
    events,
    receipts,
    accepted,
    state: {
      get openSubmissions() {
        return driveState.openSubmissions;
      },
    },
  });
  custody.own({
    closed: observed.completion.then(() => undefined),
    abort: async () => {
      shutDown(new Error("Claude query aborted"));
      await observed!.completion;
    },
    forceDispose: async () => {
      shutDown(new Error("Claude query force-disposed"));
      await observed!.completion;
    },
  });
  if (signal.aborted) abortSetup();
  try {
    await Promise.all([launchAcknowledged, observed.admission]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abortSetup);
  }

  return {
    admission: { fence: `claude:${run}:0` },
    events,
    receipts,
    completion: observed.completion,
    tell: claudeTell(input, observed, accepted, driveState, run),
    async abort(): Promise<void> {
      shutDown(new Error("Claude query aborted"));
      await observed.completion;
    },
    async forceDispose(): Promise<void> {
      shutDown(new Error("Claude query force-disposed"));
      await observed.completion;
    },
  };
}

export function createClaudeProvider(
  loadOrExecution: (() => Promise<ClaudeSdk>) | ClaudeExecution = async () =>
    (await import("@anthropic-ai/claude-agent-sdk")) as ClaudeSdk,
  execution: ClaudeExecution = {},
): ProviderAdapter {
  const load =
    typeof loadOrExecution === "function"
      ? loadOrExecution
      : async () => (await import("@anthropic-ai/claude-agent-sdk")) as ClaudeSdk;
  const selectedExecution = typeof loadOrExecution === "function" ? execution : loadOrExecution;
  return {
    admitOptions: admitClaudeOptions,
    fork: (input) =>
      createProviderAttempt(new AbortController().signal, async () => await forkClaude(load, selectedExecution, input)),
    start: (input) =>
      createProviderAttempt(
        input.signal,
        async (custody) => await driveClaude(load, selectedExecution, { ...input, signal: custody.signal }, custody),
      ),
    resume: (input) =>
      createProviderAttempt(
        input.signal,
        async (custody) => await driveClaude(load, selectedExecution, { ...input, signal: custody.signal }, custody),
      ),
  };
}

export const claudeProvider = createClaudeProvider(
  async () => (await import("@anthropic-ai/claude-agent-sdk")) as ClaudeSdk,
);
