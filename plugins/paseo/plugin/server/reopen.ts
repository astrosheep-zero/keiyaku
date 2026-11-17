import { realpath } from "node:fs/promises";
import type { PaseoAgentTimelineHandle, PaseoApi } from "@getpaseo/client";
import { matchesCanonicalMirror } from "./mirror-identity.js";
import { StaleDirectory, type DirectoryIndex } from "./directory.js";
import { raceAbort } from "./transport.js";

type Target = { world: string; akuId: string };

/** Recovery and attachment share the activation's current-connection directory. */
export function createReopener(directory: DirectoryIndex) {
  type Timeline = ReturnType<PaseoAgentTimelineHandle["refetch"]>;
  const inFlight = new Map<string, { signal: AbortSignal; result: Timeline }>();
  return async function refreshOrReopen(paseo: PaseoApi, input: Target,
    refreshLocal: (input: Target) => Promise<{ woken: number }>): Promise<{ woken: number }> {
    const world = await realpath(input.world);
    const local = await refreshLocal({ world, akuId: input.akuId });
    if (local.woken > 0) return local;
    const signal = AbortSignal.timeout(4000);
    try {
      return await raceAbort(signal, async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const evidence = await directory.read(paseo, signal);
            // Archived mappings still count towards ambiguity.
            const candidates = await evidence.mirrors(world, input.akuId);
            if (candidates.length !== 1 || candidates[0]!.archivedAt) return { woken: 0 };
            const candidate = candidates[0]!;
            const current = await raceAbort(signal, () => paseo.agents.ref(candidate.id).refresh());
            evidence.assertCurrent();
            if (!current) return evidence.changed(`mirror ${candidate.id} disappeared`);
            if (current.agent.id !== candidate.id || !(await matchesCanonicalMirror(current.agent, world, input.akuId)))
              return evidence.changed(`mirror ${candidate.id} changed identity or archive state`);
            evidence.assertCurrent();
            const key = `${candidate.id}\0${world}\0${input.akuId}`;
            let reopening = inFlight.get(key);
            if (!reopening || reopening.signal !== evidence.signal) {
              reopening = { signal: evidence.signal, result: paseo.agents.ref(current.agent).timeline.refetch({ limit: 0 }) };
              inFlight.set(key, reopening);
              void reopening.result.finally(() => { if (inFlight.get(key) === reopening) inFlight.delete(key); }).catch(() => {});
            }
            const timeline = await raceAbort(signal, () => reopening!.result);
            evidence.assertCurrent();
            const matched = !timeline.error && timeline.agent?.id === candidate.id &&
              await matchesCanonicalMirror(timeline.agent, world, input.akuId);
            evidence.assertCurrent();
            return { woken: matched ? 1 : 0 };
          } catch (error) {
            if (!(error instanceof StaleDirectory) || attempt === 1) throw error;
          }
        }
      });
    } catch (error) {
      console.warn(`Keiyaku mirror refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
      return { woken: 0 };
    }
  };
}
