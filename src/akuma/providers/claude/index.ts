import { randomUUID } from "node:crypto";
import spawn from "cross-spawn";
import { abortable } from "../../abort.js";
import type { Options, Query, SDKMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentEventChannel,
  createProviderAttempt,
  launchPrompt,
  type AttemptCustody,
  type ProviderAdapter,
  type ResumeCoordinate,
  type Session,
  type TurnResult,
} from "../../provider.js";
import { akumaExecutionEnvironment } from "../execution-environment.js";
import { providerLifecycle } from "../lifecycle.js";
import { providerTurn } from "../turn.js";
import type { ProviderOptions } from "../../provider-recipe.js";
import { emitClaudeMessage, type ClaudeObservationState } from "./events.js";
import { claudeUserMessage, createClaudeInput, isClaudeTurnEnded, type ClaudeInput } from "./input.js";

type ClaudeExecution = Readonly<{
  executable?: string;
  config?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, string>>;
}>;
type ClaudeDriveInput = Parameters<ProviderAdapter["start"]>[0] | Parameters<NonNullable<ProviderAdapter["resume"]>>[0];

type ClaudeSdk = Readonly<{
  query(input: Readonly<{ prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }>): Query;
  forkSession?(
    sessionId: string,
    options: Readonly<{ dir: string; upToMessageId: string }>,
  ): Promise<Readonly<{ sessionId: string }>>;
}>;

