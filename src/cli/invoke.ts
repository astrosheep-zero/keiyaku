import { captureRoute } from "@astrosheep/square";
import { resolveActor } from "./actor.js";
import { isParsedAkumaCommand, type InvokedAkumaCommand } from "./commands/akuma.js";
import type { AkumaInvocationResult } from "./commands/akuma-invoke.js";
import { invokeContractMutation } from "./commands/contract-invoke.js";
import type { InstallInvocationResult } from "./commands/install.js";
import type { TaskInvocationResult } from "./commands/task-invoke.js";
import {
  assertExplicitRepoUse,
  CliUsageError,
  renderCommandUsage,
  type ParsedCommand,
  type ParsedExecution,
} from "./parse.js";
import { isBlankInput } from "./usage.js";
import type { InvocationResult, RegionResult } from "./result.js";
import type { SelectedContract } from "./selectors.js";
import type { ActorId, ContractId } from "../index.js";
import type { KanshiRegionSelection } from "../kanshi/index.js";
import type { Repo } from "../library/repo.js";
import type { Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";

export type { AcceptedFact, InvocationResult, Lag } from "./result.js";

type InvokeRuntime = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  actor?: ActorId;
  onOperationStart?: () => void;
}>;

type NonInstallExecution = Readonly<{
  cwd?: string;
  repo?: string;
  command: Exclude<ParsedCommand, { command: "install" }>;
}>;
type InvocationEdge = Readonly<{
  environment: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
}>;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function selectedStdinDiagnostic(command: Exclude<ParsedCommand, { command: "install" }>): string | undefined {
  switch (command.command) {
    case "bind":
      if (command.forkOf !== undefined) return undefined;
      return `${command.command} requires a nonblank stdin document`;
    case "arc":
      return `${command.command} requires a nonblank stdin document`;
    case "amend":
      return command.stdin === true ? "amend requires a nonblank stdin document" : undefined;
    case "review":
      return command.summaryFromStdin === true ? "review requires a nonblank summary" : undefined;
    case "call":
    case "tell":
      return command.prompt.kind === "stdin" ? `${command.command} requires a nonblank prompt` : undefined;
    case "task":
      switch (command.stdin) {
        case "document":
          return "task add requires a nonblank stdin document";
        case "compose":
          return "task compose requires a nonblank stdin document";
        case "body":
          return "task update --body requires a nonblank value";
        case "append":
          return "task update --append requires a nonblank value";
        case "note":
          return "task update --note requires a nonblank value";
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

async function withAcquiredStdin(
  command: Exclude<ParsedCommand, { command: "install" }>,
  runtime: InvokeRuntime,
): Promise<InvokeRuntime> {
  const diagnostic = selectedStdinDiagnostic(command);
  if (diagnostic === undefined) return runtime;
  const bytes = await (runtime.readStdin ?? readStdin)();
  if (isBlankInput(bytes)) throw new CliUsageError(diagnostic);
  return { ...runtime, readStdin: async () => bytes };
}

export type SettingsInvocationResult = Readonly<{ kind: "settings"; value: Settings }>;
export type GuidanceInvocationResult = Readonly<{ kind: "guidance"; contract: ContractId; guidance: string }>;

async function settingsAt(root: WorldRoot | undefined, home?: string): Promise<Settings> {
  const { settings } = await import("../settings.js");
  return settings({ ...(root === undefined ? {} : { root }), ...(home === undefined ? {} : { home }) });
}

function consumeSettings<T>(run: () => T, ErrorType: new (message: string) => Error): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ErrorType) throw new CliUsageError(error.message);
    throw error;
  }
}

