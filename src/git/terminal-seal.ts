import { z } from "zod";
import type { ContractState, SnapshotId } from "../core/facts/types.js";
import { gitObjectId, gitObjectIdForSnapshot, mintSnapshotId, type GitObjectId } from "./identity.js";
import type { GitOid } from "./repository.js";
import { type GitRepository } from "./process.js";
import { captureWorkspaceTree } from "./workspace.js";

export const unsealedBytesSchema = z
  .object({
    kind: z.literal("unsealed-bytes"),
    path: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
type UnsealedBytes = z.infer<typeof unsealedBytesSchema>;
export type TerminalSealExpectations = Readonly<{
  heads: readonly SnapshotId[];
  trees: readonly GitObjectId[];
  treeBySnapshot: ReadonlyMap<SnapshotId, GitObjectId>;
}>;
type TerminalSealObject = Readonly<{ kind: "present"; type: string; bytes: Buffer }> | Readonly<{ kind: "missing" }>;
type CommitMetadata = Readonly<{ tree: GitObjectId; parents: readonly SnapshotId[] }>;
type WorkspaceTree = Awaited<ReturnType<typeof captureWorkspaceTree>>;
export type TerminalWorkspace = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  submodules: readonly string[];
}>;
type TerminalWorkspaceObservation = Readonly<{
  workspace: TerminalWorkspace;
  unsealed: UnsealedBytes | null;
}>;

export function terminalSealSnapshots(state: ContractState): readonly SnapshotId[] {
  return [
    ...new Set([
      state.coordinates.start,
      ...(state.delivery === null
        ? []
        : [
            state.delivery.data.tenderSnapshot,
            ...(state.currentIntegration === null ? [] : [state.currentIntegration.snapshot]),
          ]),
    ]),
  ];
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
  const metadata = new Map(
    snapshots.map((snapshot) => [snapshot, commitMetadata(snapshot, objects.get(gitObjectIdForSnapshot(snapshot)))]),
  );
  const treeBySnapshot = new Map([...metadata].map(([snapshot, commit]) => [snapshot, commit.tree]));
  if (state.delivery === null) {
    return { heads: [state.coordinates.start], trees: [...treeBySnapshot.values()], treeBySnapshot };
  }
  const tender = state.delivery.data.tenderSnapshot;
  const tenderMetadata = metadata.get(tender);
  if (tenderMetadata === undefined) throw new Error(`terminal seal metadata was not resolved: ${tender}`);
  const [tenderParent] = tenderMetadata.parents;
  return {
    heads: [
      ...new Set([
        state.coordinates.start,
        ...(tenderParent === undefined ? [] : [tenderParent]),
        tender,
        state.currentIntegration?.snapshot ?? state.delivery.data.integration.snapshot,
      ]),
    ],
    trees: [...treeBySnapshot.values()],
    treeBySnapshot,
  };
}

async function unsealedWorkspaceBytes(
  path: string,
  expected: TerminalSealExpectations,
  workspace: WorkspaceTree,
): Promise<UnsealedBytes | null> {
  const headIsSealed = expected.heads.includes(workspace.head);
  if (workspace.changes.submodules.length > 0) return { kind: "unsealed-bytes", path };
  if (headIsSealed && expected.trees.includes(workspace.tree)) return null;
  return { kind: "unsealed-bytes", path };
}

export async function observeTerminalWorkspace(
  repository: GitRepository,
  path: string,
  expected: TerminalSealExpectations,
): Promise<TerminalWorkspaceObservation> {
  const captured = await captureWorkspaceTree(repository, path);
  return {
    workspace: {
      tree: captured.tree,
      head: captured.head,
      submodules: captured.changes.submodules,
    },
    unsealed: await unsealedWorkspaceBytes(path, expected, captured),
  };
}
