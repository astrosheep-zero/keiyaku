import { LEASH_HELD_EXIT, runAkumaBody, type BodyLaunch } from "./akuma/body.js";
import { akumaCallRequestCommands } from "./akuma/call-request.js";
import { worldRootForAkumaPaths } from "./akuma/identity.js";
import type { WorldRoot } from "./world.js";
import { executeKillAkuma, executeTellAkuma, executeWaitAkuma } from "./library/fleet.js";
import { fleetRequestCommands, type FleetRequestPort } from "./library/fleet.js";
import { requireBranchesToBeUpToDateFrom, worktreeHooksFrom } from "./library/configuration.js";
import {
  contractRequestCommands,
  executeForwardedAudit,
  executeForwardedDeliver,
  executeForwardedReview,
  type ContractRequestPort,
} from "./library/contract-operations.js";
import { Repo } from "./library/repo.js";
import { settings } from "./settings.js";
import { executeTaskMutation, taskMutationRequestCommands, type TaskMutationRequestPort } from "./task/mutation.js";

type BodyProcessConfiguration = Readonly<{ home?: string; gitPath?: string }>;

async function contractDependencies(repoRoot: string, processConfiguration: BodyProcessConfiguration) {
  return await Promise.all([
    Repo.at({
      path: repoRoot,
      ...(processConfiguration.gitPath === undefined ? {} : { gitPath: processConfiguration.gitPath }),
    }),
    settings({
      root: repoRoot as WorldRoot,
      ...(processConfiguration.home === undefined ? {} : { home: processConfiguration.home }),
    }),
  ]);
}

function contractUpstream(processConfiguration: BodyProcessConfiguration): ContractRequestPort {
  return {
    audit: async (input) => {
      const [repo, configuration] = await contractDependencies(input.repoRoot, processConfiguration);
      return await executeForwardedAudit({
        repo,
        contractId: input.contractId,
        requester: input.requester,
        includeDirty: input.includeDirty,
        showDiff: input.showDiff,
        requireBranchesToBeUpToDate: requireBranchesToBeUpToDateFrom({ settings: configuration }),
        hooks: worktreeHooksFrom({ settings: configuration }),
        signal: input.signal,
      });
    },
    deliver: async (input) => {
      const [repo, configuration] = await contractDependencies(input.repoRoot, processConfiguration);
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
      const [repo, configuration] = await contractDependencies(input.repoRoot, processConfiguration);
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

export function upstreamFor(
  launch: BodyLaunch,
  processConfiguration: BodyProcessConfiguration,
): FleetRequestPort & ContractRequestPort & TaskMutationRequestPort {
  const path = worldRootForAkumaPaths(launch.paths) as WorldRoot;
  return {
    ...contractUpstream(processConfiguration),
    wait: async (input) =>
      await executeWaitAkuma({
        path,
        ids: input.targets,
        completion: input.completion,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: input.signal,
      }),
    tell: async (input) =>
      await executeTellAkuma({
        path,
        id: input.target,
        body: input.body,
        tellId: input.tellId,
        recordedAt: input.recordedAt,
        signal: input.signal,
      }),
    kill: async (input) => {
      const result = await executeKillAkuma({ path, ids: input.targets, signal: input.signal });
      return result;
    },
    task: async (input) =>
      await executeTaskMutation({
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
const upstream = upstreamFor(launch, configuration);
const commands = {
  ...akumaCallRequestCommands(),
  ...fleetRequestCommands(),
  ...contractRequestCommands(),
  ...taskMutationRequestCommands(),
};
if ((await runAkumaBody(launch, upstream, commands)) === "held") process.exitCode = LEASH_HELD_EXIT;
