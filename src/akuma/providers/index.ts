import type { ProviderAdapter } from "../provider.js";
import { decodeProviderRecipe, type ProviderExecution } from "../provider-recipe.js";

export function decodeProviderExecution(input: unknown): ProviderExecution {
  const decoded = decodeProviderRecipe(input);
  return Object.freeze({
    name: decoded.name,
    kind: decoded.kind,
    ...(decoded.executable === undefined ? {} : { executable: decoded.executable }),
    ...(decoded.config === undefined ? {} : { config: decoded.config }),
    ...(decoded.env === undefined ? {} : { env: decoded.env }),
  });
}

async function adapterFor(execution: ProviderExecution): Promise<ProviderAdapter> {
  if (execution.kind === "acp") return (await import("./acp/index.js")).createAcpProvider(execution);
  if (execution.kind === "claude-agent-sdk") {
    const { claudeProvider, createClaudeProvider } = await import("./claude/index.js");
    return execution.executable === undefined && execution.config === undefined && execution.env === undefined
      ? claudeProvider
      : createClaudeProvider(execution);
  }
  if (execution.kind === "codex-app-server")
    return (await import("./codex-app-server/index.js")).createCodexAppServerProvider(execution);
  if (execution.kind === "grok-build")
    return (await import("./grok-build/index.js")).createGrokBuildProvider(execution);
  if (execution.kind === "opencode-sdk")
    return (await import("./opencode-sdk/index.js")).createOpencodeProvider(execution);
  if (execution.kind === "pi") return (await import("./pi/index.js")).createPiProvider(execution);
  throw new TypeError(`unknown Akuma provider kind ${(execution as ProviderExecution).kind}`);
}

export async function resolveProviderExecution(input: unknown): Promise<
  Readonly<{
    execution: ProviderExecution;
    adapter: ProviderAdapter;
  }>
> {
  const execution = decodeProviderExecution(input);
  return Object.freeze({ execution, adapter: await adapterFor(execution) });
}
