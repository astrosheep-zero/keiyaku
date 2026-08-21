import { resolve } from "node:path";
import { identitySegments } from "../identity/coordinates.js";
import { Keiyaku, type ContractBoard, type ContractId, type ContractRow, type Repo } from "../index.js";
import type { KanshiReport } from "../kanshi/index.js";
import { CliUsageError } from "./parse.js";

type SelectorCandidate = Readonly<{
  id: ContractId;
  worktreePath: string;
}>;

function selectorError(message: string): never {
  throw new CliUsageError(message);
}

function activeManagedCandidates(rows: readonly ContractRow[]): readonly SelectorCandidate[] {
  return rows.flatMap((contract) => {
    if (contract.disposition !== "active" || contract.workspace !== "worktree" || contract.worktreePath === null)
      return [];
    return [{ id: contract.id, worktreePath: contract.worktreePath }];
  });
}

export type SelectedContract = Readonly<{ id: ContractId; contract: Keiyaku }>;

export function contractFromInput(repo: Repo, value: string): SelectedContract {
  try {
    const id = value as ContractId;
    return { id, contract: Keiyaku.of({ repo, id }) };
  } catch (error) {
    selectorError(error instanceof Error ? error.message : String(error));
  }
}

function resolveShortContract(rows: readonly ContractRow[], selector: string): ContractId {
  if (selector.startsWith("@kei/")) selectorError(`redundant short contract selector: ${selector}`);
  const short = selector.slice(1);
  const candidates = activeManagedCandidates(rows).filter((candidate) => candidate.id.slice("kei/".length) === short);
  if (candidates.length === 0) selectorError(`unknown contract selector: ${selector}`);
  if (candidates.length !== 1) selectorError(`ambiguous contract selector: ${selector}`);
  return candidates[0]!.id;
}

function resolveOmittedContract(board: ContractBoard, scope: string): ContractId {
  const candidates = activeManagedCandidates(board.rows).filter(
    (candidate) => resolve(scope) === resolve(candidate.worktreePath),
  );
  if (candidates.length === 0) {
    selectorError("an explicit full or @ contract selector is required outside a managed worktree");
  }
  if (candidates.length !== 1) selectorError("ambiguous managed worktree contract selector");
  return candidates[0]!.id;
}

export function resolveContextualContract(
  board: ContractBoard,
  selector: string | undefined,
  scope: string,
): ContractId {
  if (selector === undefined) return resolveOmittedContract(board, scope);
  if (selector.startsWith("@")) return resolveShortContract(board.rows, selector);
  return selectorError(`contract selector must be kei/<contract-segment> or @<contract-segment>: ${selector}`);
}

export function canonicalContractSelector(selector: string): ContractId {
  try {
    identitySegments({ family: "kei", value: selector });
  } catch {
    return selectorError(`contract selector must use kei/: ${selector}`);
  }
  return selector as ContractId;
}

export function resolveKanshiContract(report: KanshiReport, selector: string): string {
  if (report.contracts.kind !== "present") {
    return selectorError(`cannot select a contract while the Contract world is ${report.contracts.kind}`);
  }
  if (selector.startsWith("@")) return resolveShortContract(report.contracts.value.rows, selector);
  return canonicalContractSelector(selector);
}
