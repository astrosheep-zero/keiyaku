import type { ContractState, SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot, mintSnapshotId } from "./identity.js";
import { runGit, type GitRepository } from "./repository.js";
import { captureWorkspaceTree } from "./workspace.js";

export type UnsealedBytes = Readonly<{
  kind: "unsealed-bytes";
  path: string;
  paths: readonly string[];
  head?: SnapshotId;
}>;

export type TerminalSealExpectations = Readonly<{
  heads: readonly SnapshotId[];
  trees: readonly SnapshotId[];
}>;

function commitTree(repository: GitRepository, snapshot: SnapshotId): string {
  return runGit(repository, ["rev-parse", "--verify", `${gitObjectIdForSnapshot(snapshot)}^{tree}`])
    .toString("utf8")
    .trim();
}

function commitParents(repository: GitRepository, snapshot: SnapshotId): readonly SnapshotId[] {
  const fields = runGit(repository, ["rev-list", "--parents", "-n", "1", gitObjectIdForSnapshot(snapshot)])
    .toString("utf8")
    .trim()
    .split(" ");
  if (fields.length === 0 || fields[0] !== snapshot) throw new Error("Git commit parent row is malformed");
  return fields.slice(1).map((parent) => mintSnapshotId(parent));
}

function changedPaths(repository: GitRepository, left: string, right: string): readonly string[] {
  const fields = runGit(repository, ["diff", "--name-only", "-z", left, right]).toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("Git tree diff paths are not NUL terminated");
  return fields.slice(0, -1).sort();
}

export function terminalSealExpectations(
  repository: GitRepository,
  state: ContractState,
): TerminalSealExpectations {
  if (state.delivery === null) return { heads: [state.coordinates.start], trees: [state.coordinates.start] };
  const tender = state.delivery.data.tenderSnapshot;
  const [tenderParent] = commitParents(repository, tender);
  return {
    heads: [...new Set([
      state.coordinates.start,
      ...(tenderParent === undefined ? [] : [tenderParent]),
      tender,
      state.delivery.data.integration.snapshot,
    ])],
    trees: [state.coordinates.start, tender, state.delivery.data.integration.snapshot],
  };
}

export function unsealedBytes(
  repository: GitRepository,
  path: string,
  expected: TerminalSealExpectations,
): UnsealedBytes | null {
  const workspace = captureWorkspaceTree(repository, path);
  const trees = expected.trees.map((snapshot) => commitTree(repository, snapshot));
  const headIsSealed = expected.heads.includes(workspace.head);
  if (workspace.changes.submodules.length > 0) {
    return {
      kind: "unsealed-bytes",
      path,
      paths: workspace.changes.submodules,
      ...(headIsSealed ? {} : { head: workspace.head }),
    };
  }
  if (headIsSealed && trees.includes(workspace.tree)) return null;
  const alternatives = trees.map((tree) => changedPaths(repository, tree, workspace.tree));
  alternatives.sort((left, right) => left.length - right.length || left.join("\0").localeCompare(right.join("\0")));
  return {
    kind: "unsealed-bytes",
    path,
    paths: alternatives[0] ?? [],
    ...(headIsSealed ? {} : { head: workspace.head }),
  };
}
