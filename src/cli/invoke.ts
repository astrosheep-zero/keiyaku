import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { gatesFrom, Keiyaku, NoGitWorldError, Repo, requireBranchesToBeUpToDateFrom, settings, SettingsError, worktreeHooksFrom, type ActorId, type ChangeId, type ContractId, type Keiyaku as KeiyakuContract, type Settings, type SnapshotId, type WorktreeHooks } from "../index.js";
import { kanshi, selectKanshi } from "../kanshi/index.js";
import { resolveActor } from "./actor.js";
import { resultFromMutationCall } from "./accepted.js";
import { amendFromCommand } from "./commands/amend.js";
import { invokeAkuma, invokeAkumaStatus, type AkumaInvocationResult } from "./commands/akuma-invoke.js";
import { isParsedAkumaCommand, type ParsedAkumaCommand } from "./commands/akuma.js";
import { bindFromCommand } from "./commands/bind.js";
import { installHarnesses, type InstallInvocationResult } from "./commands/install.js";
import { invokeTask, type TaskInvocationResult } from "./commands/task-invoke.js";
import { CliUsageError, renderCommandUsage, type ParsedCommand, type ParsedExecution } from "./parse.js";
import type { DiffUnavailable, InvocationResult } from "./result.js";
import { contractFromInput, resolveContextualContract, resolveKanshiContract, type SelectedContract } from "./selectors.js";
import { resolveNamedAddress } from "../library/address.js";
import { World, WorldError, type WorldRoot } from "../world.js";

export type { AcceptedFact, DiffUnavailable, InvocationResult, Lag } from "./result.js";

type InvokeRuntime = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readStdin?: () => string;
}>;

type ExistingCommand = Exclude<ParsedCommand, ParsedAkumaCommand | { command: "bind" | "status" | "show" | "ls" | "reconcile" | "settings" | "task" | "install" }>;
type NonInstallExecution = Readonly<{ cwd?: string; repo?: string; command: Exclude<ParsedCommand, { command: "install" }> }>;
type InvocationEdge = Readonly<{
  environment: NodeJS.ProcessEnv;
  readStdin: () => string;
}>;

export type SettingsInvocationResult = Readonly<{ kind: "settings"; value: Settings }>;
export type GuidanceInvocationResult = Readonly<{ kind: "guidance"; contract: ContractId; guidance: string }>;

function settingsAt(root: WorldRoot | undefined, environment: NodeJS.ProcessEnv): Settings {
  const home = environment.KEIYAKU_HOME?.trim();
  return settings({ ...(root === undefined ? {} : { root }), ...(home === undefined || home.length === 0 ? {} : { home }) });
}

function locateWorld(coordinate: string): WorldRoot | null {
  try { return World.locate(coordinate); }
  catch (error) {
    if (error instanceof WorldError) throw new CliUsageError(error.message);
    throw error;
  }
}

function canonicalInvocationCwd(input: string): string {
  try { return realpathSync(input); }
  catch { throw new CliUsageError(`invocation cwd is not an existing directory: ${input}`); }
}

function establishWorld(coordinate: string, located: WorldRoot | null): WorldRoot {
  if (located !== null) return located;
  try { return World.at(coordinate); }
  catch (error) {
    if (error instanceof WorldError) throw new CliUsageError(error.message);
    throw error;
  }
}

function selectedGates(value: Settings, name?: string) {
  try { return gatesFrom({ settings: value, ...(name === undefined ? {} : { name }) }); }
  catch (error) {
    if (error instanceof SettingsError) throw new CliUsageError(error.message);
    throw error;
  }
}

function selectedHooks(value: Settings): WorktreeHooks {
  try { return worktreeHooksFrom({ settings: value }); }
  catch (error) {
    if (error instanceof SettingsError) throw new CliUsageError(error.message);
    throw error;
  }
}

