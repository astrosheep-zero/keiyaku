import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvider } from "./server/provider.js";
import { createSdkTransport } from "./server/sdk.js";
import { attach } from "./server/attach.js";
import { attachRpc } from "./shared/attach-rpc.js";
import { refreshRpc } from "./shared/refresh-rpc.js";

export default function contribute(server: PluginServerContext) {
  const transport = createSdkTransport();
  const mirror = createProvider(transport);
  server.registerProvider(mirror.provider);
  server.handle(refreshRpc, (input) => mirror.refresh(input));
  server.handle(attachRpc, (input, context) => attach(input, context, mirror.sync));
  return async () => {
    try { await mirror.close(); } finally { await transport.close(); }
  };
}
