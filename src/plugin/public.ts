import type { WorldRoot } from "../world.js";

export type PluginManifest = Readonly<{
  id: string;
  apiVersion: 1;
  writablePaths?: readonly Readonly<{ name: string; path: string }>[];
}>;

export type PluginOutcome = Readonly<{ kind: "answered"; text: string }> | Readonly<{ kind: "failed"; reason: string }>;

export type PluginBodyEnd = "exited" | "broke-off" | "put-down" | "hung";

export type PluginAkumaOrigin =
  | Readonly<{ kind: "direct" }>
  | Readonly<{ kind: "request"; parent: string; requestId: string }>
  | Readonly<{ kind: "fork"; parent: string; at: string }>;

export type PluginAkumaCaller =
  | Readonly<{ kind: "akuma"; world: string; akuId: string }>
  | Readonly<{ kind: "external"; integration: string; id: string }>
  | Readonly<{ kind: "unknown" }>;

export type PluginSignalMap = Readonly<{
  "akuma.initiating": Readonly<{
    initiator: string;
  }>;
  "akuma.born": Readonly<{
    akumaId: string;
    bodySequence: number;
    origin: PluginAkumaOrigin;
    caller: PluginAkumaCaller;
    initiator?: string;
    contractId?: string;
  }>;
  "akuma.outcome-observed": Readonly<{
    akumaId: string;
    historyId: string;
    observer?: string;
  }>;
  "akuma.turn-started": Readonly<{
    akumaId: string;
    turnSequence: number;
    initiator?: string;
  }>;
  "akuma.turn-outcome": Readonly<{
    akumaId: string;
    bodySequence: number;
    turnSequence: number;
    initiator?: string;
    participants?: readonly string[];
    outcome: PluginOutcome;
    contractId?: string;
  }>;
  "akuma.body-ended": Readonly<{
    akumaId: string;
    bodySequence: number;
    end: PluginBodyEnd;
    initiator?: string;
    participants?: readonly string[];
    diagnostic?: string;
    contractId?: string;
  }>;
}>;

export type PluginSignal = {
  [K in keyof PluginSignalMap]: Readonly<{ kind: K }> & PluginSignalMap[K];
}[keyof PluginSignalMap];

export type PluginHooks = Readonly<{
  [K in keyof PluginSignalMap]?: (
    signal: Readonly<{ kind: K }> & PluginSignalMap[K],
    cancellation?: AbortSignal,
  ) => Promise<void> | void;
}>;

export type PluginContext = Readonly<{
  world: WorldRoot;
  config: unknown;
  writablePath(name: string): string;
}>;

export type KeiyakuPlugin = Readonly<{
  manifest: PluginManifest;
  activate(context: PluginContext, cancellation?: AbortSignal): Promise<PluginInstance> | PluginInstance;
}>;

export type PluginWaitDeferralInput = Readonly<{ akumaIds: readonly string[] }>;

export type PluginWaitDeferral = Readonly<{
  close(cancellation?: AbortSignal): Promise<void> | void;
}>;

export type PluginInstance = Readonly<{
  signals?: PluginHooks;
  waitDeferral?: (
    input: PluginWaitDeferralInput,
    cancellation?: AbortSignal,
  ) => Promise<PluginWaitDeferral | undefined> | PluginWaitDeferral | undefined;
}>;
