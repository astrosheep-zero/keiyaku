import type { ProviderAdapter } from "../provider.js";
import { claudeProvider } from "./claude.js";
import { codexAppServerProvider } from "./codex-app-server.js";

const PROVIDERS = {
  claude: claudeProvider,
  "codex-app-server": codexAppServerProvider,
} as const satisfies Readonly<Record<string, ProviderAdapter>>;

export function providerNamed(name: string): ProviderAdapter {
  if (!Object.hasOwn(PROVIDERS, name)) throw new TypeError(`unknown Akuma provider ${name}`);
  return PROVIDERS[name as keyof typeof PROVIDERS];
}
