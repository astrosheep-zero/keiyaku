import type { ParsedContractCommand } from "./contract-grammar.js";
import { CliUsageError, consumeSettings, isBlankInput } from "../usage.js";
import { bindFromCommand } from "./bind.js";
import { amendFromCommand } from "./amend.js";
import { BindDraftError, preserveBindDraft } from "../draft.js";
import { settings } from "../../settings.js";
import {
  Akumas,
  Keiyaku,
  KeiyakuError,
  gatesFrom,
  nuke,
  requireBranchesToBeUpToDateFrom,
  SettingsError,
  worktreeHooksFrom,
} from "../../index.js";
import { observeKeiyaku } from "../../library/keiyaku.js";
import { validateArcMarkdown, validateContractMarkdown } from "../../library/input.js";
import { actorFromEdge } from "../actor.js";
import type { CliCoordinates } from "../coordinates.js";
import { displayContext, writeJson, writeStdout } from "../streams.js";
import type { CliRuntime } from "../runtime.js";
import { renderAccepted, renderRetry, renderContractHistory } from "../render/contract.js";
import { renderConflictMaterialized, renderRefusal, type RenderableRefusal } from "../render/refusal.js";
import {
  renderAkumaCatalogue,
  renderArchetypeCatalogue,
  renderContractCatalogue,
  renderTaskCatalogue,
} from "../render/catalog.js";
import { reconcileHasFailure, renderReconcile } from "../render/reconcile.js";
import { nukeExitCode, renderNukeText } from "../render/nuke.js";
import { renderRegionText } from "../render/region.js";
import { renderSettingsText, settingsJsonValue } from "../render/settings.js";
import { renderKanshiText } from "../render/kanshi.js";
import { snapshotText } from "../render/akuma-activity.js";
import { type TextRenderContext } from "../render/terminal.js";
import {
  canonicalContractSelector,
  contractFromInput,
  resolveContractId,
  resolveKanshiContract,
} from "../selectors.js";
import { resolveInvocationCwd } from "../coordinates.js";
import { kanshi, observeKanshi, selectKanshi, selectRegion } from "../../kanshi/index.js";
import { resolveNamedAddress } from "../../library/address.js";
import { Tasks } from "../../task/index.js";
import { listArchetypeDefinitions } from "../../akuma/archetype.js";
import type { KanshiReport } from "../../kanshi/index.js";
import type {
  AbandonOutcome,
  ActorId,
  AkumaObservation,
  AmendOutcome,
  ArcOutcome,
  AuditOutcome,
  BindOutcome,
  ContractId,
  ContractHistory,
  DeliverOutcome,
  Keiyaku as KeiyakuContract,
  KeiyakuLibrary,
  ReviewOutcome,
  Settings,
  WorldRoot,
} from "../../index.js";
import type { Repo } from "../../library/repo.js";
import type { WorktreeHooks } from "../../library/configuration.js";
import type { ReconcileCompletion, RepoReconcileReport } from "../../library/reconcile.js";
import type { RegionRead, Section } from "../../kanshi/index.js";
import { executionChannel, type ExecutionContext, type LibraryExecution } from "../../akuma/requests.js";

export {
  CONTRACT_COMMAND_SPECS,
  renderContractHelp,
  renderContractUsage,
  type ContractCommand,
  type ContractCommandSpec,
  type ContractFlagKind,
} from "./contract-help.js";

// ---------------------------------------------------------------------------
// Leaf dispatch: acquisition, one public SDK invocation, direct rendering
// ---------------------------------------------------------------------------

type ContractMutation = Extract<
  ParsedContractCommand,
  { command: "bind" | "amend" | "deliver" | "review" | "arc" | "abandon" | "audit" }
>;
type ExistingContractCommand = Exclude<ContractMutation, { command: "bind" }>;

type ContractAnswer =
  | BindOutcome
  | AmendOutcome
  | DeliverOutcome
  | ReviewOutcome
  | AuditOutcome
  | ArcOutcome
  | AbandonOutcome;

