import {
  AkumaWorldScopeError,
  gatesFrom,
  Keiyaku,
  KeiyakuRefused,
  Repo,
  requireBranchesToBeUpToDateFrom,
  settings,
  SettingsError,
  worktreeHooksFrom,
  type ActorId,
  type ContractId,
  type Keiyaku as KeiyakuContract,
  type Settings,
  type WorktreeHooks,
} from "../index.js";
import {
  kanshi,
  observeKanshi,
  selectKanshi,
  selectRegion,
  type KanshiRegionSelection,
} from "../kanshi/index.js";
import { resolveActor } from "./actor.js";
import {
  acceptedAbandon,
  acceptedAmend,
  acceptedArc,
  acceptedAudit,
  acceptedBind,
  acceptedDeliver,
  acceptedReview,
  resultFromMutationCall,
} from "./accepted.js";
import { amendFromCommand } from "./commands/amend.js";
import { invokeAkuma, invokeAkumaStatus, type AkumaInvocationResult } from "./commands/akuma-invoke.js";
import { isParsedAkumaCommand, type InvokedAkumaCommand } from "./commands/akuma.js";
import { bindFromCommand } from "./commands/bind.js";
import { installHarnesses, type InstallInvocationResult } from "./commands/install.js";
import { invokeTask, type TaskInvocationResult } from "./commands/task-invoke.js";
import { CliUsageError, renderCommandUsage, type ParsedCommand, type ParsedExecution } from "./parse.js";
import { isBlankInput } from "./usage.js";
import type { InvocationResult, RegionResult } from "./result.js";
import {
  canonicalContractSelector,
  contractFromInput,
  resolveContextualContract,
  resolveKanshiContract,
  type SelectedContract,
} from "./selectors.js";
import { resolveNamedAddress } from "../library/address.js";
import { injectedBodyRequests } from "../akuma/requests.js";
import { EMPTY_WORKTREE_HOOKS } from "../library/configuration.js";
import type { WorldRoot } from "../world.js";
import { assertExplicitRepoUse, resolveCliCoordinates } from "./coordinates.js";
import { BindDraftError, preserveBindDraft } from "./draft.js";

export type { AcceptedFact, InvocationResult, Lag } from "./result.js";

type InvokeRuntime = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  actor?: ActorId;
  onOperationStart?: () => void;
}>;

type ExistingCommand = Exclude<
  ParsedCommand,
  | InvokedAkumaCommand
  | { command: "history" }
  | { command: "bind" | "status" | "show" | "ls" | "reconcile" | "settings" | "region" | "task" | "install" }
>;
type NonInstallExecution = Readonly<{ cwd?: string; repo?: string; command: Exclude<ParsedCommand, { command: "install" }> }>;
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
        case "document": return "task add requires a nonblank stdin document";
        case "compose": return "task compose requires a nonblank stdin document";
        case "body": return "task update --body requires a nonblank value";
        case "append": return "task update --append requires a nonblank value";
        case "note": return "task update --note requires a nonblank value";
        default: return undefined;
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

function settingsAt(root: WorldRoot | undefined, home?: string): Promise<Settings> {
  return settings({ ...(root === undefined ? {} : { root }), ...(home === undefined ? {} : { home }) });
}

function consumeSettings<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SettingsError) throw new CliUsageError(error.message);
    throw error;
  }
}

function selectedGates(value: Settings, names?: readonly string[]) {
  return consumeSettings(() => gatesFrom({ settings: value, ...(names === undefined ? {} : { names }) }));
}

function selectedGitPolicy(value: Settings): boolean {
  return consumeSettings(() => requireBranchesToBeUpToDateFrom({ settings: value }));
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
  if (selector !== undefined && !selector.startsWith("@")) return contractFromInput(repo, selector);
  const id = resolveContextualContract(await Keiyaku.list({ repo }), selector, scope);
  return contractFromInput(repo, id);
}

type BindInvocation = Readonly<{
  parsed: Extract<ParsedCommand, { command: "bind" }>;
  repo: Repo;
  edge: InvocationEdge;
  configuration: Settings;
  hooks: WorktreeHooks;
  establishWorld: () => Promise<WorldRoot>;
}>;

