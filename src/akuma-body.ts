import { runAkumaBody, type BodyLaunch } from "./akuma/body.js";
import { worldRootForAkumaPaths } from "./akuma/identity.js";
import type { UpstreamExecutionPort } from "./akuma/requests.js";
import type { WorldRoot } from "./world.js";
import {
  executeKillAkuma,
  executeTellAkuma,
  executeWaitAkuma,
} from "./library/fleet.js";

function upstreamFor(launch: BodyLaunch): UpstreamExecutionPort {
  const path = worldRootForAkumaPaths(launch.paths) as WorldRoot;
  return {
    wait: async (input) => await executeWaitAkuma({
      path,
      ids: input.targets,
      completion: input.completion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      signal: input.signal,
    }),
    tell: async (input) => await executeTellAkuma({
      path,
      id: input.target,
      body: input.body,
      tellId: input.tellId,
      recordedAt: input.recordedAt,
      signal: input.signal,
    }),
    kill: async (input) => {
      const result = await executeKillAkuma({ path, ids: input.targets, signal: input.signal });
      return {
        result,
        service: result.results.map(({ id, evidence }) => ({ id, evidence })),
      };
    },
  };
}

await runAkumaBody(upstreamFor);