type ExistingSeat = Readonly<{
  id: ContractId;
  contract: KeiyakuContract;
  actor?: ActorId;
  hooks?: WorktreeHooks;
}>;

type ContractMutationInput = Readonly<{
  coordinates: CliCoordinates;
  runtime: CliRuntime;
  configuration?: Settings;
  hooks?: WorktreeHooks;
  execution: ExecutionContext;
}>;

function requiredRepo(coordinates: CliCoordinates): Repo {
  if (coordinates.repo === undefined) throw new CliUsageError("this command requires a resolved Repo");
  return coordinates.repo;
}

async function settingsAt(root: WorldRoot | undefined, home?: string): Promise<Settings> {
  return settings({
    ...(root === undefined ? {} : { root }),
    ...(home === undefined ? {} : { home }),
  });
}

async function contractSettings(
  command: ParsedContractCommand,
  execution: ExecutionContext,
  world: WorldRoot | null,
  home?: string,
): Promise<Readonly<{ configuration?: Settings; hooks?: WorktreeHooks }>> {
  const forwarded =
    executionChannel(execution).kind === "body-request" &&
    (command.command === "audit" || command.command === "deliver" || command.command === "review");
  if (forwarded) return {};
  const configuration = await settingsAt(world ?? undefined, home);
  return { configuration, hooks: consumeSettings(() => worktreeHooksFrom({ settings: configuration }), SettingsError) };
}

async function selectedGates(value: Settings, names?: readonly string[]) {
  return consumeSettings(
    () => gatesFrom({ settings: value, ...(names === undefined ? {} : { names }) }),
    SettingsError,
  );
}

async function selectedGitPolicy(value: Settings): Promise<boolean> {
  return consumeSettings(() => requireBranchesToBeUpToDateFrom({ settings: value }), SettingsError);
}

function draftWarning(error: unknown): Readonly<{ warning: string }> {
  return { warning: `bind draft could not be preserved: ${error instanceof Error ? error.message : String(error)}` };
}

/** Preserve a refused bind draft at the invocation cwd; coordinates are not yet available. */
async function bindDraftReceiptAtCwd(input: Readonly<{ processCwd?: string; cwd?: string }>, markdown: string) {
  try {
    return await preserveBindDraft(await resolveInvocationCwd(input), markdown);
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    return draftWarning(error);
  }
}

/**
 * The one bind-document admission that runs before coordinate resolution, so a malformed document
 * refuses as a draft-bearing refusal instead of a later Repo/Git failure. Reads the memoized stdin.
 */
export async function admitBindMarkdown(
  input: Readonly<{ markdown: string; processCwd?: string; cwd?: string }>,
): Promise<void> {
  if (isBlankInput(input.markdown)) throw new CliUsageError("bind requires a nonblank stdin document");
  try {
    validateContractMarkdown(input.markdown);
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    if (!(error instanceof TypeError) && !(error instanceof KeiyakuError && error.category === "invalid-input"))
      throw error;
    throw new BindDraftError(error, await bindDraftReceiptAtCwd(input, input.markdown));
  }
}

async function bindDraftReceipt(world: () => Promise<WorldRoot>, markdown: string) {
  try {
    return await preserveBindDraft(await world(), markdown);
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    return draftWarning(error);
  }
}

function refusedInvocation(
  answer: Extract<ContractAnswer, { kind: "refused" }>,
  project?: (refusal: RenderableRefusal) => RenderableRefusal,
): Readonly<{ operation: string; contract?: ContractId; refusal: RenderableRefusal }> {
  const refusal: RenderableRefusal = project === undefined ? answer.refusal : project(answer.refusal);
  return {
    operation: answer.operation,
    ...(answer.contract === undefined ? {} : { contract: answer.contract }),
    refusal,
  };
}

/** The CLI's own presentation of a refused dirty delivery: the available opt-in is not SDK evidence. */
function deliverRefusalProjection(refusal: RenderableRefusal): RenderableRefusal {
  if (refusal.kind !== "dirty-workspace") return refusal;
  const submodules = "submodules" in refusal && Array.isArray(refusal.submodules) ? refusal.submodules : [];
  return { ...refusal, option: { flag: "--include-dirty", available: submodules.length === 0 } };
}

