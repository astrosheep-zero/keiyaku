import type { ProviderAdapter, ProviderOptionAdmission, Session, ToolCall } from "../../provider.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import {
  startAcpSession,
  type AcpDependencies,
  type AcpLiveSession,
  type AcpStartInput,
  type AcpToolInterpreter,
  type AcpToolUpdate,
} from "../acp/core.js";

const INTERJECT_METHOD = "x.ai/interject";

type InterjectParams = Readonly<{
  sessionId: string;
  text: string;
  interjectionId: string;
}>;

type InterjectResponse = Readonly<{ status: "queued" }>;

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
    ...(options.readonly === undefined
      ? {}
      : {
          readonly: {
            enforcement: "none" as const,
            diagnostic: "Grok Build cannot remove task-surface mutation capabilities",
          },
        }),
  };
}

function grokSessionMeta(
  config: ProviderExecution["config"],
  options: ProviderOptions,
): Pick<AcpDependencies, "freshSessionMeta" | "loadSessionMeta"> {
  const configured = config === undefined ? {} : { freshSessionMeta: config, loadSessionMeta: config };
  if (options.systemPrompt === undefined || options.systemPrompt.length === 0) return configured;
  if (options.systemPromptMode === "append")
    return { ...configured, freshSessionMeta: { ...config, rules: options.systemPrompt } };
  if (options.systemPromptMode === "replace") {
    const meta = { systemPromptOverride: options.systemPrompt };
    return { ...configured, freshSessionMeta: { ...config, ...meta }, loadSessionMeta: { ...config, ...meta } };
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

function withInterject(live: AcpLiveSession): Session {
  return {
    ...live.session,
    tell: async (tell) => {
      if (!live.open()) return { kind: "turn-ended" };
      const response = await live.agent.request<InterjectResponse, InterjectParams>(INTERJECT_METHOD, {
        sessionId: live.sessionId,
        text: tell.text,
        interjectionId: tell.id,
      });
      if (!live.open()) return { kind: "turn-ended" };
      if (response === null || typeof response !== "object" || response.status !== "queued") {
        throw new Error("Grok Build interject did not return queued");
      }
      return { kind: "accepted", fence: tell.id };
    },
  };
}

export function createGrokBuildProvider(
  execution: ProviderExecution,
  dependencies: AcpDependencies = {},
): ProviderAdapter {
  if (execution.executable === undefined) throw new TypeError("Grok Build provider execution requires executable");
  const drive = async (input: AcpStartInput) => {
    const launch = {
      argv: argv(execution, input.options),
      ...(execution.env === undefined ? {} : { env: execution.env }),
    };
    return withInterject(
      await startAcpSession(launch, input, {
        ...dependencies,
        interpretTool: interpretGrokTool,
        ...grokSessionMeta(execution.config, input.options),
      }),
    );
  };
  return {
    admitOptions: optionAdmission,
    start: async (input) => await drive(input),
    resume: async (input) => await drive(input),
  };
}
