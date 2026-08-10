import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentEventChannel,
  noteEvent,
  unknownEvent,
  type Drive,
  type ProviderAdapter,
  type ProviderOptions,
  type ToolCall,
  type TurnResult,
} from "../provider.js";

type ClaudeMessageType = SDKMessage["type"];
type ClaudeSystemSubtype = Extract<SDKMessage, { type: "system" }>["subtype"];
type MessageDisposition = "assistant" | "auth" | "note" | "system" | "tool-results" | "drop" | "terminal";
type SystemDisposition = "note" | "control-progress" | "drop";
type ClaudeObservationState = { tools: Map<string, Readonly<{ name: string; call: ToolCall }>> };

export const CLAUDE_MESSAGE_DISPOSITIONS = {
  assistant: "assistant",
  auth_status: "auth",
  conversation_reset: "note",
  prompt_suggestion: "drop",
  rate_limit_event: "drop",
  result: "terminal",
  stream_event: "drop",
  system: "system",
  tool_progress: "drop",
  tool_use_summary: "drop",
  user: "tool-results",
} as const satisfies Record<ClaudeMessageType, MessageDisposition>;

export const CLAUDE_SYSTEM_DISPOSITIONS = {
  api_retry: "note",
  background_tasks_changed: "note",
  commands_changed: "drop",
  compact_boundary: "drop",
  control_request_progress: "control-progress",
  elicitation_complete: "drop",
  files_persisted: "note",
  hook_progress: "drop",
  hook_response: "drop",
  hook_started: "note",
  informational: "note",
  init: "drop",
  local_command_output: "drop",
  memory_recall: "drop",
  mirror_error: "note",
  model_refusal_fallback: "note",
  model_refusal_no_fallback: "note",
  notification: "note",
  permission_denied: "note",
  plugin_install: "note",
  session_state_changed: "drop",
  status: "note",
  task_notification: "note",
  task_progress: "note",
  task_started: "note",
  task_updated: "note",
  thinking_tokens: "drop",
  worker_shutting_down: "note",
} as const satisfies Record<ClaudeSystemSubtype, SystemDisposition>;

export type ClaudeSdk = Readonly<{
  query(input: Readonly<{ prompt: string; options?: Options }>): Query;
  forkSession?(
    sessionId: string,
    options: Readonly<{ dir: string; upToMessageId: string }>,
  ): Promise<Readonly<{ sessionId: string }>>;
}>;

