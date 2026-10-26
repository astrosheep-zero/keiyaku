import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { contractId } from "../core/facts/types.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import { contractsOperation, type RepositoryScope } from "../protocol/operations.js";
import type { ContractBoard, ContractRow } from "../protocol/read/status.js";
import type { ContractResolution, ContractResolveInput } from "./contract-types.js";
import { requireInput } from "./input.js";
import { readContractValue } from "./outcome.js";
import { scopeForRepo, type Repo } from "./repo.js";

/** Pure Contract membership shared with mixed Address; no cross-family judgment. */
export function matchContractCandidates(
  rows: readonly ContractRow[],
  selection: Readonly<{ selector: string }> | Readonly<{ cwd: string }>,
): readonly ContractRow[] {
  return rows.filter(
    (row) =>
      row.disposition === "active" &&
      row.workspace === "worktree" &&
      row.worktreePath !== null &&
      ("selector" in selection
        ? `@${row.id.slice("kei/".length)}` === selection.selector
        : normalize(row.worktreePath) === selection.cwd),
  );
}

/** The complete live Contract board: the Contract owner's own candidate set, never a display catalogue. */
function completeBoard(scope: RepositoryScope): Promise<ContractBoard> {
  return withGitDecodeChannel(scope, (channel) => contractsOperation({ scope, channel }));
}

/**
 * The complete live Contract candidates a named selection judges membership
 * against. No display bound applies, so age never decides which names exist.
 */
export async function readCompleteContractCandidates(repo: Repo): Promise<readonly ContractRow[]> {
  return (await completeBoard(scopeForRepo(repo))).rows;
}

export async function resolveContract(input: ContractResolveInput): Promise<ContractResolution> {
  const values = requireInput(input, "Keiyaku.with().resolve input", ["repo", "selector", "cwd"]);
  const scope = scopeForRepo(values.repo);
  const selector = values.selector;
  if (selector !== undefined && typeof selector !== "string") throw new TypeError("selector must be a string");
  const suppliedCwd = values.cwd;
  if (suppliedCwd !== undefined && (typeof suppliedCwd !== "string" || !isAbsolute(suppliedCwd)))
    throw new TypeError("cwd must be an absolute directory coordinate");
  let cwd = scope.invocationWorktree;
  if (typeof suppliedCwd === "string") {
    try {
      cwd = await realpath(suppliedCwd);
      if (!(await stat(cwd)).isDirectory()) throw new TypeError("cwd must be a directory");
    } catch (cause) {
      throw new TypeError("cwd must be an absolute directory coordinate", { cause });
    }
  }
  if (selector !== undefined) {
    if (selector.startsWith("@kei/"))
      return { kind: "refused", refusal: { kind: "redundant-short-selector", selector } };
    try {
      const id = contractId(selector.startsWith("@") ? `kei/${selector.slice(1)}` : selector);
      if (!selector.startsWith("@")) return { kind: "resolved", id };
    } catch (error) {
      return {
        kind: "refused",
        refusal: {
          kind: "invalid-selector",
          selector,
          diagnostic: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  const board = await readContractValue(() => completeBoard(scope));
  const candidates = matchContractCandidates(board.rows, selector === undefined ? { cwd } : { selector });
  if (candidates.length === 1) return { kind: "resolved", id: candidates[0]!.id };
  if (selector === undefined) {
    return {
      kind: "refused",
      refusal: candidates.length === 0 ? { kind: "no-contextual-match", cwd } : { kind: "ambiguous-selector", cwd },
    };
  }
  return {
    kind: "refused",
    refusal:
      candidates.length === 0 ? { kind: "unknown-short-selector", selector } : { kind: "ambiguous-selector", selector },
  };
}
