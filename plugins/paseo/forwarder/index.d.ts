import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { KeiyakuPlugin } from "@astrosheep/keiyaku/plugin";
type Client = Pick<DaemonClient, "invokePluginRpc" | "close">;
export declare function createForwarder(openClient?: (signal: AbortSignal) => Promise<Client>): KeiyakuPlugin;
declare const _default: Readonly<{
    manifest: import("@astrosheep/keiyaku/plugin").PluginManifest;
    activate(context: import("@astrosheep/keiyaku/plugin").PluginContext, cancellation?: AbortSignal): Promise<import("@astrosheep/keiyaku/plugin").PluginInstance> | import("@astrosheep/keiyaku/plugin").PluginInstance;
}>;
export default _default;
