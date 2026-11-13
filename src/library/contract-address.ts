import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { contractId, type ContractId } from "../core/facts/types.js";
import { KeiyakuError } from "../errors.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import { contractsOperation, type RepositoryScope } from "../protocol/operations.js";
import type { ContractMembership } from "../protocol/read/status.js";
import type { ContractResolution, ContractResolveInput } from "./contract-types.js";
import { requireInput } from "./input.js";
import { readContractValue } from "./outcome.js";

/** Pure Contract membership shared with mixed Address; no cross-family judgment. */
export function matchContractCandidates(
  rows: readonly ContractMembership[],
  selection: Readonly<{ selector: string }> | Readonly<{ cwd: string }>,
): readonly ContractMembership[] {
  return rows.filter(
    (row) =>
      row.phase === "bound" &&
      "path" in row.workspace &&
      ("selector" in selection
        ? `@${row.id.slice("kei/".length)}` === selection.selector
        : normalize(row.workspace.path) === selection.cwd),
  );
}

/** Observe complete contextual membership, or only the explicitly named identities. */
export function readContractCandidates(
  scope: RepositoryScope,
  ids?: readonly ContractId[],
): Promise<readonly ContractMembership[]> {
  return withGitDecodeChannel(scope, (channel) =>
    contractsOperation({ scope, channel, ...(ids === undefined ? {} : { ids }) }),
  );
}

export async function resolveContract(
  scope: RepositoryScope,
  input: ContractResolveInput,
): Promise<ContractResolution> {
  const values = requireInput(input, "Keis.resolve input", ["selector", "cwd"]);
  const selector = values.selector;
  if (selector !== undefined && typeof selector !== "string")
    throw new KeiyakuError("invalid-input", "selector must be a string");
  const suppliedCwd = values.cwd;
  if (suppliedCwd !== undefined && (typeof suppliedCwd !== "string" || !isAbsolute(suppliedCwd)))
    throw new KeiyakuError("invalid-input", "cwd must be an absolute directory coordinate");
  let cwd = scope.invocationWorktree;
  if (typeof suppliedCwd === "string") {
    try {
      cwd = await realpath(suppliedCwd);
      if (!(await stat(cwd)).isDirectory()) throw new TypeError("cwd must be a directory");
    } catch (cause) {
      throw new KeiyakuError("invalid-input", "cwd must be an absolute directory coordinate", { cause });
    }
  }
  let ids: readonly ContractId[] | undefined;
  if (selector !== undefined) {
    if (selector.startsWith("@kei/"))
      return { kind: "refused", refusal: { kind: "redundant-short-selector", selector } };
    try {
      const id = contractId(selector.startsWith("@") ? `kei/${selector.slice(1)}` : selector);
      if (!selector.startsWith("@")) return { kind: "resolved", id };
      ids = [id];
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
  const rows = await readContractValue(() => readContractCandidates(scope, ids));
  const candidates = matchContractCandidates(rows, selector === undefined ? { cwd } : { selector });
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