function contractExitCode(answer: ContractAnswer): number {
  return answer.kind === "refused" ? 1 : answer.kind === "retry" ? 2 : 0;
}

function renderContractAnswer(
  answer: ContractAnswer,
  project: ((refusal: RenderableRefusal) => RenderableRefusal) | undefined,
  context: TextRenderContext,
): string {
  switch (answer.kind) {
    case "handoff":
      return renderConflictMaterialized(answer.value, context);
    case "refused":
      return renderRefusal(refusedInvocation(answer, project), undefined, context);
    case "retry":
      return renderRetry(answer, context);
    case "accepted":
      return renderAccepted(answer, context);
  }
}

async function finishContractAnswer(
  answer: ContractAnswer,
  output: "text" | "json",
  project?: (refusal: RenderableRefusal) => RenderableRefusal,
): Promise<number> {
  if (output === "json") writeJson(answer);
  else writeStdout(renderContractAnswer(answer, project, displayContext()));
  return contractExitCode(answer);
}

async function selectedContract(
  repo: Repo,
  selector: string | undefined,
  scope: string,
): Promise<Readonly<{ id: ContractId; contract: KeiyakuContract }>> {
  const id = await resolveContractId(repo, selector, scope);
  return { id, contract: contractFromInput(repo, id).contract };
}

async function existingSeat(
  command: ExistingContractCommand,
  coordinates: CliCoordinates,
  runtime: CliRuntime,
  library: KeiyakuLibrary,
  hooks: WorktreeHooks | undefined,
): Promise<ExistingSeat> {
  const repo = requiredRepo(coordinates);
  const id = await resolveContractId(repo, command.contract, coordinates.cwd);
  const actor = "actor" in command ? actorFromEdge(command.actor, runtime.environment) : undefined;
  return {
    id,
    contract: library.select({ repo, id }),
    ...(actor === undefined ? {} : { actor }),
    ...(hooks === undefined ? {} : { hooks }),
  };
}

async function contractLibrary(
  command: ParsedContractCommand,
  execution: ExecutionContext,
  configuration: Settings | undefined,
  hooks: WorktreeHooks | undefined,
  runtime: CliRuntime,
): Promise<KeiyakuLibrary> {
  if (executionChannel(execution).kind !== "local" || !["audit", "deliver", "review"].includes(command.command)) {
    return Keiyaku.with({ execution });
  }
  const requireBranchesToBeUpToDate =
    command.command !== "review" && configuration !== undefined ? await selectedGitPolicy(configuration) : false;
  const actor = actorFromEdge(undefined, runtime.environment);
  return Keiyaku.with({
    execution,
    ...(actor === undefined ? {} : { actor }),
    ...(hooks === undefined ? {} : { hooks }),
    requireBranchesToBeUpToDate,
  });
}

async function runBind(
  command: Extract<ContractMutation, { command: "bind" }>,
  input: ContractMutationInput,
): Promise<number> {
  const { coordinates, runtime, configuration, hooks } = input;
  const repo = requiredRepo(coordinates);
  const actor = actorFromEdge(command.actor, runtime.environment);
  if (command.forkOf !== undefined) {
    const answer = await bindFromCommand({
      command,
      repo,
      ...(actor === undefined ? {} : { actor }),
      ...(hooks === undefined ? {} : { hooks }),
    });
    return await finishContractAnswer(answer, command.output);
  }
  if (configuration === undefined) throw new Error("bind invocation requires Settings");
  const markdown = await runtime.readStdin();
  if (isBlankInput(markdown)) throw new CliUsageError("bind requires a nonblank stdin document");
  try {
    validateContractMarkdown(markdown);
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof KeiyakuError && error.category === "invalid-input"))
      throw error;
    throw new BindDraftError(error, await bindDraftReceipt(coordinates.establishWorld, markdown));
  }
  const gates = await selectedGates(configuration, command.gates);
  try {
    const answer = await bindFromCommand({
      command,
      repo,
      markdown,
      gates,
      ...(actor === undefined ? {} : { actor }),
      ...(hooks === undefined ? {} : { hooks }),
    });
    if (answer.kind !== "refused") return await finishContractAnswer(answer, command.output);
    const draft = await bindDraftReceipt(coordinates.establishWorld, markdown);
    if (command.output === "json") writeJson(answer);
    else writeStdout(renderRefusal(refusedInvocation(answer), draft, displayContext()));
    return 1;
  } catch (error) {
    if (error instanceof Error && "executionReceipt" in error) throw error;
    if (!(error instanceof TypeError) && !(error instanceof KeiyakuError && error.category === "invalid-input"))
      throw error;
    throw new BindDraftError(error, await bindDraftReceipt(coordinates.establishWorld, markdown));
  }
}

