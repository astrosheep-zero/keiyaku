import type { AkumaStatus } from "./akuma.js";
import { requireBornAkuma } from "./akuma-probe.js";
import { Akuma as PublicAkuma } from "./akuma-instance.js";
import { executeKillAkuma, executeTellAkuma, executeTellWaitAkuma, executeWaitAkuma } from "./fleet-execution.js";
import type { FleetRequestPort } from "./fleet-request.js";
import { Schema } from "./schema.js";
import type { WorldRoot } from "../world.js";

/**
 * The parent's Fleet owner boundary: one forwarded request arrives as complete
 * identities the child resolved without reading a Heart, and this side answers
 * for them. It proves every target through the one addressability
 * normalization before the operation begins, so a refusal that reaches the wire
 * truthfully claims no product effect and a plural operation with an
 * unaddressable member never starts; the executor's own access to the target is
 * then the product act, never a second addressing probe.
 */
export function fleetRequestPort(world: WorldRoot): FleetRequestPort {
  const prove = async (targets: readonly AkumaStatus["id"][]): Promise<void> => {
    for (const id of targets) await requireBornAkuma(world, id);
  };
  return {
    wait: async ({ targets, ...request }) => {
      await prove(targets);
      return await executeWaitAkuma({ path: world, ids: targets, ...request });
    },
    tell: async ({ target, ...request }) => {
      await prove([target]);
      return await executeTellAkuma({ path: world, id: target, ...request });
    },
    tellWait: async ({ target, ...request }) => {
      await prove([target]);
      return await executeTellWaitAkuma({ path: world, id: target, ...request });
    },
    tellAnswer: async ({ target, ...request }) => {
      await prove([target]);
      return await PublicAkuma.select(world, target).tell(request.body, {
        schema: Schema.json(JSON.parse(request.schemaJson) as Record<string, unknown>, (value) => value),
        ...(request.interrupt === undefined ? {} : { interrupt: request.interrupt }),
        ...(request.initiator === undefined ? {} : { initiator: request.initiator }),
        signal: request.signal,
      });
    },
    kill: async ({ targets, ...request }) => {
      await prove(targets);
      return await executeKillAkuma({ path: world, ids: targets, ...request });
    },
  };
}
