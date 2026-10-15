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
  if (caller?.kind !== "external") return skip("caller is not an external host");
  const native = ["codex", "pi", "claude"].includes(caller.integration);
  let parentId = caller.id;
  const matches = (agent: { persistence?: { provider: string; sessionId: string } | null }) =>
    agent.persistence?.provider === caller.integration && agent.persistence.sessionId === caller.id;
  if (native) {
    const candidates: string[] = [];
    let cursor: string | undefined;
    do {
      const filter = { includeArchived: true, includeBackground: true };
      const page = await paseo.agents.list({ filter, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const { agent } of page.entries) if (matches(agent)) candidates.push(agent.id);
      if (candidates.length > 1) return skip(`ambiguous ${caller.integration} session ${caller.id}: multiple parents`);
      if (!page.pageInfo.hasMore) break;
      const next = page.pageInfo.nextCursor;
      if (!next || next === cursor) return skip("incomplete parent directory pagination");
      cursor = next;
    } while (cursor);
    if (!candidates[0]) return skip(`no parent for ${caller.integration} session ${caller.id}`);
    parentId = candidates[0];
  } else if (caller.integration !== "paseo") {
    return skip(`unsupported caller integration ${caller.integration}`);
  }
  const parent = await paseo.agents.ref(parentId).refresh();
  if (!parent) return skip(`parent ${parentId} does not exist`);
  if (parent.agent.archivedAt) return skip(`parent ${parentId} is archived`);
  if (native && !matches(parent.agent)) return skip(`parent ${parentId} changed native identity`);
  const world = await realpath(input.world);
  await paseo.agents.create({ parent: parentId, cwd: parent.agent.cwd, title: input.akuId,
    config: { provider: "keiyaku/mirror", options: { world, akuId: input.akuId } },
    idempotencyKey: `keiyaku:${world}:${input.akuId}`,
  });
  return { attached: true };
}
