import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LEASH_HELD_EXIT, runAkumaBody, bodyLaunchSchema, type BodyLaunch } from "./akuma/body.js";
import { worldRootForAkumaPaths } from "./akuma/identity.js";
import { World } from "./world.js";
import { selectionRequestPort } from "./akuma/selection-owner-port.js";
import { selectionRequestCommands } from "./akuma/selection-request.js";
import { contractRequestCommands, type ContractRequestPort } from "./library/contract-operations.js";
import { composeContractLibrary } from "./library/keiyaku.js";
import { localExecutionContext } from "./akuma/requests.js";
import { Repo } from "./library/repo.js";
import { settings } from "./settings.js";
import { taskMutationRequestCommands, type TaskLifecycleVerb, type TaskMutationRequestPort } from "./task/mutation.js";
import { Tasks, type Task, type TaskMutationResult } from "./task/index.js";
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

function contractChannel(
  repo: Repo,
  contractId: Parameters<ContractRequestPort["deliver"]>[0]["contractId"],
  requester: Parameters<ContractRequestPort["deliver"]>[0]["requester"],
  configuration: Awaited<ReturnType<typeof contractDependencies>>[1],
) {
  return composeContractLibrary(localExecutionContext(), { settings: configuration, actor: requester }).select({
    repo,
    id: contractId,
  });
}

function contractUpstream(processConfiguration: BodyProcessConfiguration): ContractRequestPort {
  return {
    audit: async (input) => {
      const [repo, configuration] = await contractDependencies(input.repoRoot, processConfiguration);
      return await contractChannel(repo, input.contractId, input.requester, configuration).audit(
        {
          includeDirty: input.includeDirty,
          showDiff: input.showDiff,
          signal: input.signal,
        },
        input.observe === undefined ? undefined : { observe: input.observe },
      );
    },
    deliver: async (input) => {
      const [repo, configuration] = await contractDependencies(input.repoRoot, processConfiguration);
      return await contractChannel(repo, input.contractId, input.requester, configuration).deliver(
        {
          includeDirty: input.includeDirty,
          materializeConflict: input.materializeConflict,
          ...(input.message === undefined ? {} : { message: input.message }),
          ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
          signal: input.signal,
        },
        input.observe === undefined ? undefined : { observe: input.observe },
      );
    },
    review: async (input) => {
      const [repo, configuration] = await contractDependencies(input.repoRoot, processConfiguration);
      return await contractChannel(repo, input.contractId, input.requester, configuration).review(
        {
          verdict: input.verdict,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          signal: input.signal,
        },
        input.observe === undefined ? undefined : { observe: input.observe },
      );
    },
  };
}

type TaskLifecycleInput = Readonly<{ note?: string; signal?: AbortSignal }>;

const TASK_LIFECYCLE: Readonly<
  Record<TaskLifecycleVerb, (handle: Task, input: TaskLifecycleInput) => Promise<TaskMutationResult>>
> = {
  start: async (handle, input) => await handle.start(input),
  stop: async (handle, input) => await handle.stop(input),
  hold: async (handle, input) => await handle.hold(input),
  resume: async (handle, input) => await handle.resume(input),
  done: async (handle, input) => await handle.done(input),
  drop: async (handle, input) => await handle.drop(input),
};

/**
 * The upper Body edge composes the forced-local Tasks SDK the descriptor
 * execution entries consume. Each ability is one ordinary local product
 * operation; no generic task(request) dispatcher is introduced here.
 */
function taskMutationRequestPort(): TaskMutationRequestPort {
  return {
    add: async ({ world, options }) => await Tasks.of(world).add(options),
    addDocument: async ({ world, document }) => await Tasks.of(world).addDocument(document),
    compose: async ({ world, markdown, defaultNamespace, actor, signal }) =>
      await Tasks.of(world).compose({
        markdown,
        namespace: defaultNamespace,
        actor,
        ...(signal === undefined ? {} : { signal }),
      }),
    update: async ({ world, id, options }) => await Tasks.of(world).task({ id }).update(options),
    lifecycle: async ({ world, verb, id, note, signal }) =>
      await TASK_LIFECYCLE[verb](Tasks.of(world).task({ id }), {
        ...(note === undefined ? {} : { note }),
        ...(signal === undefined ? {} : { signal }),
      }),
    batch: async ({ world, verb, ids, note, signal }) =>
      await Tasks.of(world).batch({
        verb,
        ids,
        ...(note === undefined ? {} : { note }),
        ...(signal === undefined ? {} : { signal }),
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
