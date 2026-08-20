import { runAkumaBody, type BodyLaunch } from "./akuma/body.js";
import { worldRootForAkumaPaths } from "./akuma/identity.js";
import type { UpstreamExecutionPort } from "./akuma/request-serve.js";
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
import { executeTaskMutation } from "./task/mutation.js";

type BodyProcessConfiguration = Readonly<{ home?: string; gitPath?: string }>;

export function upstreamFor(
  launch: BodyLaunch,
  processConfiguration: BodyProcessConfiguration,
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
        Repo.at({
          path: input.repoRoot,
          ...(processConfiguration.gitPath === undefined ? {} : { gitPath: processConfiguration.gitPath }),
        }),
        settings({
          root: input.repoRoot as WorldRoot,
          ...(processConfiguration.home === undefined ? {} : { home: processConfiguration.home }),
        }),
      ]);
      return await executeForwardedDeliver({
        repo,
        contractId: input.contractId,
        requester: input.requester,
        ...(input.message === undefined ? {} : { message: input.message }),
        includeDirty: input.includeDirty,
        materializeConflict: input.materializeConflict,
        requireBranchesToBeUpToDate: requireBranchesToBeUpToDateFrom({ settings: configuration }),
        hooks: worktreeHooksFrom({ settings: configuration }),
        signal: input.signal,
      });
    },
    review: async (input) => {
      const [repo, configuration] = await Promise.all([
        Repo.at({
          path: input.repoRoot,
          ...(processConfiguration.gitPath === undefined ? {} : { gitPath: processConfiguration.gitPath }),
        }),
        settings({
          root: input.repoRoot as WorldRoot,
          ...(processConfiguration.home === undefined ? {} : { home: processConfiguration.home }),
        }),
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
    task: async (input) => await executeTaskMutation({
      world: input.world as WorldRoot,
      request: input.request,
      requester: input.requester,
      signal: input.signal,
    }),
  };
}

const encoded = process.argv[2];
if (encoded === undefined) throw new TypeError("Akuma body launch payload is missing");
const launch = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as BodyLaunch;
const mappedHome = process.env.KEIYAKU_HOME?.trim();
const mappedGitPath = process.env.KEIYAKU_GIT_PATH;
if (mappedGitPath !== undefined && mappedGitPath.trim().length === 0) {
  throw new TypeError("KEIYAKU_GIT_PATH requires a nonblank value");
}
const configuration = {
  ...(mappedHome === undefined || mappedHome.length === 0 ? {} : { home: mappedHome }),
  ...(mappedGitPath === undefined ? {} : { gitPath: mappedGitPath }),
};
await runAkumaBody(launch, upstreamFor(launch, configuration));
