import type { ProviderAdapter } from "../provider.js";
import type { ProviderExecution } from "../provider-recipe.js";

export { decodeProviderRecipe as decodeProviderExecution } from "../provider-recipe.js";

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

export async function resolveProviderExecution(execution: ProviderExecution): Promise<
  Readonly<{
    execution: ProviderExecution;
    adapter: ProviderAdapter;
  }>
> {
  return Object.freeze({ execution, adapter: await adapterFor(execution) });
}