function admitClaudeOptions(options: ProviderOptions): ReturnType<ProviderAdapter["admitOptions"]> {
  if (options.network !== undefined) {
    return { kind: "refused", diagnostic: "Claude provider does not support the network option" };
  }
  return {
    kind: "admitted",
    options: Object.freeze({ ...options }),
  };
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
  const instructions = [input.options.systemPrompt, input.runtimeInstructions]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
  return {
    ...(execution.config ?? {}),
    cwd: input.cwd,
    abortController,
    ...(execution.executable === undefined ? {} : { pathToClaudeCodeExecutable: execution.executable }),
    env: akumaExecutionEnvironment(process.env, execution.env, [], input.execution),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["user", "project", "local"],
    ...(input.options.model === undefined ? {} : { model: input.options.model }),
    ...(input.options.effort === undefined ? {} : { effort: input.options.effort as NonNullable<Options["effort"]> }),
    ...(instructions.length === 0
      ? {}
      : {
          systemPrompt:
            input.options.systemPromptMode === "replace" && (input.options.systemPrompt?.length ?? 0) > 0
              ? instructions
              : { type: "preset", preset: "claude_code", append: instructions },
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

type ClaudeQueryEvidence = { nativeResult: boolean; stderr: string };

function claudeSpawn(
  options: Options,
  custody: AttemptCustody,
  evidence: ClaudeQueryEvidence,
): NonNullable<Options["spawnClaudeCodeProcess"]> {
  return (request) => {
    const { command, args, cwd, env, signal } = request;
    const custom = options.spawnClaudeCodeProcess;
    const local =
      custom === undefined ? spawn(command, args, { cwd, env, signal, stdio: "pipe", windowsHide: true }) : undefined;
    // The piped stdio above supplies the streams required by the native hook.
    const child = local === undefined ? custom!(request) : (local as SpawnedProcess);
    let failure: Error | undefined;
    let stderr = "";
    child.on("error", (error) => {
      if (evidence.nativeResult && (!signal.aborted || error.name !== "AbortError")) failure ??= error;
      evidence.stderr = (evidence.stderr + error.message).slice(-4_000);
    });
    local?.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
      evidence.stderr = (evidence.stderr + chunk).slice(-4_000);
      options.stderr?.(chunk);
    });
    let departed = false;
    let exitedAfterResult = false;
    let forced = false;
    const closed = new Promise<void>((resolve, reject) => {
      const confirm = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        if (failure !== undefined) return reject(failure);
        const expectedSignal = (exitSignal === "SIGKILL" && forced) || (exitSignal === "SIGTERM" && signal.aborted);
        if (exitedAfterResult && code !== 0 && !expectedSignal) {
          const status = code === null ? (exitSignal ?? "unknown status") : `code ${code}`;
          return reject(new Error(`Claude process exited with ${status}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        }
        resolve();
      };
      // Exit establishes order. For a local child, close additionally proves stdio retirement.
      child.once("exit", (code, exitSignal) => {
        departed = true;
        exitedAfterResult = evidence.nativeResult;
        if (local === undefined) confirm(code, exitSignal);
      });
      local?.once("close", confirm);
    });
    custody.own({
      closed,
      abort: () => closed, // Query owns the SDK's graceful shutdown and forwarded signal.
      async forceDispose() {
        if (!departed && child.exitCode === null && child.signalCode == null) forced = child.kill("SIGKILL");
        await closed;
      },
    });
    return child;
  };
}

function claudeResult(message: Extract<SDKMessage, { type: "result" }>, historyId?: string): TurnResult {
  return message.subtype === "success"
    ? { kind: "answered", answer: message.result, ...(historyId === undefined ? {} : { historyId }) }
    : { kind: "failed", diagnostic: message.errors.join("; ") || message.subtype };
}

async function consumeClaudeQuery(
  query: Query,
  turn: ReturnType<typeof providerTurn>,
  admit: () => void,
  finish: (result?: TurnResult) => void,
): Promise<void> {
  const observation: ClaudeObservationState = { tools: new Map() };
  let admitted = false;
  let historyId: string | undefined;
  for await (const message of query) {
    if (turn.terminal) continue;
    if (!admitted && "session_id" in message && typeof message.session_id === "string") {
      admitted = true;
      turn.events.emit({ type: "session", coordinate: { sessionId: message.session_id } });
      admit();
    }
    emitClaudeMessage(message, turn.events, observation);
    if (
      message.type === "assistant" &&
      message.parent_tool_use_id === null &&
      typeof message.uuid === "string" &&
      message.uuid.length > 0
    )
      historyId = message.uuid;
    if (message.type === "result") finish(claudeResult(message, historyId));
  }
  finish();
}

function ownClaudeQuery(
  query: Query,
  input: ClaudeInput,
  turn: ReturnType<typeof providerTurn>,
  execution: { abortController: AbortController; custody: AttemptCustody; evidence: ClaudeQueryEvidence },
) {
  const { abortController, custody, evidence } = execution;
  let admit!: () => void;
  let rejectAdmission!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    admit = resolve;
    rejectAdmission = reject;
  });
  let startRetirement!: () => void;
  const retired = new Promise<void>((resolve) => {
    startRetirement = resolve;
  }).then(async () => {
    const close = Promise.resolve().then(() => query.close?.());
    const [request, consumer] = await Promise.allSettled([close, consuming]);
    if (request.status === "rejected" && consumer.status === "rejected") {
      throw new AggregateError([request.reason, consumer.reason], "Claude Query close and consumer failed");
    }
    if (request.status === "rejected") throw request.reason;
    if (consumer.status === "rejected") throw consumer.reason;
  });
  const retire = (): Promise<void> => {
    startRetirement();
    return retired;
  };
  const finish = (result?: TurnResult): void => {
    const outcome = result ?? { kind: "failed", diagnostic: "Claude query ended without a result" };
    if (!turn.finish(outcome)) return;
    evidence.nativeResult = result !== undefined;
    rejectAdmission(
      new Error(outcome.kind === "failed" ? outcome.diagnostic : "Claude query ended before session admission"),
    );
    void retire();
  };
  const consuming = consumeClaudeQuery(query, turn, admit, finish).catch((error: unknown) => {
    if (turn.terminal) {
      const cancelled =
        abortController.signal.aborted &&
        (error === abortController.signal.reason || (error instanceof Error && error.name === "AbortError"));
      if (!cancelled) throw error;
      return;
    }
    const diagnostic = evidence.stderr.trim();
    if (diagnostic) turn.events.emit({ type: "note", text: diagnostic });
    input.fail(error);
    if (turn.fail(error)) rejectAdmission(error);
    void retire();
  });
  const abort = (): Promise<void> => {
    abortController.abort(custody.signal.reason);
    input.fail(custody.signal.reason);
    if (turn.fail(custody.signal.reason)) rejectAdmission(custody.signal.reason);
    return retire();
  };
  custody.own({ closed: retired, abort, forceDispose: abort });
  return { ready, retire };
}

async function driveClaude(
  load: () => Promise<ClaudeSdk>,
  execution: ClaudeExecution,
  drive: ClaudeDriveInput,
  custody: AttemptCustody,
): Promise<Session> {
  const { signal } = custody;
  signal.throwIfAborted();
  const sdk = await abortable(load(), signal);
  signal.throwIfAborted();
  const events = new AgentEventChannel();
  const input = createClaudeInput();
  const abortController = new AbortController();
  const options = claudeQueryOptions(drive, execution, abortController);
  const run = randomUUID();
  let submission = 0;
  const evidence: ClaudeQueryEvidence = { stderr: "", nativeResult: false };
  const turn = providerTurn(events, input.end);
  const launch = input.push(claudeUserMessage(launchPrompt(drive.body, drive.launchTells)));
  void launch.catch(() => undefined);
  let query: Query;
  try {
    query = sdk.query({
      prompt: input.iterable,
      options: {
        ...options,
        spawnClaudeCodeProcess: claudeSpawn(options, custody, evidence),
      },
    });
  } catch (error) {
    input.fail(error);
    turn.fail(error);
    throw error;
  }
  const { ready, retire } = ownClaudeQuery(query, input, turn, { abortController, custody, evidence });
  try {
    await Promise.all([launch, ready]);
    signal.throwIfAborted();
  } catch (error) {
    // Keep ownership open for native spawn/setup until Query retirement.
    turn.fail(error);
    await retire().catch(() => undefined);
    throw error;
  }
  return {
    admission: { fence: `claude:${run}:0` },
    events,
    completion: turn.completion,
    async tell(tell) {
      if (turn.terminal || input.closed) return { kind: "turn-ended" };
      const fence = `claude:${run}:${++submission}`;
      try {
        await input.push(claudeUserMessage(tell.text));
        return { kind: "accepted", fence };
      } catch (error) {
        if (isClaudeTurnEnded(error)) return { kind: "turn-ended" };
        throw error;
      }
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
    ...providerLifecycle((input, custody) => driveClaude(load, selectedExecution, input, custody)),
  };
}

export const claudeProvider = createClaudeProvider(
  async () => (await import("@anthropic-ai/claude-agent-sdk")) as ClaudeSdk,
);
