import { randomUUID } from "node:crypto";
import { abortable } from "../../abort.js";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AKUMA_REQUESTS_ENV,
  AgentEventChannel,
  type ProviderAdapter,
  type Session,
  type TellReceipt,
  type TurnResult,
} from "../../provider.js";
import type { ProviderOptions } from "../../provider-recipe.js";
import {
  emitClaudeMessage,
  type ClaudeObservationState,
} from "./events.js";
import { claudeUserMessage, createClaudeInput, isClaudeTurnEnded, type ClaudeInput } from "./input.js";
import type { ResumeCoordinate } from "../../provider.js";

export { CLAUDE_MESSAGE_DISPOSITIONS, CLAUDE_SYSTEM_DISPOSITIONS } from "./events.js";

type ClaudeExecution = Readonly<{ executable?: string; env?: Readonly<Record<string, string>> }>;
type ClaudeDriveInput = Parameters<ProviderAdapter["start"]>[0]
  | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];
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
    cwd: input.cwd,
    abortController,
    ...(input.requests === undefined ? {} : { additionalDirectories: [input.requests.dir] }),
    ...(execution.executable === undefined ? {} : { pathToClaudeCodeExecutable: execution.executable }),
    ...((execution.env === undefined && input.requests === undefined) ? {} : { env: {
      ...process.env,
      ...execution.env,
      ...(input.requests === undefined ? {} : { [AKUMA_REQUESTS_ENV]: input.requests.dir }),
    } }),
    permissionMode: mode,
    ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    settingSources: ["user", "project", "local"],
    ...(input.options.model === undefined ? {} : { model: input.options.model }),
    ...(input.options.effort === undefined ? {} : { effort: input.options.effort as NonNullable<Options["effort"]> }),
    ...(input.options.systemPrompt === undefined || input.options.systemPrompt.length === 0 ? {} : {
      systemPrompt: { type: "preset", preset: "claude_code", append: input.options.systemPrompt },
    }),
    ...(input.session.kind === "fresh" ? {} : { resume: claudeSessionId(input.session.coordinate) }),
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
  return [input.body, ...input.launchTells.map((tell) => tell.text)]
    .filter((part) => part.length > 0).join("\n\n");
}

type Observation = Readonly<{
  admission: Promise<void>;
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

function observeClaudeQuery(context: ObserveInput): Observation {
  const { query, input, events, receipts, accepted, state } = context;
  const observation: ClaudeObservationState = { tools: new Map() };
  let admit!: () => void;
  let rejectAdmission!: (error: Error) => void;
  const admission = new Promise<void>((resolve, reject) => { admit = resolve; rejectAdmission = reject; });
  let settle!: (result: TurnResult) => void;
  const completion = new Promise<TurnResult>((resolve) => { settle = resolve; });
  let checkpoint = 0, ended = false;

  const settleReceipts = (): void => {
    if (ended && state.openSubmissions === 0 && accepted.every((tell) => tell.visible)) receipts.end();
  };
  const flushReceipts = (): void => {
    for (let index = 0; index < accepted.length;) {
      const tell = accepted[index]!;
      if (!tell.visible || tell.afterCheckpoint >= checkpoint) {
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

  void (async () => {
    let admitted = false;
    let terminal: TurnResult | null = null;
    let historyId: string | undefined;
    try {
      for await (const message of query) {
        if (!admitted && "session_id" in message && typeof message.session_id === "string") {
          admitted = true;
          events.emit({ type: "session", coordinate: { sessionId: message.session_id } });
          admit();
        }
        emitClaudeMessage(message, events, observation);
        if (message.type === "assistant" && message.parent_tool_use_id === null
          && typeof message.uuid === "string" && message.uuid.length > 0) historyId = message.uuid;
        if (message.type !== "result") continue;
        if (message.subtype === "success") {
          terminal = successfulResult(message, historyId);
          checkpoint += 1;
          flushReceipts();
          queueMicrotask(closeWhenIdle);
        } else {
          terminal = { kind: "failed", diagnostic: message.errors.join("; ") || message.subtype };
          input.close();
        }
      }
      ended = true;
      const result = terminal ?? { kind: "failed" as const, diagnostic: "Claude query ended without a result" };
      if (!admitted) rejectAdmission(new Error(
        result.kind === "failed" ? result.diagnostic : "Claude query ended before session admission",
      ));
      settle(result);
    } catch (error) {
      ended = true;
      input.fail(error);
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!admitted) rejectAdmission(failure);
      settle({ kind: "failed", diagnostic: failure.message });
    } finally {
      finishClaudeInput(input, terminal);
      events.end();
      settleReceipts();
    }
  })();

  return {
    admission,
    completion,
    get ended() { return ended; },
    get checkpoint() { return checkpoint; },
    flushReceipts,
    settleReceipts,
  };
}

async function driveClaude(
  load: () => Promise<ClaudeSdk>,
  execution: ClaudeExecution,
  drive: ClaudeDriveInput,
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
  let submission = 0;
  let openSubmissions = 0;
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
  const abortSetup = () => shutDown(signal.reason);
  signal.addEventListener("abort", abortSetup, { once: true });
  const observed = observeClaudeQuery({
    query, input, events, receipts, accepted,
    state: { get openSubmissions() { return openSubmissions; } },
  });
  try { await Promise.all([launchAcknowledged, observed.admission]); }
  finally { signal.removeEventListener("abort", abortSetup); }

  return {
    admission: { fence: `claude:${run}:0` },
    events,
    receipts,
    completion: observed.completion,
    tell(tell) {
      if (observed.ended || input.closed) return Promise.resolve({ kind: "turn-ended" });
      openSubmissions += 1;
      const ordinal = ++submission;
      return new Promise((resolve, reject) => {
        const pending: AcceptedTell = { id: tell.id, afterCheckpoint: 0, visible: false };
        void input.push(claudeUserMessage(tell.text), () => {
          pending.afterCheckpoint = observed.checkpoint;
          accepted.push(pending);
        }).then(() => {
          openSubmissions -= 1;
          resolve({ kind: "accepted", fence: `claude:${run}:${ordinal}` });
          queueMicrotask(() => {
            pending.visible = true;
            observed.flushReceipts();
            observed.settleReceipts();
          });
        }, (error) => {
          openSubmissions -= 1;
          if (isClaudeTurnEnded(error)) resolve({ kind: "turn-ended" });
          else reject(error);
          observed.settleReceipts();
        });
      });
    },
    async abort(): Promise<void> {
      shutDown(new Error("Claude query aborted"));
    },
  };
}

export function createClaudeProvider(
  load: () => Promise<ClaudeSdk>,
  execution: ClaudeExecution = {},
): ProviderAdapter {
  return {
    admitOptions: admitClaudeOptions,
    fork: (input) => forkClaude(load, execution, input),
    start: (input) => driveClaude(load, execution, input),
    resume: (input) => driveClaude(load, execution, input),
  };
}

export const claudeProvider = createClaudeProvider(async () =>
  await import("@anthropic-ai/claude-agent-sdk") as ClaudeSdk);
