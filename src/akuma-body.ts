import { LEASH_HELD_EXIT, runAkumaBody, type BodyLaunch } from "./akuma/body.js";
import { worldRootForAkumaPaths } from "./akuma/identity.js";
import { World } from "./world.js";
import { executeKillAkuma, executeTellAkuma, executeWaitAkuma } from "./akuma/fleet-execution.js";
import { fleetRequestCommands, type FleetRequestPort } from "./akuma/fleet-request.js";
import { worktreeHooksFrom } from "./git/hooks.js";
import {
  contractRequestCommands,
  executeForwardedAudit,
  executeForwardedDeliver,
  executeForwardedReview,
  type ContractRequestPort,
} from "./library/contract-operations.js";
import { Repo } from "./library/repo.js";
import { requireBranchesToBeUpToDateFrom, settings } from "./settings.js";
import { executeTaskMutation, taskMutationRequestCommands, type TaskMutationRequestPort } from "./task/mutation.js";
import { composeRequestCommands } from "./akuma/request-wire.js";

type BodyProcessConfiguration = Readonly<{ home?: string; gitPath?: string }>;

async function contractDependencies(repoRoot: string, processConfiguration: BodyProcessConfiguration) {
  const repo = await Repo.at({
    path: repoRoot,
    ...(processConfiguration.gitPath === undefined ? {} : { gitPath: processConfiguration.gitPath }),
  });
  if (repo.root !== repoRoot)
    throw new TypeError("forwarded Contract repoRoot must equal the canonical primary worktree");
  const world = await World.prove(repo.root);
  const configuration = await settings({
    root: world,
    ...(processConfiguration.home === undefined ? {} : { home: processConfiguration.home }),
  });
  return [repo, configuration] as const;
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

function fleetRequestPort(world: Awaited<ReturnType<typeof World.prove>>): FleetRequestPort {
  return {
    wait: async (input) =>
      await executeWaitAkuma({
        path: world,
        ids: input.targets,
        completion: input.completion,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: input.signal,
      }),
    tell: async (input) =>
      await executeTellAkuma({
        path: world,
        id: input.target,
        body: input.body,
        tellId: input.tellId,
        recordedAt: input.recordedAt,
        signal: input.signal,
      }),
    kill: async (input) => {
      const result = await executeKillAkuma({ path: world, ids: input.targets, signal: input.signal });
      return result;
    },
  };
}

function taskMutationRequestPort(): TaskMutationRequestPort {
  return {
    task: async (input) =>
      await executeTaskMutation({
        world: input.world,
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
export async function externalRequestCommandsFor(
  launch: BodyLaunch,
  processConfiguration: BodyProcessConfiguration,
): Promise<
  Readonly<{
    world: Awaited<ReturnType<typeof World.prove>>;
    commands: Readonly<Record<string, import("./akuma/request-wire.js").ErasedRequestCommand>>;
  }>
> {
  const world = await World.prove(worldRootForAkumaPaths(launch.paths));
  return {
    world,
    commands: composeRequestCommands(
      fleetRequestCommands(fleetRequestPort(world)),
      contractRequestCommands(contractUpstream(processConfiguration)),
      taskMutationRequestCommands(taskMutationRequestPort()),
    ),
  };
}

const { world, commands: externalCommands } = await externalRequestCommandsFor(launch, configuration);
if ((await runAkumaBody(launch, world, externalCommands)) === "held") process.exitCode = LEASH_HELD_EXIT;
