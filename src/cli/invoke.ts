import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gatesFrom, Keiyaku, Repo, settings, SettingsError, type ActorId, type ChangeId, type ContractId, type Keiyaku as KeiyakuContract, type Settings, type SnapshotId } from "../index.js";
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

export type { AcceptedFact, DiffUnavailable, InvocationResult, Lag } from "./result.js";

type InvokeRuntime = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readStdin?: () => string;
}>;

type ExistingCommand = Exclude<ParsedCommand, ParsedAkumaCommand | { command: "bind" | "status" | "reconcile" | "settings" | "task" | "install" }>;
type NonInstallExecution = Readonly<{ cwd?: string; command: Exclude<ParsedCommand, { command: "install" }> }>;
type InvocationEdge = Readonly<{
  environment: NodeJS.ProcessEnv;
  readStdin: () => string;
}>;

export type SettingsInvocationResult = Readonly<{ kind: "settings"; value: Settings }>;

function settingsAt(root: string, environment: NodeJS.ProcessEnv): Settings {
  const home = environment.KEIYAKU_HOME?.trim();
  return settings({ root, ...(home === undefined || home.length === 0 ? {} : { home }) });
}

function selectedGates(value: Settings, name?: string) {
  try { return gatesFrom({ settings: value, ...(name === undefined ? {} : { name }) }); }
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

function repoAt(coordinate: string | undefined): Repo {
  return coordinate === undefined ? Repo.at() : Repo.at({ path: coordinate });
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
): Promise<InvocationResult> {
  const markdown = edge.readStdin();
  const gates = selectedGates(settingsAt(repo.root, edge.environment), parsed.gates);
  return resultFromMutationCall(
    "bind",
    () => bindFromCommand(parsed, repo, markdown, gates, actorFromEdge(parsed.actor, edge.environment)),
  );
}

function unavailableDiff(delivery: { snapshotId: SnapshotId; changeId: ChangeId }): DiffUnavailable {
  return {
    reason: "transport-unavailable",
    snapshotId: delivery.snapshotId,
    changeId: delivery.changeId,
  };
}

type ExistingSeat = Readonly<{
  contract: KeiyakuContract;
  id: ContractId;
  actor?: ActorId;
}>;

async function invokeDeliver(
  parsed: Extract<ExistingCommand, { command: "deliver" }>,
  seat: ExistingSeat,
): Promise<InvocationResult> {
  return resultFromMutationCall("deliver", () => seat.contract.deliver({
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  }), {
    coordinate: seat.id,
    project: (result) => ({
      obligations: {
        ...(result.value.verification === undefined ? {} : { verification: result.value.verification }),
        ...(result.value.placement === undefined ? {} : { placement: result.value.placement }),
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
  }), {
    coordinate: seat.id,
    project: (result) => ({
      obligations: result.value.placement === undefined ? {} : { placement: result.value.placement },
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
    () => seat.contract.audit(seat.actor === undefined ? {} : { actor: seat.actor }),
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

async function invokeExisting(parsed: ExistingCommand, repo: Repo, edge: InvocationEdge, scope: string): Promise<InvocationResult> {
  const { id, contract } = await selectContract(repo, parsed.contract, scope);
  const actor = actorFromEdge(parsed.actor, edge.environment);
  const seat: ExistingSeat = { contract, id, ...(actor === undefined ? {} : { actor }) };

  switch (parsed.command) {
    case "amend": {
      const markdown = edge.readStdin();
      const gates = parsed.gates === undefined
        ? undefined
        : selectedGates(settingsAt(repo.root, edge.environment), parsed.gates);
      return resultFromMutationCall(
        "amend",
        () => amendFromCommand({ command: parsed, repo, contract, markdown, gates, ...(actor === undefined ? {} : { actor }) }),
        { coordinate: id },
      );
    }
    case "deliver":
      return invokeDeliver(parsed, seat);
    case "review":
      return invokeReview(parsed, seat, edge.readStdin);
    case "arc": {
      const markdown = edge.readStdin();
      return resultFromMutationCall("arc", () => contract.arc({
          markdown,
          ...(actor === undefined ? {} : { actor }),
        }), { coordinate: id });
    }
    case "abandon":
      return resultFromMutationCall("abandon", () => contract.abandon({
        ...(actor === undefined ? {} : { actor }),
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
      }), { coordinate: id });
    case "audit":
      return invokeAudit(parsed, seat);
    default:
      return parsed satisfies never;
  }
}

async function invokeParsed(invocation: NonInstallExecution, runtime: InvokeRuntime): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult | SettingsInvocationResult> {
  const coordinate = invocation.cwd ?? runtime.cwd;
  const edge: InvocationEdge = {
    environment: runtime.environment ?? process.env,
    readStdin: runtime.readStdin ?? (() => readFileSync(0, "utf8")),
  };
  const parsed = invocation.command;
  if (parsed.command === "settings") {
    return { kind: "settings", value: settingsAt(resolve(coordinate ?? "."), edge.environment) };
  }
  if (parsed.command === "task") {
    try { return await invokeTask(parsed, { ...(coordinate === undefined ? {} : { path: coordinate }), readStdin: edge.readStdin }); }
    catch (error) { if (error instanceof TypeError) throw new CliUsageError(error.message); throw error; }
  }
  if (isParsedAkumaCommand(parsed)) {
    const path = resolve(coordinate ?? ".");
    return await invokeAkuma(parsed, { path, settings: settingsAt(path, edge.environment), readStdin: edge.readStdin });
  }
  if (parsed.command === "status") {
    if (parsed.akuma === true) {
      return invokeAkumaStatus(coordinate ?? ".", parsed.contract);
    }
    const report = await kanshi(coordinate === undefined ? {} : { path: coordinate });
    if (parsed.contract === undefined) return { kind: "status", report };
    const contract = resolveKanshiContract(report, parsed.contract);
    return { kind: "status", report: selectKanshi({ report, contract }) };
  }
  const repo = repoAt(coordinate);
  const scope = coordinate ?? repo.root;

  switch (parsed.command) {
    case "reconcile": {
      if (parsed.contract === undefined) {
        return { kind: "observation", command: "reconcile", ...await repo.reconcile() };
      }
      const { contract } = await selectContract(repo, parsed.contract, scope);
      const { kind: reconciliation, ...report } = await contract.reconcile();
      return { kind: "observation", command: "reconcile", reconciliation, ...report };
    }
    case "bind":
      return invokeBind(parsed, repo, edge);
    default:
      return invokeExisting(parsed, repo, edge, scope);
  }
}

async function invokeInstall(command: Extract<ParsedCommand, { command: "install" }>, runtime: InvokeRuntime): Promise<InstallInvocationResult> {
  return installHarnesses(command.harnesses, runtime.environment ?? process.env);
}

export async function invoke(invocation: ParsedExecution, runtime: InvokeRuntime = {}): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult | SettingsInvocationResult | InstallInvocationResult> {
  try {
    const command = invocation.command;
    if (command.command === "install") return await invokeInstall(command, runtime);
    return await invokeParsed({ ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }), command }, runtime);
  } catch (error) {
    if (error instanceof CliUsageError && error.projection === undefined) {
      throw new CliUsageError(error.diagnostic, renderCommandUsage(invocation.command));
    }
    throw error;
  }
}
