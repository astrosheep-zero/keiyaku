import { resolve } from "node:path";
import { type ContractId, type Keiyaku, type Repo, type StatusReport } from "../index.js";
import { CliUsageError } from "./parse.js";

type SelectorCandidate = Readonly<{
  id: ContractId;
  worktreePath: string;
}>;

function selectorError(message: string): never {
  throw new CliUsageError(message);
}

function activeManagedCandidates(status: StatusReport): readonly SelectorCandidate[] {
  return status.contracts.flatMap((contract) => {
    if (contract.phase === "claimed" || contract.phase === "abandoned" || contract.workspace !== "worktree" || contract.worktreePath === null) return [];
    return [{ id: contract.contractId, worktreePath: contract.worktreePath }];
  });
}

export type SelectedContract = Readonly<{ id: ContractId; contract: Keiyaku }>;

export function contractFromInput(repo: Repo, value: string): SelectedContract {
  try {
    const id = value as ContractId;
    return { id, contract: repo.contract({ id }) };
  } catch (error) {
    selectorError(error instanceof Error ? error.message : String(error));
  }
}

function resolveShortContract(status: StatusReport, selector: string): ContractId {
  if (selector.startsWith("@kei/")) selectorError(`redundant short contract selector: ${selector}`);
  const short = selector.slice(1);
  const candidates = activeManagedCandidates(status)
    .filter((candidate) => candidate.id.slice("kei/".length) === short);
  if (candidates.length === 0) selectorError(`unknown contract selector: ${selector}`);
  if (candidates.length !== 1) selectorError(`ambiguous contract selector: ${selector}`);
  return candidates[0]!.id;
}

function resolveOmittedContract(status: StatusReport): ContractId {
  const candidates = activeManagedCandidates(status)
    .filter((candidate) => resolve(status.scope) === resolve(candidate.worktreePath));
  if (candidates.length === 0) {
    selectorError("an explicit full or @ contract selector is required outside a managed worktree");
  }
  if (candidates.length !== 1) selectorError("ambiguous managed worktree contract selector");
  return candidates[0]!.id;
}

export function resolveContextualContract(status: StatusReport, selector: string | undefined): ContractId {
  if (selector === undefined) return resolveOmittedContract(status);
  if (selector.startsWith("@")) return resolveShortContract(status, selector);
  return selectorError(`contract selector must be kei/<contract-segment> or @<contract-segment>: ${selector}`);
}
