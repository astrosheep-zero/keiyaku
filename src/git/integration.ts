import type { Preparation } from "../core/decide.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ChangeId, ContractCoordinates, ContractId, SnapshotId } from "../core/facts/types.js";
import { gitObjectId, gitObjectIdForSnapshot, mintChangeId, mintSnapshotId, type GitObjectId } from "./identity.js";
import {
  GitPlumbingError,
  readRef,
  runGit,
  runGitWithEnvironment,
  readBlob,
  readTreeEntries,
  updateGitTree,
  writeBlob,
  type GitRepository,
} from "./repository.js";
import type { TenderCapture } from "./tender.js";

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
      reason: "not-based-on-target" | "unrelated-histories" | "conflict";
      targetHead: SnapshotId;
      conflictPaths?: readonly string[];
    }>
  | Readonly<{
      kind: "integration-unsupported";
      contractId: ContractId;
      requiredGit: typeof REQUIRED_GIT;
    }>;

export type IntegrationCoordinates = Readonly<{
  contractId: ContractId;
  coordinates: ContractCoordinates;
}>;

export type IntegrationPlan = Readonly<{
  predecessor: SnapshotId;
  tree: GitObjectId;
  changeId: ChangeId;
}>;

export type IntegrationBlob = Readonly<{ bytes: Uint8Array; mode: string }>;

export function readIntegrationBlob(
  repository: GitRepository,
  tree: GitObjectId,
  path: string,
): Readonly<{ kind: "present"; data: IntegrationBlob } | { kind: "missing" | "not-a-blob" }> {
  const entry = readTreeEntries(repository, tree).get(path);
  if (entry === undefined) return { kind: "missing" };
  if (entry.type !== "blob") return { kind: "not-a-blob" };
  return { kind: "present", data: { bytes: readBlob(repository, entry.oid), mode: entry.mode } };
}

export function updateIntegrationPlan(
  repository: GitRepository,
  plan: IntegrationPlan,
  update: Readonly<{ path: string; bytes: Uint8Array; mode: string }>,
): IntegrationPlan {
  const blob = writeBlob(repository, update.bytes);
  const tree = gitObjectId(updateGitTree(repository, plan.tree, new Map([[update.path, { oid: blob, mode: update.mode, type: "blob" }]])), "updated integration tree");
  return { ...plan, tree, changeId: stablePatchId(repository, plan.predecessor, tree) };
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

/** Materialize the exact integration tree against its observed predecessor. */
export function materializeIntegrationSnapshot(
  repository: GitRepository,
  tree: GitObjectId,
  parent: SnapshotId,
  input: Readonly<{ contractId: ContractId; title: string; message?: string }>,
): SnapshotId {
  const commit = runGitWithEnvironment(
    repository,
    ["commit-tree", tree, "-p", gitObjectIdForSnapshot(parent)],
    `${input.message ?? `${input.contractId}: ${input.title}`}\n\nKeiyaku-Contract: ${input.contractId}\n`,
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

function commonAncestor(repository: GitRepository, left: SnapshotId, right: SnapshotId): SnapshotId | null {
  const result = runAllowingNonzero(repository, [
    "merge-base",
    gitObjectIdForSnapshot(left),
    gitObjectIdForSnapshot(right),
  ]);
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new GitPlumbingError({
      stderr: result.stderr,
      status: result.status,
      message: "git merge-base failed",
    });
  }
  return mintSnapshotId(result.stdout.toString("utf8").trim());
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

export function planIntegration(
  repository: GitRepository,
  input: IntegrationCoordinates,
  tender: TenderCapture,
  requireBranchesToBeUpToDate: boolean,
): Preparation<IntegrationPlan, Readonly<{ kind: "target-missing"; contractId: ContractId }> | IntegrationPreparationRefusal> {
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
    const base = commonAncestor(repository, tender.head, targetHead);
    if (base === null) {
      return {
        kind: "refused",
        refusal: {
          kind: "integration-failed",
          contractId: input.contractId,
          reason: "unrelated-histories",
          targetHead,
        },
      };
    }
    const merged = mergedTree(
      repository,
      input.contractId,
      base,
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

function deliverySnapshotAvailability(
  repository: GitRepository,
  predecessor: SnapshotId,
  candidate: SnapshotId,
): "available" | "unavailable" {
  const objects = [gitObjectIdForSnapshot(predecessor), gitObjectIdForSnapshot(candidate)] as const;
  const types = runGit(
    repository,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${objects.join("\n")}\n`,
  ).toString("ascii").trimEnd().split("\n").map((record) => record.split(" ")[1]);
  if (types.includes("missing")) return "unavailable";
  if (types.some((type) => type !== "commit")) {
    throw new AuthorityCorruptionError("recorded delivery snapshot is not a Git commit");
  }
  return "available";
}

/** Read a recorded integration pair's patch, or null when Git no longer has it. */
export function readDeliveryDiff(repository: GitRepository, predecessor: SnapshotId, candidate: SnapshotId): string | null {
  if (deliverySnapshotAvailability(repository, predecessor, candidate) === "unavailable") return null;
  try {
    return runGit(repository, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      gitObjectIdForSnapshot(predecessor),
      gitObjectIdForSnapshot(candidate),
    ]).toString("utf8");
  } catch (error) {
    if (deliverySnapshotAvailability(repository, predecessor, candidate) === "unavailable") return null;
    throw error;
  }
}
