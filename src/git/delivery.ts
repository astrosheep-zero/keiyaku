import { existsSync } from "node:fs";
import type { Preparation } from "../core/decide.js";
import type { ChangeId, ContractCoordinates, ContractId, DeliverData, SnapshotId } from "../core/facts/types.js";
import { gitObjectId, gitObjectIdForSnapshot, mintChangeId, mintSnapshotId, type GitObjectId } from "./identity.js";
import {
  GitPlumbingError,
  readRef,
  registeredWorktreePaths,
  runGit,
  runGitWithEnvironment,
  type GitRepository,
} from "./repository.js";
import { currentBranch } from "./observe.js";
import type { WorkspaceNotOnTargetRefusal } from "./target-placement.js";
import { captureWorkspaceTree, deliveryWorktreePath } from "./workspace.js";

const REQUIRED_GIT = "2.38" as const;

function runAllowingNonzero(repository: GitRepository, args: readonly string[], input?: string): Readonly<{ stdout: Buffer; stderr: Buffer; status: number | null }> {
  try { return { stdout: runGit(repository, args, input), stderr: Buffer.alloc(0), status: 0 }; }
  catch (error) {
    if (!(error instanceof GitPlumbingError)) throw error;
    return { stdout: error.stdout, stderr: error.stderr, status: error.status };
  }
}

export type IntegrationPreparationRefusal =
  | Readonly<{
      kind: "integration-failed";
      contractId: ContractId;
      reason: "not-based-on-target" | "conflict";
      targetHead: SnapshotId;
      conflictPaths?: readonly string[];
    }>
  | Readonly<{
      kind: "integration-unsupported";
      contractId: ContractId;
      requiredGit: typeof REQUIRED_GIT;
    }>;

export type DeliveryPreparationRefusal =
  | Readonly<{
      kind: "target-missing" | "worktree-missing";
      contractId: ContractId;
    }>
  | IntegrationPreparationRefusal
  | WorkspaceNotOnTargetRefusal;

export type ReviewPreparationRefusal =
  | Readonly<{
      kind: "target-missing" | "worktree-missing";
      contractId: ContractId;
    }>
  | IntegrationPreparationRefusal;

export type DeliveryPreparationCoordinates = Readonly<{
  contractId: ContractId;
  coordinates: ContractCoordinates;
}>;

type TenderContent = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  dirty: boolean;
}>;

type IntegrationTree = Readonly<{
  predecessor: SnapshotId;
  tree: GitObjectId;
  changeId: ChangeId;
}>;

function workspaceExists(repository: GitRepository, workspace: "worktree" | "here", path: string): boolean {
  return workspace === "here"
    || (existsSync(path) && registeredWorktreePaths(repository).includes(path));
}

function workspaceFor(repository: GitRepository, id: ContractId, workspace: "worktree" | "here"): string {
  return workspace === "worktree" ? deliveryWorktreePath(repository, id) : repository.effectiveCwd;
}

function stablePatchId(repository: GitRepository, predecessor: SnapshotId, tree: GitObjectId): ChangeId {
  const diff = runGit(repository, ["diff", "--binary", gitObjectIdForSnapshot(predecessor), tree]);
  const output = runGit(repository, ["patch-id", "--stable"], diff).toString("utf8").trim();
  const separator = output.indexOf(" ");
  const identity = output.length === 0
    ? runGit(repository, ["hash-object", "-t", "blob", "--stdin"], diff).toString("utf8").trim()
    : separator < 0 ? output : output.slice(0, separator);
  return mintChangeId(identity);
}

function commitMessage(contractId: ContractId, title: string, message?: string): string {
  const subject = message ?? `${contractId}: ${title}`;
  return `${subject}\n\nKeiyaku-Contract: ${contractId}\n`;
}

