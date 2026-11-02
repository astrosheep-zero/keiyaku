import { realpath } from "node:fs/promises";
import type { PaseoAgent } from "@getpaseo/client";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { attachRpc } from "../shared/attach-rpc.js";
import { listMirrorCandidates, matchesCanonicalMirror } from "./mirror-identity.js";

function skip(reason: string) {
  console.warn(`Keiyaku mirror not attached: ${reason}`);
  return { attached: false };
}
export async function attach(input: z.output<typeof attachRpc.input>, { paseo }: PluginHandlerContext) {
  const caller = input.caller;
  if (caller?.kind === "akuma") return attachToAkuma(input, caller, paseo);
  if (caller?.kind !== "external") return skip("caller is not an external host");
  const native = ["codex", "pi", "claude"].includes(caller.integration);
  let parentId = caller.id;
  const matches = (agent: { persistence?: { provider: string; sessionId: string } | null }) =>
    agent.persistence?.provider === caller.integration && agent.persistence.sessionId === caller.id;
  if (native) {
    const candidates: string[] = [];
    let cursor: string | undefined;
    do {
      const filter = { includeArchived: true };
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
  // Keep the creation fingerprint immutable: aliases belong to the forwarder's
  // rename path, not this idempotent request (including retries after rename).
  await paseo.agents.create({ parent: parentId, cwd: parent.agent.cwd, title: input.akuId,
    config: { provider: "keiyaku/mirror", options: { world, akuId: input.akuId } },
    idempotencyKey: `keiyaku:${world}:${input.akuId}`,
  });
  return { attached: true };
}

async function attachToAkuma(input: z.output<typeof attachRpc.input>,
  caller: Extract<NonNullable<z.output<typeof attachRpc.input>["caller"]>, { kind: "akuma" }>,
  paseo: PluginHandlerContext["paseo"]): Promise<{ attached: boolean }> {
  let parentWorld: string;
  let childWorld: string;
  try {
    [parentWorld, childWorld] = await Promise.all([realpath(caller.world), realpath(input.world)]);
  } catch {
    return skip("Akuma parent or child World is unavailable");
  }
  let candidates: PaseoAgent[];
  try {
    candidates = await listMirrorCandidates(paseo, parentWorld, caller.akuId, true);
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error));
  }
  if (candidates.length !== 1) return skip(candidates.length
    ? `ambiguous Akuma parent ${caller.akuId}: multiple mirrors`
    : `no mirror for Akuma parent ${caller.akuId}`);
  const candidate = candidates[0]!;
  let current: { agent: PaseoAgent } | null;
  try {
    current = await paseo.agents.ref(candidate.id).refresh();
  } catch (error) {
    return skip(`Akuma parent mirror ${candidate.id} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!current) return skip(`Akuma parent mirror ${candidate.id} does not exist`);
  if (current.agent.archivedAt) return skip(`Akuma parent mirror ${candidate.id} is archived`);
  if (!(await matchesCanonicalMirror(current.agent, parentWorld, caller.akuId))) {
    return skip(`Akuma parent mirror ${candidate.id} changed identity`);
  }
  const parentId = current.agent.id;
  await paseo.agents.create({ parent: parentId, cwd: current.agent.cwd, title: input.akuId,
    config: { provider: "keiyaku/mirror", options: { world: childWorld, akuId: input.akuId } },
    idempotencyKey: `keiyaku:${childWorld}:${input.akuId}`,
  });
  return { attached: true };
}