async function runAmend(
  command: Extract<ContractMutation, { command: "amend" }>,
  input: ContractMutationInput,
  seat: ExistingSeat,
): Promise<number> {
  const { coordinates, runtime, configuration, hooks } = input;
  if (configuration === undefined) throw new Error("amend invocation requires Settings");
  const markdown = command.stdin === true ? await runtime.readStdin() : undefined;
  if (markdown !== undefined && isBlankInput(markdown))
    throw new CliUsageError("amend requires a nonblank stdin document");
  const gates = command.gates === undefined ? undefined : await selectedGates(configuration, command.gates);
  const answer = await amendFromCommand({
    command,
    repo: requiredRepo(coordinates),
    contract: seat.contract,
    ...(markdown === undefined ? {} : { markdown }),
    gates,
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(hooks === undefined ? {} : { hooks }),
  });
  return await finishContractAnswer(answer, command.output);
}

async function runDeliver(
  command: Extract<ContractMutation, { command: "deliver" }>,
  runtime: CliRuntime,
  seat: ExistingSeat,
): Promise<number> {
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  let answer: DeliverOutcome;
  try {
    answer = await seat.contract.deliver(
      {
        ...(command.message === undefined ? {} : { message: command.message }),
        includeDirty: command.includeDirty,
        materializeConflict: command.materializeConflict,
        overwrite: command.overwrite,
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      },
      { ...(driver === undefined ? {} : { observe: driver.observe }) },
    );
  } finally {
    if (driver !== undefined) await driver.finish().catch(() => undefined);
  }
  return await finishContractAnswer(answer, command.output, deliverRefusalProjection);
}

async function runReview(
  command: Extract<ContractMutation, { command: "review" }>,
  runtime: CliRuntime,
  seat: ExistingSeat,
): Promise<number> {
  const summary = command.summaryFromStdin === true ? await runtime.readStdin() : command.summary;
  if (command.summaryFromStdin === true && isBlankInput(summary ?? ""))
    throw new CliUsageError("review requires a nonblank summary");
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  let answer: ReviewOutcome;
  try {
    answer = await seat.contract.review(
      {
        verdict: command.verdict,
        ...(summary === undefined ? {} : { summary }),
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      },
      { ...(driver === undefined ? {} : { observe: driver.observe }) },
    );
  } finally {
    if (driver !== undefined) await driver.finish().catch(() => undefined);
  }
  return await finishContractAnswer(answer, command.output);
}

async function runArc(
  command: Extract<ContractMutation, { command: "arc" }>,
  runtime: CliRuntime,
  seat: ExistingSeat,
): Promise<number> {
  const markdown = await runtime.readStdin();
  try {
    validateArcMarkdown(markdown);
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof KeiyakuError && error.category === "invalid-input"))
      throw error;
    const refusal: RenderableRefusal = { kind: "invalid-document", diagnostic: error.message };
    if (command.output === "json") writeJson({ kind: "refused", operation: "arc", contract: seat.id, refusal });
    else writeStdout(renderRefusal({ operation: "arc", contract: seat.id, refusal }, undefined, displayContext()));
    return 1;
  }
  const answer = await seat.contract.arc({
    markdown,
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(seat.hooks === undefined ? {} : { hooks: seat.hooks }),
  });
  return await finishContractAnswer(answer, command.output);
}

