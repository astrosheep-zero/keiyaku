import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvider } from "./server/provider.js";
import { attach } from "./server/attach.js";
import { attachRpc } from "./shared/attach-rpc.js";
import { refreshRpc } from "./shared/refresh-rpc.js";

export default function contribute(server: PluginServerContext) {
  const mirror = createProvider();
  server.registerProvider(mirror.provider);
  server.handle(refreshRpc, (input) => mirror.refresh(input));
  server.handle(attachRpc, attach);
  return () => mirror.close();
}
