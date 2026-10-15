import { realpath } from "node:fs/promises";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { attachRpc } from "../shared/attach-rpc.js";

function skip(reason: string) {
  console.warn(`Keiyaku mirror not attached: ${reason}`);
  return { attached: false };
}
export async function attach(input: z.output<typeof attachRpc.input>, { paseo }: PluginHandlerContext) {
  const caller = input.caller;
  if (caller?.kind !== "external" || caller.integration !== "paseo") return skip("caller is not Paseo");
  const parent = await paseo.agents.ref(caller.id).refresh();
  if (!parent) return skip(`parent ${caller.id} does not exist`);
  const world = await realpath(input.world);
  await paseo.agents.create({ parent: caller.id, cwd: parent.agent.cwd,
    config: { provider: "keiyaku/mirror", options: { world, akuId: input.akuId } },
    idempotencyKey: `keiyaku:${world}:${input.akuId}`,
  });
  return { attached: true };
}
