import type { Preparation } from "../core/decide.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import type { ChangeId, ContractCoordinates, ContractId, SnapshotId } from "../core/facts/types.js";
import { gitObjectId, gitObjectIdForSnapshot, mintChangeId, mintSnapshotId, type GitObjectId } from "./identity.js";
import {
  decodeGitNameOnly,
  decodeGitNumstat,
  GitPlumbingError,
  readRef,
  runGit,
  runGitWithEnvironment,
  type GitRepository,
} from "./repository.js";
import type { DeliveryCommitMetadata, TenderCapture } from "./tender.js";

const REQUIRED_GIT = "2.38" as const;

async function runAllowingNonzero(repository: GitRepository, args: readonly string[], input?: string): Promise<Readonly<{ stdout: Buffer; stderr: Buffer; status: number | null }>> {
  try { return { stdout: await runGit(repository, args, input), stderr: Buffer.alloc(0), status: 0 }; }
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
}>;

/** Mint the one worktree-content identity shared by review and delivery. */
export async function worktreeChangeId(
  repository: GitRepository,
  input: IntegrationCoordinates,
  tender: TenderCapture,
): Promise<ChangeId> {
  const patch = await runGit(repository, [
    "-c", "core.quotePath=false",
    "-c", "core.abbrev=40",
    "-c", "diff.algorithm=myers",
    "-c", "diff.renames=false",
    "-c", "diff.indentHeuristic=false",
    "-c", "diff.suppressBlankEmpty=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-indent-heuristic",
    "--no-renames",
    "--full-index",
    "--binary",
    "--no-color",
    "--diff-algorithm=myers",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--inter-hunk-context=0",
    "--no-relative",
    "--ignore-submodules=none",
    "--submodule=short",
    gitObjectIdForSnapshot(input.coordinates.start),
    tender.tree,
  ]);
  const id = (await runGit(repository, ["patch-id", "--verbatim"], patch)).toString("utf8").trim().split(/\s/, 1)[0] ?? "";
  return mintChangeId(id === "" ? "0000000000000000000000000000000000000000" : id);
}

/** Materialize the exact integration tree against its observed predecessor. */
export async function materializeIntegrationSnapshot(
  repository: GitRepository,
  tree: GitObjectId,
  parent: SnapshotId,
  metadata: DeliveryCommitMetadata,
): Promise<SnapshotId> {
  const commit = (await runGitWithEnvironment(
    repository,
    ["commit-tree", tree, "-p", gitObjectIdForSnapshot(parent)],
    metadata.message,
    {
      GIT_AUTHOR_NAME: metadata.identity.name,
      GIT_AUTHOR_EMAIL: metadata.identity.email,
      GIT_COMMITTER_NAME: metadata.identity.name,
      GIT_COMMITTER_EMAIL: metadata.identity.email,
      GIT_AUTHOR_DATE: metadata.at,
      GIT_COMMITTER_DATE: metadata.at,
    },
  )).toString("utf8").trim();
  return mintSnapshotId(commit);
}

async function isAncestor(repository: GitRepository, ancestor: SnapshotId, descendant: SnapshotId): Promise<boolean> {
  const result = await runAllowingNonzero(repository, [
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

async function commonAncestor(repository: GitRepository, left: SnapshotId, right: SnapshotId): Promise<SnapshotId | null> {
  const result = await runAllowingNonzero(repository, [
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

async function supportsMergeTree(repository: GitRepository): Promise<boolean> {
  return (await runAllowingNonzero(repository, ["merge-tree", "--write-tree", "--stdin"], "")).status === 0;
}

function nulFields(output: Buffer): readonly string[] {
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) !== "") throw new Error("Git merge-tree output is not NUL terminated");
  return fields.slice(0, -1);
}

async function mergedTree(
  repository: GitRepository,
  contractId: ContractId,
  base: SnapshotId,
  targetHead: SnapshotId,
  tenderTree: GitObjectId,
): Promise<Preparation<GitObjectId, IntegrationPreparationRefusal>> {
  if (!(await supportsMergeTree(repository))) {
    return { kind: "refused", refusal: { kind: "integration-unsupported", contractId, requiredGit: REQUIRED_GIT } };
  }
  const result = await runAllowingNonzero(repository, [
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

export async function planIntegration(
  repository: GitRepository,
  input: IntegrationCoordinates,
  tender: TenderCapture,
  requireBranchesToBeUpToDate: boolean,
): Promise<Preparation<IntegrationPlan, Readonly<{ kind: "target-missing"; contractId: ContractId }> | IntegrationPreparationRefusal>> {
  const target = input.coordinates.target;
  if (target === undefined) {
    return {
      kind: "prepared",
      data: {
        predecessor: input.coordinates.start,
        tree: tender.tree,
      },
    };
  }
  const observed = await readRef(repository, target);
  if (observed === null) {
    return { kind: "refused", refusal: { kind: "target-missing", contractId: input.contractId } };
  }
  const targetHead = mintSnapshotId(observed);
  let tree: GitObjectId;
  if (requireBranchesToBeUpToDate) {
    if (!(await isAncestor(repository, targetHead, tender.head))) {
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
    const base = await commonAncestor(repository, tender.head, targetHead);
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
    const merged = await mergedTree(
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
    },
  };
}

async function deliverySnapshotAvailability(
  repository: GitRepository,
  predecessor: SnapshotId,
  candidate: SnapshotId,
): Promise<"available" | "unavailable"> {
  const objects = [gitObjectIdForSnapshot(predecessor), gitObjectIdForSnapshot(candidate)] as const;
  const types = (await runGit(
    repository,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${objects.join("\n")}\n`,
  )).toString("ascii").trimEnd().split("\n").map((record) => record.split(" ")[1]);
  if (types.includes("missing")) return "unavailable";
  if (types.some((type) => type !== "commit")) {
    throw new AuthorityCorruptionError("recorded delivery snapshot is not a Git commit");
  }
  return "available";
}

export type DeliveryDiffScope = Readonly<{
  filesChanged: number;
  insertions: number;
  deletions: number;
  paths?: readonly string[];
}>;

/** Compute predecessor-to-candidate scope from the exact integration trees. */
export async function readDeliveryScope(
  repository: GitRepository,
  predecessor: SnapshotId,
  candidate: SnapshotId,
  includePaths: boolean,
): Promise<DeliveryDiffScope> {
  const scope = decodeGitNumstat(await runGit(repository, [
    "diff",
    "--numstat",
    "-z",
    gitObjectIdForSnapshot(predecessor),
    gitObjectIdForSnapshot(candidate),
  ]));
  if (!includePaths) return scope;
  return {
    ...scope,
    paths: decodeGitNameOnly(await runGit(repository, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      gitObjectIdForSnapshot(predecessor),
      gitObjectIdForSnapshot(candidate),
    ])),
  };
}

/** Read a recorded integration pair's patch, or null when Git no longer has it. */
export async function readDeliveryDiff(repository: GitRepository, predecessor: SnapshotId, candidate: SnapshotId): Promise<string | null> {
  if (await deliverySnapshotAvailability(repository, predecessor, candidate) === "unavailable") return null;
  try {
    return (await runGit(repository, [
      "diff",
      "--no-ext-diff",
      "--no-color",
      gitObjectIdForSnapshot(predecessor),
      gitObjectIdForSnapshot(candidate),
    ])).toString("utf8");
  } catch (error) {
    if (await deliverySnapshotAvailability(repository, predecessor, candidate) === "unavailable") return null;
    throw error;
  }
}
