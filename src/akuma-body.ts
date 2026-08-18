import { runAkumaBody, type BodyLaunch } from "./akuma/body.js";
import { worldRootForAkumaPaths } from "./akuma/identity.js";
import type { UpstreamExecutionPort } from "./akuma/requests.js";
import type { WorldRoot } from "./world.js";
import {
  executeKillAkuma,
  executeTellAkuma,
  executeWaitAkuma,
} from "./library/fleet.js";
import {
  requireBranchesToBeUpToDateFrom,
  worktreeHooksFrom,
} from "./library/configuration.js";
import {
  executeForwardedDeliver,
  executeForwardedReview,
} from "./library/contract.js";
import { Repo } from "./library/repo.js";
import { settings } from "./settings.js";

export function upstreamFor(
  launch: BodyLaunch,
  settingsCoordinates: Readonly<{ home?: string }>,
): UpstreamExecutionPort {
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
    deliver: async (input) => {
      const [repo, configuration] = await Promise.all([
        Repo.at({ path: input.repoRoot }),
        settings({ root: input.repoRoot as WorldRoot, ...settingsCoordinates }),
      ]);
      return await executeForwardedDeliver({
        repo,
        contractId: input.contractId,
        requester: input.requester,
        ...(input.message === undefined ? {} : { message: input.message }),
        includeDirty: input.includeDirty,
        requireBranchesToBeUpToDate: requireBranchesToBeUpToDateFrom({ settings: configuration }),
        hooks: worktreeHooksFrom({ settings: configuration }),
        signal: input.signal,
      });
    },
    review: async (input) => {
      const [repo, configuration] = await Promise.all([
        Repo.at({ path: input.repoRoot }),
        settings({ root: input.repoRoot as WorldRoot, ...settingsCoordinates }),
      ]);
      return await executeForwardedReview({
        repo,
        contractId: input.contractId,
        requester: input.requester,
        verdict: input.verdict,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        hooks: worktreeHooksFrom({ settings: configuration }),
      });
    },
  };
}

await runAkumaBody(upstreamFor);
