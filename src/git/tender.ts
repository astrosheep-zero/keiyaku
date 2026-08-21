import { access } from "node:fs/promises";
import type { Preparation } from "../core/decide.js";
import type { ActorId, ContractCoordinates, ContractId, SnapshotId } from "../core/facts/types.js";
import { gitObjectIdForSnapshot, mintSnapshotId, type GitObjectId } from "./identity.js";
import { decodeGitNumstat, registeredWorktreePaths } from "./repository.js";
import { GitPlumbingError, runGit, runGitWithEnvironment, type GitRepository } from "./process.js";
import { captureWorkspaceTree, unmergedWorkspacePaths, workspaceMergeHead, worktreePath } from "./workspace.js";

export type TenderCaptureCoordinates = Readonly<{
  contractId: ContractId;
  coordinates: ContractCoordinates;
  place?: string;
  workspacePath?: string;
  captureMergeState?: boolean;
  rejectUnmerged?: boolean;
}>;

export type WorktreeMissingRefusal = Readonly<{
  kind: "worktree-missing";
  contractId: ContractId;
}>;

export type TenderCaptureRefusal =
  | WorktreeMissingRefusal
  | Readonly<{
      kind: "unmerged-paths";
      contractId: ContractId;
      paths: readonly string[];
    }>;

export type WorkspaceDirtyDelta = Readonly<{
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  shortStat: Readonly<{ filesChanged: number; insertions: number; deletions: number }>;
}>;

export type DirtyWorkspaceRefusal = Readonly<{
  kind: "dirty-workspace";
  contractId: ContractId;
  staged: readonly string[];
  unstaged: readonly string[];
  untracked: readonly string[];
  submodules: readonly string[];
  shortStat: WorkspaceDirtyDelta["shortStat"];
}>;

export type TenderCapture = Readonly<{
  tree: GitObjectId;
  head: SnapshotId;
  mergeHead?: SnapshotId;
  at: string;
  dirty: boolean;
  changes: Awaited<ReturnType<typeof captureWorkspaceTree>>["changes"];
}>;

async function workspaceExists(
  repository: GitRepository,
  workspace: "worktree" | "here",
  path: string,
): Promise<boolean> {
  const exists = await access(path).then(
    () => true,
    () => false,
  );
  return workspace === "here" || (exists && (await registeredWorktreePaths(repository)).includes(path));
}

function workspaceFor(repository: GitRepository, input: TenderCaptureCoordinates): string | undefined {
  if (input.workspacePath !== undefined) return input.workspacePath;
  return input.place === undefined ? undefined : worktreePath(repository, input.place);
}

/** Capture the complete workspace tree through Git's private index mechanics. */
export function captureTender(
  repository: GitRepository,
  input: TenderCaptureCoordinates & Readonly<{ rejectUnmerged: true }>,
): Promise<Preparation<TenderCapture, TenderCaptureRefusal>>;
export function captureTender(
  repository: GitRepository,
  input: TenderCaptureCoordinates,
): Promise<Preparation<TenderCapture, WorktreeMissingRefusal>>;
export async function captureTender(
  repository: GitRepository,
  input: TenderCaptureCoordinates,
): Promise<Preparation<TenderCapture, TenderCaptureRefusal>> {
  const workspace = workspaceFor(repository, input);
  if (workspace === undefined || !(await workspaceExists(repository, input.coordinates.workspace, workspace))) {
    return { kind: "refused", refusal: { kind: "worktree-missing", contractId: input.contractId } };
  }
  if (input.rejectUnmerged === true) {
    const paths = await unmergedWorkspacePaths(repository, workspace);
    if (paths.length > 0)
      return { kind: "refused", refusal: { kind: "unmerged-paths", contractId: input.contractId, paths } };
  }
  const captured = await captureWorkspaceTree(repository, workspace);
  const mergeHead = input.captureMergeState === true ? await workspaceMergeHead(repository, workspace) : undefined;
  return {
    kind: "prepared",
    data: { ...captured, ...(mergeHead === undefined ? {} : { mergeHead }) },
  };
}

