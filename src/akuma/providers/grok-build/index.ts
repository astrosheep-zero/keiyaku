import { createProviderAttempt } from "../../provider.js";
import type { AttemptCustody, ProviderAdapter, ProviderOptionAdmission, Session, ToolCall } from "../../provider.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import {
  startAcpSession,
  type AcpDependencies,
  type AcpLiveSession,
  type AcpStartInput,
  type AcpToolInterpreter,
  type AcpToolUpdate,
} from "../acp/core.js";

const INTERJECT_METHOD = "_x.ai/interject";
const INTERJECTION_METHOD = "_x.ai/session/interjection";

type InterjectParams = Readonly<{
  sessionId: string;
  text: string;
  interjectionId: string;
}>;

function nonblank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function nativeName(update: AcpToolUpdate): string | undefined {
  const wire = update as AcpToolUpdate & { toolName?: unknown };
  return nonblank(update.name) ?? nonblank(update.title) ?? nonblank(wire.toolName);
}

function readCall(name: string, input: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name !== "read_file" && name !== "hashline_read") return undefined;
  const sourcePath = nonblank(input.target_file);
  const capturedPath = name === "read_file" ? nonblank(input.path) : undefined;
  const path = sourcePath ?? capturedPath;
  return path === undefined ? undefined : { kind: "read", path };
}

function contentSearchCall(name: string, input: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name !== "grep" && name !== "hashline_grep") return undefined;
  const query = nonblank(input.pattern);
  if (query === undefined) return undefined;
  const path = nonblank(input.path);
  const glob = nonblank(input.glob);
  return {
    kind: "search",
    query,
    scope: "content",
    ...(path === undefined ? {} : { path }),
    ...(glob === undefined ? {} : { glob }),
  };
}

function runCall(name: string, input: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name !== "run_terminal_cmd") return undefined;
  const command = nonblank(input.command);
  return command === undefined ? undefined : { kind: "run", command };
}

function webSearchCall(name: string, input: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name !== "web_search") return undefined;
  const query = nonblank(input.query);
  return query === undefined ? undefined : { kind: "search", query, scope: "web" };
}

function fileChangeCall(name: string, input: Readonly<Record<string, unknown>>): ToolCall | undefined {
  if (name !== "search_replace") return undefined;
  const path = nonblank(input.file_path);
  return path === undefined ? undefined : { kind: "fileChange", changes: [{ op: "unspecified", path }] };
}

export const interpretGrokTool: AcpToolInterpreter = (update) => {
  const name = nativeName(update);
  const input = object(update.rawInput);
  if (name === undefined || input === undefined) return undefined;
  return (
    readCall(name, input) ??
    contentSearchCall(name, input) ??
    runCall(name, input) ??
    webSearchCall(name, input) ??
    fileChangeCall(name, input)
  );
};

function optionAdmission(options: ProviderOptions): ProviderOptionAdmission {
  if (options.network !== undefined) {
    return { kind: "refused", diagnostic: "Grok Build does not support the network option" };
  }
  if (options.systemPrompt !== undefined && options.systemPrompt.length > 0 && options.systemPromptMode === undefined) {
    return { kind: "refused", diagnostic: "Grok Build does not support the systemPrompt option" };
  }
  return {
    kind: "admitted",
    options,
  };
}

function grokSessionMeta(
  config: ProviderExecution["config"],
  options: ProviderOptions,
): Pick<AcpDependencies, "freshSessionMeta" | "loadSessionMeta"> {
  // Keiyaku does not implement Grok's reverse ask_user_question request, so
  // keep that unsupported tool out of every session's advertised toolset.
  const sessionMeta = { ...(config ?? {}), askUserQuestion: false };
  const configured = { freshSessionMeta: sessionMeta, loadSessionMeta: sessionMeta };
  if (options.systemPrompt === undefined || options.systemPrompt.length === 0) return configured;
  if (options.systemPromptMode === "append")
    return { ...configured, freshSessionMeta: { ...sessionMeta, rules: options.systemPrompt } };
  if (options.systemPromptMode === "replace") {
    const meta = { systemPromptOverride: options.systemPrompt };
    return {
      ...configured,
      freshSessionMeta: { ...sessionMeta, ...meta },
      loadSessionMeta: { ...sessionMeta, ...meta },
    };
  }
  return configured;
}

