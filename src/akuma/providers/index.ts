import type { ProviderAdapter } from "../provider.js";
import type { ProviderExecution } from "../heart/index.js";
import { claudeProvider, createClaudeProvider } from "./claude/index.js";
import { createCodexAppServerProvider } from "./codex-app-server/index.js";
import { createOpencodeProvider } from "./opencode-sdk/index.js";

const PROVIDERS = {
  claude: claudeProvider,
} as const satisfies Readonly<Record<string, ProviderAdapter>>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot));
  const object = record(value);
  if (object === null) return value;
  return Object.freeze(Object.fromEntries(Object.entries(object).map(([key, item]) => [key, snapshot(item)])));
}

function optionalText(value: Readonly<Record<string, unknown>>, field: "executable"): string | undefined {
  const selected = value[field];
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || selected.trim().length === 0) {
    throw new TypeError(`provider execution ${field} must be a nonblank string`);
  }
  return selected;
}

function providerKind(value: unknown): value is ProviderExecution["kind"] {
  return value === "claude-agent-sdk" || value === "codex-app-server" || value === "opencode-sdk";
}

function providerConfig(value: Readonly<Record<string, unknown>>, kind: ProviderExecution["kind"]): Readonly<Record<string, unknown>> | undefined {
  const config = value.config === undefined ? undefined : record(value.config);
  if (config === null) throw new TypeError("provider execution config must be an object");
  if (kind === "claude-agent-sdk" && config !== undefined) throw new TypeError("provider execution config is unsupported by claude-agent-sdk");
  if (kind === "opencode-sdk" && config !== undefined) throw new TypeError("provider execution config is unsupported by opencode-sdk");
  return config;
}

export function decodeProviderExecution(input: unknown): ProviderExecution {
  const value = record(input);
  if (value === null) throw new TypeError("provider execution must be an object");
  const allowed = ["config", "env", "executable", "kind", "name"];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`provider execution has unknown field ${unknown}`);
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new TypeError("provider execution name must be a nonblank string");
  }
  if (!providerKind(value.kind)) {
    throw new TypeError("provider execution has unknown kind");
  }
  const executable = optionalText(value, "executable");
  const config = providerConfig(value, value.kind);
  const env = value.env === undefined ? undefined : record(value.env);
  if (env === null) throw new TypeError("provider execution env must be an object");
  if (env !== undefined && Object.values(env).some((item) => typeof item !== "string")) {
    throw new TypeError("provider execution env must contain only string values");
  }
  return Object.freeze({
    name: value.name,
    kind: value.kind,
    ...(executable === undefined ? {} : { executable }),
    ...(config === undefined ? {} : { config: snapshot(config) as Readonly<Record<string, unknown>> }),
    ...(env === undefined ? {} : { env: Object.freeze({ ...env }) as Readonly<Record<string, string>> }),
  });
}

export function providerNamed(execution: ProviderExecution): ProviderAdapter {
  if (execution.kind === "claude-agent-sdk") {
    return execution.executable === undefined && execution.env === undefined
      ? PROVIDERS.claude
      : createClaudeProvider(async () => await import("@anthropic-ai/claude-agent-sdk"), execution);
  }
  if (execution.kind === "codex-app-server") return createCodexAppServerProvider(execution);
  if (execution.kind === "opencode-sdk") return createOpencodeProvider(execution);
  throw new TypeError(`unknown Akuma provider kind ${(execution as ProviderExecution).kind}`);
}
