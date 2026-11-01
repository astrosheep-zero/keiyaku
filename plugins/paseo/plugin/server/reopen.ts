import { realpath } from "node:fs/promises";
import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import { z } from "zod";

const PAGE_SIZE = 200;
const mirrorPersistence = z.object({ version: z.literal(1),
  data: z.object({ world: z.string(), akuId: z.string() }) });
const reopenInFlight = new Map<string, Promise<boolean>>();

function metadataMatches(agent: PaseoAgent, akuId: string): boolean {
  if (agent.provider !== "keiyaku" || agent.archivedAt || agent.persistence?.provider !== "keiyaku") return false;
  const parsed = mirrorPersistence.safeParse(agent.persistence.metadata?.pluginProviderPersistence);
  return parsed.success && parsed.data.data.world.length > 0 && parsed.data.data.akuId === akuId;
}

async function matchesCanonicalIdentity(agent: PaseoAgent, world: string, akuId: string): Promise<boolean> {
  if (!metadataMatches(agent, akuId)) return false;
  const parsed = mirrorPersistence.parse(agent.persistence!.metadata!.pluginProviderPersistence);
  try {
    return await realpath(parsed.data.world) === world && parsed.data.akuId === akuId;
  } catch {
    return false;
  }
}

async function listCandidates(paseo: PaseoApi, world: string, akuId: string): Promise<PaseoAgent[]> {
  const candidates: PaseoAgent[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await paseo.agents.list({ filter: { includeArchived: true, includeBackground: true },
      page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
    for (const { agent } of page.entries) if (await matchesCanonicalIdentity(agent, world, akuId)) candidates.push(agent);
    if (!page.pageInfo.hasMore) return candidates;
    const next = page.pageInfo.nextCursor;
    if (!next || next === cursor || seenCursors.has(next)) throw new Error("incomplete Paseo agent directory pagination");
    seenCursors.add(next);
    cursor = next;
  }
}

async function reopenOne(paseo: PaseoApi, candidate: PaseoAgent, world: string, akuId: string): Promise<boolean> {
  const current = await paseo.agents.ref(candidate.id).refresh();
  if (!current || !(await matchesCanonicalIdentity(current.agent, world, akuId))) return false;
  const handle: PaseoAgentHandle = paseo.agents.ref(current.agent);
  const timeline = await handle.timeline.refetch({ limit: 0 });
  if (timeline.error || !timeline.agent || !(await matchesCanonicalIdentity(timeline.agent, world, akuId))) return false;
  return true;
}

export async function refreshOrReopen(paseo: PaseoApi, input: { world: string; akuId: string },
  refreshLocal: (input: { world: string; akuId: string }) => Promise<{ woken: number }>): Promise<{ woken: number }> {
  const world = await realpath(input.world);
  const local = await refreshLocal({ world, akuId: input.akuId });
  if (local.woken > 0) return local;

  let candidates: PaseoAgent[];
  try {
    candidates = await listCandidates(paseo, world, input.akuId);
  } catch (error) {
    console.warn(`Keiyaku mirror refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { woken: 0 };
  }
  let woken = 0;
  for (const candidate of candidates) {
    const key = `${candidate.id}\0${world}\0${input.akuId}`;
    let reopening = reopenInFlight.get(key);
    if (!reopening) {
      reopening = reopenOne(paseo, candidate, world, input.akuId).catch((error: unknown) => {
        console.warn(`Keiyaku mirror ${candidate.id} was not reopened: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }).finally(() => reopenInFlight.delete(key));
      reopenInFlight.set(key, reopening);
    }
    if (await reopening) woken++;
  }
  return { woken };
}