function assistantText(message: SDKMessage): string | null {
  if (message.type !== "assistant" || message.aborted === true || message.error !== undefined) return null;
  const text = message.message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text.length === 0 ? null : text;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function nonblank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const CLAUDE_SYSTEM_NOTES = {
  api_retry: (message) => {
    const attempt = number(message.attempt);
    const maximum = number(message.max_retries);
    return attempt === undefined || maximum === undefined
      ? "Retrying request"
      : `Retrying request ${attempt}/${maximum}`;
  },
  background_tasks_changed: (message) => `Background tasks: ${Array.isArray(message.tasks) ? message.tasks.length : 0}`,
  files_persisted: (message) => {
    const files = Array.isArray(message.files) ? message.files.length : 0;
    const failed = Array.isArray(message.failed) ? message.failed.length : 0;
    return failed === 0 ? `Persisted ${files} files` : `Persisted ${files} files; ${failed} failed`;
  },
  hook_started: (message) => `Hook ${nonblank(message.hook_name) ?? "unknown"} started`,
  informational: (message) => nonblank(message.content) ?? "Informational notice",
  mirror_error: (message) => `Transcript mirror warning: ${nonblank(message.error) ?? nonblank(message.message) ?? "unknown error"}`,
  model_refusal_fallback: () => "Model refusal; using fallback",
  model_refusal_no_fallback: () => "Model refusal; no fallback available",
  notification: (message) => nonblank(message.message) ?? nonblank(message.content) ?? "Notification",
  permission_denied: (message) => `Permission refused${nonblank(message.message) === undefined ? "" : `: ${nonblank(message.message)}`}`,
  plugin_install: (message) => `Plugin install ${nonblank(message.status) ?? "updated"}${nonblank(message.name) === undefined ? "" : `: ${nonblank(message.name)}`}`,
  status: (message) => `Status: ${nonblank(message.status) ?? "idle"}${nonblank(message.error) === undefined ? "" : ` (${nonblank(message.error)})`}`,
  task_notification: (message) => `Task ${nonblank(message.task_id) ?? "unknown"} ${nonblank(message.status) ?? "updated"}`,
  task_progress: (message) => nonblank(message.description) ?? `Task ${nonblank(message.task_id) ?? "unknown"} progressed`,
  task_started: (message) => nonblank(message.description) ?? `Task ${nonblank(message.task_id) ?? "unknown"} started`,
  task_updated: (message) => `Task ${nonblank(message.task_id) ?? "unknown"} updated`,
  worker_shutting_down: (message) => `Worker stopping: ${nonblank(message.reason) ?? "unknown reason"}`,
} satisfies Partial<Record<ClaudeSystemSubtype, (message: Readonly<Record<string, unknown>>) => string>>;

function toolCall(name: string, input: unknown): ToolCall {
  const value = object(input) ?? {};
  const command = nonblank(value.command);
  if (command !== undefined) return { kind: "run", command };
  const path = nonblank(value.file_path) ?? nonblank(value.path);
  if (/^(?:read|view)/iu.test(name) && path !== undefined) return { kind: "read", path };
  const query = nonblank(value.query) ?? nonblank(value.pattern);
  if (/search|grep|glob/iu.test(name) && query !== undefined) return { kind: "search", query };
  if (/write/iu.test(name) && path !== undefined) {
    return { kind: "fileChange", changes: [{ op: "add", path }] };
  }
  if (/edit|notebook/iu.test(name) && path !== undefined) {
    return { kind: "fileChange", changes: [{ op: "update", path }] };
  }
  return { kind: "other", display: name };
}

function assistantEvents(
  message: Extract<SDKMessage, { type: "assistant" }>,
  events: AgentEventChannel,
  state: ClaudeObservationState,
): void {
  if (message.aborted === true) return;
  if (message.error !== undefined) {
    events.emit(noteEvent(`Assistant error: ${message.error}`));
    return;
  }
  const text = assistantText(message);
  if (text !== null) events.emit({ type: "assistant", text });
  for (const block of message.message.content) {
    const value = object(block);
    if (value?.type === "thinking" && typeof value.thinking === "string" && value.thinking.trim().length > 0) {
      events.emit({ type: "thought", text: value.thinking });
      continue;
    }
    if (block.type !== "tool_use") continue;
    const call = toolCall(block.name, block.input);
    state.tools.set(block.id, { name: block.name, call });
    events.emit({ type: "tool", phase: "started", id: block.id, name: block.name, call });
  }
}

function toolResultEvents(
  message: Extract<SDKMessage, { type: "user" }>,
  events: AgentEventChannel,
  state: ClaudeObservationState,
): void {
  const content = object(message.message)?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const value = object(block);
    if (value?.type !== "tool_result") continue;
    const id = nonblank(value.tool_use_id);
    if (id === undefined) continue;
    const observed = state.tools.get(id);
    if (observed === undefined) continue;
    state.tools.delete(id);
    events.emit({
      type: "tool",
      phase: "completed",
      id,
      name: observed.name,
      call: observed.call,
      result: { status: value.is_error === true ? "error" : "ok" },
    });
  }
}

function systemNote(message: Readonly<Record<string, unknown>>, subtype: ClaudeSystemSubtype): string {
  const note = CLAUDE_SYSTEM_NOTES[subtype as keyof typeof CLAUDE_SYSTEM_NOTES];
  return note?.(message) ?? subtype;
}

function emitClaudeMessage(message: SDKMessage, events: AgentEventChannel, state: ClaudeObservationState): void {
  const value = object(message);
  const kind = nonblank(value?.type) ?? "unknown";
  if (!Object.hasOwn(CLAUDE_MESSAGE_DISPOSITIONS, kind)) {
    events.emit(unknownEvent(kind));
    return;
  }
  const disposition = CLAUDE_MESSAGE_DISPOSITIONS[kind as ClaudeMessageType];
  if (disposition === "assistant") {
    assistantEvents(message as Extract<SDKMessage, { type: "assistant" }>, events, state);
    return;
  }
  if (disposition === "tool-results") {
    toolResultEvents(message as Extract<SDKMessage, { type: "user" }>, events, state);
    return;
  }
  if (disposition === "auth") {
    const error = nonblank(value?.error);
    if (error !== undefined) events.emit(noteEvent(`Authentication warning: ${error}`));
    return;
  }
  if (disposition === "note") {
    events.emit(noteEvent("Conversation reset"));
    return;
  }
  if (disposition !== "system") return;
  const subtype = nonblank(value?.subtype) ?? "unknown";
  if (!Object.hasOwn(CLAUDE_SYSTEM_DISPOSITIONS, subtype)) {
    events.emit(unknownEvent(subtype));
    return;
  }
  const systemDisposition = CLAUDE_SYSTEM_DISPOSITIONS[subtype as ClaudeSystemSubtype];
  if (systemDisposition === "drop") return;
  if (systemDisposition === "control-progress" && value?.status !== "api_retry") return;
  events.emit(noteEvent(systemNote(value ?? {}, subtype as ClaudeSystemSubtype)));
}

