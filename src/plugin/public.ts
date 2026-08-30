import type { WorldRoot } from "../world.js";

export type PluginManifest = Readonly<{
  id: string;
  apiVersion: 1;
  writablePaths?: readonly Readonly<{ name: string; path: string }>[];
}>;

export type PluginOutcome = Readonly<{ kind: "answered"; text: string }> | Readonly<{ kind: "failed"; reason: string }>;

export type PluginSignalMap = Readonly<{
  "akuma.initial-turn": Readonly<{
    akumaId: string;
    outcome: PluginOutcome;
    contractId?: string;
  }>;
}>;

export type PluginSignal = {
  [K in keyof PluginSignalMap]: Readonly<{ kind: K }> & PluginSignalMap[K];
}[keyof PluginSignalMap];

export type PluginHooks = Readonly<{
  [K in keyof PluginSignalMap]?: (signal: Readonly<{ kind: K }> & PluginSignalMap[K]) => Promise<void> | void;
}>;

export type PluginContext = Readonly<{
  world: WorldRoot;
  config: unknown;
  writablePath(name: string): string;
}>;

export type KeiyakuPlugin = Readonly<{
  manifest: PluginManifest;
  activate(context: PluginContext): Promise<PluginInstance> | PluginInstance;
}>;

export type PluginInstance = Readonly<{
  signals?: PluginHooks;
}>;
