import { localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import { identitySegments } from "../identity/coordinates.js";
import { Keiyaku, type ContractId, type Repo } from "../index.js";
import { composeContractLibrary } from "../library/contract-composition.js";
import { createKeiyakuHandle } from "../library/keiyaku.js";
import { CliUsageError } from "./parse.js";

type SelectedContract = Readonly<{ id: ContractId; contract: Keiyaku }>;

export function contractFromInput(
  repo: Repo,
  value: string,
  execution: ExecutionContext = localExecutionContext(),
): SelectedContract {
  try {
    const id = value as ContractId;
    return { id, contract: composeContractLibrary(execution, createKeiyakuHandle).select({ repo, id }) };
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Adapt public Contract resolution evidence to the existing CLI usage diagnostics. */
export async function resolveContractId(repo: Repo, selector: string | undefined, cwd: string): Promise<ContractId> {
  const result = await Keiyaku.with().resolve({ repo, ...(selector === undefined ? {} : { selector }), cwd });
  if (result.kind === "resolved") return result.id;
  const refusal = result.refusal;
  switch (refusal.kind) {
    case "invalid-selector":
      throw new CliUsageError(refusal.diagnostic);
    case "redundant-short-selector":
      throw new CliUsageError(`redundant short contract selector: ${refusal.selector}`);
    case "unknown-short-selector":
      throw new CliUsageError(`unknown contract selector: ${refusal.selector}`);
    case "ambiguous-selector":
      throw new CliUsageError(
        "selector" in refusal
          ? `ambiguous contract selector: ${refusal.selector}`
          : "ambiguous managed worktree contract selector",
      );
    case "no-contextual-match":
      throw new CliUsageError("an explicit full or @ contract selector is required outside a managed worktree");
  }
}

export function canonicalContractSelector(selector: string): ContractId {
  try {
    identitySegments({ family: "kei", value: selector });
  } catch {
    throw new CliUsageError(`contract selector must use kei/: ${selector}`);
  }
  return selector as ContractId;
}