function actorFromEdge(actor: string | undefined, environment: NodeJS.ProcessEnv): ActorId | undefined {
  let resolved: ActorId | undefined;
  try {
    resolved = resolveActor({ env: environment, ...(actor === undefined ? {} : { actor }) });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
  return resolved;
}

function gitPathFromEdge(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.KEIYAKU_GIT_PATH;
  if (value === undefined) return undefined;
  if (value.trim().length === 0) throw new CliUsageError("KEIYAKU_GIT_PATH requires a nonblank value");
  return value;
}

async function selectContract(repo: Repo, selector: string | undefined, scope: string): Promise<SelectedContract> {
  const { contractFromInput, resolveContextualContract } = await import("./selectors.js");
  if (selector !== undefined && !selector.startsWith("@")) return contractFromInput(repo, selector);
  const { Keiyaku } = await import("../library/keiyaku.js");
  const id = resolveContextualContract(await Keiyaku.list({ repo }), selector, scope);
  return contractFromInput(repo, id);
}

type AkumaEdgeInput = Readonly<{
  located: WorldRoot | null;
  candidate: WorldRoot | null;
  establish: () => Promise<WorldRoot>;
  statedCwd?: string;
  invocationCwd: string;
  repo?: Repo;
  home?: string;
  edge: InvocationEdge;
}>;

async function invokeAkumaFromEdge(parsed: InvokedAkumaCommand, input: AkumaEdgeInput) {
  try {
    const { statedCwd, repo, edge } = input;
    const path = await akumaWorldFor(parsed, input.located, input.candidate, input.establish);
    const home = parsed.command === "call" ? input.home : undefined;
    const configuration = parsed.command === "call" ? await settingsAt(path, home) : undefined;
    if (parsed.command === "call" && parsed.contract !== undefined && repo === undefined) {
      throw new Error("call with Contract requires a resolved Repo");
    }
    const { invokeAkuma } = await import("./commands/akuma-invoke.js");
    const contract =
      parsed.command === "call" && parsed.contract !== undefined
        ? (await import("./selectors.js")).contractFromInput(repo as Repo, parsed.contract).contract
        : undefined;
    const resultRoute =
      parsed.command === "call" ? captureRoute({ cwd: input.invocationCwd, env: edge.environment }) : null;
    return await invokeAkuma(parsed, {
      path,
      ...(statedCwd === undefined ? {} : { statedCwd }),
      ...(home === undefined ? {} : { home }),
      ...(configuration === undefined ? {} : { settings: configuration }),
      ...(contract === undefined ? (repo === undefined ? {} : { repo }) : { contract }),
      ...(resultRoute === null ? {} : { resultRoute }),
      readStdin: edge.readStdin,
    });
  } catch (error) {
    const { AkumaWorldScopeError } = await import("../library/address.js");
    if (error instanceof AkumaWorldScopeError) throw error;
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}

async function akumaWorldFor(
  parsed: InvokedAkumaCommand,
  located: WorldRoot | null,
  candidate: WorldRoot | null,
  establish: () => Promise<WorldRoot>,
): Promise<WorldRoot> {
  const world = parsed.command === "call" ? (candidate ?? (await establish())) : located;
  if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
  return world;
}

async function invokeCatalog(
  parsed: Extract<ParsedCommand, { command: "ls" }>,
  world: WorldRoot | null,
  repo: Repo | undefined,
  home?: string,
) {
  try {
    const { Keiyaku } = await import("../library/keiyaku.js");
    if (parsed.query.kind === "contracts") {
      if (repo === undefined) throw new Error("Contract catalog requires a resolved Repo");
      return { kind: "catalog" as const, catalog: await Keiyaku.ls({ query: parsed.query, repo }) };
    }
    if (parsed.query.kind === "archetypes") {
      return {
        kind: "catalog" as const,
        catalog: await Keiyaku.ls({ query: parsed.query, ...(home === undefined ? {} : { home }) }),
      };
    }
    if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
    if (parsed.query.kind === "tasks") {
      return { kind: "catalog" as const, catalog: await Keiyaku.ls({ query: parsed.query, path: world }) };
    }
    return { kind: "catalog" as const, catalog: await Keiyaku.ls({ query: parsed.query, path: world }) };
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    throw error;
  }
}

async function invokeStatus(
  parsed: Extract<ParsedCommand, { command: "status" }>,
  world: WorldRoot | null,
  repo: Repo | undefined,
) {
  if (parsed.akuma === true) {
    if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
    return (await import("./commands/akuma-invoke.js")).invokeAkumaStatus(world, parsed.contract, undefined, repo);
  }
  const { kanshi, observeKanshi, selectKanshi } = await import("../kanshi/index.js");
  if (parsed.contract === undefined) {
    const report = await kanshi({ world, ...(repo === undefined ? {} : { repo }) });
    return { kind: "status" as const, report, selection: "world" as const };
  }
  if (parsed.contract.startsWith("@")) {
    try {
      const observation = await observeKanshi({ world, ...(repo === undefined ? {} : { repo }) });
      const { resolveNamedAddress } = await import("../library/address.js");
      const address = resolveNamedAddress({
        selector: parsed.contract,
        report: observation.report,
        aliases: observation.aliases,
      });
      if (address.kind === "akuma") {
        if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
        return (await import("./commands/akuma-invoke.js")).invokeAkumaStatus(world, address.id, parsed.contract, repo);
      }
      if (repo === undefined) throw new CliUsageError("cannot select a contract while the Contract world is absent");
      return {
        kind: "status" as const,
        report: await kanshi({ world, repo, contract: address.id }),
        selection: "contract" as const,
      };
    } catch (error) {
      if (error instanceof TypeError) throw new CliUsageError(error.message);
      throw error;
    }
  }
  if (parsed.contract.startsWith("kei/")) {
    if (repo === undefined) throw new CliUsageError("cannot select a contract while the Contract world is absent");
    const { canonicalContractSelector } = await import("./selectors.js");
    const contract = canonicalContractSelector(parsed.contract);
    return {
      kind: "status" as const,
      report: await kanshi({ world, repo, contract }),
      selection: "contract" as const,
    };
  }
  const report = await kanshi({ world, ...(repo === undefined ? {} : { repo }) });
  const { resolveKanshiContract } = await import("./selectors.js");
  const contract = resolveKanshiContract(report, parsed.contract);
  return { kind: "status" as const, report: selectKanshi({ report, contract }), selection: "contract" as const };
}

async function invokeRegion(
  parsed: Extract<ParsedCommand, { command: "region" }>,
  world: WorldRoot | null,
  repo: Repo,
): Promise<RegionResult> {
  const { kanshi, selectRegion } = await import("../kanshi/index.js");
  const read = async (region: KanshiRegionSelection) => {
    try {
      return await kanshi({ world, repo, region });
    } catch (error) {
      if (error instanceof TypeError) throw new CliUsageError(error.message);
      throw error;
    }
  };
  if (parsed.paths !== undefined) {
    const report = await read({ kind: "path", patterns: parsed.paths });
    return { kind: "region", region: report.region ?? { kind: "absent" } };
  }
  if (parsed.contract === undefined) {
    const report = await read({ kind: "declarations" });
    return { kind: "region", region: report.region ?? { kind: "absent" } };
  }
  const report = await read({ kind: "declarations" });
  const { resolveKanshiContract } = await import("./selectors.js");
  const contract = resolveKanshiContract(report, parsed.contract) as ContractId;
  if (
    report.contracts.kind !== "present" ||
    report.contracts.value.rows.every((row) => row.id !== contract || row.disposition !== "active")
  ) {
    throw new CliUsageError(`unknown contract selector: ${parsed.contract}`);
  }
  if (report.region?.kind !== "present" || report.region.value.kind !== "declarations") {
    return { kind: "region", region: report.region ?? { kind: "absent" } };
  }
  return {
    kind: "region",
    region: {
      kind: "present",
      value: selectRegion({
        declarations: report.region.value.declarations,
        selection: { kind: "contract", contract },
      }),
    },
  };
}

async function invokeContractHistory(repo: Repo | undefined, contract: string): Promise<InvocationResult> {
  if (repo === undefined) throw new Error("history kei/... requires a resolved Repo");
  const { contractFromInput } = await import("./selectors.js");
  const selected = contractFromInput(repo, contract);
  try {
    return { kind: "contract-history" as const, history: await selected.contract.history() };
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    const { KeiyakuRefused } = await import("../library/keiyaku.js");
    if (error instanceof KeiyakuRefused) {
      return { kind: "refused" as const, verb: "history", contract: selected.id, refusal: error.refusal };
    }
    throw error;
  }
}

async function invokeForwardedContractMutation(
  parsed: Extract<ParsedCommand, { command: "deliver" | "review" }>,
  repo: Repo,
  edge: InvocationEdge,
  scope: string,
  establishWorld: () => Promise<WorldRoot>,
): Promise<InvocationResult> {
  const { EMPTY_WORKTREE_HOOKS } = await import("../library/configuration.js");
  return invokeContractMutation({
    parsed,
    repo,
    edge,
    scope,
    hooks: EMPTY_WORKTREE_HOOKS,
    establishWorld,
    forwarded: true,
  });
}

async function resolveInvocationCoordinates(invocation: NonInstallExecution, runtime: InvokeRuntime) {
  const environment = runtime.environment ?? process.env,
    gitPath = gitPathFromEdge(environment);
  const { resolveCliCoordinates } = await import("./coordinates.js");
  return resolveCliCoordinates({
    ...(runtime.cwd === undefined ? {} : { processCwd: runtime.cwd }),
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
    ...(gitPath === undefined ? {} : { gitPath }),
    command: invocation.command,
  });
}

// eslint-disable-next-line complexity -- command dispatch keeps the CLI's existing boundary in one place.
async function invokeParsed(
  invocation: NonInstallExecution,
  runtime: InvokeRuntime,
): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult | SettingsInvocationResult> {
  const environment = runtime.environment ?? process.env;
  const coordinates = await resolveInvocationCoordinates(invocation, runtime);
  const { cwd, cwdSource, repo, world, candidateWorld, establishWorld, taskContext } = coordinates;
  const edge: InvocationEdge = { environment, readStdin: runtime.readStdin ?? readStdin };
  const parsed = invocation.command;
  const mapped = edge.environment.KEIYAKU_HOME?.trim();
  const home = mapped === undefined || mapped.length === 0 ? undefined : mapped;
  if (parsed.command === "settings") return { kind: "settings", value: await settingsAt(world ?? undefined, home) };
  if (parsed.command === "nuke") return await (await import("./commands/nuke.js")).invokeNuke(parsed, world);
  if (parsed.command === "task") {
    const actor =
      runtime.actor ??
      actorFromEdge(typeof parsed.flags.actor === "string" ? parsed.flags.actor : undefined, edge.environment);
    return await (
      await import("./commands/task-invoke.js")
    ).invokeTaskFromEdge({
      parsed,
      world,
      context: taskContext,
      establish: coordinates.establishWorld,
      readStdin: edge.readStdin,
      actor,
    });
  }
  if (parsed.command === "history" && "contract" in parsed) return await invokeContractHistory(repo, parsed.contract);
  if (isParsedAkumaCommand(parsed)) {
    return await invokeAkumaFromEdge(parsed, {
      located: world,
      candidate: candidateWorld,
      establish: coordinates.establishWorld,
      invocationCwd: cwd,
      ...(cwdSource === "input" ? { statedCwd: cwd } : {}),
      ...(repo === undefined ? {} : { repo }),
      ...(home === undefined ? {} : { home }),
      edge,
    });
  }
  if (parsed.command === "ls") return await invokeCatalog(parsed, world, repo, home);
  if (parsed.command === "status") return await invokeStatus(parsed, world, repo);
  if (repo === undefined) throw new Error(`${parsed.command} requires a resolved Repo`);
  if (parsed.command === "region") return invokeRegion(parsed, world, repo);
  const scope = cwd;
  if (
    (parsed.command === "deliver" || parsed.command === "review") &&
    (await import("../akuma/requests.js")).injectedBodyRequests() !== null
  ) {
    return invokeForwardedContractMutation(parsed, repo, edge, scope, establishWorld);
  }
  const configuration = await settingsAt(world ?? undefined, home);
  const { worktreeHooksFrom, SettingsError } = await import("../library/configuration.js");
  const hooks = consumeSettings(() => worktreeHooksFrom({ settings: configuration }), SettingsError);

  if (parsed.command === "show") {
    const selected = await selectContract(repo, parsed.contract, scope);
    return { kind: "guidance", contract: selected.id, guidance: await selected.contract.guidance() };
  }
  if (parsed.command === "reconcile") {
    if (parsed.contract === undefined) {
      return {
        kind: "observation",
        command: "reconcile",
        report: await repo.reconcile({ hooks, retryHooks: parsed.retryHooks }),
      };
    }
    const { contract } = await selectContract(repo, parsed.contract, scope);
    return {
      kind: "observation",
      command: "reconcile",
      ...(await contract.reconcile({ hooks, retryHooks: parsed.retryHooks })),
    };
  }
  return invokeContractMutation({ parsed, repo, edge, scope, configuration, hooks, establishWorld });
}

function withResolvedTaskActor(command: ParsedCommand, runtime: InvokeRuntime): InvokeRuntime {
  if (command.command !== "task" || (command.action !== "add" && command.action !== "compose")) return runtime;
  const actor = actorFromEdge(
    typeof command.flags.actor === "string" ? command.flags.actor : undefined,
    runtime.environment ?? process.env,
  );
  return actor === undefined ? runtime : { ...runtime, actor };
}

export async function invoke(
  invocation: ParsedExecution,
  runtime: InvokeRuntime = {},
): Promise<
  InvocationResult | TaskInvocationResult | AkumaInvocationResult | SettingsInvocationResult | InstallInvocationResult
> {
  try {
    const command = invocation.command;
    assertExplicitRepoUse(command, invocation.repo);
    if (command.command === "install") {
      runtime.onOperationStart?.();
      return (await import("./commands/install.js")).installHarnesses(
        command.harnesses,
        runtime.environment ?? process.env,
      );
    }
    const acquiredRuntime = await withAcquiredStdin(command, withResolvedTaskActor(command, runtime));
    runtime.onOperationStart?.();
    return await invokeParsed(
      {
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
        command,
      },
      acquiredRuntime,
    );
  } catch (error) {
    if (error instanceof CliUsageError && error.projection === undefined) {
      throw new CliUsageError(error.diagnostic, renderCommandUsage(invocation.command));
    }
    throw error;
  }
}
