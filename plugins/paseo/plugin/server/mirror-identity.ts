import { realpath } from "node:fs/promises";
import type { PaseoAgent } from "@getpaseo/client";
import { z } from "zod";

const mirrorPersistence = z.object({ version: z.literal(1),
  data: z.object({ world: z.string(), akuId: z.string() }) });

export function persistedMirrorIdentity(agent: PaseoAgent): { world: string; akuId: string } | undefined {
  if (agent.provider !== "keiyaku" || agent.persistence?.provider !== "keiyaku") return undefined;
  const parsed = mirrorPersistence.safeParse(agent.persistence.metadata?.pluginProviderPersistence);
  return parsed.success && parsed.data.data.world.length > 0 && parsed.data.data.akuId.length > 0
    ? parsed.data.data : undefined;
}

export async function matchesCanonicalMirror(agent: PaseoAgent, world: string, akuId: string, includeArchived = false): Promise<boolean> {
  if (agent.archivedAt && !includeArchived) return false;
  const identity = persistedMirrorIdentity(agent);
  if (!identity || identity.akuId !== akuId) return false;
  try {
    return await realpath(identity.world) === world;
  } catch {
    return false;
  }
}
