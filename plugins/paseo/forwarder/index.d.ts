import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { KeiyakuPlugin } from "@astrosheep/keiyaku/plugin";
type Client = Pick<DaemonClient, "invokePluginRpc" | "fetchAgents" | "updateAgent" | "close">;
export declare function syncMirrorTitles(client: Pick<Client, "fetchAgents" | "updateAgent">, path: string, akuId?: string, signal?: AbortSignal): Promise<number>;
export declare function backfillMirrorTitles(path: string, akuId?: string, signal?: AbortSignal, openClient?: (signal: AbortSignal) => Promise<Client>): Promise<number>;
export declare function createForwarder(openClient?: (signal: AbortSignal) => Promise<Client>): KeiyakuPlugin;
declare const _default: Readonly<{
    manifest: import("@astrosheep/keiyaku").PluginManifest;
    activate(context: import("@astrosheep/keiyaku").PluginContext, cancellation?: AbortSignal): Promise<import("@astrosheep/keiyaku").PluginInstance> | import("@astrosheep/keiyaku").PluginInstance;
}>;
export default _default;