async function bindDraftReceipt(establishWorld: () => Promise<WorldRoot>, markdown: string) {
  try {
    return preserveBindDraft(await establishWorld(), markdown);
  } catch (error) {
    return { warning: `bind draft could not be preserved: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function invokeBind({ parsed, repo, edge, configuration, hooks, establishWorld }: BindInvocation): Promise<InvocationResult> {
  const markdown = await edge.readStdin();
  const gates = selectedGates(configuration, parsed.gates);
  const actor = actorFromEdge(parsed.actor, edge.environment);
  try {
    const result = await resultFromMutationCall(
      "bind",
      () => bindFromCommand({
        command: parsed,
        repo,
        markdown,
        gates,
        ...(actor === undefined ? {} : { actor }),
        hooks,
      }),
      (accepted) => {
        const bound = accepted.facts.find((fact) => fact.kind === "bind");
        if (bound === undefined || bound.kind !== "bind") throw new Error("accepted bind is missing its bind fact");
        return acceptedBind(accepted, bound.data.coordinates);
      },
    );
    if (result.kind !== "refused") return result;
    return { ...result, draft: await bindDraftReceipt(establishWorld, markdown) };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new BindDraftError(error, await bindDraftReceipt(establishWorld, markdown));
  }
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
  }), (result) => acceptedDeliver(result, seat.id), {
    coordinate: seat.id,
    projectRefusal: deliverRefusal,
  });
}

async function invokeReview(
  parsed: Extract<ExistingCommand, { command: "review" }>,
  seat: ExistingSeat,
  readStdin: () => Promise<string>,
): Promise<InvocationResult> {
  const summary = parsed.summaryFromStdin === true ? await readStdin() : parsed.summary;
  return resultFromMutationCall("review", () => seat.contract.review({
    verdict: parsed.verdict,
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(summary === undefined ? {} : { summary }),
    hooks: seat.hooks,
  }), (result) => acceptedReview(result, seat.id), { coordinate: seat.id });
}

async function invokeAudit(
  parsed: Extract<ExistingCommand, { command: "audit" }>,
  seat: ExistingSeat,
  requireBranchesToBeUpToDate: boolean,
): Promise<InvocationResult> {
  return resultFromMutationCall(
    "audit",
    () => seat.contract.audit({
      ...(seat.actor === undefined ? {} : { actor: seat.actor }),
      includeDirty: parsed.includeDirty,
      showDiff: parsed.showDiff,
      requireBranchesToBeUpToDate,
      hooks: seat.hooks,
    }),
    (result) => acceptedAudit(result, seat.id),
    { coordinate: seat.id },
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

async function existingSeat(
  { parsed, repo, edge, scope, hooks }: Omit<ExistingInvocation, "configuration">,
): Promise<ExistingSeat> {
  const { id, contract } = await selectContract(repo, parsed.contract, scope);
  const actor = actorFromEdge(parsed.actor, edge.environment);
  return { contract, id, ...(actor === undefined ? {} : { actor }), hooks };
}

async function invokeExisting(input: ExistingInvocation): Promise<InvocationResult> {
  const { parsed, repo, edge, configuration, hooks } = input;
  const seat = await existingSeat(input);
  const { id, contract, actor } = seat;

  switch (parsed.command) {
    case "amend": {
      const markdown = parsed.stdin === true ? await edge.readStdin() : undefined;
      const gates = parsed.gates === undefined
        ? undefined
        : selectedGates(configuration, parsed.gates);
      return resultFromMutationCall(
        "amend",
        () => amendFromCommand({
          command: parsed,
          repo,
          contract,
          ...(markdown === undefined ? {} : { markdown }),
          gates,
          ...(actor === undefined ? {} : { actor }),
          hooks,
        }),
        (result) => acceptedAmend(result, id),
        { coordinate: id },
      );
    }
    case "deliver":
      return invokeDeliver(parsed, seat, selectedGitPolicy(configuration));
    case "review":
      return invokeReview(parsed, seat, edge.readStdin);
    case "arc": {
      const markdown = await edge.readStdin();
      return resultFromMutationCall("arc", () => contract.arc({
          markdown,
          ...(actor === undefined ? {} : { actor }),
          hooks,
        }), (result) => acceptedArc(result, id), { coordinate: id });
    }
    case "abandon":
      return resultFromMutationCall("abandon", () => contract.abandon({
        ...(actor === undefined ? {} : { actor }),
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
        hooks,
      }), (result) => acceptedAbandon(result, id), { coordinate: id });
    case "audit":
      return invokeAudit(parsed, seat, selectedGitPolicy(configuration));
    default:
      return parsed satisfies never;
  }
}

type AkumaEdgeInput = Readonly<{
  path: WorldRoot;
  statedCwd?: string;
  repo?: Repo;
  home?: string;
  configuration?: Settings;
  edge: InvocationEdge;
}>;

async function invokeAkumaFromEdge(parsed: InvokedAkumaCommand, input: AkumaEdgeInput) {
  try {
    const { path, statedCwd, repo, home, configuration, edge } = input;
    if (parsed.command === "call" && parsed.contract !== undefined && repo === undefined) {
      throw new Error("call with Contract requires a resolved Repo");
    }
    return await invokeAkuma(parsed, {
      path,
      ...(statedCwd === undefined ? {} : { statedCwd }),
      ...(home === undefined ? {} : { home }),
      ...(configuration === undefined ? {} : { settings: configuration }),
      ...(parsed.command === "call" && parsed.contract !== undefined
        ? { contract: contractFromInput(repo as Repo, parsed.contract).contract }
        : repo === undefined ? {} : { repo }),
      readStdin: edge.readStdin,
    });
  } catch (error) {
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
  const world = parsed.command === "call" ? candidate ?? await establish() : located;
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
    return invokeAkumaStatus(world, parsed.contract, undefined, repo);
  }
  if (parsed.contract === undefined) {
    const report = await kanshi({ world, ...(repo === undefined ? {} : { repo }) });
    return { kind: "status" as const, report, selection: "world" as const };
  }
  if (parsed.contract.startsWith("@")) {
    try {
      const observation = await observeKanshi({ world, ...(repo === undefined ? {} : { repo }) });
      const address = resolveNamedAddress({
        selector: parsed.contract,
        report: observation.report,
        aliases: observation.aliases,
      });
      if (address.kind === "akuma") {
        if (world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
        return invokeAkumaStatus(world, address.id, parsed.contract, repo);
      }
      return { kind: "status" as const, report: selectKanshi({ report: observation.report, contract: address.id }), selection: "contract" as const };
    } catch (error) {
      if (error instanceof TypeError) throw new CliUsageError(error.message);
      throw error;
    }
  }
  if (parsed.contract.startsWith("kei/")) {
    if (repo === undefined) throw new CliUsageError("cannot select a contract while the Contract world is absent");
    const contract = canonicalContractSelector(parsed.contract);
    return {
      kind: "status" as const,
      report: await kanshi({ world, repo, contract }),
      selection: "contract" as const,
    };
  }
  const report = await kanshi({ world, ...(repo === undefined ? {} : { repo }) });
  const contract = resolveKanshiContract(report, parsed.contract);
  return { kind: "status" as const, report: selectKanshi({ report, contract }), selection: "contract" as const };
}

async function invokeRegion(
  parsed: Extract<ParsedCommand, { command: "region" }>,
  world: WorldRoot | null,
  repo: Repo,
): Promise<RegionResult> {
  const read = async (region: KanshiRegionSelection) => {
    try { return await kanshi({ world, repo, region }); }
    catch (error) { if (error instanceof TypeError) throw new CliUsageError(error.message); throw error; }
  };
  if (parsed.contract === undefined) {
    const selection: KanshiRegionSelection = parsed.path !== undefined
      ? { kind: "path", path: parsed.path }
      : parsed.overlap ? { kind: "overlap" } : { kind: "declarations" };
    const report = await read(selection);
    return { kind: "region", region: report.region ?? { kind: "absent" } };
  }
  const report = await read({ kind: "declarations" });
  const contract = resolveKanshiContract(report, parsed.contract) as ContractId;
  if (report.contracts.kind !== "present" || report.contracts.value.rows.every((row) => row.id !== contract || row.disposition !== "active")) {
    throw new CliUsageError(`unknown contract selector: ${parsed.contract}`);
  }
  if (report.region?.kind !== "present" || report.region.value.kind !== "declarations") {
    return { kind: "region", region: report.region ?? { kind: "absent" } };
  }
  const selection: KanshiRegionSelection = parsed.overlap ? { kind: "overlap", contract } : { kind: "contract", contract };
  return { kind: "region", region: { kind: "present", value: selectRegion({ declarations: report.region.value.declarations, selection }) } };
}

async function invokeContractHistory(repo: Repo | undefined, contract: string): Promise<InvocationResult> {
  if (repo === undefined) throw new Error("history kei/... requires a resolved Repo");
  const selected = contractFromInput(repo, contract);
  try {
    return { kind: "contract-history" as const, history: await selected.contract.history() };
  } catch (error) {
    if (error instanceof TypeError) throw new CliUsageError(error.message);
    if (error instanceof KeiyakuRefused) {
      return { kind: "refused" as const, verb: "history", contract: selected.id, refusal: error.refusal };
    }
    throw error;
  }
}

// eslint-disable-next-line complexity -- command dispatch keeps the CLI's existing boundary in one place.
async function invokeParsed(
  invocation: NonInstallExecution,
  runtime: InvokeRuntime,
): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult | SettingsInvocationResult> {
  const environment = runtime.environment ?? process.env;
  const gitPath = gitPathFromEdge(environment);
  const coordinates = await resolveCliCoordinates({
    ...(runtime.cwd === undefined ? {} : { processCwd: runtime.cwd }),
    ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
    ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
    ...(gitPath === undefined ? {} : { gitPath }),
    command: invocation.command,
  });
  const { cwd, cwdSource, repo, world, candidateWorld, establishWorld, taskContext } = coordinates;
  const edge: InvocationEdge = {
    environment: runtime.environment ?? process.env,
    readStdin: runtime.readStdin ?? readStdin,
  };
  const parsed = invocation.command;
  const mapped = edge.environment.KEIYAKU_HOME?.trim();
  const home = mapped === undefined || mapped.length === 0 ? undefined : mapped;
  if (parsed.command === "settings") {
    return { kind: "settings", value: await settingsAt(world ?? undefined, home) };
  }
  if (parsed.command === "task") {
    try {
      return await invokeTask(parsed, {
        world,
        context: taskContext,
        establish: coordinates.establishWorld,
        readStdin: edge.readStdin,
        ...(runtime.actor === undefined ? {} : { actor: runtime.actor }),
      });
    }
    catch (error) { if (error instanceof TypeError) throw new CliUsageError(error.message); throw error; }
  }
  if (parsed.command === "history" && "contract" in parsed) return await invokeContractHistory(repo, parsed.contract);
  if (isParsedAkumaCommand(parsed)) {
    const akumaWorld = await akumaWorldFor(parsed, world, candidateWorld, coordinates.establishWorld);
    const configuration = parsed.command === "call" ? await settingsAt(akumaWorld, home) : undefined;
    return await invokeAkumaFromEdge(parsed, {
      path: akumaWorld,
      ...(cwdSource === "input" ? { statedCwd: cwd } : {}),
      ...(repo === undefined ? {} : { repo }),
      ...(parsed.command === "call" && home !== undefined ? { home } : {}),
      ...(configuration === undefined ? {} : { configuration }),
      edge,
    });
  }
  if (parsed.command === "ls") return await invokeCatalog(parsed, world, repo, home);
  if (parsed.command === "status") return await invokeStatus(parsed, world, repo);
  if (repo === undefined) throw new Error(`${parsed.command} requires a resolved Repo`);
  if (parsed.command === "region") return invokeRegion(parsed, world, repo);
  const scope = cwd;
  if ((parsed.command === "deliver" || parsed.command === "review") && injectedBodyRequests() !== null) {
    const seat = await existingSeat({ parsed, repo, edge, scope, hooks: EMPTY_WORKTREE_HOOKS });
    return parsed.command === "deliver"
      ? await invokeDeliver(parsed, seat, false)
      : await invokeReview(parsed, seat, edge.readStdin);
  }
  const configuration = await settingsAt(world ?? undefined, home);
  const hooks = consumeSettings(() => worktreeHooksFrom({ settings: configuration }));

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
      return invokeBind({ parsed, repo, edge, configuration, hooks, establishWorld });
    default:
      return invokeExisting({ parsed, repo, edge, scope, configuration, hooks });
  }
}

function withResolvedTaskActor(command: ParsedCommand, runtime: InvokeRuntime): InvokeRuntime {
  if (command.command !== "task" || (command.action !== "add" && command.action !== "compose")) return runtime;
  const actor = actorFromEdge(typeof command.flags.actor === "string" ? command.flags.actor : undefined, runtime.environment ?? process.env);
  return actor === undefined ? runtime : { ...runtime, actor };
}

export async function invoke(invocation: ParsedExecution, runtime: InvokeRuntime = {}): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult | SettingsInvocationResult | InstallInvocationResult> {
  try {
    const command = invocation.command;
    assertExplicitRepoUse(command, invocation.repo);
    if (command.command === "install") {
      runtime.onOperationStart?.();
      return installHarnesses(command.harnesses, runtime.environment ?? process.env);
    }
    const acquiredRuntime = await withAcquiredStdin(command, withResolvedTaskActor(command, runtime));
    runtime.onOperationStart?.();
    return await invokeParsed({
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(invocation.repo === undefined ? {} : { repo: invocation.repo }),
      command,
    }, acquiredRuntime);
  } catch (error) {
    if (error instanceof CliUsageError && error.projection === undefined) {
      throw new CliUsageError(error.diagnostic, renderCommandUsage(invocation.command));
    }
    throw error;
  }
}
