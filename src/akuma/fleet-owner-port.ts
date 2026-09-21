import type { AkumaStatus } from "./akuma.js";
import { AkumaObservationError, AkumaNotBornError } from "./akuma-errors.js";
import { Akuma as PublicAkuma } from "./akuma-instance.js";
import { probeBornAkuma } from "./akuma-probe.js";
import { executeKillAkuma, executeTellAkuma, executeTellWaitAkuma, executeWaitAkuma } from "./fleet-execution.js";
import type { FleetRequestPort } from "./fleet-request.js";
import { Schema } from "./schema.js";
import type { WorldRoot } from "../world.js";

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The parent's Fleet owner boundary: one forwarded request arrives as complete
 * identities the child already resolved, and this side answers for them.
 * Addressing a target here is what keeps a refusal in the caller's vocabulary —
 * a missing Heart is an absent Akuma, an unreadable one is an observation
 * failure that keeps its reason with the identity — so the transport never has
 * to guess at a bare storage error, and a genuine action failure after the
 * target is established stays its own unclassified failure.
 */
export function fleetRequestPort(world: WorldRoot): FleetRequestPort {
  const addressable = async (id: AkumaStatus["id"]): Promise<void> => {
    let born: boolean;
    try {
      born = await probeBornAkuma(world, id);
    } catch (error) {
      throw new AkumaObservationError(id, diagnostic(error));
    }
    if (!born) throw new AkumaNotBornError(id);
  };
  return {
    wait: async (input) => {
      for (const id of input.targets) await addressable(id);
      return await executeWaitAkuma({
        path: world,
        ids: input.targets,
        completion: input.completion,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: input.signal,
      });
    },
    tell: async (input) => {
      await addressable(input.target);
      return await executeTellAkuma({
        path: world,
        id: input.target,
        body: input.body,
        tellId: input.tellId,
        recordedAt: input.recordedAt,
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        signal: input.signal,
      });
    },
    tellWait: async (input) => {
      await addressable(input.target);
      return await executeTellWaitAkuma({
        path: world,
        id: input.target,
        body: input.body,
        tellId: input.tellId,
        recordedAt: input.recordedAt,
        timeoutMs: input.timeoutMs,
        ...(input.schemaJson === undefined ? {} : { schemaJson: input.schemaJson }),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt }),
        signal: input.signal,
      });
    },
    tellAnswer: async (input) => {
      await addressable(input.target);
      return await PublicAkuma.select(world, input.target).tell(input.body, {
        schema: Schema.json(JSON.parse(input.schemaJson) as Record<string, unknown>, (value) => value),
        ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt }),
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
        signal: input.signal,
      });
    },
    kill: async (input) => {
      for (const id of input.targets) await addressable(id);
      return await executeKillAkuma({ path: world, ids: input.targets, signal: input.signal });
    },
  };
}
