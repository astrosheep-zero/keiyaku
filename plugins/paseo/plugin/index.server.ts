import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvider } from "./server/provider.js";
import { createSdkTransport } from "./server/sdk.js";
import { attach } from "./server/attach.js";
import { attachRpc } from "./shared/attach-rpc.js";
import { refreshRpc } from "./shared/refresh-rpc.js";
import { refreshOrReopen } from "./server/reopen.js";
import { registerModelCorrection } from "./server/model.js";
import { createRegistrationHandoff, registerRegistrationHooks } from "./server/handoff.js";

export default function contribute(server: PluginServerContext) {
  const transport = createSdkTransport();
  const handoff = createRegistrationHandoff();
  const mirror = createProvider(transport, handoff);
  server.registerProvider(mirror.provider);
  server.handle(refreshRpc, (input, context) => refreshOrReopen(context.paseo, input, mirror.refresh));
  server.handle(attachRpc, (input, context) => attach(input, context, transport.status));
  const removeModelCorrection = registerModelCorrection(server, transport.status);
  const removeHooks = registerRegistrationHooks(server, handoff);
  return async () => {
    removeHooks();
    removeModelCorrection();
    await handoff.close();
    try { await mirror.close(); } finally { await transport.close(); }
  };
}
