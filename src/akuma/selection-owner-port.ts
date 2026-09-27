import type { AkumaStatus } from "./akuma.js";
import { requireBornAkuma } from "./akuma-probe.js";
import { executeKillAkuma, executeTellAkuma, executeAskAkuma, executeWaitAkuma } from "./selection-execution.js";
import type { SelectionRequestPort } from "./selection-request.js";
import type { WorldRoot } from "../world.js";

/**
 * The parent's Selection owner boundary: one forwarded request arrives as complete
 * identities the child resolved without reading a Heart, and this side answers
 * for them. It proves every target through the one addressability
 * normalization before the operation begins, so a refusal that reaches the wire
 * truthfully claims no product effect and a plural operation with an
 * unaddressable member never starts; the executor's own access to the target is
 * then the product act, never a second addressing probe.
 */
export function selectionRequestPort(world: WorldRoot): SelectionRequestPort {
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
    ask: async ({ target, ...request }) => {
      await prove([target]);
      return await executeAskAkuma({ path: world, id: target, ...request });
    },
    kill: async ({ targets, ...request }) => {
      await prove(targets);
      return await executeKillAkuma({ path: world, ids: targets, ...request });
    },
  };
}
