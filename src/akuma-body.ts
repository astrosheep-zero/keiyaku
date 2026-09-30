import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEASH_HELD_EXIT, runAkumaBody, bodyLaunchSchema, type BodyLaunch } from "./akuma/body.js";
import { worldRootForAkumaPaths } from "./akuma/identity.js";
import { World } from "./world.js";
import { selectionRequestPort } from "./akuma/selection-owner-port.js";
import { selectionRequestCommands } from "./akuma/selection-request.js";
import { worktreeHooksFrom } from "./git/hooks.js";
import { contractRequestCommands, type ContractRequestPort } from "./library/contract-operations.js";
import {
  executeForwardedAudit,
  executeForwardedDeliver,
  executeForwardedReview,
} from "./library/contract-forwarding.js";
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
        ...(input.observe === undefined ? {} : { observe: input.observe }),
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
        ...(input.observe === undefined ? {} : { observe: input.observe }),
        contractId: input.contractId,
        requester: input.requester,
        ...(input.message === undefined ? {} : { message: input.message }),
        includeDirty: input.includeDirty,
        materializeConflict: input.materializeConflict,
        ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
        requireBranchesToBeUpToDate: requireBranchesToBeUpToDateFrom({ settings: configuration }),
        hooks: worktreeHooksFrom({ settings: configuration }),
        signal: input.signal,
      });
    },
    review: async (input) => {
      const [repo, configuration] = await contractDependencies(input.repoRoot, processConfiguration);
      return await executeForwardedReview({
        repo,
        ...(input.observe === undefined ? {} : { observe: input.observe }),
        contractId: input.contractId,
        requester: input.requester,
        verdict: input.verdict,
        signal: input.signal,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        hooks: worktreeHooksFrom({ settings: configuration }),
      });
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
      selectionRequestCommands(selectionRequestPort(world)),
      contractRequestCommands(contractUpstream(processConfiguration)),
      taskMutationRequestCommands(taskMutationRequestPort()),
    ),
  };
}

function bodyProcessConfiguration(): BodyProcessConfiguration {
  const mappedHome = process.env.KEIYAKU_HOME?.trim();
  const mappedGitPath = process.env.KEIYAKU_GIT_PATH;
  if (mappedGitPath !== undefined && mappedGitPath.trim().length === 0) {
    throw new TypeError("KEIYAKU_GIT_PATH requires a nonblank value");
  }
  return {
    ...(mappedHome === undefined || mappedHome.length === 0 ? {} : { home: mappedHome }),
    ...(mappedGitPath === undefined ? {} : { gitPath: mappedGitPath }),
  };
}

async function runBodyEntrypoint(): Promise<void> {
  const encoded = process.argv[2];
  if (encoded === undefined) throw new TypeError("Akuma body launch payload is missing");
  const launch = bodyLaunchSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  const { world, commands } = await externalRequestCommandsFor(launch, bodyProcessConfiguration());
  if ((await runAkumaBody(launch, world, commands)) === "held") process.exitCode = LEASH_HELD_EXIT;
}

/** Only the spawned entrypoint launches a Body; importing this module composes commands without side effects. */
function invokedAsBodyEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (invokedAsBodyEntrypoint()) await runBodyEntrypoint();