async function dirtyShortStat(
  repository: GitRepository,
  tender: TenderCapture,
): Promise<WorkspaceDirtyDelta["shortStat"]> {
  return decodeGitNumstat(
    await runGit(repository, ["diff", "--numstat", "-z", gitObjectIdForSnapshot(tender.head), tender.tree]),
  );
}

export async function dirtyTenderRefusal(
  repository: GitRepository,
  contractId: ContractId,
  tender: TenderCapture,
): Promise<DirtyWorkspaceRefusal> {
  return {
    kind: "dirty-workspace",
    contractId,
    ...tender.changes,
    shortStat: await dirtyShortStat(repository, tender),
  };
}

export async function dirtyTenderDelta(
  repository: GitRepository,
  tender: TenderCapture,
): Promise<WorkspaceDirtyDelta | undefined> {
  if (!tender.dirty) return undefined;
  const { staged, unstaged, untracked } = tender.changes;
  return { staged, unstaged, untracked, shortStat: await dirtyShortStat(repository, tender) };
}

type GitCommitIdentity = Readonly<{ name: string; email: string }>;

export type DeliveryCommitMetadata = Readonly<{
  message: string;
  at: string;
  identity: GitCommitIdentity;
}>;

async function effectiveConfig(
  repository: GitRepository,
  key: "user.name" | "user.email",
): Promise<string | undefined> {
  try {
    const value = (await runGit(repository, ["config", "--get", key])).toString("utf8").trim();
    return value.length === 0 ? undefined : value;
  } catch (error) {
    if (error instanceof GitPlumbingError && error.status === 1) return undefined;
    throw error;
  }
}

function contractBody(bytes: string): string {
  return `${bytes.replace(/(?:\r\n|\r|\n)+$/u, "")}\n`;
}

export async function prepareDeliveryCommitMetadata(
  repository: GitRepository,
  input: Readonly<{
    contractId: ContractId;
    title: string;
    document: string;
    at: string;
    actor?: ActorId;
    message?: string;
  }>,
): Promise<DeliveryCommitMetadata> {
  let identity: GitCommitIdentity;
  if (input.actor !== undefined) {
    identity = { name: input.actor, email: "keiyaku@localhost" };
  } else {
    const [name, email] = await Promise.all([
      effectiveConfig(repository, "user.name"),
      effectiveConfig(repository, "user.email"),
    ]);
    identity =
      name !== undefined && email !== undefined ? { name, email } : { name: "Keiyaku", email: "keiyaku@localhost" };
  }
  const subject = input.message ?? `${input.contractId}: ${input.title}`;
  return {
    message: `${subject}\n\n${contractBody(input.document)}\nKeiyaku-Contract: ${input.contractId}\n`,
    at: input.at,
    identity,
  };
}

/** Materialize the tender tree when it contains admitted dirty workspace bytes. */
export async function materializeTenderSnapshot(
  repository: GitRepository,
  tender: TenderCapture,
  commit: DeliveryCommitMetadata,
): Promise<SnapshotId> {
  if (!tender.dirty && tender.mergeHead === undefined) return tender.head;
  const parents = ["-p", gitObjectIdForSnapshot(tender.head)];
  if (tender.mergeHead !== undefined) parents.push("-p", gitObjectIdForSnapshot(tender.mergeHead));
  const oid = (
    await runGitWithEnvironment(repository, ["commit-tree", tender.tree, ...parents], commit.message, {
      GIT_AUTHOR_NAME: commit.identity.name,
      GIT_AUTHOR_EMAIL: commit.identity.email,
      GIT_COMMITTER_NAME: commit.identity.name,
      GIT_COMMITTER_EMAIL: commit.identity.email,
      GIT_AUTHOR_DATE: commit.at,
      GIT_COMMITTER_DATE: commit.at,
    })
  )
    .toString("utf8")
    .trim();
  return mintSnapshotId(oid);
}
