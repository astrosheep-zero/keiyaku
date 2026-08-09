import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  actionEvent,
  AgentEventChannel,
  unknownEvent,
  type Drive,
  type ProviderAdapter,
  type ProviderOptions,
  type TurnResult,
} from "../provider.js";

type ClaudeMessageType = SDKMessage["type"];
type ClaudeSystemSubtype = Extract<SDKMessage, { type: "system" }>["subtype"];
type MessageDisposition = "assistant" | "auth" | "action" | "system" | "drop" | "terminal";
type SystemDisposition = "action" | "control-progress" | "drop";

export const CLAUDE_MESSAGE_DISPOSITIONS = {
  assistant: "assistant",
  auth_status: "auth",
  conversation_reset: "action",
  prompt_suggestion: "drop",
  rate_limit_event: "drop",
  result: "terminal",
  stream_event: "drop",
  system: "system",
  tool_progress: "drop",
  tool_use_summary: "drop",
  user: "drop",
} as const satisfies Record<ClaudeMessageType, MessageDisposition>;

export const CLAUDE_SYSTEM_DISPOSITIONS = {
  api_retry: "action",
  background_tasks_changed: "action",
  commands_changed: "drop",
  compact_boundary: "drop",
  control_request_progress: "control-progress",
  elicitation_complete: "drop",
  files_persisted: "action",
  hook_progress: "drop",
  hook_response: "drop",
  hook_started: "action",
  informational: "action",
  init: "drop",
  local_command_output: "drop",
  memory_recall: "drop",
  mirror_error: "action",
  model_refusal_fallback: "action",
  model_refusal_no_fallback: "action",
  notification: "action",
  permission_denied: "action",
  plugin_install: "action",
  session_state_changed: "drop",
  status: "action",
  task_notification: "action",
  task_progress: "action",
  task_started: "action",
  task_updated: "action",
  thinking_tokens: "drop",
  worker_shutting_down: "action",
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

function assistantEvents(message: Extract<SDKMessage, { type: "assistant" }>, events: AgentEventChannel): void {
  if (message.aborted === true) return;
  if (message.error !== undefined) {
    events.emit(actionEvent(`Assistant error: ${message.error}`));
    return;
  }
  const text = assistantText(message);
  if (text !== null) events.emit({ type: "assistant", text });
  for (const block of message.message.content) {
    if (block.type === "tool_use") events.emit(actionEvent(`Tool ${block.name}`));
  }
}

function systemNote(message: Readonly<Record<string, unknown>>, subtype: ClaudeSystemSubtype): string {
  const note = CLAUDE_SYSTEM_NOTES[subtype as keyof typeof CLAUDE_SYSTEM_NOTES];
  return note?.(message) ?? subtype;
}

function emitClaudeMessage(message: SDKMessage, events: AgentEventChannel): void {
  const value = object(message);
  const kind = nonblank(value?.type) ?? "unknown";
  if (!Object.hasOwn(CLAUDE_MESSAGE_DISPOSITIONS, kind)) {
    events.emit(unknownEvent(kind));
    return;
  }
  const disposition = CLAUDE_MESSAGE_DISPOSITIONS[kind as ClaudeMessageType];
  if (disposition === "assistant") {
    assistantEvents(message as Extract<SDKMessage, { type: "assistant" }>, events);
    return;
  }
  if (disposition === "auth") {
    const error = nonblank(value?.error);
    if (error !== undefined) events.emit(actionEvent(`Authentication warning: ${error}`));
    return;
  }
  if (disposition === "action") {
    events.emit(actionEvent("Conversation reset"));
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
  events.emit(actionEvent(systemNote(value ?? {}, subtype as ClaudeSystemSubtype)));
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

export function createClaudeProvider(load: () => Promise<ClaudeSdk>): ProviderAdapter {
  return {
    confinement: () => ({ kind: "unconfined" }),
    admitOptions: admitClaudeOptions,
    async fork(input) {
      const sdk = await load();
      if (sdk.forkSession === undefined) throw new Error("Claude SDK does not expose forkSession");
      const forked = await sdk.forkSession(input.session.sessionId, {
        dir: input.cwd,
        upToMessageId: input.at,
      });
      if (forked.sessionId.trim().length === 0) throw new Error("Claude fork returned an empty child session id");
      if (forked.sessionId === input.session.sessionId) throw new Error("Claude fork reused the source session id");
      return { session: { sessionId: forked.sessionId } };
    },
    async start(input): Promise<Drive> {
      const sdk = await load();
      const events = new AgentEventChannel();
      const abortController = new AbortController();
      const providerOptions = input.options;
      const access = permissionMode(providerOptions.access);
      const options: Options = {
        cwd: input.cwd,
        abortController,
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
            emitClaudeMessage(message, events);
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
