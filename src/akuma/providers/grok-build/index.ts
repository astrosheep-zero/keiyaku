import { tellRegistry, type TellRegistry } from "../../provider.js";
import type { AttemptCustody, ProviderAdapter, ProviderOptionAdmission, Session, ToolCall } from "../../provider.js";
import type { ProviderExecution, ProviderOptions } from "../../provider-recipe.js";
import { nonblank, object, searchToolCall } from "../decode.js";
import { providerLifecycle } from "../lifecycle.js";
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
  return query === undefined
    ? undefined
    : searchToolCall(query, "content", { path: nonblank(input.path), glob: nonblank(input.glob) });
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
  input: AcpStartInput,
): Pick<AcpDependencies, "freshSessionMeta" | "loadSessionMeta"> {
  // Grok appends rules only when creating a session; ordinary load preserves
  // that immutable execution context without requiring a hot-update channel.
  const options = input.options;
  const sessionMeta = { ...(config ?? {}), askUserQuestion: false };
  const replacement =
    options.systemPromptMode === "replace" && options.systemPrompt?.trim()
      ? options.systemPrompt
      : typeof config?.systemPromptOverride === "string" && config.systemPromptOverride.trim()
        ? config.systemPromptOverride
        : undefined;
  if (replacement !== undefined) {
    const meta = {
      ...sessionMeta,
      systemPromptOverride: [replacement, input.runtimeInstructions].filter((part) => part !== undefined).join("\n\n"),
    };
    return { freshSessionMeta: meta, loadSessionMeta: meta };
  }
  const rules = options.systemPromptMode === "append" ? options.systemPrompt : config?.rules;
  const appended = [typeof rules === "string" ? rules : undefined, input.runtimeInstructions]
    .filter((part) => part !== undefined && part.length > 0)
    .join("\n\n");
  return {
    freshSessionMeta: { ...sessionMeta, ...(appended === "" ? {} : { rules: appended }) },
    loadSessionMeta: sessionMeta,
  };
}

function argv(execution: ProviderExecution, options: ProviderOptions): readonly [string, ...string[]] {
  if (execution.executable === undefined) throw new Error("Grok Build provider execution requires executable");
  const values = [execution.executable, "agent", "--always-approve"];
  if (options.model !== undefined) values.push("--model", options.model);
  if (options.effort !== undefined) values.push("--reasoning-effort", options.effort);
  values.push("stdio");
  return values as [string, ...string[]];
}

function withInterject(live: AcpLiveSession, tells: TellRegistry<string>): Session {
  return {
    ...live.session,
    tell: (tell) => {
      if (!live.open()) return Promise.resolve({ kind: "turn-ended" } as const);
      const receipt = tells.register(tell.id, tell.id);
      void live.agent
        .request<Readonly<{ status: "queued" }>, InterjectParams>(INTERJECT_METHOD, {
          sessionId: live.sessionId,
          text: tell.text,
          interjectionId: tell.id,
        })
        .then(
          (response) => {
            if (response?.status !== "queued") {
              tells.fail(tell.id, new Error("Grok Build interject did not return queued"));
            }
          },
          (error: unknown) => tells.fail(tell.id, error),
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
    const tells = tellRegistry<string>();
    let live: AcpLiveSession | undefined;
    const launch = {
      argv: argv(execution, input.options),
      ...(execution.env === undefined ? {} : { env: execution.env }),
    };
    const sessionMeta = grokSessionMeta(execution.config, input);
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
              tells.accept(params.interjectionId);
            },
          );
        },
        onTerminal: () => tells.end(),
        interpretTool: interpretGrokTool,
        freshSessionMeta: { ...(dependencies.freshSessionMeta ?? {}), ...(sessionMeta.freshSessionMeta ?? {}) },
        loadSessionMeta: { ...(dependencies.loadSessionMeta ?? {}), ...(sessionMeta.loadSessionMeta ?? {}) },
      },
      custody,
    );
    return withInterject(live, tells);
  };
  return {
    admitOptions: optionAdmission,
    ...providerLifecycle(drive),
  };
}