function admitClaudeOptions(options: ProviderOptions): ReturnType<ProviderAdapter["admitOptions"]> {
  if (options.network !== undefined) {
    return { kind: "refused", diagnostic: "Claude provider does not support the Persona network option" };
  }
  return { kind: "admitted", options: Object.freeze({ ...options }) };
}

function permissionMode(access: ProviderOptions["access"]): "plan" | "acceptEdits" | "bypassPermissions" {
  if (access === "read") return "plan";
  if (access === "write") return "acceptEdits";
  return "bypassPermissions";
}

async function forkClaude(
  load: () => Promise<ClaudeSdk>,
  execution: Readonly<{ env?: Readonly<Record<string, string>> }>,
  input: Parameters<NonNullable<ProviderAdapter["fork"]>>[0],
): Promise<Readonly<{ session: { sessionId: string } }>> {
  if (execution.env !== undefined) {
    throw new Error("Claude fork cannot apply the frozen provider environment");
  }
  const sdk = await load();
  if (sdk.forkSession === undefined) throw new Error("Claude SDK does not expose forkSession");
  const forked = await sdk.forkSession(input.session.sessionId, { dir: input.cwd, upToMessageId: input.at });
  if (forked.sessionId.trim().length === 0) throw new Error("Claude fork returned an empty child session id");
  if (forked.sessionId === input.session.sessionId) throw new Error("Claude fork reused the source session id");
  return { session: { sessionId: forked.sessionId } };
}

export function createClaudeProvider(
  load: () => Promise<ClaudeSdk>,
  execution: Readonly<{ executable?: string; env?: Readonly<Record<string, string>> }> = {},
): ProviderAdapter {
  return {
    confinement: () => ({ kind: "unconfined" }),
    admitOptions: admitClaudeOptions,
    fork: (input) => forkClaude(load, execution, input),
    async start(input): Promise<Drive> {
      const sdk = await load();
      const events = new AgentEventChannel();
      const abortController = new AbortController();
      const providerOptions = input.options;
      const access = permissionMode(providerOptions.access);
      const options: Options = {
        cwd: input.cwd,
        abortController,
        ...(execution.executable === undefined ? {} : { pathToClaudeCodeExecutable: execution.executable }),
        ...(execution.env === undefined ? {} : { env: { ...process.env, ...execution.env } }),
        permissionMode: access,
        ...(access === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        settingSources: ["user", "project", "local"],
        ...(providerOptions.model === undefined ? {} : { model: providerOptions.model }),
        ...(providerOptions.effort === undefined ? {} : { effort: providerOptions.effort as NonNullable<Options["effort"]> }),
        ...(providerOptions.systemPrompt === undefined || providerOptions.systemPrompt.length === 0 ? {} : {
          systemPrompt: { type: "preset", preset: "claude_code", append: providerOptions.systemPrompt },
        }),
        ...(input.session === undefined ? {} : { resume: input.session.sessionId }),
      };
      const query = sdk.query({ prompt: input.prompt, options });
      const observation: ClaudeObservationState = { tools: new Map() };
      let admitted = false;
      let settle!: (result: TurnResult) => void;
      const completion = new Promise<TurnResult>((resolve) => { settle = resolve; });
      void (async () => {
        let terminal: TurnResult | null = null;
        let historyId: string | undefined;
        try {
          for await (const message of query) {
            if (!admitted && "session_id" in message && typeof message.session_id === "string") {
              admitted = true;
              events.emit({ type: "session", coordinate: { sessionId: message.session_id } });
            }
            emitClaudeMessage(message, events, observation);
            if (message.type === "assistant" && message.parent_tool_use_id === null
              && typeof message.uuid === "string" && message.uuid.length > 0) {
              historyId = message.uuid;
            }
            if (message.type === "result") terminal = message.subtype === "success"
              ? historyId === undefined
                ? { kind: "failed", diagnostic: "Claude query succeeded without an assistant history id" }
                : { kind: "answered", answer: message.result, historyId }
              : { kind: "failed", diagnostic: message.errors.join("; ") || message.subtype };
          }
          settle(terminal ?? { kind: "failed", diagnostic: "Claude query ended without a result" });
        } catch (error) {
          settle({ kind: "failed", diagnostic: error instanceof Error ? error.message : String(error) });
        } finally {
          events.end();
        }
      })();
      return {
        events,
        completion,
        async abort(): Promise<void> {
          abortController.abort();
          query.close();
          await completion;
        },
      };
    },
  };
}

export const claudeProvider = createClaudeProvider(async () =>
  await import("@anthropic-ai/claude-agent-sdk") as ClaudeSdk);
