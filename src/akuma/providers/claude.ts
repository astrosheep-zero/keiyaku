import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentEventChannel, type Drive, type ProviderAdapter, type ProviderOptions, type TurnResult } from "../provider.js";

export type ClaudeSdk = Readonly<{
  query(input: Readonly<{ prompt: string; options?: Options }>): Query;
  forkSession?(
    sessionId: string,
    options: Readonly<{ dir: string; upToMessageId: string }>,
  ): Promise<Readonly<{ sessionId: string }>>;
}>;

function assistantText(message: SDKMessage): string | null {
  if (message.type !== "assistant") return null;
  const text = message.message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  return text.length === 0 ? null : text;
}

function activity(message: SDKMessage): Readonly<Record<string, unknown>> {
  return {
    type: message.type,
    ...(message.type === "system" && "subtype" in message ? { subtype: message.subtype } : {}),
  };
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
            const text = assistantText(message);
            if (text !== null) events.emit({ type: "assistant", text });
            if (message.type === "assistant" && message.parent_tool_use_id === null
              && typeof message.uuid === "string" && message.uuid.length > 0) {
              historyId = message.uuid;
            }
            events.emit({ type: "activity", event: activity(message) });
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