async function runAbandon(
  command: Extract<ContractMutation, { command: "abandon" }>,
  seat: ExistingSeat,
): Promise<number> {
  const answer = await seat.contract.abandon({
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(command.note === undefined ? {} : { note: command.note }),
    ...(seat.hooks === undefined ? {} : { hooks: seat.hooks }),
  });
  return await finishContractAnswer(answer, command.output);
}

async function runAudit(
  command: Extract<ContractMutation, { command: "audit" }>,
  runtime: CliRuntime,
  seat: ExistingSeat,
): Promise<number> {
  const driver = command.output === "text" ? await runtime.progress() : undefined;
  let answer: AuditOutcome;
  try {
    answer = await seat.contract.audit(
      {
        includeDirty: command.includeDirty,
        showDiff: command.showDiff,
        ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
      },
      { ...(driver === undefined ? {} : { observe: driver.observe }) },
    );
  } finally {
    if (driver !== undefined) await driver.finish().catch(() => undefined);
  }
  return await finishContractAnswer(answer, command.output, deliverRefusalProjection);
}

async function runContractMutation(command: ContractMutation, input: ContractMutationInput): Promise<number> {
  if (command.command === "bind") return await runBind(command, input);
  const library = await contractLibrary(command, input.execution, input.configuration, input.hooks, input.runtime);
  const seat = await existingSeat(command, input.coordinates, input.runtime, library, input.hooks);
  switch (command.command) {
    case "amend":
      return await runAmend(command, input, seat);
    case "deliver":
      return await runDeliver(command, input.runtime, seat);
    case "review":
      return await runReview(command, input.runtime, seat);
    case "arc":
      return await runArc(command, input.runtime, seat);
    case "abandon":
      return await runAbandon(command, seat);
    case "audit":
      return await runAudit(command, input.runtime, seat);
  }
}

function statusRefusal(
  operation: string,
  contract: ContractId,
): Readonly<{
  operation: string;
  contract: ContractId;
  refusal: RenderableRefusal;
}> {
  return { operation, contract, refusal: { kind: "contract-missing", contractId: contract } };
}

async function runSettings(
  coordinates: CliCoordinates,
  home: string | undefined,
  output: "text" | "json",
): Promise<number> {
  const value = await settingsAt(coordinates.world ?? undefined, home);
  if (output === "json") writeJson(settingsJsonValue(value));
  else writeStdout(renderSettingsText(value, displayContext().columns));
  return 0;
}