function materializeCommit(
  repository: GitRepository,
  tree: GitObjectId,
  parent: SnapshotId,
  message: string,
): SnapshotId {
  const commit = runGitWithEnvironment(
    repository,
    ["commit-tree", tree, "-p", gitObjectIdForSnapshot(parent)],
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

function isAncestor(repository: GitRepository, ancestor: SnapshotId, descendant: SnapshotId): boolean {
  const result = runAllowingNonzero(repository, [
    "merge-base",
    "--is-ancestor",
    gitObjectIdForSnapshot(ancestor),
    gitObjectIdForSnapshot(descendant),
  ]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new GitPlumbingError({
    stderr: result.stderr,
    status: result.status,
    message: "git merge-base --is-ancestor failed",
  });
}

function supportsMergeTree(repository: GitRepository): boolean {
  return runAllowingNonzero(repository, ["merge-tree", "--write-tree", "--stdin"], "").status === 0;
}

function nulFields(output: Buffer): readonly string[] {
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("Git merge-tree output is not NUL terminated");
  return fields.slice(0, -1);
}

function mergedTree(
  repository: GitRepository,
  contractId: ContractId,
  base: SnapshotId,
  targetHead: SnapshotId,
  tenderTree: GitObjectId,
): Preparation<GitObjectId, IntegrationPreparationRefusal> {
  if (!supportsMergeTree(repository)) {
    return { kind: "refused", refusal: { kind: "integration-unsupported", contractId, requiredGit: REQUIRED_GIT } };
  }
  const result = runAllowingNonzero(repository, [
    "merge-tree",
    "--write-tree",
    "--no-messages",
    "-z",
    "--name-only",
    "--merge-base",
    gitObjectIdForSnapshot(base),
    gitObjectIdForSnapshot(targetHead),
    tenderTree,
  ]);
  const fields = nulFields(result.stdout);
  if (result.status === 0) {
    if (fields.length !== 1) throw new Error("successful Git merge-tree output has unexpected fields");
    return { kind: "prepared", data: gitObjectId(fields[0]!, "integration tree") };
  }
  if (result.status === 1) {
    if (fields.length < 2) throw new Error("conflicted Git merge-tree output is missing paths");
    return {
      kind: "refused",
      refusal: {
        kind: "integration-failed",
        contractId,
        reason: "conflict",
        targetHead,
        conflictPaths: Object.freeze([...new Set(fields.slice(1))].sort()),
      },
    };
  }
  throw new GitPlumbingError({
    stderr: result.stderr,
    status: result.status,
    message: "git merge-tree --write-tree failed",
  });
}

function integrationTree(
  repository: GitRepository,
  input: DeliveryPreparationCoordinates,
  tender: TenderContent,
  requireBranchesToBeUpToDate: boolean,
): Preparation<IntegrationTree, ReviewPreparationRefusal> {
  const target = input.coordinates.target;
  if (target === undefined) {
    return {
      kind: "prepared",
      data: {
        predecessor: input.coordinates.start,
        tree: tender.tree,
        changeId: stablePatchId(repository, input.coordinates.start, tender.tree),
      },
    };
  }
  const observed = readRef(repository, target);
  if (observed === null) {
    return { kind: "refused", refusal: { kind: "target-missing", contractId: input.contractId } };
  }
  const targetHead = mintSnapshotId(observed);
  let tree: GitObjectId;
  if (requireBranchesToBeUpToDate) {
    if (!isAncestor(repository, targetHead, tender.head)) {
      return {
        kind: "refused",
        refusal: {
          kind: "integration-failed",
          contractId: input.contractId,
          reason: "not-based-on-target",
          targetHead,
        },
      };
    }
    tree = tender.tree;
  } else {
    const merged = mergedTree(
      repository,
      input.contractId,
      input.coordinates.start,
      targetHead,
      tender.tree,
    );
    if (merged.kind === "refused") return merged;
    tree = merged.data;
  }
  return {
    kind: "prepared",
    data: {
      predecessor: targetHead,
      tree,
      changeId: stablePatchId(repository, targetHead, tree),
    },
  };
}

function observedTender(repository: GitRepository, input: DeliveryPreparationCoordinates): Preparation<TenderContent, Readonly<{
  kind: "worktree-missing";
  contractId: ContractId;
}>> {
  const workspace = workspaceFor(repository, input.contractId, input.coordinates.workspace);
  if (!workspaceExists(repository, input.coordinates.workspace, workspace)) {
    return { kind: "refused", refusal: { kind: "worktree-missing", contractId: input.contractId } };
  }
  return { kind: "prepared", data: captureWorkspaceTree(repository, workspace) };
}

export function prepareReview(
  repository: GitRepository,
  input: DeliveryPreparationCoordinates,
): Preparation<ChangeId, ReviewPreparationRefusal> {
  const tender = observedTender(repository, input);
  if (tender.kind === "refused") return tender;
  const integration = integrationTree(repository, input, tender.data, false);
  return integration.kind === "refused"
    ? integration
    : { kind: "prepared", data: integration.data.changeId };
}

export function prepareDelivery(
  repository: GitRepository,
  stage: DeliveryPreparationCoordinates,
  input: Readonly<{ title: string; message?: string; requireBranchesToBeUpToDate: boolean }>,
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
  const tender = observedTender(repository, stage);
  if (tender.kind === "refused") return tender;
  const requireBranchesToBeUpToDate = input.requireBranchesToBeUpToDate ?? false;
  const message = commitMessage(id, input.title, input.message);
  const tenderSnapshot = tender.data.dirty
    ? materializeCommit(repository, tender.data.tree, tender.data.head, message)
    : tender.data.head;
  const preparedTender = { ...tender.data, head: tenderSnapshot };
  const integration = integrationTree(
    repository,
    stage,
    preparedTender,
    requireBranchesToBeUpToDate,
  );
  if (integration.kind === "refused") return integration;
  const integrationSnapshot = coordinates.target === undefined
    ? tenderSnapshot
    : materializeCommit(repository, integration.data.tree, integration.data.predecessor, message);
  return {
    kind: "prepared",
    data: {
      tenderSnapshot,
      integration: {
        predecessor: integration.data.predecessor,
        snapshot: integrationSnapshot,
        changeId: integration.data.changeId,
      },
      method: "squash",
      policy: { requireBranchesToBeUpToDate },
    },
  };
}
