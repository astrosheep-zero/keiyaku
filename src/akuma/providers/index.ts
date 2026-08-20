import type { ProviderAdapter } from "../provider.js";
import { decodeProviderRecipe, type ProviderExecution } from "../provider-recipe.js";
import { decodeAcpConfig } from "./acp/config.js";

export function decodeProviderExecution(input: unknown): ProviderExecution {
  const decoded = decodeProviderRecipe(input);
  if ((decoded.kind === "claude-agent-sdk" || decoded.kind === "opencode-sdk") && decoded.config !== undefined) {
    throw new TypeError(`provider execution config is unsupported by ${decoded.kind}`);
  }
  if (decoded.kind === "pi") {
    if (decoded.executable !== undefined || decoded.config !== undefined) {
      throw new TypeError("Pi provider does not support executable or config");
    }
    if (decoded.env !== undefined && Object.keys(decoded.env).length > 0) {
      throw new TypeError("env injection not supported for provider pi");
    }
  }
  if (decoded.kind === "grok-build" && decoded.config !== undefined) {
    throw new TypeError("Grok Build does not support execution config");
  }
  const config = decoded.kind === "acp" ? decodeAcpConfig(decoded.config) : decoded.config;
  return Object.freeze({
    name: decoded.name,
    kind: decoded.kind,
    ...(decoded.executable === undefined ? {} : { executable: decoded.executable }),
    ...(config === undefined ? {} : { config }),
    ...(decoded.env === undefined ? {} : { env: decoded.env }),
  });
}

async function adapterFor(execution: ProviderExecution): Promise<ProviderAdapter> {
  if (execution.kind === "acp") return (await import("./acp/index.js")).createAcpProvider(execution);
  if (execution.kind === "claude-agent-sdk") {
    const { claudeProvider, createClaudeProvider } = await import("./claude/index.js");
    return execution.executable === undefined && execution.env === undefined
      ? claudeProvider
      : createClaudeProvider(execution);
  }
  if (execution.kind === "codex-app-server") return (await import("./codex-app-server/index.js")).createCodexAppServerProvider(execution);
  if (execution.kind === "grok-build") return (await import("./grok-build/index.js")).createGrokBuildProvider(execution);
  if (execution.kind === "opencode-sdk") return (await import("./opencode-sdk/index.js")).createOpencodeProvider(execution);
  if (execution.kind === "pi") return (await import("./pi/index.js")).createPiProvider(execution);
  throw new TypeError(`unknown Akuma provider kind ${(execution as ProviderExecution).kind}`);
}

export async function resolveProviderExecution(input: unknown): Promise<Readonly<{
  execution: ProviderExecution;
  adapter: ProviderAdapter;
}>> {
  const execution = decodeProviderExecution(input);
  return Object.freeze({ execution, adapter: await adapterFor(execution) });
}
