import type { ContractState, SnapshotId } from "../core/facts/types.js";
import { gitObjectId, gitObjectIdForSnapshot, mintSnapshotId, type GitObjectId } from "./identity.js";
import { runGit, type GitOid, type GitRepository } from "./repository.js";
import { captureWorkspaceTree } from "./workspace.js";

export type UnsealedBytes = Readonly<{
  kind: "unsealed-bytes";
  path: string;
  paths: readonly string[];
  head?: SnapshotId;
}>;

export type TerminalSealExpectations = Readonly<{
  heads: readonly SnapshotId[];
  trees: readonly GitObjectId[];
  treeBySnapshot: ReadonlyMap<SnapshotId, GitObjectId>;
}>;
export type TerminalSealObject = Readonly<{ kind: "present"; type: string; bytes: Buffer }>
  | Readonly<{ kind: "missing" }>;
type CommitMetadata = Readonly<{ tree: GitObjectId; parents: readonly SnapshotId[] }>;

export function terminalSealSnapshots(state: ContractState): readonly SnapshotId[] {
  return [...new Set([
    state.coordinates.start,
    ...(state.delivery === null ? [] : [
      state.delivery.data.tenderSnapshot,
      state.delivery.data.integration.snapshot,
    ]),
  ])];
}

function commitMetadata(snapshot: SnapshotId, result: TerminalSealObject | undefined): CommitMetadata {
  if (result === undefined || result.kind === "missing") {
    throw new Error(`terminal seal commit is missing: ${snapshot}`);
  }
  if (result.type !== "commit") throw new Error(`terminal seal snapshot is not a commit: ${snapshot}`);
  const headerEnd = result.bytes.indexOf("\n\n");
  if (headerEnd < 0) throw new Error(`terminal seal commit has no headers: ${snapshot}`);
  const headers = result.bytes.subarray(0, headerEnd).toString("ascii").split("\n");
  const treeHeader = headers[0];
  if (treeHeader === undefined || !treeHeader.startsWith("tree ")) {
    throw new Error(`terminal seal commit has no root tree: ${snapshot}`);
  }
  return {
    tree: gitObjectId(treeHeader.slice("tree ".length), "terminal seal tree"),
    parents: headers
      .filter((header) => header.startsWith("parent "))
      .map((header) => mintSnapshotId(header.slice("parent ".length))),
  };
}

export function terminalSealExpectations(
  state: ContractState,
  objects: ReadonlyMap<GitOid, TerminalSealObject>,
): TerminalSealExpectations {
  const snapshots = terminalSealSnapshots(state);
  const metadata = new Map(snapshots.map((snapshot) => [
    snapshot,
    commitMetadata(snapshot, objects.get(gitObjectIdForSnapshot(snapshot))),
  ]));
  const treeBySnapshot = new Map([...metadata].map(([snapshot, commit]) => [snapshot, commit.tree]));
  if (state.delivery === null) {
    return { heads: [state.coordinates.start], trees: [...treeBySnapshot.values()], treeBySnapshot };
  }
  const tender = state.delivery.data.tenderSnapshot;
  const tenderMetadata = metadata.get(tender);
  if (tenderMetadata === undefined) throw new Error(`terminal seal metadata was not resolved: ${tender}`);
  const [tenderParent] = tenderMetadata.parents;
  return {
    heads: [...new Set([
      state.coordinates.start,
      ...(tenderParent === undefined ? [] : [tenderParent]),
      tender,
      state.delivery.data.integration.snapshot,
    ])],
    trees: [...treeBySnapshot.values()],
    treeBySnapshot,
  };
}

async function changedPaths(repository: GitRepository, left: string, right: string): Promise<readonly string[]> {
  const fields = (await runGit(repository, ["diff", "--name-only", "-z", left, right])).toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("Git tree diff paths are not NUL terminated");
  return fields.slice(0, -1).sort();
}

export async function unsealedBytes(
  repository: GitRepository,
  path: string,
  expected: TerminalSealExpectations,
): Promise<UnsealedBytes | null> {
  const workspace = await captureWorkspaceTree(repository, path);
  const headIsSealed = expected.heads.includes(workspace.head);
  if (workspace.changes.submodules.length > 0) {
    return {
      kind: "unsealed-bytes",
      path,
      paths: workspace.changes.submodules,
      ...(headIsSealed ? {} : { head: workspace.head }),
    };
  }
  if (headIsSealed && expected.trees.includes(workspace.tree)) return null;
  const alternatives: (readonly string[])[] = [];
  for (const tree of expected.trees) alternatives.push(await changedPaths(repository, tree, workspace.tree));
  alternatives.sort((left, right) => left.length - right.length || left.join("\0").localeCompare(right.join("\0")));
  return {
    kind: "unsealed-bytes",
    path,
    paths: alternatives[0] ?? [],
    ...(headIsSealed ? {} : { head: workspace.head }),
  };
}