async function runNuke(
  command: Extract<ParsedContractCommand, { command: "nuke" }>,
  coordinates: CliCoordinates,
): Promise<number> {
  if (coordinates.world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
  const result = await nuke({
    world: coordinates.world,
    ...(command.confirm === undefined ? {} : { confirm: command.confirm }),
  });
  if (command.output === "json") writeJson(result);
  else writeStdout(renderNukeText(result));
  return nukeExitCode(result);
}

async function runLs(
  command: Extract<ParsedContractCommand, { command: "ls" }>,
  coordinates: CliCoordinates,
  home: string | undefined,
): Promise<number> {
  const query = command.query;
  if (query.kind === "contracts") {
    const list = await Keiyaku.with().list({
      repo: requiredRepo(coordinates),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    if (command.output === "json") writeJson(list);
    else writeStdout(renderContractCatalogue(list));
    return 0;
  }
  if (query.kind === "archetypes") {
    const list = await listArchetypeDefinitions({
      ...(coordinates.world === null ? {} : { project: coordinates.world }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(home === undefined ? {} : { home }),
    });
    if (command.output === "json") writeJson(list);
    else writeStdout(renderArchetypeCatalogue(list));
    return 0;
  }
  if (coordinates.world === null) throw new CliUsageError("no Keiyaku world contains the invocation cwd");
  if (query.kind === "tasks") {
    const listed = await Tasks.of(coordinates.world).list({
      selection: "all",
      namespace: query.namespace ?? [],
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    if (listed.kind !== "accepted") throw new Error("Task list did not return an accepted observation");
    if (command.output === "json") writeJson(listed);
    else writeStdout(renderTaskCatalogue(listed.value, query.namespace ?? []));
    return 0;
  }
  const listed = await Akumas.of(coordinates.world).list({
    ...(query.archetype === undefined ? {} : { archetype: query.archetype }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  });
  if (command.output === "json") writeJson(listed);
  else writeStdout(renderAkumaCatalogue(listed, query.archetype ?? null));
  return 0;
}

async function readAkumaStatus(
  akuma: string,
  alias: string | undefined,
  coordinates: CliCoordinates,
): Promise<Readonly<{ value: AkumaObservation; project: () => string }>> {
  if (coordinates.world === null) throw new CliUsageError("no Keiyaku world contains the Akuma selector");
  const status = await Akumas.of(coordinates.world).status({
    akuma,
    ...(coordinates.repo === undefined ? {} : { repo: coordinates.repo }),
  });
  return {
    value: status,
    project: () => snapshotText(status, displayContext(), ...(alias === undefined ? [{}] : [{ alias }])),
  };
}

async function readContractStatus(
  selector: string | undefined,
  coordinates: CliCoordinates,
  named: Awaited<ReturnType<typeof observeKanshi>> | undefined,
): Promise<Readonly<{ value: KanshiReport; project: () => string }>> {
  const repo = requiredRepo(coordinates);
  if (selector !== undefined && selector.startsWith("@")) {
    if (named === undefined) throw new CliUsageError("cannot resolve a named status selector");
    const address = resolveNamedAddress({ selector, report: named.report, aliases: named.aliases });
    if (address.kind === "akuma") throw new CliUsageError("named status selector resolved to an Akuma");
    const report = await kanshi({ world: coordinates.world, repo, contract: address.id });
    return { value: report, project: () => renderKanshiText(report, displayContext(), "contract") };
  }
  const contract = selector === undefined ? undefined : canonicalContractSelector(selector);
  const report = await kanshi({ world: coordinates.world, repo, ...(contract === undefined ? {} : { contract }) });
  return { value: report, project: () => renderKanshiText(report, displayContext(), "contract") };
}

async function namedStatus(
  selector: string,
  coordinates: CliCoordinates,
  named: Awaited<ReturnType<typeof observeKanshi>> | undefined,
): Promise<Readonly<{ value: AkumaObservation | KanshiReport; project: () => string }>> {
  if (named === undefined) throw new CliUsageError("cannot resolve a named status selector");
  const address = resolveNamedAddress({ selector, report: named.report, aliases: named.aliases });
  if (address.kind === "akuma") return await readAkumaStatus(address.id, selector, coordinates);
  return await readContractStatus(address.id, coordinates, named);
}

async function runStatusGuidance(
  command: Extract<ParsedContractCommand, { command: "status" }>,
  coordinates: CliCoordinates,
): Promise<number> {
  const repo = coordinates.repo;
  if (repo === undefined) throw new CliUsageError("cannot select a contract while the Contract world is absent");
  const selected = await selectedContract(repo, command.contract, coordinates.cwd);
  const guidance = await selected.contract.guidance();
  if (guidance === null) {
    if (command.output === "json") writeJson(null);
    else writeStdout(renderRefusal(statusRefusal("status", selected.id), undefined, displayContext()));
    return 1;
  }
  if (command.output === "json") writeJson(guidance);
  else writeStdout(guidance);
  return 0;
}

async function runStatusSelection(
  command: Extract<ParsedContractCommand, { command: "status" }> & Readonly<{ selectors: readonly string[] }>,
  coordinates: CliCoordinates,
): Promise<number> {
  const selectors = command.selectors;
  if (selectors.length < 2) throw new CliUsageError("status requires at least two selectors");
  if (
    selectors.some((selector) => !selector.startsWith("aku/") && !selector.startsWith("@")) &&
    coordinates.repo === undefined
  )
    throw new CliUsageError("cannot select a contract while the Contract world is absent");
  const named = selectors.some((selector) => selector.startsWith("@"))
    ? await observeKanshi({
        world: coordinates.world,
        ...(coordinates.repo === undefined ? {} : { repo: coordinates.repo }),
      })
    : undefined;
  const values: (AkumaObservation | KanshiReport)[] = [];
  const blocks: string[] = [];
  for (const selector of selectors) {
    const resolved = selector.startsWith("aku/")
      ? await readAkumaStatus(selector, undefined, coordinates)
      : selector.startsWith("@")
        ? await namedStatus(selector, coordinates, named)
        : await readContractStatus(selector, coordinates, named);
    values.push(resolved.value);
    if (command.output === "text") blocks.push(resolved.project());
  }
  if (command.output === "json") writeJson(values);
  else writeStdout(blocks.join("\n\n"));
  return 0;
}

async function runStatus(
  command: Extract<ParsedContractCommand, { command: "status" }>,
  coordinates: CliCoordinates,
): Promise<number> {
  if (command.guidance === true) return await runStatusGuidance(command, coordinates);
  if ("selectors" in command && command.selectors !== undefined)
    return await runStatusSelection({ ...command, selectors: command.selectors }, coordinates);
  if (command.akuma === true && command.contract !== undefined) {
    const resolved = await readAkumaStatus(command.contract, undefined, coordinates);
    if (command.output === "json") writeJson(resolved.value);
    else writeStdout(resolved.project());
    return 0;
  }
  if (command.contract === undefined) {
    const report = await kanshi({
      world: coordinates.world,
      ...(coordinates.repo === undefined ? {} : { repo: coordinates.repo }),
    });
    if (command.output === "json") writeJson(report);
    else writeStdout(renderKanshiText(report, displayContext(), "world"));
    return 0;
  }
  if (command.contract.startsWith("@")) {
    const resolved = await namedStatus(
      command.contract,
      coordinates,
      await observeKanshi({
        world: coordinates.world,
        ...(coordinates.repo === undefined ? {} : { repo: coordinates.repo }),
      }),
    );
    if (command.output === "json") writeJson(resolved.value);
    else writeStdout(resolved.project());
    return 0;
  }
  if (command.contract.startsWith("kei/")) {
    const repo = requiredRepo(coordinates);
    const contract = canonicalContractSelector(command.contract);
    const report = await kanshi({ world: coordinates.world, repo, contract });
    if (report.contracts.kind === "present" && report.contracts.value.rows.length === 0) {
      if (command.output === "json") writeJson(statusRefusal("status", contract).refusal);
      else writeStdout(renderRefusal(statusRefusal("status", contract), undefined, displayContext()));
      return 1;
    }
    if (command.output === "json") writeJson(report);
    else writeStdout(renderKanshiText(report, displayContext(), "contract"));
    return 0;
  }
  const report = await kanshi({
    world: coordinates.world,
    ...(coordinates.repo === undefined ? {} : { repo: coordinates.repo }),
  });
  const contract = resolveKanshiContract(report, command.contract);
  const selected = selectKanshi({ report, contract });
  if (command.output === "json") writeJson(selected);
  else writeStdout(renderKanshiText(selected, displayContext(), "contract"));
  return 0;
}

async function runRegion(
  command: Extract<ParsedContractCommand, { command: "region" }>,
  coordinates: CliCoordinates,
): Promise<number> {
  const repo = requiredRepo(coordinates);
  const emit = (section: Section<RegionRead>): number => {
    if (command.output === "json") writeJson(section);
    else writeStdout(renderRegionText(section));
    return 0;
  };
  if (command.paths !== undefined) {
    const report = await kanshi({ world: coordinates.world, repo, region: { kind: "path", patterns: command.paths } });
    return emit(report.region ?? { kind: "absent" });
  }
  const report = await kanshi({ world: coordinates.world, repo, region: { kind: "declarations" } });
  if (command.contract === undefined) return emit(report.region ?? { kind: "absent" });
  const contract = resolveKanshiContract(report, command.contract) as ContractId;
  const observed = await observeKeiyaku({ repo, id: contract });
  if (observed.kind === "missing" || observed.row.phase === "claimed" || observed.row.phase === "abandoned") {
    const refusal: RenderableRefusal = {
      kind: observed.kind === "missing" ? "contract-missing" : "terminal",
      contractId: contract,
    };
    if (command.output === "json") writeJson(refusal);
    else writeStdout(renderRefusal({ operation: "region", contract, refusal }, undefined, displayContext()));
    return 1;
  }
  if (report.region?.kind !== "present" || report.region.value.kind !== "declarations")
    return emit(report.region ?? { kind: "absent" });
  return emit({
    kind: "present",
    value: selectRegion({
      declarations: report.region.value.declarations,
      selection: { kind: "contract", contract },
    }),
  });
}

export type ParsedContractHistory = Readonly<{
  command: "history";
  contract: string;
  full: boolean;
  output: "text" | "json";
}>;

export async function runContractHistoryCommand(
  command: ParsedContractHistory,
  coordinates: CliCoordinates,
): Promise<number> {
  const repo = requiredRepo(coordinates);
  const selected = contractFromInput(repo, command.contract);
  const history: ContractHistory | null = await selected.contract.history();
  if (history === null) {
    const refusal: RenderableRefusal = { kind: "contract-missing", contractId: selected.id };
    if (command.output === "json") writeJson(refusal);
    else
      writeStdout(renderRefusal({ operation: "history", contract: selected.id, refusal }, undefined, displayContext()));
    return 1;
  }
  if (command.output === "json") writeJson(history);
  else writeStdout(renderContractHistory(history, { full: command.full }));
  return 0;
}

async function runReconcile(
  command: Extract<ParsedContractCommand, { command: "reconcile" }>,
  coordinates: CliCoordinates,
  execution: LibraryExecution,
  home: string | undefined,
): Promise<number> {
  const repo = requiredRepo(coordinates);
  const { hooks } = await contractSettings(command, execution, coordinates.world, home);
  const library = Keiyaku.with({ execution, ...(hooks === undefined ? {} : { hooks }) });
  let report: ReconcileCompletion | RepoReconcileReport;
  if (command.contract === undefined) {
    report = await library.reconcile({ repo, retryHooks: command.retryHooks });
  } else {
    const selected = await selectedContract(repo, command.contract, coordinates.cwd);
    const observed = await observeKeiyaku({ repo, id: selected.id });
    if (observed.kind === "missing") {
      if (command.output === "json") writeJson(statusRefusal("reconcile", selected.id).refusal);
      else writeStdout(renderRefusal(statusRefusal("reconcile", selected.id), undefined, displayContext()));
      return 1;
    }
    report = await library.reconcile({ repo, contract: selected.id, retryHooks: command.retryHooks });
  }
  if (command.output === "json") writeJson(report);
  else writeStdout(renderReconcile(report, displayContext()));
  return reconcileHasFailure(report) ? 1 : 0;
}

export async function runContractCommand(
  command: ParsedContractCommand,
  coordinates: CliCoordinates,
  runtime: CliRuntime,
): Promise<number> {
  const execution = runtime.execution;
  const home = runtime.home;
  switch (command.command) {
    case "settings":
      return await runSettings(coordinates, home, command.output);
    case "nuke":
      return await runNuke(command, coordinates);
    case "ls":
      return await runLs(command, coordinates, home);
    case "status":
      return await runStatus(command, coordinates);
    case "region":
      return await runRegion(command, coordinates);
    case "reconcile":
      return await runReconcile(command, coordinates, execution, home);
    default: {
      const { configuration, hooks } = await contractSettings(command, execution, coordinates.world, home);
      return await runContractMutation(command, {
        coordinates,
        runtime,
        execution,
        ...(configuration === undefined ? {} : { configuration }),
        ...(hooks === undefined ? {} : { hooks }),
      });
    }
  }
}