function argv(execution: ProviderExecution, options: ProviderOptions): readonly [string, ...string[]] {
  if (execution.executable === undefined) throw new Error("Grok Build provider execution requires executable");
  const values = [execution.executable, "agent", "--always-approve"];
  if (options.model !== undefined) values.push("--model", options.model);
  if (options.effort !== undefined) values.push("--reasoning-effort", options.effort);
  values.push("stdio");
  return values as [string, ...string[]];
}

function withInterject(
  live: AcpLiveSession,
  pending: Map<
    string,
    { resolve(value: Awaited<ReturnType<NonNullable<Session["tell"]>>>): void; reject(error: unknown): void }
  >,
): Session {
  return {
    ...live.session,
    tell: (tell) => {
      if (!live.open()) return Promise.resolve({ kind: "turn-ended" } as const);
      const existing = pending.get(tell.id);
      if (existing !== undefined) throw new Error("Grok Build duplicate pending interjection id");
      const receipt = new Promise<Awaited<ReturnType<NonNullable<Session["tell"]>>>>((resolve, reject) => {
        pending.set(tell.id, { resolve, reject });
      });
      void live.agent
        .request<Readonly<{ status: "queued" }>, InterjectParams>(INTERJECT_METHOD, {
          sessionId: live.sessionId,
          text: tell.text,
          interjectionId: tell.id,
        })
        .then(
          (response) => {
            if (response?.status !== "queued" && pending.has(tell.id)) {
              pending.get(tell.id)?.reject(new Error("Grok Build interject did not return queued"));
              pending.delete(tell.id);
            }
          },
          (error: unknown) => {
            pending.get(tell.id)?.reject(error);
            pending.delete(tell.id);
          },
        );
      return receipt;
    },
  };
}

export function createGrokBuildProvider(
  execution: ProviderExecution,
  dependencies: AcpDependencies = {},
): ProviderAdapter {
  if (execution.executable === undefined) throw new TypeError("Grok Build provider execution requires executable");
  const drive = async (input: AcpStartInput, custody: AttemptCustody) => {
    const pending = new Map<
      string,
      { resolve(value: Awaited<ReturnType<NonNullable<Session["tell"]>>>): void; reject(error: unknown): void }
    >();
    let live: AcpLiveSession | undefined;
    const launch = {
      argv: argv(execution, input.options),
      ...(execution.env === undefined ? {} : { env: execution.env }),
    };
    const sessionMeta = grokSessionMeta(execution.config, input.options);
    live = await startAcpSession(
      launch,
      input,
      {
        ...dependencies,
        configureClient: (client) => {
          client.onNotification<InterjectParams>(
            INTERJECTION_METHOD,
            (value) => value as InterjectParams,
            ({ params }) => {
              if (params.sessionId !== live?.sessionId) return;
              const waiter = pending.get(params.interjectionId);
              if (waiter === undefined) return;
              pending.delete(params.interjectionId);
              waiter.resolve({ kind: "accepted", fence: params.interjectionId });
            },
          );
        },
        onTerminal: () => {
          for (const waiter of pending.values()) waiter.resolve({ kind: "turn-ended" });
          pending.clear();
        },
        interpretTool: interpretGrokTool,
        freshSessionMeta: { ...(dependencies.freshSessionMeta ?? {}), ...(sessionMeta.freshSessionMeta ?? {}) },
        loadSessionMeta: { ...(dependencies.loadSessionMeta ?? {}), ...(sessionMeta.loadSessionMeta ?? {}) },
      },
      custody,
    );
    return withInterject(live, pending);
  };
  return {
    admitOptions: optionAdmission,
    start: (input) =>
      createProviderAttempt(
        input.signal,
        async (custody) => await drive({ ...input, signal: custody.signal }, custody),
      ),
    resume: (input) =>
      createProviderAttempt(
        input.signal,
        async (custody) => await drive({ ...input, signal: custody.signal }, custody),
      ),
  };
}
