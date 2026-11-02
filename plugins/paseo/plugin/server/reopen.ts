import { realpath } from "node:fs/promises";
import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import { listMirrorCandidates, matchesCanonicalMirror } from "./mirror-identity.js";

const reopenInFlight = new Map<string, Promise<boolean>>();

async function reopenOne(paseo: PaseoApi, candidate: PaseoAgent, world: string, akuId: string): Promise<boolean> {
  const current = await paseo.agents.ref(candidate.id).refresh();
  if (!current || !(await matchesCanonicalMirror(current.agent, world, akuId))) return false;
  const handle: PaseoAgentHandle = paseo.agents.ref(current.agent);
  const timeline = await handle.timeline.refetch({ limit: 0 });
  if (timeline.error || !timeline.agent || !(await matchesCanonicalMirror(timeline.agent, world, akuId))) return false;
  return true;
}

export async function refreshOrReopen(paseo: PaseoApi, input: { world: string; akuId: string },
  refreshLocal: (input: { world: string; akuId: string }) => Promise<{ woken: number }>): Promise<{ woken: number }> {
  const world = await realpath(input.world);
  const local = await refreshLocal({ world, akuId: input.akuId });
  if (local.woken > 0) return local;

  let candidates: PaseoAgent[];
  try {
    candidates = await listMirrorCandidates(paseo, world, input.akuId);
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
