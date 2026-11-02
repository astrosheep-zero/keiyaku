import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderConfigState } from "@getpaseo/plugin/server/provider";
import type { StatusReader } from "./transport.js";

const identity = z.object({ world: z.string().min(1), akuId: z.string().regex(/^aku\//u) });

export async function mirrorTarget(value: unknown): Promise<{ world: string; akuId: string }> {
  const target = identity.parse(value);
  return { world: await realpath(target.world), akuId: target.akuId };
}

export function registerModelCorrection(server: Pick<PluginServerContext, "before">, status: StatusReader): () => void {
  return server.before("agent.create", async ({ request }, context) => {
    if (request.config.provider !== "keiyaku") return;
    const { model: _placeholder, ...config } = request.config;
    try {
      const target = await mirrorTarget(config.providerOptions);
      const observed = await status(target.world, target.akuId, context.signal);
      return { ...request, config: { ...config, ...(observed.model === undefined ? {} : { model: observed.model }) } };
    } catch (error) {
      console.warn(`Keiyaku mirror model unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return { ...request, config };
    }
  });
}

/** A mirror reports the public Akuma configuration; it cannot change it. */
export function modelConfig(status: { provider?: string; model?: string }): ProviderConfigState {
  return {
    ...(status.model === undefined ? {} : { model: status.model }),
    models: status.model === undefined ? [] : [{
      id: status.model,
      label: status.provider ? `${status.provider} / ${status.model}` : status.model,
      isSelectable: false,
    }],
    modes: [], thinkingOptions: [], settings: [],
  };
}
