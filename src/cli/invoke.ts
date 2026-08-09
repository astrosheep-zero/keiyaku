import { readFileSync } from "node:fs";
import { Keiyaku, Repo, type ActorId, type ChangeId, type ContractId, type Keiyaku as KeiyakuContract, type Outcome, type SnapshotId } from "../index.js";
import { kanshi, selectKanshi } from "../kanshi/index.js";
import { resolveActor } from "./actor.js";
import { resultFromOutcome } from "./accepted.js";
import { amendFromCommand } from "./commands/amend.js";
import { invokeAkuma, type AkumaInvocationResult } from "./commands/akuma-invoke.js";
import { bindFromCommand } from "./commands/bind.js";
import { invokeTask, type TaskInvocationResult } from "./commands/task-invoke.js";
import { CliUsageError, renderCommandUsage, type ParsedCommand, type ParsedExecution } from "./parse.js";
import type { AcceptedResult, DiffUnavailable, InvocationResult } from "./result.js";
import { contractFromInput, resolveContextualContract, resolveKanshiContract, type SelectedContract } from "./selectors.js";
import { selectedGates } from "./settings.js";

export type { AcceptedFact, DiffUnavailable, InvocationResult, Lag } from "./result.js";

type InvokeRuntime = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readStdin?: () => string;
}>;

type ExistingCommand = Exclude<ParsedCommand, { command: "akuma" | "bind" | "status" | "reconcile" | "task" }>;
type InvocationEdge = Readonly<{
  environment: NodeJS.ProcessEnv;
  readStdin: () => string;
}>;

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

async function resultForExisting<A>(
  verb: string,
  outcome: Outcome<A>,
  contract: KeiyakuContract,
  id: ContractId,
  obligations: Pick<AcceptedResult, "verification" | "placement" | "leak"> = {},
): Promise<InvocationResult> {
  return resultFromOutcome(verb, outcome, { coordinate: id, reconcile: contract, obligations });
}

async function invokeBind(
  parsed: Extract<ParsedCommand, { command: "bind" }>,
  repo: Repo,
  edge: InvocationEdge,
): Promise<InvocationResult> {
  const markdown = edge.readStdin();
  const gates = selectedGates(repo.root, parsed.gates);
  const outcome = await bindFromCommand(parsed, repo, markdown, gates, actorFromEdge(parsed.actor, edge.environment));
  return resultFromOutcome("bind", outcome, outcome.kind === "accepted" ? { reconcile: outcome.value } : {});
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
  const outcome = await seat.contract.deliver({
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  });
  const obligations = outcome.kind !== "accepted" ? {} : {
    ...(outcome.value.verification === undefined ? {} : { verification: outcome.value.verification }),
    ...(outcome.value.placement === undefined ? {} : { placement: outcome.value.placement }),
    ...(outcome.value.leak === undefined ? {} : { leak: outcome.value.leak }),
  };
  return resultForExisting("deliver", outcome, seat.contract, seat.id, obligations);
}

async function invokeReview(
  parsed: Extract<ExistingCommand, { command: "review" }>,
  seat: ExistingSeat,
  readStdin: () => string,
): Promise<InvocationResult> {
  const summary = parsed.summaryFromStdin === true ? readStdin() : parsed.summary;
  const outcome = await seat.contract.review({
    verdict: parsed.verdict,
    ...(seat.actor === undefined ? {} : { actor: seat.actor }),
    ...(summary === undefined ? {} : { summary }),
  });
  const obligations = outcome.kind !== "accepted" || outcome.value.placement === undefined
    ? {}
    : { placement: outcome.value.placement };
  return resultForExisting("review", outcome, seat.contract, seat.id, obligations);
}

async function invokeAudit(
  parsed: Extract<ExistingCommand, { command: "audit" }>,
  seat: ExistingSeat,
): Promise<InvocationResult> {
  const delivery = parsed.showDiffBody ? await seat.contract.delivery() : null;
  const outcome = await seat.contract.audit(seat.actor === undefined ? {} : { actor: seat.actor });
  let renderedDiff: string | DiffUnavailable | undefined;
  if (parsed.showDiffBody && delivery !== null && outcome.kind === "accepted") {
    const diff = await delivery.diff();
    renderedDiff = diff === null ? unavailableDiff(delivery) : diff;
  }
  const result = outcome.kind === "accepted"
    ? await resultFromOutcome("audit", outcome, { coordinate: seat.id, report: outcome.value })
    : await resultFromOutcome("audit", outcome, { coordinate: seat.id });
  return result.kind === "accepted" && renderedDiff !== undefined ? { ...result, diff: renderedDiff } : result;
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
        : selectedGates(repo.root, parsed.gates);
      const outcome = await amendFromCommand({ command: parsed, repo, contract, markdown, gates, ...(actor === undefined ? {} : { actor }) });
      return resultFromOutcome("amend", outcome, { coordinate: id, reconcile: contract });
    }
    case "deliver":
      return invokeDeliver(parsed, seat);
    case "review":
      return invokeReview(parsed, seat, edge.readStdin);
    case "arc": {
      const markdown = edge.readStdin();
      return resultForExisting("arc", await contract.arc({
        markdown,
        ...(actor === undefined ? {} : { actor }),
      }), contract, id);
    }
    case "abandon":
      return resultForExisting("abandon", await contract.abandon({
        ...(actor === undefined ? {} : { actor }),
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
      }), contract, id);
    case "audit":
      return invokeAudit(parsed, seat);
    default:
      return parsed satisfies never;
  }
}

async function invokeParsed(invocation: ParsedExecution, runtime: InvokeRuntime): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult> {
  const coordinate = invocation.cwd ?? runtime.cwd;
  const edge: InvocationEdge = {
    environment: runtime.environment ?? process.env,
    readStdin: runtime.readStdin ?? (() => readFileSync(0, "utf8")),
  };
  const parsed = invocation.command;
  if (parsed.command === "task") {
    try { return await invokeTask(parsed, { ...(coordinate === undefined ? {} : { path: coordinate }), readStdin: edge.readStdin }); }
    catch (error) { if (error instanceof TypeError) throw new CliUsageError(error.message); throw error; }
  }
  if (parsed.command === "akuma") {
    return await invokeAkuma(parsed, { path: coordinate ?? ".", readStdin: edge.readStdin });
  }
  if (parsed.command === "status") {
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
      return { kind: "observation", command: "reconcile", ...await contract.reconcile() };
    }
    case "bind":
      return invokeBind(parsed, repo, edge);
    default:
      return invokeExisting(parsed, repo, edge, scope);
  }
}

export async function invoke(invocation: ParsedExecution, runtime: InvokeRuntime = {}): Promise<InvocationResult | TaskInvocationResult | AkumaInvocationResult> {
  try {
    return await invokeParsed(invocation, runtime);
  } catch (error) {
    if (error instanceof CliUsageError && error.projection === undefined) {
      throw new CliUsageError(error.diagnostic, renderCommandUsage(invocation.command));
    }
    throw error;
  }
}
