import type { ProviderAdapter } from "../provider.js";
import { decodeProviderRecipe, type ProviderExecution } from "../provider-recipe.js";
import { createAcpProvider, decodeAcpConfig } from "./acp/index.js";
import { claudeProvider, createClaudeProvider } from "./claude/index.js";
import { createCodexAppServerProvider } from "./codex-app-server/index.js";
import { createGrokBuildProvider } from "./grok-build/index.js";
import { createOpencodeProvider } from "./opencode-sdk/index.js";
import { createPiProvider } from "./pi/index.js";

const PROVIDERS = {
  claude: claudeProvider,
} as const satisfies Readonly<Record<string, ProviderAdapter>>;

function providerConfig(execution: ProviderExecution): Readonly<Record<string, unknown>> | undefined {
  const { config, kind } = execution;
  if (kind === "claude-agent-sdk" && config !== undefined) throw new TypeError("provider execution config is unsupported by claude-agent-sdk");
  if (kind === "opencode-sdk" && config !== undefined) throw new TypeError("provider execution config is unsupported by opencode-sdk");
  if (kind === "acp") return decodeAcpConfig(config);
  return config;
}

function adapterFor(execution: ProviderExecution): ProviderAdapter {
  if (execution.kind === "acp") return createAcpProvider(execution);
  if (execution.kind === "claude-agent-sdk") {
    return execution.executable === undefined && execution.env === undefined
      ? PROVIDERS.claude
      : createClaudeProvider(async () => await import("@anthropic-ai/claude-agent-sdk"), execution);
  }
  if (execution.kind === "codex-app-server") return createCodexAppServerProvider(execution);
  if (execution.kind === "grok-build") return createGrokBuildProvider(execution);
  if (execution.kind === "opencode-sdk") return createOpencodeProvider(execution);
  if (execution.kind === "pi") return createPiProvider(execution);
  throw new TypeError(`unknown Akuma provider kind ${(execution as ProviderExecution).kind}`);
}

export function resolveProviderExecution(input: unknown): Readonly<{
  execution: ProviderExecution;
  adapter: ProviderAdapter;
}> {
  const decoded = decodeProviderRecipe(input);
  const config = providerConfig(decoded);
  const execution: ProviderExecution = Object.freeze({
    name: decoded.name,
    kind: decoded.kind,
    ...(decoded.executable === undefined ? {} : { executable: decoded.executable }),
    ...(config === undefined ? {} : { config }),
    ...(decoded.env === undefined ? {} : { env: decoded.env }),
  });
  return Object.freeze({ execution, adapter: adapterFor(execution) });
}
