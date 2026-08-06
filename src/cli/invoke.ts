import { readFileSync } from "node:fs";
import { Keiyaku, Repo, type ActorId, type ChangeId, type ContractId, type Keiyaku as KeiyakuContract, type Outcome, type SnapshotId } from "../index.js";
import { resolveActor } from "./actor.js";
import { resultFromOutcome } from "./accepted.js";
import { abandonFromCommand } from "./commands/abandon.js";
import { amendFromCommand } from "./commands/amend.js";
import { arcFromCommand } from "./commands/arc.js";
import { auditFromCommand } from "./commands/audit.js";
import { bindFromCommand } from "./commands/bind.js";
import { deliverFromCommand } from "./commands/deliver.js";
import { reconcileAllFromCommand, reconcileFromCommand } from "./commands/reconcile.js";
import { reviewFromCommand } from "./commands/review.js";
import { statusFromCommand } from "./commands/status.js";
import { CliUsageError, type ParsedInvocation } from "./parse.js";
import type { DiffUnavailable, InvocationResult } from "./result.js";
import { contractIdentity, resolveExistingContract, resolveOptionalContract } from "./selectors.js";
import { selectedGates } from "./settings.js";

export type { AcceptedFact, DiffUnavailable, InvocationResult, Lag } from "./result.js";

export type InvokeRuntime = Readonly<{
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  readStdin?: () => string;
}>;

type ParsedCommand = ParsedInvocation["command"];
type ExistingCommand = Exclude<ParsedCommand, { command: "bind" | "status" | "reconcile" }>;
type InvocationEdge = Readonly<{
  coordinate?: string;
  environment: NodeJS.ProcessEnv;
  readStdin: () => string;
}>;

function inputValue<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
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

function contractAt(id: ContractId, coordinate: string | undefined): KeiyakuContract {
  return coordinate === undefined ? Keiyaku.of({ id }) : Keiyaku.of({ id, repo: coordinate });
}

async function statusAt(coordinate: string | undefined): Promise<Awaited<ReturnType<Repo["status"]>>> {
  const repo = repoAt(coordinate);
  return repo.status();
}

async function selectContract(selector: string | undefined, coordinate: string | undefined): Promise<ContractId> {
  if (selector !== undefined && selector.startsWith("kei/")) return contractIdentity(selector);
  const status = await statusAt(coordinate);
  return resolveExistingContract(status, selector);
}

async function resultForExisting<A>(
  verb: string,
  outcome: Outcome<A>,
  contract: KeiyakuContract,
  id: ContractId,
): Promise<InvocationResult> {
  return resultFromOutcome(verb, outcome, contract, id);
}

async function invokeBind(parsed: Extract<ParsedCommand, { command: "bind" }>, edge: InvocationEdge): Promise<InvocationResult> {
  const markdown = inputValue(edge.readStdin);
  const repo = repoAt(edge.coordinate);
  const gates = selectedGates(repo.root, parsed.gates);
  const outcome = await bindFromCommand(parsed, markdown, edge.coordinate, gates, actorFromEdge(parsed.actor, edge.environment));
  return resultFromOutcome("bind", outcome, outcome.kind === "accepted" ? outcome.value : null);
}

function unavailableDiff(delivery: { snapshotId: SnapshotId; changeId: ChangeId }): DiffUnavailable {
  return {
    reason: "transport-unavailable",
    snapshotId: delivery.snapshotId,
    changeId: delivery.changeId,
  };
}

async function invokeExisting(parsed: ExistingCommand, edge: InvocationEdge): Promise<InvocationResult> {
  const id = await selectContract(parsed.contract, edge.coordinate);
  const contract = contractAt(id, edge.coordinate);
  const actor = actorFromEdge(parsed.actor, edge.environment);

  switch (parsed.command) {
    case "amend": {
      const markdown = inputValue(edge.readStdin);
      const gates = parsed.gates === undefined
        ? undefined
        : selectedGates(repoAt(edge.coordinate).root, parsed.gates);
      const outcome = await amendFromCommand(parsed, contract, markdown, gates, actor);
      return resultFromOutcome("amend", outcome, contract, id);
    }
    case "deliver":
      return resultForExisting("deliver", await deliverFromCommand(parsed, contract, actor), contract, id);
    case "review": {
      const review = parsed.summaryFromStdin === true
        ? { ...parsed, summary: inputValue(edge.readStdin) }
        : parsed;
      return resultForExisting("review", await reviewFromCommand(review, id, contract, actor), contract, id);
    }
    case "arc": {
      const markdown = inputValue(edge.readStdin);
      return resultForExisting("arc", await arcFromCommand(parsed, contract, markdown, actor), contract, id);
    }
    case "abandon":
      return resultForExisting("abandon", await abandonFromCommand(parsed, contract, actor), contract, id);
    case "audit": {
      const delivery = parsed.showDiffBody ? await contract.delivery() : null;
      const outcome = await auditFromCommand(parsed, contract, actor);
      const diff = parsed.showDiffBody && delivery !== null && outcome.kind === "accepted"
        ? await delivery.diff()
        : undefined;
      let renderedDiff: string | DiffUnavailable | undefined;
      if (diff === null) {
        if (delivery === null) throw new Error("delivery diff was returned without a delivery");
        renderedDiff = unavailableDiff(delivery);
      } else {
        renderedDiff = diff;
      }
      if (outcome.kind === "accepted" && outcome.receipt.facts.length === 0) {
        return {
          kind: "observation",
          command: "audit",
          ...outcome.value,
          ...(renderedDiff === undefined ? {} : { diff: renderedDiff }),
        };
      }
      const result = outcome.kind === "accepted"
        ? await resultFromOutcome("audit", outcome, contract, id, outcome.value)
        : await resultForExisting("audit", outcome, contract, id);
      return result.kind === "accepted" && renderedDiff !== undefined ? { ...result, diff: renderedDiff } : result;
    }
    default:
      throw new TypeError("unhandled command");
  }
}

export async function invoke(invocation: ParsedInvocation, runtime: InvokeRuntime = {}): Promise<InvocationResult> {
  const coordinate = invocation.cwd ?? runtime.cwd;
  const edge: InvocationEdge = {
    ...(coordinate === undefined ? {} : { coordinate }),
    environment: runtime.environment ?? process.env,
    readStdin: runtime.readStdin ?? (() => readFileSync(0, "utf8")),
  };
  const parsed = invocation.command;

  switch (parsed.command) {
    case "status": {
      const status = await statusAt(edge.coordinate);
      return statusFromCommand(status, parsed, resolveOptionalContract(status, parsed.contract));
    }
    case "reconcile": {
      if (parsed.contract === undefined) return reconcileAllFromCommand(repoAt(edge.coordinate));
      const id = await selectContract(parsed.contract, edge.coordinate);
      return reconcileFromCommand(id, contractAt(id, edge.coordinate));
    }
    case "bind":
      return invokeBind(parsed, edge);
    default:
      return invokeExisting(parsed, edge);
  }
}