function selectedGitPolicy(value: Settings): boolean {
  try { return requireBranchesToBeUpToDateFrom({ settings: value }); }
  catch (error) {
    if (error instanceof SettingsError) throw new CliUsageError(error.message);
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

function repoAt(coordinate: string): Repo {
  return Repo.at({ path: coordinate });
}

function optionalRepoAt(coordinate: string): Repo | undefined {
  try { return repoAt(coordinate); }
  catch (error) {
    if (error instanceof NoGitWorldError) return undefined;
    throw error;
  }
}

type RepoUse = "none" | "optional" | "required";

function repoUse(command: ParsedCommand): RepoUse {
  switch (command.command) {
    case "bind":
    case "amend":
    case "deliver":
    case "review":
    case "arc":
    case "abandon":
    case "audit":
    case "reconcile":
    case "show":
      return "required";
    case "ls":
      return command.query.kind === "contracts" ? "required" : "none";
    case "status":
    case "tell":
    case "history":
    case "fork":
      return "optional";
    case "wait":
    case "kill":
      return command.akuma.some((selector) => selector.startsWith("kei/")) ? "required" : "optional";
    case "call":
      return command.contract === undefined ? "none" : "required";
    case "settings":
    case "task":
    case "install":
      return "none";
  }
}

function refuseUnusedRepo(command: ParsedCommand): never {
  if (command.command === "call") throw new CliUsageError("--repo has no consumer without --contract");
  throw new CliUsageError(`--repo has no consumer for ${command.command}`);
}

function repoFor(use: RepoUse, coordinate: string): Repo | undefined {
  switch (use) {
    case "none": return undefined;
    case "optional": return optionalRepoAt(coordinate);
    case "required": return repoAt(coordinate);
  }
}

async function selectContract(repo: Repo, selector: string | undefined, scope: string): Promise<SelectedContract> {
  if (selector !== undefined && !selector.startsWith("@")) return contractFromInput(repo, selector);
  const id = resolveContextualContract(await Keiyaku.list({ repo }), selector, scope);
  return contractFromInput(repo, id);
}

async function invokeBind(
  parsed: Extract<ParsedCommand, { command: "bind" }>,
  repo: Repo,
  edge: InvocationEdge,
  configuration: Settings,
  hooks: WorktreeHooks,
): Promise<InvocationResult> {
  const markdown = edge.readStdin();
  const gates = selectedGates(configuration, parsed.gates);
  const actor = actorFromEdge(parsed.actor, edge.environment);
  return resultFromMutationCall(
    "bind",
    () => bindFromCommand({
      command: parsed,
      repo,
      markdown,
      gates,
      ...(actor === undefined ? {} : { actor }),
      hooks,
    }),
    {
      project: (result) => {
        const bound = result.facts.find((fact) => fact.kind === "bind");
        if (bound === undefined || bound.kind !== "bind") throw new Error("accepted bind is missing its bind fact");
        return { target: bound.data.coordinates.target ?? null };
      },
    },
  );
}

function unavailableDiff(delivery: { integration: { snapshot: SnapshotId; changeId: ChangeId } }): DiffUnavailable {
  return {
    reason: "git-unavailable",
    integrationSnapshot: delivery.integration.snapshot,
    changeId: delivery.integration.changeId,
  };
}

type ExistingSeat = Readonly<{
  contract: KeiyakuContract;
  id: ContractId;
  actor?: ActorId;
  hooks: WorktreeHooks;
}>;

function deliverRefusal(refusal: unknown): unknown {
  if (typeof refusal !== "object" || refusal === null || !("kind" in refusal) || refusal.kind !== "dirty-workspace") {
    return refusal;
  }
  const submodules = "submodules" in refusal && Array.isArray(refusal.submodules) ? refusal.submodules : [];
  return { ...refusal, option: { flag: "--include-dirty", available: submodules.length === 0 } };
}

async function invokeDeliver(
  parsed: Extract<ExistingCommand, { command: "deliver" }>,
  seat: ExistingSeat,
  requireBranchesToBeUpToDate: boolean,
): Promise<InvocationResult> {
  return resultFromMutationCall("deliver", () => seat.contract.deliver({
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
    requireBranchesToBeUpToDate,
    includeDirty: parsed.includeDirty,
    hooks: seat.hooks,
  }), {
    coordinate: seat.id,
    projectRefusal: deliverRefusal,
    project: (result) => ({
      obligations: {
        ...(result.value.verification === undefined ? {} : { verification: result.value.verification }),
        ...(result.value.placement === undefined ? {} : { placement: result.value.placement }),
        ...(result.value.cleanup === undefined ? {} : { cleanup: result.value.cleanup }),
        ...(result.value.leak === undefined ? {} : { leak: result.value.leak }),
      },
    }),
  });
}

async function invokeReview(
  parsed: Extract<ExistingCommand, { command: "review" }>,
  seat: ExistingSeat,
  readStdin: () => string,
): Promise<InvocationResult> {
  const summary = parsed.summaryFromStdin === true ? readStdin() : parsed.summary;
  return resultFromMutationCall("review", () => seat.contract.review({
    verdict: parsed.verdict,
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(summary === undefined ? {} : { summary }),
    hooks: seat.hooks,
  }), {
    coordinate: seat.id,
    project: (result) => ({
      obligations: result.value.placement === undefined ? {} : { placement: result.value.placement },
      workspace: result.value.workspace,
    }),
  });
}

async function invokeAudit(
  parsed: Extract<ExistingCommand, { command: "audit" }>,
  seat: ExistingSeat,
): Promise<InvocationResult> {
  const delivery = parsed.showDiffBody ? await seat.contract.delivery() : null;
  return resultFromMutationCall(
    "audit",
    () => seat.contract.audit({ ...(seat.actor === undefined ? {} : { actor: seat.actor }), hooks: seat.hooks }),
    {
      coordinate: seat.id,
      project: async (result) => {
        let renderedDiff: string | DiffUnavailable | undefined;
        if (parsed.showDiffBody && delivery !== null) {
          const diff = await delivery.diff();
          renderedDiff = diff === null ? unavailableDiff(delivery) : diff;
        }
        return {
          report: result.value,
          ...(renderedDiff === undefined ? {} : { diff: renderedDiff }),
        };
      },
    },
  );
}

type ExistingInvocation = Readonly<{
  parsed: ExistingCommand;
  repo: Repo;
  edge: InvocationEdge;
  scope: string;
  configuration: Settings;
  hooks: WorktreeHooks;
}>;

async function invokeExisting({ parsed, repo, edge, scope, configuration, hooks }: ExistingInvocation): Promise<InvocationResult> {
  const { id, contract } = await selectContract(repo, parsed.contract, scope);
  const actor = actorFromEdge(parsed.actor, edge.environment);
  const seat: ExistingSeat = { contract, id, ...(actor === undefined ? {} : { actor }), hooks };

  switch (parsed.command) {
    case "amend": {
      const markdown = edge.readStdin();
      const gates = parsed.gates === undefined
        ? undefined
        : selectedGates(configuration, parsed.gates);
      return resultFromMutationCall(
        "amend",
        () => amendFromCommand({ command: parsed, repo, contract, markdown, gates, ...(actor === undefined ? {} : { actor }), hooks }),
        { coordinate: id },
      );
    }
    case "deliver":
      return invokeDeliver(parsed, seat, selectedGitPolicy(configuration));
    case "review":
      return invokeReview(parsed, seat, edge.readStdin);
    case "arc": {
      const markdown = edge.readStdin();
      return resultFromMutationCall("arc", () => contract.arc({
          markdown,
          ...(actor === undefined ? {} : { actor }),
          hooks,
        }), { coordinate: id });
    }
    case "abandon":
      return resultFromMutationCall("abandon", () => contract.abandon({
        ...(actor === undefined ? {} : { actor }),
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
        hooks,
      }), { coordinate: id });
    case "audit":
      return invokeAudit(parsed, seat);
    default:
      return parsed satisfies never;
  }
}

type AkumaEdgeInput = Readonly<{
  path: WorldRoot;
  executionCwd: string;
  repo?: Repo;
  configuration: Settings;
  edge: InvocationEdge;
}>;

async function invokeAkumaCommand(parsed: ParsedAkumaCommand, input: AkumaEdgeInput): Promise<AkumaInvocationResult> {
  const { path, executionCwd, repo, configuration, edge } = input;
  if (parsed.command === "call" && parsed.contract !== undefined) {
    if (repo === undefined) throw new Error("call with Contract requires a resolved Repo");
    const selected = contractFromInput(repo, parsed.contract);
    return await invokeAkuma(parsed, {
      path,
      executionCwd,
      settings: configuration,
      contract: selected.contract,
      readStdin: edge.readStdin,
    });
  }
  return await invokeAkuma(parsed, {
    path,
    executionCwd,
    settings: configuration,
    ...(repo === undefined ? {} : { repo }),
    readStdin: edge.readStdin,
  });
}

async function invokeAkumaFromEdge(parsed: ParsedAkumaCommand, input: AkumaEdgeInput) {
  try { return await invokeAkumaCommand(parsed, input); }
  catch (error) { if (error instanceof TypeError) throw new CliUsageError(error.message); throw error; }
}

function akumaWorldFor(parsed: ParsedAkumaCommand, cwd: string, located: WorldRoot | null): WorldRoot {
  const world = parsed.command === "call" ? establishWorld(cwd, located) : located;
  if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
  return world;
}

async function invokeCatalog(
  parsed: Extract<ParsedCommand, { command: "ls" }>,
  world: WorldRoot | null,
  repo: Repo | undefined,
  edge: InvocationEdge,
) {
  try {
    if (parsed.query.kind === "contracts") {
      if (repo === undefined) throw new Error("Contract catalog requires a resolved Repo");
      return { kind: "catalog" as const, catalog: await Keiyaku.ls({ query: parsed.query, repo }) };
    }
    if (parsed.query.kind === "archetypes") {
      return {
        kind: "catalog" as const,
        catalog: await Keiyaku.ls({ query: parsed.query, settings: settingsAt(undefined, edge.environment) }),
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
  edge: InvocationEdge,
) {
  const configuration = settingsAt(world ?? undefined, edge.environment);
  if (parsed.akuma === true) {
    if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
    return invokeAkumaStatus(world, parsed.contract, configuration, undefined, repo);
  }
  if (parsed.contract === undefined) {
    const report = await kanshi({ world, ...(repo === undefined ? {} : { repo }) });
    return { kind: "status" as const, report, selection: "world" as const };
  }
  if (parsed.contract.startsWith("@")) {
    try {
      const address = resolveNamedAddress({
        path: world,
        selector: parsed.contract,
        contracts: repo === undefined ? [] : (await Keiyaku.list({ repo })).rows,
      });
      if (address.kind === "akuma") {
        if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
        return invokeAkumaStatus(world, address.id, configuration, parsed.contract, repo);
      }
      const report = await kanshi({ world, ...(repo === undefined ? {} : { repo }) });
      return { kind: "status" as const, report: selectKanshi({ report, contract: address.id }), selection: "contract" as const };
    } catch (error) {
      if (error instanceof TypeError) throw new CliUsageError(error.message);
      throw error;
    }
  }
  const report = await kanshi({ world, ...(repo === undefined ? {} : { repo }) });
  const contract = resolveKanshiContract(report, parsed.contract);
  return { kind: "status" as const, report: selectKanshi({ report, contract }), selection: "contract" as const };
}

async function invokeParsed(
  invocation: NonInstallExecution,
  runtime: InvokeRuntime,
  use: RepoUse,
): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult | SettingsInvocationResult> {
  const processCwd = resolve(runtime.cwd ?? ".");
  const cwd = canonicalInvocationCwd(resolve(processCwd, invocation.cwd ?? "."));
  const edge: InvocationEdge = {
    environment: runtime.environment ?? process.env,
    readStdin: runtime.readStdin ?? (() => readFileSync(0, "utf8")),
  };
  const parsed = invocation.command;
  const repoCoordinate = resolve(cwd, invocation.repo ?? ".");
  const repo = repoFor(use, repoCoordinate);
  const world = locateWorld(cwd);
  if (parsed.command === "settings") {
    return { kind: "settings", value: settingsAt(world ?? undefined, edge.environment) };
  }
  if (parsed.command === "task") {
    try {
      return await invokeTask(parsed, {
        world,
        establish: () => establishWorld(cwd, world),
        readStdin: edge.readStdin,
      });
    }
    catch (error) { if (error instanceof TypeError) throw new CliUsageError(error.message); throw error; }
  }
  if (isParsedAkumaCommand(parsed)) {
    const akumaWorld = akumaWorldFor(parsed, cwd, world);
    const configuration = settingsAt(akumaWorld, edge.environment);
    return await invokeAkumaFromEdge(parsed, {
      path: akumaWorld,
      executionCwd: cwd,
      ...(repo === undefined ? {} : { repo }),
      configuration,
      edge,
    });
  }
  if (parsed.command === "ls") return await invokeCatalog(parsed, world, repo, edge);
  if (parsed.command === "status") return await invokeStatus(parsed, world, repo, edge);
  if (repo === undefined) throw new Error(`${parsed.command} requires a resolved Repo`);
  const scope = cwd;
  const configuration = settingsAt(world ?? undefined, edge.environment);
  const hooks = selectedHooks(configuration);

  if (parsed.command === "show") {
    const selected = await selectContract(repo, parsed.contract, scope);
    return { kind: "guidance", contract: selected.id, guidance: await selected.contract.guidance() };
  }

  switch (parsed.command) {
    case "reconcile": {
      if (parsed.contract === undefined) {
        return { kind: "observation", command: "reconcile", ...await repo.reconcile({ hooks, retryHooks: parsed.retryHooks }) };
      }
      const { contract } = await selectContract(repo, parsed.contract, scope);
      return { kind: "observation", command: "reconcile", ...await contract.reconcile({ hooks, retryHooks: parsed.retryHooks }) };
    }
    case "bind":
      return invokeBind(parsed, repo, edge, configuration, hooks);
    default:
      return invokeExisting({ parsed, repo, edge, scope, configuration, hooks });
  }
}

async function invokeInstall(command: Extract<ParsedCommand, { command: "install" }>, runtime: InvokeRuntime): Promise<InstallInvocationResult> {
  return installHarnesses(command.harnesses, runtime.environment ?? process.env);
}

export async function invoke(invocation: ParsedExecution, runtime: InvokeRuntime = {}): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult | SettingsInvocationResult | InstallInvocationResult> {
  try {
    const command = invocation.command;
    const use = repoUse(command);
    if (invocation.repo !== undefined && use === "none") refuseUnusedRepo(command);
    if (command.command === "install") return await invokeInstall(command, runtime);
    return await invokeParsed({
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
      command,
    }, runtime, use);
  } catch (error) {
    if (error instanceof CliUsageError && error.projection === undefined) {
      throw new CliUsageError(error.diagnostic, renderCommandUsage(invocation.command));
    }
    throw error;
  }
}
