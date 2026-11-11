import { realpath } from "node:fs/promises";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { raceAbort } from "./transport.js";

const PAGE_SIZE = 200;
const mirrorPersistence = z.object({ version: z.literal(1),
  data: z.object({ world: z.string(), akuId: z.string() }) });

export function persistedMirrorIdentity(agent: PaseoAgent): { world: string; akuId: string } | undefined {
  if (agent.provider !== "keiyaku" || agent.persistence?.provider !== "keiyaku") return undefined;
  const parsed = mirrorPersistence.safeParse(agent.persistence.metadata?.pluginProviderPersistence);
  return parsed.success && parsed.data.data.world.length > 0 && parsed.data.data.akuId.length > 0
    ? parsed.data.data : undefined;
}

export async function matchesCanonicalMirror(agent: PaseoAgent, world: string, akuId: string): Promise<boolean> {
  if (agent.archivedAt) return false;
  const identity = persistedMirrorIdentity(agent);
  if (!identity || identity.akuId !== akuId) return false;
  try {
    return await realpath(identity.world) === world;
  } catch {
    return false;
  }
}

export async function listMirrorCandidates(paseo: PaseoApi, world: string, akuId: string,
  includeArchived = false, signal?: AbortSignal): Promise<PaseoAgent[]> {
  const candidates: PaseoAgent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const list = () => paseo.agents.list({ filter: { includeArchived: true, includeBackground: true },
      ...(signal ? { signal } : {}), page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
    const page = await (signal ? raceAbort(signal, list) : list());
    for (const { agent } of page.entries) {
      if (agent.archivedAt && !includeArchived) continue;
      const identity = persistedMirrorIdentity(agent);
      if (!identity || identity.akuId !== akuId) continue;
      try {
        if (await realpath(identity.world) === world) candidates.push(agent);
      } catch {
        throw new Error(`unreadable mirror World for ${akuId}`);
      }
    }
    if (!page.pageInfo.hasMore) return candidates;
    const next = page.pageInfo.nextCursor;
    if (!next || next === cursor || seenCursors.has(next)) throw new Error("incomplete Paseo agent directory pagination");
    seenCursors.add(next);
    cursor = next;
  }
}
