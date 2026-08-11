import { existsSync } from "node:fs";
import type { Preparation } from "../core/decide.js";
import type { ChangeId, ContractCoordinates, ContractId, DeliverData, SnapshotId } from "../core/facts/types.js";
import { mintChangeId, mintSnapshotId, gitObjectIdForSnapshot, type GitObjectId } from "./identity.js";
import { readRef, registeredWorktreePaths, runGit, runGitWithEnvironment, type GitRepository } from "./repository.js";
import { currentBranch } from "./observe.js";
import type { WorkspaceNotOnTargetRefusal } from "./target-placement.js";
import { captureWorkspaceTree, deliveryWorktreePath } from "./workspace.js";

export type DeliveryPreparationRefusal =
  | Readonly<{
      kind: "target-missing" | "candidate-not-based-on-target" | "worktree-missing";
      contractId: ContractId;
    }>
  | WorkspaceNotOnTargetRefusal;

export type ReviewPreparationRefusal = Readonly<{
  kind: "worktree-missing";
  contractId: ContractId;
}>;

export type DeliveryPreparationCoordinates = Readonly<{
  contractId: ContractId;
  coordinates: ContractCoordinates;
}>;

function workspaceExists(repository: GitRepository, workspace: "worktree" | "here", path: string): boolean {
  return workspace === "here"
    || (existsSync(path) && registeredWorktreePaths(repository).includes(path));
}

function workspaceFor(repository: GitRepository, id: ContractId, workspace: "worktree" | "here"): string {
  return workspace === "worktree" ? deliveryWorktreePath(repository, id) : repository.effectiveCwd;
}

function stablePatchId(repository: GitRepository, predecessor: SnapshotId, tree: GitObjectId): ReturnType<typeof mintChangeId> {
  const diff = runGit(repository, ["diff", "--binary", gitObjectIdForSnapshot(predecessor), tree]);
  const output = runGit(repository, ["patch-id", "--stable"], diff).toString("utf8").trim();
  const separator = output.indexOf(" ");
  const identity = output.length === 0
    ? runGit(repository, ["hash-object", "-t", "blob", "--stdin"], diff).toString("utf8").trim()
    : separator < 0 ? output : output.slice(0, separator);
  return mintChangeId(identity);
}

type CandidateInput = Readonly<{
  repository: GitRepository;
  contractId: ContractId;
  workspace: string;
  title: string;
  message?: string;
  tree: GitObjectId;
  head: SnapshotId;
}>;

function materializeCandidate(input: CandidateInput): SnapshotId {
  const subject = input.message ?? `${input.contractId}: ${input.title}`;
  const message = `${subject}\n\nKeiyaku-Contract: ${input.contractId}\n`;
  const commit = runGitWithEnvironment(
    input.repository,
    ["-C", input.workspace, "commit-tree", input.tree, "-p", gitObjectIdForSnapshot(input.head)],
    message,
    {
      GIT_AUTHOR_NAME: "Keiyaku",
      GIT_AUTHOR_EMAIL: "keiyaku@localhost",
      GIT_COMMITTER_NAME: "Keiyaku",
      GIT_COMMITTER_EMAIL: "keiyaku@localhost",
      GIT_AUTHOR_DATE: "Thu, 01 Jan 1970 00:00:00 +0000",
      GIT_COMMITTER_DATE: "Thu, 01 Jan 1970 00:00:00 +0000",
    },
  ).toString("utf8").trim();
  return mintSnapshotId(commit);
}

export function prepareReview(
  repository: GitRepository,
  input: DeliveryPreparationCoordinates,
): Preparation<ChangeId, ReviewPreparationRefusal> {
  const workspace = workspaceFor(repository, input.contractId, input.coordinates.workspace);
  if (!workspaceExists(repository, input.coordinates.workspace, workspace)) {
    return { kind: "refused", refusal: { kind: "worktree-missing", contractId: input.contractId } };
  }
  const tree = captureWorkspaceTree(repository, workspace);
  return { kind: "prepared", data: stablePatchId(repository, input.coordinates.start, tree.tree) };
}

export function prepareDelivery(
  repository: GitRepository,
  stage: DeliveryPreparationCoordinates,
  input: Readonly<{ title: string; message?: string }>,
): Preparation<DeliverData, DeliveryPreparationRefusal> {
  const id = stage.contractId;
  const coordinates = stage.coordinates;
  if (coordinates.workspace === "here" && coordinates.target !== undefined) {
    const branch = currentBranch(repository);
    if (branch !== coordinates.target) {
      return {
        kind: "refused",
        refusal: { kind: "workspace-not-on-target", contractId: id, target: coordinates.target, branch },
      };
    }
  }
  const observedTarget = coordinates.target === undefined ? null : readRef(repository, coordinates.target);
  if (coordinates.target !== undefined && observedTarget === null) {
    return { kind: "refused", refusal: { kind: "target-missing", contractId: id } };
  }
  const predecessor = observedTarget === null ? coordinates.start : mintSnapshotId(observedTarget);
  const workspace = workspaceFor(repository, id, coordinates.workspace);
  if (!workspaceExists(repository, coordinates.workspace, workspace)) {
    return { kind: "refused", refusal: { kind: "worktree-missing", contractId: id } };
  }
  const content = captureWorkspaceTree(repository, workspace);
  const candidate = content.dirty
    ? materializeCandidate({ repository, contractId: id, workspace, ...input, tree: content.tree, head: content.head })
    : content.head;

  if (coordinates.target !== undefined) {
    try {
      runGit(repository, ["merge-base", "--is-ancestor", gitObjectIdForSnapshot(predecessor), gitObjectIdForSnapshot(candidate)]);
    } catch (error) {
      const status = (error as { status?: number | null }).status;
      if (status === 1) return { kind: "refused", refusal: { kind: "candidate-not-based-on-target", contractId: id } };
      throw error;
    }
  }
  return {
    kind: "prepared",
    data: {
      expectedPredecessor: predecessor,
      candidate,
      deliveryPatchId: stablePatchId(repository, predecessor, content.tree),
    },
  };
}
