import { resolve } from "node:path";
import type { ContractId, StatusReport } from "../index.js";
import { CliUsageError } from "./parse.js";

type SelectorCandidate = Readonly<{
  id: ContractId;
  worktreePath: string;
}>;

const CONTRACT_ID = /^kei\/[a-z0-9][a-z0-9-]*$/;

function selectorError(message: string): never {
  throw new CliUsageError(message);
}

function activeManagedCandidates(status: StatusReport): readonly SelectorCandidate[] {
  return status.contracts.flatMap((contract) => {
    if (contract.terminal !== null || contract.workspace !== "worktree" || contract.worktreePath === null) return [];
    return [{ id: contract.contractId, worktreePath: contract.worktreePath }];
  });
}

export function contractIdentity(value: string): ContractId {
  if (!CONTRACT_ID.test(value)) selectorError("contract ID must be kei/<lowercase-machine-contract>");
  return value as ContractId;
}

function resolveShortContract(status: StatusReport, selector: string): ContractId {
  if (selector.startsWith("@kei/")) selectorError(`redundant short contract selector: ${selector}`);
  const short = selector.slice(1);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(short)) selectorError(`invalid short contract selector: ${selector}`);
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

export function resolveExistingContract(status: StatusReport, selector: string | undefined): ContractId {
  if (selector === undefined) return resolveOmittedContract(status);
  if (selector.startsWith("kei/")) return contractIdentity(selector);
  if (selector.startsWith("@")) return resolveShortContract(status, selector);
  return selectorError(`contract selector must be kei/<machine-contract> or @<machine-contract>: ${selector}`);
}

export function resolveOptionalContract(status: StatusReport, selector: string | undefined): ContractId | undefined {
  return selector === undefined ? undefined : resolveExistingContract(status, selector);
}
